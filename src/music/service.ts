import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type VoiceBasedChannel,
} from "discord.js";
import {
  Connectors,
  LoadType,
  Shoukaku,
  type Player,
  type Track,
} from "shoukaku";
import type { AppConfig } from "../config.ts";
import type { Coordinator } from "../infra/coordinator.ts";
import type { Logger } from "../logger.ts";
import { formatMusicHistory, formatMusicQueue, musicTrackLabel } from "./format.ts";
import { MusicQueryError, musicIdentifier } from "./query.ts";
import { MusicQueueLimitError, MusicStore } from "./store.ts";
import type { QueuedMusicTrack, ResolvedMusicTrack } from "./types.ts";

class MusicUserError extends Error {}

interface MusicServiceDependencies {
  client: Client;
  config: AppConfig["music"];
  coordinator: Coordinator;
  store: MusicStore;
  logger: Logger;
}

export class MusicService {
  private readonly shoukaku?: Shoukaku;
  private readonly boundPlayers = new Set<string>();
  private readonly suppressedEndEvents = new Set<string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dependencies: MusicServiceDependencies) {
    if (!dependencies.config.enabled) return;
    if (!dependencies.config.lavalinkPassword) {
      throw new Error("LAVALINK_PASSWORD is required when MUSIC_ENABLED=true");
    }

    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(dependencies.client),
      [
        {
          name: "primary",
          url: dependencies.config.lavalinkUrl,
          auth: dependencies.config.lavalinkPassword,
          secure: dependencies.config.lavalinkSecure,
        },
      ],
      {
        reconnectTries: 12,
        reconnectInterval: 5_000,
        resume: true,
        resumeTimeout: 60,
        restTimeout: 15_000,
      },
    );
    this.shoukaku.on("ready", (name) => {
      dependencies.logger.info({ node: name }, "Lavalink music node ready");
    });
    this.shoukaku.on("error", (name, error) => {
      dependencies.logger.warn({ err: error, node: name }, "Lavalink music node error");
    });
    this.shoukaku.on("close", (name, code) => {
      dependencies.logger.warn({ node: name, code }, "Lavalink music node closed");
    });
  }

  get enabled(): boolean {
    return this.shoukaku !== undefined;
  }

  async start(): Promise<void> {
    if (!this.enabled) return;
    const recovered = await this.dependencies.store.recoverInterruptedPlayback();
    if (recovered > 0) {
      this.dependencies.logger.info({ recovered }, "requeued interrupted music playback");
    }
  }

  async stop(): Promise<void> {
    if (!this.shoukaku) return;
    const guildIds = [...this.shoukaku.players.keys()];
    await Promise.allSettled(guildIds.map((guildId) => this.shoukaku!.leaveVoiceChannel(guildId)));
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.boundPlayers.clear();
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.shoukaku) {
      await interaction.reply({
        content: "music is disabled here. set `MUSIC_ENABLED=true` and start the Lavalink profile.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "music only works in a server voice channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    try {
      const content = await this.dependencies.coordinator.withMusicLock(
        interaction.guildId,
        async () => await this.execute(interaction, interaction.guild!),
        10_000,
      );
      if (!content) throw new MusicUserError("another music command is already running—try that again in a second");
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, guildId: interaction.guildId, command: interaction.options.getSubcommand(false) },
        "music command failed",
      );
      const message = error instanceof MusicUserError || error instanceof MusicQueryError || error instanceof MusicQueueLimitError
        ? error.message
        : "music hit a wall. the queue is safe—try again in a moment.";
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
    }
  }

  private async execute(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    const command = interaction.options.getSubcommand(true);
    switch (command) {
      case "play":
        return await this.play(interaction, guild);
      case "queue":
        return formatMusicQueue(await this.dependencies.store.snapshot(guild.id));
      case "now":
        return this.nowPlaying(guild.id);
      case "history":
        return formatMusicHistory(await this.dependencies.store.history(guild.id));
      case "pause":
        return await this.pause(interaction, guild, true);
      case "resume":
        return await this.pause(interaction, guild, false);
      case "skip":
        return await this.skip(interaction, guild);
      case "stop":
        return await this.stopPlayback(interaction, guild);
      case "shuffle":
        return await this.shuffle(interaction, guild);
      case "remove":
        return await this.remove(interaction, guild);
      case "volume":
        return await this.setVolume(interaction, guild);
      case "seek":
        return await this.seek(interaction, guild);
      default:
        throw new MusicUserError("that music command is not wired up yet");
    }
  }

  private async play(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    const voice = await this.requireVoiceChannel(interaction, guild);
    const query = interaction.options.getString("query", true);
    const tracks = await this.resolve(query);
    const beforeEnqueue = await this.dependencies.store.snapshot(guild.id);
    const activeCount = beforeEnqueue.upcoming.length + (beforeEnqueue.current ? 1 : 0);
    if (activeCount + tracks.length > this.dependencies.config.maxQueueLength) {
      throw new MusicQueueLimitError(
        `queue is capped at ${this.dependencies.config.maxQueueLength} tracks`,
      );
    }
    const player = await this.ensurePlayer(guild, voice);
    const added = await this.dependencies.store.enqueue(
      guild.id,
      {
        userId: interaction.user.id,
        username: interaction.user.username,
        query,
      },
      tracks,
      this.dependencies.config.maxQueueLength,
    );

    const snapshot = await this.dependencies.store.snapshot(guild.id);
    const started = snapshot.current ? undefined : await this.playNext(player);
    if (added.length === 1) {
      return started
        ? `now playing ${musicTrackLabel(started)}`
        : `queued ${musicTrackLabel(added[0]!)}`;
    }
    return started
      ? `queued ${added.length} tracks and started ${musicTrackLabel(started)}`
      : `queued ${added.length} tracks`;
  }

  private async pause(
    interaction: ChatInputCommandInteraction,
    guild: Guild,
    paused: boolean,
  ): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const player = this.playerFor(guild.id);
    if (!player?.track) throw new MusicUserError("nothing is playing right now");
    await player.setPaused(paused);
    return paused ? "paused." : "back on.";
  }

  private async skip(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const player = this.playerFor(guild.id);
    if (!player?.track) throw new MusicUserError("nothing is playing right now");
    this.suppressEnd(guild.id);
    await player.stopTrack();
    await this.dependencies.store.finishCurrent(guild.id, "skipped");
    const next = await this.playNext(player);
    return next ? `skipped. now playing ${musicTrackLabel(next)}` : "skipped. queue is empty.";
  }

  private async stopPlayback(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const active = await this.dependencies.store.clear(guild.id);
    this.suppressEnd(guild.id);
    this.clearIdleTimer(guild.id);
    await this.shoukaku!.leaveVoiceChannel(guild.id);
    this.boundPlayers.delete(guild.id);
    return active > 0 ? "stopped, cleared the queue, and left voice." : "queue cleared and left voice.";
  }

  private async shuffle(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const count = await this.dependencies.store.shuffleUpcoming(guild.id);
    return count > 1 ? `shuffled ${count} queued tracks.` : "there aren't enough queued tracks to shuffle.";
  }

  private async remove(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const position = interaction.options.getInteger("position", true);
    const removed = await this.dependencies.store.removeUpcoming(guild.id, position);
    if (!removed) throw new MusicUserError(`there is no queued track at position ${position}`);
    return `removed ${musicTrackLabel(removed)}`;
  }

  private async setVolume(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const volume = interaction.options.getInteger("level", true);
    await this.dependencies.store.setVolume(guild.id, volume);
    const player = this.playerFor(guild.id);
    if (player) await player.setGlobalVolume(volume);
    return `volume set to ${volume}%.`;
  }

  private async seek(interaction: ChatInputCommandInteraction, guild: Guild): Promise<string> {
    await this.requireVoiceChannel(interaction, guild);
    const player = this.playerFor(guild.id);
    if (!player?.track) throw new MusicUserError("nothing is playing right now");
    const seconds = interaction.options.getInteger("seconds", true);
    await player.seekTo(seconds * 1_000);
    return `jumped to ${seconds}s.`;
  }

  private async nowPlaying(guildId: string): Promise<string> {
    const snapshot = await this.dependencies.store.snapshot(guildId);
    return snapshot.current
      ? `now playing ${musicTrackLabel(snapshot.current)} · volume ${snapshot.volume}%`
      : "nothing is playing right now.";
  }

  private async resolve(query: string): Promise<ResolvedMusicTrack[]> {
    const identifier = musicIdentifier(query);
    const node = this.readyNode();
    const resolved = await node.rest.resolve(identifier);
    if (!resolved || resolved.loadType === LoadType.EMPTY) {
      throw new MusicUserError("couldn't find anything for that");
    }
    if (resolved.loadType === LoadType.ERROR) {
      throw new MusicUserError("that source could not be loaded");
    }

    const tracks = resolved.loadType === LoadType.TRACK
      ? [resolved.data]
      : resolved.loadType === LoadType.PLAYLIST
        ? resolved.data.tracks.slice(0, this.dependencies.config.maxPlaylistTracks)
        : resolved.data.slice(0, 1);
    if (tracks.length === 0) throw new MusicUserError("that playlist has no playable tracks");
    return tracks.map(toResolvedTrack);
  }

  private async ensurePlayer(guild: Guild, voice: VoiceBasedChannel): Promise<Player> {
    const existing = this.playerFor(guild.id);
    const botChannelId = guild.members.me?.voice.channelId;
    if (botChannelId && botChannelId !== voice.id) {
      throw new MusicUserError("i'm already in a different voice channel");
    }
    if (existing) return existing;

    const player = await this.shoukaku!.joinVoiceChannel({
      guildId: guild.id,
      channelId: voice.id,
      shardId: guild.shardId,
      deaf: true,
    });
    this.bindPlayer(player);
    await player.setGlobalVolume(await this.dependencies.store.volume(guild.id));
    return player;
  }

  private async requireVoiceChannel(
    interaction: ChatInputCommandInteraction,
    guild: Guild,
  ): Promise<VoiceBasedChannel> {
    const member = await guild.members.fetch(interaction.user.id);
    const channel = member.voice.channel;
    if (!channel?.isVoiceBased()) {
      throw new MusicUserError("join a voice channel first");
    }
    const botChannelId = guild.members.me?.voice.channelId;
    if (botChannelId && botChannelId !== channel.id) {
      throw new MusicUserError("i'm already in a different voice channel");
    }
    return channel;
  }

  private async playNext(player: Player): Promise<QueuedMusicTrack | undefined> {
    this.clearIdleTimer(player.guildId);
    while (true) {
      const next = await this.dependencies.store.next(player.guildId);
      if (!next) {
        this.scheduleIdleLeave(player);
        return undefined;
      }
      try {
        await player.setGlobalVolume(await this.dependencies.store.volume(player.guildId));
        await player.playTrack({ track: { encoded: next.encodedTrack } });
        return next;
      } catch (error) {
        this.dependencies.logger.warn({ err: error, guildId: player.guildId }, "music track failed to start");
        await this.dependencies.store.finishCurrent(player.guildId, "failed");
      }
    }
  }

  private bindPlayer(player: Player): void {
    if (this.boundPlayers.has(player.guildId)) return;
    this.boundPlayers.add(player.guildId);
    player.on("end", (event) => {
      void this.onTrackEnd(player, event.track.encoded, event.reason).catch((error) => {
        this.dependencies.logger.error(
          { err: error, guildId: player.guildId },
          "failed to advance music queue after a track ended",
        );
      });
    });
    player.on("stuck", (event) => {
      this.dependencies.logger.warn({ guildId: player.guildId, thresholdMs: event.thresholdMs }, "music track stuck");
    });
    player.on("exception", (event) => {
      this.dependencies.logger.warn({ guildId: player.guildId, err: event.exception }, "music track exception");
    });
    player.on("closed", (event) => {
      this.dependencies.logger.warn({ guildId: player.guildId, code: event.code }, "music voice websocket closed");
    });
  }

  private async onTrackEnd(player: Player, endedTrack: string, reason: string): Promise<void> {
    if (this.suppressedEndEvents.delete(player.guildId) || reason === "replaced") return;
    const advanced = await this.dependencies.coordinator.withMusicLock(
      player.guildId,
      async () => {
        const current = (await this.dependencies.store.snapshot(player.guildId)).current;
        if (!current || current.encodedTrack !== endedTrack) {
          this.dependencies.logger.debug(
            { guildId: player.guildId, reason },
            "ignored stale music track-end event",
          );
          return true;
        }
        await this.dependencies.store.finishCurrent(
          player.guildId,
          reason === "finished" ? "played" : reason === "loadFailed" ? "failed" : "skipped",
        );
        await this.playNext(player);
        return true;
      },
      30_000,
    );
    if (!advanced) {
      this.dependencies.logger.warn({ guildId: player.guildId }, "could not acquire music lock to advance queue");
    }
  }

  private readyNode() {
    const node = this.shoukaku?.getIdealNode();
    if (!node || node.state !== 1) {
      throw new MusicUserError("the music node is still waking up—try again in a few seconds");
    }
    return node;
  }

  private playerFor(guildId: string): Player | undefined {
    return this.shoukaku?.players.get(guildId);
  }

  private scheduleIdleLeave(player: Player): void {
    this.clearIdleTimer(player.guildId);
    const timer = setTimeout(() => {
      void this.dependencies.coordinator
        .withMusicLock(player.guildId, async () => {
          const snapshot = await this.dependencies.store.snapshot(player.guildId);
          if (snapshot.current || snapshot.upcoming.length > 0) return;
          this.suppressEnd(player.guildId);
          await this.shoukaku?.leaveVoiceChannel(player.guildId);
          this.boundPlayers.delete(player.guildId);
        })
        .catch((error) => {
          this.dependencies.logger.warn(
            { err: error, guildId: player.guildId },
            "failed to leave an idle music voice channel",
          );
        });
    }, this.dependencies.config.idleTimeoutSeconds * 1_000);
    timer.unref?.();
    this.idleTimers.set(player.guildId, timer);
  }

  private clearIdleTimer(guildId: string): void {
    const timer = this.idleTimers.get(guildId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(guildId);
  }

  private suppressEnd(guildId: string): void {
    this.suppressedEndEvents.add(guildId);
    const timer = setTimeout(() => this.suppressedEndEvents.delete(guildId), 5_000);
    timer.unref?.();
  }
}

function toResolvedTrack(track: Track): ResolvedMusicTrack {
  return {
    encodedTrack: track.encoded,
    title: track.info.title || "untitled track",
    author: track.info.author || "unknown artist",
    ...(track.info.uri ? { uri: track.info.uri } : {}),
    ...(track.info.artworkUrl ? { artworkUrl: track.info.artworkUrl } : {}),
    durationMs: Number(track.info.length) || 0,
  };
}
