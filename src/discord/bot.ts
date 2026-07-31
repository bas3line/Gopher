import {
  ActivityType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type ThreadChannel,
  type User,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import {
  AIProviderError,
  type AgentCompletionClient,
  type CompletionClient,
} from "../ai/client.ts";
import { AgentLoop, AgentLoopError } from "../agent/loop.ts";
import type {
  AgentRequestContext,
  DiscordAgentAdapter,
} from "../agent/context.ts";
import { createAgentTools } from "../agent/tools.ts";
import {
  buildAmbientMessages,
  buildAnswerMessages,
  compactSummaryOutput,
  buildSummaryMessages,
  isAmbientSkip,
} from "../ai/prompts.ts";
import type { Logger } from "../logger.ts";
import { MemoryStore } from "../memory/store.ts";
import { MusicService } from "../music/service.ts";
import { MusicStore } from "../music/store.ts";
import { parseMusicTextCommand, type TextMusicCommand } from "../music/query.ts";
import { Coordinator, Semaphore } from "../infra/coordinator.ts";
import type { WebSource } from "../types.ts";
import { WebResearch, WebResearchError } from "../web/firecrawl.ts";
import { aboutText, commandData } from "./commands.ts";
import {
  parseReactionRequest,
  shouldReactWithTuff,
  tuffEmoji,
  type ReactionRequest,
} from "./banter.ts";
import {
  buildServerEmojiCatalog,
  customEmojiImageUrls,
  type ServerEmoji,
} from "./emojis.ts";
import {
  casualizeReply,
  quickCasualReply,
  splitDiscordMessage,
  withSources,
} from "./format.ts";
import { renderEngineerCard } from "./images.ts";
import { ServerModeration } from "./moderation.ts";
import {
  buildConversationRetrievalQuery,
  decideConversationContext,
  decideResponse,
  isAnswerRequest,
  isTechnicalRequest,
  needsWebSearch,
  stripBotMention,
  voiceCapabilityStatusReply,
  wantsImageCard,
  wantsVoiceReply,
} from "./router.ts";
import type {
  SynthesizedVoiceMessage,
  VoiceSynthesizer,
} from "../voice/fish-audio.ts";
import { VoiceChatService } from "../voice/chat.ts";
import { CloudflareWhisper } from "../voice/cloudflare-whisper.ts";
import { DiscordJsAgentAdapter } from "./agent-adapter.ts";
import { containsSecret } from "../memory/extractor.ts";
import {
  memoryKindSchema,
  memoryScopeSchema,
} from "../memory/types.ts";

interface AnswerInput {
  discordMessageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  question: string;
  imageUrls: string[];
  forceWebSearch: boolean;
  forceCard: boolean;
  forceVoice: boolean;
  ambient: boolean;
  forceRecentContext: boolean;
  isOwner: boolean;
  isAdministrator: boolean;
  discordAdapter: DiscordAgentAdapter;
}

interface AnswerOutput {
  text: string;
  rawAnswer: string;
  sources: WebSource[];
  card?: Buffer;
  voice?: SynthesizedVoiceMessage;
}

export class DiscordBot {
  private readonly client: Client;
  private readonly moderation: ServerModeration;
  private readonly semaphore: Semaphore;
  private music: MusicService | undefined;
  private readonly voiceChat: VoiceChatService;

  constructor(
    private readonly dependencies: {
      config: AppConfig;
      textAI: AgentCompletionClient;
      summaryAI: CompletionClient;
      visionAI: CompletionClient;
      memory: MemoryStore;
      musicStore: MusicStore;
      coordinator: Coordinator;
      web: WebResearch;
      voice: VoiceSynthesizer;
      voiceChatStt: CloudflareWhisper;
      voiceChatVoice: VoiceSynthesizer;
      logger: Logger;
    },
  ) {
    this.semaphore = new Semaphore(dependencies.config.maxConcurrentAIRequests);
    this.moderation = new ServerModeration(
      dependencies.coordinator,
      dependencies.logger,
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
        Partials.User,
      ],
      allowedMentions: { parse: [], repliedUser: false },
      presence: {
        status: "online",
        activities: [
          { type: ActivityType.Watching, name: "the gc do unpaid labour" },
        ],
      },
    });
    try {
      // Shoukaku's Discord.js connector subscribes to clientReady itself, so it
      // must exist before login rather than being created from the ready handler.
      this.music = new MusicService({
        client: this.client,
        config: this.dependencies.config.music,
        coordinator: this.dependencies.coordinator,
        store: this.dependencies.musicStore,
        logger: this.dependencies.logger,
      });
    } catch (error) {
      this.dependencies.logger.error({ err: error }, "failed to configure music service");
    }
    this.voiceChat = new VoiceChatService({
      client: this.client,
      config: this.dependencies.config.voiceChat,
      stt: this.dependencies.voiceChatStt,
      synthesizer: this.dependencies.voiceChatVoice,
      complete: async (messages) =>
        await this.semaphore.use(async () =>
          await this.dependencies.textAI.complete(
            messages,
            this.dependencies.config.text.model,
          ),
        ),
      textModel: this.dependencies.config.text.model,
      sttModel: this.dependencies.config.cloudflare.sttModel,
      memory: this.dependencies.memory,
      coordinator: this.dependencies.coordinator,
      maxUserRequestsPerMinute:
        this.dependencies.config.maxUserRequestsPerMinute,
      releaseMusic: async (guildId) => {
        await this.music?.releaseForVoiceChat(guildId);
      },
      logger: this.dependencies.logger,
    });
  }

  get ready(): boolean {
    return this.client.isReady();
  }

  async start(token: string): Promise<void> {
    this.client.once(Events.ClientReady, async (readyClient) => {
      this.dependencies.logger.info(
        {
          botUser: readyClient.user.tag,
          guilds: readyClient.guilds.cache.size,
        },
        "Discord bot ready",
      );
      if (this.music) {
        try {
          await this.music.start();
        } catch (error) {
          await this.music.stop();
          this.music = undefined;
          this.dependencies.logger.error({ err: error }, "failed to start music service");
        }
      }
      try {
        await this.registerCommands();
      } catch (error) {
        this.dependencies.logger.error(
          { err: error },
          "failed to register Discord commands",
        );
      }
      await this.refreshServerEmojis(readyClient.guilds.cache.values());
    });
    this.client.on(Events.GuildCreate, (guild) => {
      void this.registerGuildCommands(guild).catch((error) => {
        this.dependencies.logger.error(
          { err: error, guildId: guild.id },
          "failed to register commands in a new guild",
        );
      });
      void this.refreshServerEmojis([guild]);
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });
    this.client.on(Events.MessageUpdate, (_previous, updated) => {
      void (async () => {
        const message = updated.partial ? await updated.fetch() : updated;
        await this.handleMessageUpdate(message);
      })().catch((error) => {
        this.dependencies.logger.warn(
          { err: error, messageId: updated.id },
          "failed to record Discord message edit",
        );
      });
    });
    this.client.on(Events.MessageDelete, (message) => {
      void this.handleMessageDelete(message).catch((error) => {
        this.dependencies.logger.warn(
          { err: error, messageId: message.id },
          "failed to record Discord message deletion",
        );
      });
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.handleReactionEvent("add", reaction, user).catch((error) => {
        this.dependencies.logger.debug(
          { err: error, messageId: reaction.message.id },
          "failed to record Discord reaction addition",
        );
      });
    });
    this.client.on(Events.MessageReactionRemove, (reaction, user) => {
      void this.handleReactionEvent("remove", reaction, user).catch((error) => {
        this.dependencies.logger.debug(
          { err: error, messageId: reaction.message.id },
          "failed to record Discord reaction removal",
        );
      });
    });
    this.client.on(Events.ThreadCreate, (thread) => {
      void this.handleThreadEvent("create", thread).catch((error) => {
        this.dependencies.logger.debug(
          { err: error, threadId: thread.id },
          "failed to record Discord thread creation",
        );
      });
    });
    this.client.on(Events.ThreadUpdate, (_previous, updated) => {
      void this.handleThreadEvent("update", updated).catch((error) => {
        this.dependencies.logger.debug(
          { err: error, threadId: updated.id },
          "failed to record Discord thread update",
        );
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch((error) => {
        this.dependencies.logger.error(
          { err: error, interactionId: interaction.id },
          "unhandled Discord interaction failure",
        );
        if (
          interaction.isRepliable() &&
          !interaction.replied &&
          !interaction.deferred
        ) {
          void interaction
            .reply({
              content:
                "something broke before Discord accepted that. nothing was changed.",
              flags: MessageFlags.Ephemeral,
              allowedMentions: { parse: [] },
            })
            .catch((replyError) => {
              this.dependencies.logger.error(
                { err: replyError, interactionId: interaction.id },
                "failed to send Discord interaction error",
              );
            });
        }
      });
    });
    this.client.on(Events.Error, (error) => {
      this.dependencies.logger.error({ err: error }, "Discord client error");
    });
    this.client.on(Events.Warn, (warning) => {
      this.dependencies.logger.warn({ warning }, "Discord client warning");
    });

    await this.client.login(token);
  }

  async stop(): Promise<void> {
    await this.voiceChat.stop();
    await this.music?.stop();
    this.client.destroy();
  }

  private async registerCommands(): Promise<void> {
    if (!this.client.application)
      throw new Error("Discord application is not ready");

    // Keep a single command scope. Publishing the same names globally and per
    // guild makes Discord clients show duplicate command entries.
    await this.client.application.commands.set([]);

    const guildIds = new Set(this.client.guilds.cache.keys());
    if (this.dependencies.config.discordGuildId) {
      guildIds.add(this.dependencies.config.discordGuildId);
    }
    const results = await Promise.allSettled(
      [...guildIds].map(async (guildId) => {
        const guild = await this.client.guilds.fetch(guildId);
        await this.registerGuildCommands(guild);
        return guildId;
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    this.dependencies.logger.info(
      {
        globalCommandsCleared: true,
        guilds: results.length - failures.length,
        failedGuilds: failures.length,
      },
      "refreshed Discord commands once per connected guild",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `failed to refresh commands in ${failures.length} guild(s)`,
      );
    }
  }

  private async registerGuildCommands(guild: Guild): Promise<void> {
    await guild.commands.set(commandData);
    this.dependencies.logger.debug(
      { guildId: guild.id },
      "refreshed guild Discord commands",
    );
  }

  private async handleMessageUpdate(message: Message): Promise<void> {
    if (message.webhookId || !message.author) return;
    const guildId = message.guildId ?? `dm:${message.author.id}`;
    const content =
      this.client.user
        ? stripBotMention(message.content, this.client.user.id)
        : message.content.trim();
    await this.dependencies.memory.recordMessageEdit({
      discordMessageId: message.id,
      guildId,
      channelId: message.channelId,
      actorUserId: message.author.id,
      replacementContent: content || "[non-text message]",
      editedAt: message.editedAt ?? new Date(),
    });
  }

  private async handleMessageDelete(
    message: Message | PartialMessage,
  ): Promise<void> {
    const authorId = message.author?.id;
    const guildId =
      message.guildId ?? `dm:${authorId ?? `channel:${message.channelId}`}`;
    const deletedAt = new Date();
    const recorded = await this.dependencies.memory.recordMessageDeletion({
      discordMessageId: message.id,
      guildId,
      channelId: message.channelId,
      ...(authorId ? { actorUserId: authorId } : {}),
      deletedAt,
    });
    if (!recorded) {
      await this.dependencies.memory.recordDiscordEvent({
        eventKey: `message:delete:${message.id}`,
        guildId,
        channelId: message.channelId,
        ...(authorId ? { actorUserId: authorId } : {}),
        eventType: "message_delete",
        payload: { discordMessageId: message.id, messageWasNotInMemory: true },
        occurredAt: deletedAt,
      });
    }
  }

  private async handleReactionEvent(
    action: "add" | "remove",
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    const hydratedReaction = reaction.partial
      ? await reaction.fetch()
      : reaction;
    const hydratedUser = user.partial ? await user.fetch() : user;
    const message = hydratedReaction.message;
    const guildId =
      message.guildId ?? `dm:${hydratedUser.id}`;
    const emoji =
      hydratedReaction.emoji.id && hydratedReaction.emoji.name
        ? `<${hydratedReaction.emoji.animated ? "a" : ""}:${hydratedReaction.emoji.name}:${hydratedReaction.emoji.id}>`
        : (hydratedReaction.emoji.name ?? "unknown");
    await this.dependencies.memory.recordDiscordEvent({
      eventKey: `reaction:${action}:${message.id}:${hydratedReaction.emoji.identifier}:${hydratedUser.id}`,
      guildId,
      channelId: message.channelId,
      actorUserId: hydratedUser.id,
      eventType: action === "add" ? "reaction_add" : "reaction_remove",
      payload: { discordMessageId: message.id, emoji },
      occurredAt: new Date(),
    });
  }

  private async handleThreadEvent(
    action: "create" | "update",
    thread: ThreadChannel,
  ): Promise<void> {
    await this.dependencies.memory.recordDiscordEvent({
      eventKey:
        action === "create"
          ? `thread:create:${thread.id}`
          : `thread:update:${thread.id}:${thread.archived ? "archived" : "active"}:${thread.locked ? "locked" : "unlocked"}:${thread.name}`,
      guildId: thread.guildId,
      channelId: thread.id,
      eventType: action === "create" ? "thread_create" : "thread_update",
      payload: {
        threadId: thread.id,
        parentId: thread.parentId,
        name: thread.name,
        archived: thread.archived,
        locked: thread.locked,
      },
      occurredAt:
        action === "create" ? (thread.createdAt ?? new Date()) : new Date(),
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || message.webhookId || !this.client.user) return;

    try {
      const firstSeen = await this.dependencies.coordinator.markMessageSeen(
        message.id,
      );
      if (!firstSeen) return;

      const guildId = message.guildId ?? `dm:${message.author.id}`;
      const username =
        message.member?.displayName ??
        message.author.globalName ??
        message.author.username;
      const attachments = [...message.attachments.values()].map(
        (attachment) => ({
          url: attachment.url,
          name: attachment.name,
          ...(attachment.contentType
            ? { contentType: attachment.contentType }
            : {}),
        }),
      );
      const imageUrls = attachments
        .filter((attachment) => attachment.contentType?.startsWith("image/"))
        .map((attachment) => attachment.url);
      const cleanContent =
        stripBotMention(message.content, this.client.user.id) ||
        (imageUrls.length > 0
          ? "Inspect the attached image."
          : "[non-text message]");

      await this.dependencies.memory.recordMessage({
        discordMessageId: message.id,
        guildId,
        channelId: message.channelId,
        userId: message.author.id,
        username,
        role: "user",
        content: cleanContent,
        attachments,
        ...(message.reference?.messageId
          ? { replyToDiscordMessageId: message.reference.messageId }
          : {}),
        createdAt: message.createdAt,
      });

      if (message.guildId && shouldReactWithTuff(cleanContent)) {
        await message.react(tuffEmoji).catch((error) => {
          this.dependencies.logger.debug(
            { err: error, messageId: message.id, emoji: "tuff" },
            "could not add tuff reaction",
          );
        });
      }

      if (await this.moderation.beginFromMessage(message, cleanContent)) return;

      const isReplyToBot = await this.isReplyToBot(message);
      const isOwner = this.dependencies.config.ownerUserIds.includes(
        message.author.id,
      );
      const decision = decideResponse({
        content: cleanContent,
        mode: this.dependencies.config.interactionMode,
        isDirectMessage: !message.guildId,
        isMentioned: message.mentions.has(this.client.user),
        isReplyToBot,
        isOwner,
        mentionsOtherRecipients:
          message.mentions.users.some(
            (user) => user.id !== this.client.user?.id,
          ) ||
          message.mentions.roles.size > 0 ||
          message.mentions.everyone,
        hasImage: imageUrls.length > 0,
        ambientReplyChance: this.dependencies.config.ambientReplyChance,
      });
      if (decision === "ignore") return;

      const ambient = decision === "ambient";
      if (ambient) {
        const canEvaluate =
          await this.dependencies.coordinator.claimAmbientEvaluation(
            message.channelId,
            this.dependencies.config.ambientEvaluationCooldownSeconds,
          );
        if (!canEvaluate) return;
      } else {
        const withinLimit =
          await this.dependencies.coordinator.consumeUserRequest(
            message.author.id,
            this.dependencies.config.maxUserRequestsPerMinute,
          );
        if (!withinLimit) {
          await message.reply({
            content: "slow down bro, rate limit",
            allowedMentions: { parse: [], repliedUser: false },
          });
          return;
        }
      }

      const serverEmojis = this.serverEmojis(guildId);
      const reactionRequest = parseReactionRequest(cleanContent, serverEmojis);
      if (reactionRequest) {
        await this.executeReactionRequest(message, reactionRequest, guildId);
        return;
      }

      const musicCommand = !ambient && message.guild
        ? parseMusicTextCommand(cleanContent)
        : undefined;
      if (musicCommand) {
        await this.handleTextMusicCommand(message, guildId, username, musicCommand);
        return;
      }

      const result = await this.dependencies.coordinator.withChannelLock(
        message.channelId,
        async () => {
          const answer = await this.answer({
            discordMessageId: message.id,
            guildId,
            channelId: message.channelId,
            userId: message.author.id,
            username,
            question: cleanContent,
            imageUrls: [
              ...imageUrls,
              ...customEmojiImageUrls(cleanContent, serverEmojis),
            ].slice(0, 4),
            forceWebSearch: false,
            forceCard: false,
            forceVoice: wantsVoiceReply(cleanContent),
            ambient,
            forceRecentContext: isReplyToBot || !message.guildId,
            isOwner,
            isAdministrator:
              message.member?.permissions.has(
                PermissionFlagsBits.Administrator,
              ) ?? false,
            discordAdapter: new DiscordJsAgentAdapter({
              client: this.client,
              ...(message.guildId ? { guildId: message.guildId } : {}),
              channelId: message.channelId,
              requesterUserId: message.author.id,
              triggerMessageId: message.id,
            }),
          });
          if (!answer) return false;
          const sent = await this.sendMessageAnswer(message, answer);
          await this.dependencies.memory.recordMessage({
            discordMessageId: sent.id,
            guildId,
            channelId: message.channelId,
            userId: this.client.user?.id ?? "bot",
            username: this.client.user?.username ?? "Gopher",
            role: "assistant",
            content: answer.rawAnswer,
            replyToDiscordMessageId: message.id,
            createdAt: sent.createdAt,
          });
          await this.maybeSummarize(guildId, message.channelId);
          return true;
        },
        ambient ? 0 : 60_000,
      );
      if (result === undefined && !ambient) {
        await message.reply({
          content: "busy rn, say that again",
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    } catch (error) {
      this.dependencies.logger.error(
        { err: error, messageId: message.id, channelId: message.channelId },
        "failed to handle Discord message",
      );
      await this.sendUserFacingError(message, error);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.moderation.handleButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "server") {
      await this.moderation.begin(interaction);
      return;
    }
    if (interaction.commandName === "about") {
      await interaction.reply({
        content: aboutText,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (interaction.commandName === "voicechat") {
      await this.voiceChat.handle(interaction);
      return;
    }
    if (interaction.commandName === "music") {
      if (interaction.guildId && this.voiceChat.hasActiveSession(interaction.guildId)) {
        await interaction.reply({
          content: "live voice chat owns the VC right now. use `/voicechat leave` before music commands.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (!this.music) {
        await interaction.reply({
          content: "music is unavailable right now—try again in a moment.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await this.music.handle(interaction);
      return;
    }

    const guildId = interaction.guildId ?? `dm:${interaction.user.id}`;
    if (interaction.commandName === "memory") {
      await this.handleMemoryInteraction(interaction, guildId);
      return;
    }

    await interaction.deferReply();
    try {
      const withinLimit =
        await this.dependencies.coordinator.consumeUserRequest(
          interaction.user.id,
          this.dependencies.config.maxUserRequestsPerMinute,
        );
      if (!withinLimit) {
        await interaction.editReply("slow down bro, rate limit");
        return;
      }

      const optionName =
        interaction.commandName === "search" ? "query" : "prompt";
      const question = interaction.options.getString(optionName, true);
      const username =
        interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : (interaction.user.globalName ?? interaction.user.username);

      await this.dependencies.memory.recordMessage({
        discordMessageId: `interaction:${interaction.id}`,
        guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        username,
        role: "user",
        content: question,
        createdAt: interaction.createdAt,
      });

      const result = await this.dependencies.coordinator.withChannelLock(
        interaction.channelId,
        async () => {
          const answer = await this.answer({
            discordMessageId: `interaction:${interaction.id}`,
            guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            username,
            question,
            imageUrls: customEmojiImageUrls(
              question,
              this.serverEmojis(guildId),
            ),
            forceWebSearch: interaction.commandName === "search",
            forceCard: interaction.commandName === "card",
            forceVoice:
              interaction.commandName === "voice" || wantsVoiceReply(question),
            ambient: false,
            forceRecentContext: false,
            isOwner: this.dependencies.config.ownerUserIds.includes(
              interaction.user.id,
            ),
            isAdministrator:
              interaction.memberPermissions?.has(
                PermissionFlagsBits.Administrator,
              ) ?? false,
            discordAdapter: new DiscordJsAgentAdapter({
              client: this.client,
              ...(interaction.guildId
                ? { guildId: interaction.guildId }
                : {}),
              channelId: interaction.channelId,
              requesterUserId: interaction.user.id,
            }),
          });
          if (!answer)
            throw new Error(
              "direct interaction unexpectedly produced no answer",
            );
          const sentId = await this.sendInteractionAnswer(interaction, answer);
          await this.dependencies.memory.recordMessage({
            discordMessageId: sentId,
            guildId,
            channelId: interaction.channelId,
            userId: this.client.user?.id ?? "bot",
            username: this.client.user?.username ?? "Gopher",
            role: "assistant",
            content: answer.rawAnswer,
            createdAt: new Date(),
          });
          await this.maybeSummarize(guildId, interaction.channelId);
          return true;
        },
        60_000,
      );

      if (result === undefined) {
        await interaction.editReply("busy rn, try again");
      }
    } catch (error) {
      this.dependencies.logger.error(
        {
          err: error,
          interactionId: interaction.id,
          command: interaction.commandName,
        },
        "failed to handle Discord interaction",
      );
      await interaction.editReply(this.userFacingError(error));
    }
  }

  private async handleMemoryInteraction(
    interaction: ChatInputCommandInteraction,
    guildId: string,
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const isOwner = this.dependencies.config.ownerUserIds.includes(
      interaction.user.id,
    );
    const isAdministrator =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
      false;

    if (subcommand === "status") {
      const [summary, overview] = await Promise.all([
        this.dependencies.memory.summary(guildId, interaction.channelId),
        this.dependencies.memory.memoryOverview({
          guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
        }),
      ]);
      await interaction.reply({
        content:
          `**memory status**\n` +
          `typed memories: ${overview.total} (${overview.user} yours, ${overview.channel} channel, ${overview.guild} server)\n` +
          `pending consolidation jobs: ${overview.pendingIngestion}\n` +
          `rolling channel summary: ${summary ? `updated ${summary.updatedAt.toISOString()}` : "not built yet"}\n\n` +
          (summary
            ? summary.summary.slice(0, 1_350)
            : "Raw message history is still retained and searchable while consolidation catches up."),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "search") {
      const query = interaction.options.getString("query", true);
      const memories = await this.dependencies.memory.recall({
        guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        query,
        limit: 10,
      });
      const content =
        memories.length === 0
          ? "no durable memory matched that query."
          : memories
              .map(
                (memory) =>
                  `**#${memory.id} · ${memory.kind} · ${memory.scope} · ${(memory.confidence * 100).toFixed(0)}%**\n${memory.content.slice(0, 500)}`,
              )
              .join("\n\n")
              .slice(0, 1_950);
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "remember") {
      const scope = memoryScopeSchema.parse(
        interaction.options.getString("scope") ?? "user",
      );
      if (
        scope !== "user" &&
        !isOwner &&
        !isAdministrator
      ) {
        await interaction.reply({
          content:
            "channel/server memory writes need a bot owner or server administrator.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const content = interaction.options.getString("content", true);
      if (containsSecret(content)) {
        await interaction.reply({
          content:
            "i won't put credentials or authentication material into durable memory.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const evidenceMessageId = `interaction:${interaction.id}`;
      await this.dependencies.memory.recordMessage({
        discordMessageId: evidenceMessageId,
        guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        username:
          interaction.user.globalName ?? interaction.user.username,
        role: "user",
        content: `[explicit memory request] ${content}`,
        createdAt: interaction.createdAt,
      });
      const saved = await this.dependencies.memory.upsertMemories({
        guildId,
        channelId: interaction.channelId,
        source: "explicit",
        candidates: [
          {
            scope,
            ...(scope === "user"
              ? { subjectUserId: interaction.user.id }
              : {}),
            kind: memoryKindSchema.parse(
              interaction.options.getString("kind", true),
            ),
            key: interaction.options.getString("key", true),
            content,
            importance: 8,
            confidence: 1,
            evidenceMessageIds: [evidenceMessageId],
            reason: "Saved through the explicit /memory remember command.",
          },
        ],
      });
      const memory = saved[0];
      await interaction.reply({
        content: memory
          ? `remembered as **#${memory.id} · ${memory.key}** (revision ${memory.version}).`
          : "nothing was saved.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const memoryId = interaction.options.getInteger("memory_id", true);
    const forgotten = await this.dependencies.memory.forgetMemory({
      id: memoryId,
      guildId,
      requesterUserId: interaction.user.id,
      allowGuildScope: isOwner || isAdministrator,
      reason: `Forgotten through /memory by Discord user ${interaction.user.id}`,
    });
    await interaction.reply({
      content: forgotten
        ? `forgot memory **#${memoryId}**. its revision audit remains, but it will not be recalled.`
        : "that memory does not exist or you cannot forget it.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  private async handleTextMusicCommand(
    message: Message,
    guildId: string,
    username: string,
    command: TextMusicCommand,
  ): Promise<void> {
    const guild = message.guild;
    if (!guild) return;

    const content = this.voiceChat.hasActiveSession(guildId)
      ? "live voice chat owns the VC right now. use `/voicechat leave` before music commands."
      : this.music
        ? await this.music.handleTextCommand({
            guild,
            userId: message.author.id,
            username,
            command,
          })
        : "music is unavailable right now—try again in a moment.";
    const sent = await message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
    });
    await this.dependencies.memory.recordMessage({
      discordMessageId: sent.id,
      guildId,
      channelId: message.channelId,
      userId: this.client.user?.id ?? "bot",
      username: this.client.user?.username ?? "Gopher",
      role: "assistant",
      content,
      replyToDiscordMessageId: message.id,
      createdAt: sent.createdAt,
    });
    await this.maybeSummarize(guildId, message.channelId);
  }

  private async answer(input: AnswerInput): Promise<AnswerOutput | undefined> {
    const { config, memory, web, textAI, visionAI } = this.dependencies;
    const useVision = input.imageUrls.length > 0;
    const serverEmojis = this.serverEmojis(input.guildId);
    const voiceCapabilityReply = voiceCapabilityStatusReply(input.question, {
      nativeVoiceEnabled: this.dependencies.voice.enabled,
      liveVoiceChatEnabled:
        config.voiceChat.enabled &&
        this.dependencies.voiceChatStt.enabled &&
        this.dependencies.voiceChatVoice.enabled,
      liveVoiceChatActive:
        !input.guildId.startsWith("dm:") && this.voiceChat.hasActiveSession(input.guildId),
    });
    if (voiceCapabilityReply) {
      return await this.withVoice(input, {
        text: voiceCapabilityReply,
        rawAnswer: voiceCapabilityReply,
        sources: [],
      });
    }
    const quickReply =
      !input.ambient &&
      !useVision &&
      !input.forceWebSearch &&
      !input.forceCard &&
      !isTechnicalRequest(input.question)
        ? quickCasualReply(input.question)
        : undefined;
    if (quickReply) {
      return await this.withVoice(input, {
        text: quickReply,
        rawAnswer: quickReply,
        sources: [],
      });
    }
    if (
      useVision &&
      !(await this.dependencies.coordinator.consumeVisionRequest(
        config.maxVisionRequestsPerMinute,
      ))
    ) {
      throw new Error(
        "Vision limit reached for this minute. Try the image again shortly.",
      );
    }

    const useAgent = config.agent.enabled && !input.ambient && !useVision;
    const shouldSearch =
      !useAgent &&
      !input.ambient &&
      (input.forceWebSearch || needsWebSearch(input.question));
    const casual =
      !shouldSearch &&
      !input.forceWebSearch &&
      !useVision &&
      !input.forceCard &&
      !isAnswerRequest(input.question) &&
      !isTechnicalRequest(input.question) &&
      input.question.length <= 240;
    const contextMode = decideConversationContext({
      ambient: input.ambient,
      casual,
      forceRecent: input.forceRecentContext,
      content: input.question,
    });
    const sources = shouldSearch ? await web.search(input.question) : [];
    if (sources.length > 0) {
      await memory.saveWebSources(input.question, sources).catch((error) => {
        this.dependencies.logger.warn(
          { err: error },
          "failed to cache web sources",
        );
      });
    }

    const recentLimit =
      contextMode === "none"
        ? 0
        : contextMode === "full"
          ? config.recentMessageCount
          : 9;
    const recent =
      recentLimit > 0
        ? await memory.recent(input.guildId, input.channelId, recentLimit)
        : [];
    const recentWithoutCurrent = recent.filter(
      (message) => message.discordMessageId !== input.discordMessageId,
    );
    const retrievalQuery = buildConversationRetrievalQuery(
      input.question,
      recentWithoutCurrent
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    );
    const loadLongTermContext =
      contextMode === "full" || (useAgent && !casual);
    const [summary, relevant, memoryPack] = loadLongTermContext
      ? await Promise.all([
          memory.summary(input.guildId, input.channelId),
          memory.relevant(
            input.guildId,
            input.channelId,
            retrievalQuery,
            config.ragResultCount,
          ),
          memory.contextPack({
            guildId: input.guildId,
            channelId: input.channelId,
            userId: input.userId,
            query: retrievalQuery,
            limit: config.memory.recallCount,
          }),
        ])
      : [undefined, [], undefined];
    const model = useVision ? config.openAI.visionModel : config.text.model;
    const completionClient = useVision ? visionAI : textAI;
    const kind = useVision ? "vision" : useAgent ? "agent" : "chat";
    const startedAt = performance.now();

    try {
      const promptMessages =
        input.ambient && !useVision
          ? buildAmbientMessages({
              username: input.username,
              question: input.question,
              recent: recentWithoutCurrent,
              serverEmojis,
            })
          : buildAnswerMessages({
              username: input.username,
              question: input.question,
              ...(summary ? { summary: summary.summary } : {}),
              recent: recentWithoutCurrent,
              relevant,
              webSources: sources,
              ...(memoryPack?.durable.length
                ? { durableMemories: memoryPack.durable }
                : {}),
              ...(memoryPack?.commitments.length
                ? { pendingCommitments: memoryPack.commitments }
                : {}),
              serverEmojis,
              isOwner: input.isOwner,
              ...(useVision ? { imageUrls: input.imageUrls } : {}),
              runtimeCapabilities: {
                nativeVoiceEnabled: this.dependencies.voice.enabled,
                liveVoiceChatEnabled:
                  config.voiceChat.enabled &&
                  this.dependencies.voiceChatStt.enabled &&
                  this.dependencies.voiceChatVoice.enabled,
                liveVoiceChatActive:
                  !input.guildId.startsWith("dm:") &&
                  this.voiceChat.hasActiveSession(input.guildId),
                musicEnabled: this.music?.enabled ?? false,
              },
              ...(useAgent
                ? {
                    agentRuntime: {
                      enabled: true,
                      currentDate: new Date().toISOString().slice(0, 10),
                      webEnabled: web.enabled,
                      discordActionsEnabled:
                        config.agent.discordActionsEnabled,
                      forceWebSearch: input.forceWebSearch,
                    },
                  }
                : {}),
            });
      let completion;
      if (useAgent) {
        const runId = randomUUID();
        let observedIterations = 0;
        let observedToolCalls = 0;
        let observedPromptTokens = 0;
        let observedCompletionTokens = 0;
        await memory.startAgentRun({
          id: runId,
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.userId,
          discordMessageId: input.discordMessageId,
          model,
        });
        const agentContext: AgentRequestContext = {
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.userId,
          username: input.username,
          requestText: input.question,
          discordMessageId: input.discordMessageId,
          isOwner: input.isOwner,
          isAdministrator: input.isAdministrator,
          isDirectMessage: input.guildId.startsWith("dm:"),
          discordActionsEnabled: config.agent.discordActionsEnabled,
          memory,
          web,
          discord: input.discordAdapter,
          collectedWebSources: sources,
        };
        const agent = new AgentLoop({
          client: {
            complete: async (messages, selectedModel) =>
              await this.semaphore.use(() =>
                textAI.complete(messages, selectedModel),
              ),
            completeToolTurn: async (messages, selectedModel, tools) =>
              await this.semaphore.use(() =>
                textAI.completeToolTurn(messages, selectedModel, tools),
              ),
          },
          model,
          tools: createAgentTools({
            webEnabled: web.enabled,
            discordAvailable: true,
            discordWritesEnabled: config.agent.discordActionsEnabled,
          }),
          logger: this.dependencies.logger,
          options: {
            maxIterations: config.agent.maxIterations,
            maxToolCalls: config.agent.maxToolCalls,
            maxParallelToolCalls: config.agent.maxParallelToolCalls,
            runTimeoutMs: config.agent.runTimeoutMs,
            toolTimeoutMs: config.agent.toolTimeoutMs,
          },
          observer: {
            modelTurn: async (event) => {
              observedIterations = Math.max(
                observedIterations,
                event.iteration,
              );
              observedToolCalls += event.toolCallCount;
              observedPromptTokens += event.promptTokens ?? 0;
              observedCompletionTokens += event.completionTokens ?? 0;
            },
            toolExecution: async (execution) => {
              await memory
                .recordAgentToolExecution(runId, execution)
                .catch((error) => {
                  this.dependencies.logger.warn(
                    { err: error, runId, callId: execution.callId },
                    "could not record agent tool telemetry",
                  );
                });
            },
          },
        });
        try {
          const result = await agent.run({
            runId,
            messages: promptMessages,
            context: agentContext,
          });
          completion = {
            content: result.content,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          };
          await memory.finishAgentRun({
            id: runId,
            status: "completed",
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          });
        } catch (error) {
          await memory
            .finishAgentRun({
              id: runId,
              status: "failed",
              iterations: observedIterations,
              toolCalls: observedToolCalls,
              promptTokens: observedPromptTokens,
              completionTokens: observedCompletionTokens,
              errorCode:
                error instanceof AgentLoopError
                  ? error.code
                  : error instanceof AIProviderError
                    ? "provider_error"
                    : "agent_error",
            })
            .catch(() => undefined);
          throw error;
        }
      } else {
        completion = await this.semaphore.use(() =>
          completionClient.complete(promptMessages, model),
        );
      }
      await memory.recordAIEvent({
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        model,
        kind,
        success: true,
        latencyMs: Math.round(performance.now() - startedAt),
        ...(completion.promptTokens !== undefined
          ? { promptTokens: completion.promptTokens }
          : {}),
        ...(completion.completionTokens !== undefined
          ? { completionTokens: completion.completionTokens }
          : {}),
      });

      if (input.ambient && !useVision && isAmbientSkip(completion.content))
        return undefined;
      const rawAnswer = casual
        ? casualizeReply(completion.content)
        : completion.content.trim();
      const text = withSources(rawAnswer, sources);
      const makeCard = input.forceCard || wantsImageCard(input.question);
      const card = makeCard
        ? await renderEngineerCard({
            title: "Gopher Verdict",
            body: rawAnswer,
            author: input.username,
          })
        : undefined;
      return await this.withVoice(input, {
        text,
        rawAnswer,
        sources,
        ...(card ? { card } : {}),
      });
    } catch (error) {
      await memory
        .recordAIEvent({
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.userId,
          model,
          kind,
          success: false,
          latencyMs: Math.round(performance.now() - startedAt),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async withVoice(
    input: AnswerInput,
    answer: AnswerOutput,
  ): Promise<AnswerOutput> {
    if (!input.forceVoice) return answer;
    if (!this.dependencies.voice.enabled) {
      return {
        ...answer,
        text: `voice isn't configured rn, text instead\n\n${answer.text}`,
      };
    }
    try {
      const voice = await this.dependencies.voice.synthesize(answer.rawAnswer);
      return { ...answer, voice };
    } catch (error) {
      this.dependencies.logger.warn(
        {
          err:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : "unknown voice error",
          messageId: input.discordMessageId,
        },
        "voice synthesis failed; sending text fallback",
      );
      return {
        ...answer,
        text: `voice died rn, text instead\n\n${answer.text}`,
      };
    }
  }

  private async maybeSummarize(
    guildId: string,
    channelId: string,
  ): Promise<void> {
    const previous = await this.dependencies.memory.summary(guildId, channelId);
    const messages = await this.dependencies.memory.unsummarized(
      guildId,
      channelId,
      previous?.lastMessageId ?? 0,
      this.dependencies.config.summaryEveryMessages,
    );
    if (messages.length === 0) return;

    const startedAt = performance.now();
    try {
      const completion = await this.semaphore.use(() =>
        this.dependencies.summaryAI.complete(
          buildSummaryMessages(previous?.summary, messages),
          this.dependencies.config.text.model,
        ),
      );
      const lastMessage = messages.at(-1);
      if (!lastMessage) return;
      const summary = compactSummaryOutput(completion.content);
      if (!summary) {
        throw new AIProviderError("AI provider returned an empty summary", false);
      }
      if (completion.truncated) {
        this.dependencies.logger.warn(
          {
            guildId,
            channelId,
            completionTokens: completion.completionTokens,
          },
          "summary provider reached its output limit; saved a compact prefix",
        );
      }
      await this.dependencies.memory.saveSummary(
        guildId,
        channelId,
        summary,
        lastMessage.id,
      );
      await this.dependencies.memory.recordAIEvent({
        guildId,
        channelId,
        userId: "system",
        model: this.dependencies.config.text.model,
        kind: "summary",
        success: true,
        latencyMs: Math.round(performance.now() - startedAt),
        ...(completion.promptTokens !== undefined
          ? { promptTokens: completion.promptTokens }
          : {}),
        ...(completion.completionTokens !== undefined
          ? { completionTokens: completion.completionTokens }
          : {}),
      });
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, guildId, channelId },
        "summary refresh failed",
      );
    }
  }

  private async isReplyToBot(message: Message): Promise<boolean> {
    if (!message.reference?.messageId || !this.client.user) return false;
    try {
      const referenced = await message.fetchReference();
      return referenced.author.id === this.client.user.id;
    } catch {
      return false;
    }
  }

  private async executeReactionRequest(
    message: Message,
    request: ReactionRequest,
    guildId: string,
  ): Promise<void> {
    let target = message;
    if (message.reference?.messageId) {
      try {
        target = await message.fetchReference();
      } catch (error) {
        this.dependencies.logger.debug(
          { err: error, messageId: message.id },
          "could not fetch reaction target; reacting to the request instead",
        );
      }
    }

    const requestedEmoji =
      !message.guildId && /^<a?:/.test(request.emoji) ? "👍" : request.emoji;
    try {
      await target.react(requestedEmoji);
    } catch (error) {
      this.dependencies.logger.warn(
        {
          err: error,
          messageId: message.id,
          targetMessageId: target.id,
          reaction: request.label,
        },
        "Discord rejected an explicit reaction request",
      );
      await message.reply({
        content: "couldn't add that reaction here",
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }

    await this.dependencies.memory
      .recordMessage({
        discordMessageId: `reaction:${message.id}`,
        guildId,
        channelId: message.channelId,
        userId: this.client.user?.id ?? "bot",
        username: this.client.user?.username ?? "Gopher",
        role: "assistant",
        content: `[reacted with ${request.label}]`,
      })
      .catch((error) => {
        this.dependencies.logger.warn(
          { err: error, messageId: message.id },
          "reaction succeeded but memory recording failed",
        );
      });
  }

  private serverEmojis(guildId: string): ServerEmoji[] {
    const guild = this.client.guilds.cache.get(guildId);
    return guild ? buildServerEmojiCatalog(guild.emojis.cache.values()) : [];
  }

  private async refreshServerEmojis(guilds: Iterable<Guild>): Promise<void> {
    const results = await Promise.allSettled(
      [...guilds].map(async (guild) => {
        const emojis = await guild.emojis.fetch();
        return { guildId: guild.id, emojis: emojis.size };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        this.dependencies.logger.info(
          result.value,
          "refreshed server custom emoji catalog",
        );
      } else {
        this.dependencies.logger.warn(
          { err: result.reason },
          "could not refresh a server custom emoji catalog; using gateway cache",
        );
      }
    }
  }

  private async sendMessageAnswer(
    message: Message,
    answer: AnswerOutput,
  ): Promise<Message> {
    if (answer.voice) {
      try {
        const first = await message.reply({
          files: [this.voiceAttachment(answer.voice)],
          flags: MessageFlags.IsVoiceMessage,
          allowedMentions: { parse: [], repliedUser: false },
        });
        if (
          (answer.voice.needsTextFollowUp ||
            answer.sources.length > 0 ||
            answer.card) &&
          message.channel.isSendable()
        ) {
          await this.sendTextFollowUps(message.channel, answer).catch(
            (error) => {
              this.dependencies.logger.warn(
                { err: error, messageId: message.id },
                "voice sent but its text follow-up failed",
              );
            },
          );
        }
        return first;
      } catch (error) {
        this.dependencies.logger.warn(
          { err: error, messageId: message.id },
          "Discord rejected the native voice message; sending text fallback",
        );
        const { voice: _voice, ...fallback } = answer;
        return await this.sendMessageAnswer(message, {
          ...fallback,
          text: `voice upload failed rn, text instead\n\n${answer.text}`,
        });
      }
    }

    const chunks = splitDiscordMessage(answer.text);
    const first = await message.reply({
      content: chunks[0] ?? "got nothing",
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds,
      ...(answer.card
        ? {
            files: [
              new AttachmentBuilder(answer.card, {
                name: "gopher-overdrive-verdict.png",
              }),
            ],
          }
        : {}),
    });
    if (message.channel.isSendable()) {
      for (const chunk of chunks.slice(1)) {
        await message.channel.send({
          content: chunk,
          allowedMentions: { parse: [] },
          flags: MessageFlags.SuppressEmbeds,
        });
      }
    }
    return first;
  }

  private async sendInteractionAnswer(
    interaction: ChatInputCommandInteraction,
    answer: AnswerOutput,
  ): Promise<string> {
    if (answer.voice) {
      let deletedDeferredReply = false;
      try {
        await interaction.deleteReply();
        deletedDeferredReply = true;
      } catch (error) {
        this.dependencies.logger.warn(
          { err: error, interactionId: interaction.id },
          "could not remove deferred reply before sending voice",
        );
      }
      try {
        const response = await interaction.followUp({
          files: [this.voiceAttachment(answer.voice)],
          flags: MessageFlags.IsVoiceMessage,
          allowedMentions: { parse: [] },
        });
        if (!deletedDeferredReply) {
          await interaction
            .editReply({
              content: "voice reply below",
              allowedMentions: { parse: [] },
            })
            .catch(() => undefined);
        }
        if (
          answer.voice.needsTextFollowUp ||
          answer.sources.length > 0 ||
          answer.card
        ) {
          await this.sendInteractionTextFollowUps(interaction, answer).catch(
            (error) => {
              this.dependencies.logger.warn(
                { err: error, interactionId: interaction.id },
                "voice sent but its interaction text follow-up failed",
              );
            },
          );
        }
        return response.id;
      } catch (error) {
        this.dependencies.logger.warn(
          { err: error, interactionId: interaction.id },
          "Discord rejected the native interaction voice message; sending text fallback",
        );
        const { voice: _voice, ...fallback } = answer;
        return await this.sendInteractionTextAnswer(
          interaction,
          {
            ...fallback,
            text: `voice upload failed rn, text instead\n\n${answer.text}`,
          },
          deletedDeferredReply,
        );
      }
    }

    return await this.sendInteractionTextAnswer(interaction, answer, false);
  }

  private async sendInteractionTextAnswer(
    interaction: ChatInputCommandInteraction,
    answer: AnswerOutput,
    useFollowUp: boolean,
  ): Promise<string> {
    const chunks = splitDiscordMessage(answer.text);
    const options = {
      content: chunks[0] ?? "got nothing",
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
      ...(answer.card
        ? {
            files: [
              new AttachmentBuilder(answer.card, {
                name: "gopher-overdrive-verdict.png",
              }),
            ],
          }
        : {}),
    } as const;
    const response = useFollowUp
      ? await interaction.followUp(options)
      : await interaction.editReply(options);
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    }
    return response.id;
  }

  private voiceAttachment(voice: SynthesizedVoiceMessage): AttachmentBuilder {
    return new AttachmentBuilder(voice.audio, {
      name: "gopher-voice.ogg",
      description: "Gopher voice reply",
      duration: voice.durationSeconds,
      waveform: voice.waveform,
    });
  }

  private async sendTextFollowUps(
    channel: Extract<Message["channel"], { send: unknown }>,
    answer: AnswerOutput,
  ): Promise<void> {
    const chunks = splitDiscordMessage(answer.text);
    for (const [index, chunk] of chunks.entries()) {
      await channel.send({
        content: chunk,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
        ...(index === 0 && answer.card
          ? {
              files: [
                new AttachmentBuilder(answer.card, {
                  name: "gopher-overdrive-verdict.png",
                }),
              ],
            }
          : {}),
      });
    }
  }

  private async sendInteractionTextFollowUps(
    interaction: ChatInputCommandInteraction,
    answer: AnswerOutput,
  ): Promise<void> {
    const chunks = splitDiscordMessage(answer.text);
    for (const [index, chunk] of chunks.entries()) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
        ...(index === 0 && answer.card
          ? {
              files: [
                new AttachmentBuilder(answer.card, {
                  name: "gopher-overdrive-verdict.png",
                }),
              ],
            }
          : {}),
      });
    }
  }

  private async sendUserFacingError(
    message: Message,
    error: unknown,
  ): Promise<void> {
    if (!message.channel.isSendable()) return;
    await message
      .reply({
        content: this.userFacingError(error),
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => undefined);
  }

  private userFacingError(error: unknown): string {
    if (error instanceof AIProviderError) {
      return "provider died, try again";
    }
    if (error instanceof WebResearchError) {
      return "web search died, not gonna fake it";
    }
    if (error instanceof AgentLoopError) {
      return error.code === "tool_budget" || error.code === "iteration_limit"
        ? "agent loop hit its safety limit before finishing. narrow the request and try again."
        : "agent run timed out, try again";
    }
    if (error instanceof Error && error.message.startsWith("Vision limit")) {
      return error.message;
    }
    return "something broke, tragic";
  }
}
