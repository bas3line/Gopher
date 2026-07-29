import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import type { ChatMessage, CompletionResult } from "../ai/client.ts";
import {
  buildVoiceChatMessages,
  type VoiceChatHistoryTurn,
} from "../ai/prompts.ts";
import type { AppConfig } from "../config.ts";
import type { Coordinator } from "../infra/coordinator.ts";
import type { Logger } from "../logger.ts";
import type { MemoryStore } from "../memory/store.ts";
import {
  DISCORD_OPUS_CHANNELS,
  PCM_BYTES_PER_SECOND,
  maxPcmBytesForSeconds,
  pcmToWav,
} from "./audio.ts";
import { CloudflareWhisper } from "./cloudflare-whisper.ts";
import type { VoiceSynthesizer } from "./fish-audio.ts";

const receiveSilenceMs = 1_100;
const minimumUtteranceSeconds = 0.25;

class VoiceChatUserError extends Error {}

interface VoiceChatSession {
  guildId: string;
  voiceChannelId: string;
  controlChannelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  turns: VoiceChatHistoryTurn[];
  onSpeakingStart: (userId: string) => void;
  processing: boolean;
  ending: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface VoiceChatServiceDependencies {
  client: Client;
  config: AppConfig["voiceChat"];
  stt: CloudflareWhisper;
  synthesizer: VoiceSynthesizer;
  complete: (messages: ChatMessage[]) => Promise<CompletionResult>;
  textModel: string;
  sttModel: string;
  memory: MemoryStore;
  coordinator: Coordinator;
  maxUserRequestsPerMinute: number;
  releaseMusic: (guildId: string) => Promise<void>;
  logger: Logger;
}

/**
 * Live voice sessions are intentionally in-memory only. Audio is decoded,
 * transcribed, and discarded inside one utterance; neither it nor text is
 * sent through the persistent channel-history path.
 */
export class VoiceChatService {
  private readonly sessions = new Map<string, VoiceChatSession>();
  private readonly joiningGuilds = new Set<string>();

  constructor(private readonly dependencies: VoiceChatServiceDependencies) {}

  hasActiveSession(guildId: string): boolean {
    return this.sessions.has(guildId) || this.joiningGuilds.has(guildId);
  }

  async stop(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      this.endSession(session, "shutdown");
    }
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.dependencies.config.enabled) {
      await interaction.reply({
        content: "live voice chat is disabled. an administrator can enable it with `VOICE_CHAT_ENABLED=true`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.inGuild() || !interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: "live voice chat only works in a server voice channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: "live voice chat is an administrator-only control.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.dependencies.stt.enabled || !this.dependencies.synthesizer.enabled) {
      await interaction.reply({
        content: "live voice chat is missing its Cloudflare speech configuration.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const command = interaction.options.getSubcommand(true);
    if (command === "status") {
      await this.status(interaction);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (command === "join") {
        await this.join(interaction, interaction.guild);
      } else if (command === "leave") {
        await this.leave(interaction);
      } else {
        throw new VoiceChatUserError("that voice-chat command is not wired up yet");
      }
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, guildId: interaction.guildId, command },
        "voice chat command failed",
      );
      await interaction.editReply({
        content:
          error instanceof VoiceChatUserError
            ? error.message
            : "voice chat hit a wall before it could join. nothing is being recorded—try again in a moment.",
        allowedMentions: { parse: [] },
      });
    }
  }

  private async status(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = interaction.guildId
      ? this.sessions.get(interaction.guildId)
      : undefined;
    const content = session
      ? `live voice chat is active in <#${session.voiceChannelId}>. use \`/voicechat leave\` to end it.`
      : interaction.guildId && this.joiningGuilds.has(interaction.guildId)
        ? "live voice chat is joining now."
        : "live voice chat is not active.";
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  private async join(
    interaction: ChatInputCommandInteraction,
    guild: Guild,
  ): Promise<void> {
    const existing = this.sessions.get(guild.id);
    if (existing) {
      throw new VoiceChatUserError(
        `live voice chat is already active in <#${existing.voiceChannelId}>. use \`/voicechat leave\` first.`,
      );
    }
    if (this.joiningGuilds.has(guild.id)) {
      throw new VoiceChatUserError("live voice chat is already joining—give it a moment.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;
    if (!channel?.isVoiceBased()) {
      throw new VoiceChatUserError("join a voice channel first, then run `/voicechat join`.");
    }

    this.joiningGuilds.add(guild.id);
    let connection: VoiceConnection | undefined;
    try {
      // Prevent Lavalink and Discord Voice from attempting to own one VC.
      await this.dependencies.releaseMusic(guild.id);
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
      });
      connection.subscribe(player);
      const session: VoiceChatSession = {
        guildId: guild.id,
        voiceChannelId: channel.id,
        controlChannelId: interaction.channelId,
        connection,
        player,
        turns: [],
        onSpeakingStart: (userId) => {
          void this.captureSpeaker(session, guild, userId);
        },
        processing: false,
        ending: false,
      };
      this.sessions.set(guild.id, session);
      this.bindSession(session, guild);
      this.touch(session);
      await interaction.editReply({
        content:
          `joined <#${channel.id}>. this is an explicit, ephemeral session: ` +
          "audio and transcripts are not saved. use `/voicechat leave` when the call is done.",
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      connection?.destroy();
      throw error;
    } finally {
      this.joiningGuilds.delete(guild.id);
    }
  }

  private async leave(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const session = this.sessions.get(guildId);
    if (!session) {
      if (this.joiningGuilds.has(guildId)) {
        throw new VoiceChatUserError("live voice chat is still joining—try leaving again in a second.");
      }
      await interaction.editReply({
        content: "live voice chat is not active.",
        allowedMentions: { parse: [] },
      });
      return;
    }
    this.endSession(session, "admin_leave");
    await interaction.editReply({
      content: "live voice chat ended. audio and the in-memory call context were discarded.",
      allowedMentions: { parse: [] },
    });
  }

  private bindSession(session: VoiceChatSession, guild: Guild): void {
    session.connection.receiver.speaking.on("start", session.onSpeakingStart);
    session.connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.endSession(session, "disconnected");
    });
    session.connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.endSession(session, "destroyed");
    });
    session.player.on("error", (error) => {
      this.dependencies.logger.warn(
        { err: error, guildId: guild.id },
        "voice chat playback failed",
      );
    });
  }

  private async captureSpeaker(
    session: VoiceChatSession,
    guild: Guild,
    userId: string,
  ): Promise<void> {
    if (!canCaptureVoiceChatUtterance({
      sessionActive: this.isCurrent(session),
      sessionEnding: session.ending,
      processing: session.processing,
      userId,
      ...(this.dependencies.client.user?.id
        ? { botUserId: this.dependencies.client.user.id }
        : {}),
    })) {
      return;
    }

    session.processing = true;
    this.touch(session);
    try {
      const member = await guild.members.fetch(userId);
      if (member.voice.channelId !== session.voiceChannelId) return;
      const withinRateLimit = await this.dependencies.coordinator.consumeUserRequest(
        userId,
        this.dependencies.maxUserRequestsPerMinute,
      );
      if (!withinRateLimit) {
        this.dependencies.logger.debug(
          { guildId: guild.id, userId },
          "voice chat utterance skipped by user rate limit",
        );
        return;
      }

      const pcm = await this.receiveUtterance(session, userId);
      if (!pcm || !this.isCurrent(session)) return;

      const sttStartedAt = performance.now();
      let transcript: string;
      try {
        transcript = await this.dependencies.stt.transcribe(pcmToWav(pcm));
        await this.recordEvent({
          session,
          userId,
          model: this.dependencies.sttModel,
          kind: "voice_stt",
          success: true,
          latencyMs: Math.round(performance.now() - sttStartedAt),
        });
      } catch (error) {
        await this.recordEvent({
          session,
          userId,
          model: this.dependencies.sttModel,
          kind: "voice_stt",
          success: false,
          latencyMs: Math.round(performance.now() - sttStartedAt),
        });
        throw error;
      }
      if (!this.isCurrent(session) || !transcript.trim()) return;

      const username = member.displayName.slice(0, 80);
      const chatStartedAt = performance.now();
      let completion: CompletionResult;
      try {
        completion = await this.dependencies.complete(
          buildVoiceChatMessages({
            username,
            transcript,
            history: session.turns,
            maxReplyCharacters: this.dependencies.config.maxReplyCharacters,
          }),
        );
        await this.recordEvent({
          session,
          userId,
          model: this.dependencies.textModel,
          kind: "voice_chat",
          success: true,
          latencyMs: Math.round(performance.now() - chatStartedAt),
          ...(completion.promptTokens !== undefined
            ? { promptTokens: completion.promptTokens }
            : {}),
          ...(completion.completionTokens !== undefined
            ? { completionTokens: completion.completionTokens }
            : {}),
        });
      } catch (error) {
        await this.recordEvent({
          session,
          userId,
          model: this.dependencies.textModel,
          kind: "voice_chat",
          success: false,
          latencyMs: Math.round(performance.now() - chatStartedAt),
        });
        throw error;
      }
      if (!this.isCurrent(session)) return;

      const reply = limitVoiceChatReply(
        completion.content,
        this.dependencies.config.maxReplyCharacters,
      );
      if (!reply) return;
      session.turns.push({ role: "user", username, content: transcript });
      session.turns.push({ role: "assistant", content: reply });
      if (session.turns.length > 12) session.turns.splice(0, session.turns.length - 12);
      await this.playReply(session, reply);
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, guildId: guild.id, userId },
        "voice chat utterance failed",
      );
    } finally {
      session.processing = false;
      if (this.isCurrent(session)) this.touch(session);
    }
  }

  private async receiveUtterance(
    session: VoiceChatSession,
    userId: string,
  ): Promise<Buffer | undefined> {
    const stream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: receiveSilenceMs,
      },
    });
    const decoder = new OpusScript(
      48_000,
      DISCORD_OPUS_CHANNELS,
      OpusScript.Application.VOIP,
    );
    const maxBytes = maxPcmBytesForSeconds(
      this.dependencies.config.maxUtteranceSeconds,
    );
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    try {
      for await (const packet of stream) {
        if (!Buffer.isBuffer(packet)) continue;
        let decoded: Buffer;
        try {
          decoded = Buffer.from(decoder.decode(packet));
        } catch {
          continue;
        }
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          capped = true;
          stream.destroy();
          break;
        }
        if (decoded.length > remaining) {
          chunks.push(decoded.subarray(0, remaining));
          total += remaining;
          capped = true;
          stream.destroy();
          break;
        }
        chunks.push(decoded);
        total += decoded.length;
      }
    } catch (error) {
      if (!capped) throw error;
    } finally {
      decoder.delete();
      stream.destroy();
    }

    if (total < PCM_BYTES_PER_SECOND * minimumUtteranceSeconds) return undefined;
    return Buffer.concat(chunks, total);
  }

  private async playReply(session: VoiceChatSession, reply: string): Promise<void> {
    const synthesized = await this.dependencies.synthesizer.synthesize(reply);
    if (!this.isCurrent(session)) return;
    const resource = createAudioResource(Readable.from([synthesized.audio]), {
      inputType: StreamType.OggOpus,
      silencePaddingFrames: 5,
    });
    const timeoutMs = Math.min(
      120_000,
      Math.max(15_000, Math.ceil(synthesized.durationSeconds * 1_500 + 10_000)),
    );
    await waitForPlayerIdle(session.player, resource, timeoutMs);
  }

  private touch(session: VoiceChatSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    const timer = setTimeout(() => {
      this.endSession(session, "idle_timeout");
    }, this.dependencies.config.idleTimeoutSeconds * 1_000);
    timer.unref?.();
    session.idleTimer = timer;
  }

  private endSession(session: VoiceChatSession, reason: string): void {
    if (!this.isCurrent(session) || session.ending) return;
    session.ending = true;
    this.sessions.delete(session.guildId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.connection.receiver.speaking.off("start", session.onSpeakingStart);
    session.player.stop(true);
    session.connection.destroy();
    session.turns.splice(0, session.turns.length);
    this.dependencies.logger.info(
      { guildId: session.guildId, voiceChannelId: session.voiceChannelId, reason },
      "voice chat session ended",
    );
  }

  private isCurrent(session: VoiceChatSession): boolean {
    return !session.ending && this.sessions.get(session.guildId) === session;
  }

  private async recordEvent(input: {
    session: VoiceChatSession;
    userId: string;
    model: string;
    kind: "voice_stt" | "voice_chat";
    success: boolean;
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
  }): Promise<void> {
    try {
      await this.dependencies.memory.recordAIEvent({
        guildId: input.session.guildId,
        channelId: input.session.controlChannelId,
        userId: input.userId,
        model: input.model,
        kind: input.kind,
        success: input.success,
        latencyMs: input.latencyMs,
        ...(input.promptTokens !== undefined
          ? { promptTokens: input.promptTokens }
          : {}),
        ...(input.completionTokens !== undefined
          ? { completionTokens: input.completionTokens }
          : {}),
      });
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, guildId: input.session.guildId, kind: input.kind },
        "could not record anonymous voice-chat event",
      );
    }
  }
}

export function limitVoiceChatReply(input: string, maximum: number): string {
  const normalized = input
    .replace(/[\r\n]+/g, " ")
    .replace(/[\t ]{2,}/g, " ")
    .replace(/[`*_#>]/g, "")
    .trim();
  if (normalized.length <= maximum) return normalized;
  const prefix = normalized.slice(0, maximum).trimEnd();
  const boundary = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
  );
  if (boundary >= Math.floor(maximum * 0.55)) return prefix.slice(0, boundary + 1);
  return `${prefix.slice(0, Math.max(1, maximum - 1)).trimEnd()}.`;
}

export function canCaptureVoiceChatUtterance(input: {
  sessionActive: boolean;
  sessionEnding: boolean;
  processing: boolean;
  userId: string;
  botUserId?: string;
}): boolean {
  return (
    input.sessionActive &&
    !input.sessionEnding &&
    !input.processing &&
    input.userId !== input.botUserId
  );
}

function waitForPlayerIdle(
  player: AudioPlayer,
  resource: ReturnType<typeof createAudioResource>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      player.stop(true);
      reject(new Error("voice chat playback timed out"));
    }, timeoutMs);
    timeout.unref?.();
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      player.removeListener("error", onError);
    };
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
    player.play(resource);
  });
}
