import {
  ChannelType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { AgentToolError } from "../agent/loop.ts";
import type {
  DiscordAgentAdapter,
  DiscordChannelSnapshot,
  DiscordMemberSnapshot,
  DiscordMessageSnapshot,
} from "../agent/context.ts";

export class DiscordJsAgentAdapter implements DiscordAgentAdapter {
  constructor(
    private readonly dependencies: {
      client: Client;
      guildId?: string;
      channelId: string;
      requesterUserId: string;
      triggerMessageId?: string;
    },
  ) {}

  async readMessages(input: {
    channelId?: string;
    beforeMessageId?: string;
    limit: number;
    query?: string;
  }): Promise<DiscordMessageSnapshot[]> {
    const channel = await this.fetchTextChannel(
      input.channelId,
      PermissionFlagsBits.ReadMessageHistory,
    );
    const fetched = await channel.messages.fetch({
      limit: input.limit,
      cache: false,
      ...(input.beforeMessageId ? { before: input.beforeMessageId } : {}),
    });
    const query = input.query?.trim().toLocaleLowerCase("en");
    return [...fetched.values()]
      .filter(
        (message) =>
          !query ||
          message.content.toLocaleLowerCase("en").includes(query) ||
          message.author.username.toLocaleLowerCase("en").includes(query),
      )
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map(messageSnapshot);
  }

  async listChannels(input: {
    query?: string;
    limit: number;
  }): Promise<DiscordChannelSnapshot[]> {
    const guild = await this.fetchGuild();
    if (!guild) {
      throw new AgentToolError(
        "guild_required",
        "Channel listing is only available inside a server",
      );
    }
    const requester = await guild.members.fetch(this.dependencies.requesterUserId);
    const bot = await this.fetchBotMember(guild);
    const query = input.query?.trim().toLocaleLowerCase("en");
    const channels = await guild.channels.fetch();
    return [...channels.values()]
      .filter((channel) => {
        if (!channel) return false;
        if (query && !channel.name.toLocaleLowerCase("en").includes(query))
          return false;
        return (
          channel
            .permissionsFor(requester)
            ?.has(PermissionFlagsBits.ViewChannel) === true &&
          channel.permissionsFor(bot)?.has(PermissionFlagsBits.ViewChannel) ===
            true
        );
      })
      .slice(0, input.limit)
      .map((channel) => ({
        id: channel!.id,
        name: channel!.name,
        type: ChannelType[channel!.type] ?? String(channel!.type),
        ...(channel!.parentId ? { parentId: channel!.parentId } : {}),
      }));
  }

  async findMember(input: {
    userId?: string;
    query?: string;
  }): Promise<DiscordMemberSnapshot | undefined> {
    const guild = await this.fetchGuild();
    if (!guild) {
      throw new AgentToolError(
        "guild_required",
        "Member lookup is only available inside a server",
      );
    }
    if (input.userId) {
      const member = await guild.members
        .fetch(input.userId)
        .catch(() => undefined);
      return member ? memberSnapshot(member) : undefined;
    }
    const query = input.query?.trim();
    if (!query) return undefined;
    const normalized = query.toLocaleLowerCase("en");
    const cached = guild.members.cache.find(
      (member) =>
        member.displayName.toLocaleLowerCase("en") === normalized ||
        member.user.username.toLocaleLowerCase("en") === normalized,
    );
    if (cached) return memberSnapshot(cached);

    const fetched = await guild.members.fetch({ query, limit: 10 });
    const exact =
      fetched.find(
        (member) =>
          member.displayName.toLocaleLowerCase("en") === normalized ||
          member.user.username.toLocaleLowerCase("en") === normalized,
      ) ?? (fetched.size === 1 ? fetched.first() : undefined);
    return exact ? memberSnapshot(exact) : undefined;
  }

  async react(input: {
    messageId: string;
    emoji: string;
  }): Promise<{ messageId: string; emoji: string }> {
    const message = await this.fetchMessage(
      input.messageId,
      PermissionFlagsBits.AddReactions,
    );
    await message.react(input.emoji);
    return { messageId: message.id, emoji: input.emoji };
  }

  async sendMessage(input: {
    channelId?: string;
    content: string;
  }): Promise<{ messageId: string; channelId: string }> {
    const channel = await this.fetchTextChannel(
      input.channelId,
      PermissionFlagsBits.SendMessages,
    );
    if (!channel.isSendable()) {
      throw new AgentToolError(
        "channel_not_sendable",
        "That channel cannot accept bot messages",
      );
    }
    const message = await channel.send({
      content: input.content,
      allowedMentions: { parse: [] },
    });
    return { messageId: message.id, channelId: message.channelId };
  }

  async createThread(input: {
    messageId?: string;
    name: string;
  }): Promise<{ threadId: string; name: string }> {
    const messageId = input.messageId ?? this.dependencies.triggerMessageId;
    if (!messageId) {
      throw new AgentToolError(
        "message_required",
        "A source message is required to create a thread",
      );
    }
    const message = await this.fetchMessage(
      messageId,
      PermissionFlagsBits.CreatePublicThreads,
    );
    if (!message.inGuild()) {
      throw new AgentToolError(
        "guild_required",
        "Threads can only be created inside a server",
      );
    }
    const thread = await message.startThread({
      name: input.name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Requested by Discord user ${this.dependencies.requesterUserId}`,
    });
    return { threadId: thread.id, name: thread.name };
  }

  async editOwnMessage(input: {
    messageId: string;
    content: string;
  }): Promise<{ messageId: string }> {
    const message = await this.fetchMessage(
      input.messageId,
      PermissionFlagsBits.ViewChannel,
    );
    if (message.author.id !== this.dependencies.client.user?.id) {
      throw new AgentToolError(
        "not_bot_message",
        "The bot can edit only its own messages",
      );
    }
    await message.edit({
      content: input.content,
      allowedMentions: { parse: [] },
    });
    return { messageId: message.id };
  }

  async deleteOwnMessage(input: {
    messageId: string;
  }): Promise<{ messageId: string }> {
    const message = await this.fetchMessage(
      input.messageId,
      PermissionFlagsBits.ViewChannel,
    );
    if (message.author.id !== this.dependencies.client.user?.id) {
      throw new AgentToolError(
        "not_bot_message",
        "The bot can delete only its own messages",
      );
    }
    await message.delete();
    return { messageId: message.id };
  }

  async pinMessage(input: {
    messageId: string;
  }): Promise<{ messageId: string }> {
    const message = await this.fetchMessage(
      input.messageId,
      PermissionFlagsBits.ManageMessages,
    );
    await message.pin(
      `Requested by Discord user ${this.dependencies.requesterUserId}`,
    );
    return { messageId: message.id };
  }

  private async fetchMessage(
    messageId: string,
    requiredPermission:
      | bigint
      | (typeof PermissionFlagsBits)[keyof typeof PermissionFlagsBits],
  ): Promise<Message> {
    const channel = await this.fetchTextChannel(undefined, requiredPermission);
    return await channel.messages.fetch(messageId).catch(() => {
      throw new AgentToolError(
        "message_not_found",
        "That message was not found in the current channel",
      );
    });
  }

  private async fetchTextChannel(
    requestedChannelId:
      | string
      | undefined,
    requiredPermission:
      | bigint
      | (typeof PermissionFlagsBits)[keyof typeof PermissionFlagsBits],
  ): Promise<TextBasedChannel> {
    const channelId = requestedChannelId ?? this.dependencies.channelId;
    if (!this.dependencies.guildId && channelId !== this.dependencies.channelId) {
      throw new AgentToolError(
        "cross_channel_denied",
        "A DM agent cannot access another channel",
      );
    }
    const channel = await this.dependencies.client.channels
      .fetch(channelId)
      .catch(() => undefined);
    if (!channel?.isTextBased() || !("messages" in channel)) {
      throw new AgentToolError(
        "channel_not_text",
        "That channel is unavailable or not text-based",
      );
    }
    if (!channel.isDMBased()) {
      const requester = await channel.guild.members.fetch(
        this.dependencies.requesterUserId,
      );
      const bot = await this.fetchBotMember(channel.guild);
      for (const member of [requester, bot]) {
        const permissions = channel.permissionsFor(member);
        if (
          !permissions?.has(PermissionFlagsBits.ViewChannel) ||
          !permissions.has(requiredPermission)
        ) {
          throw new AgentToolError(
            "missing_permission",
            member.id === requester.id
              ? "You do not have the required permission in that channel"
              : "The bot does not have the required permission in that channel",
          );
        }
      }
    }
    return channel;
  }

  private async fetchGuild(): Promise<Guild | undefined> {
    if (!this.dependencies.guildId) return undefined;
    return (
      this.dependencies.client.guilds.cache.get(this.dependencies.guildId) ??
      (await this.dependencies.client.guilds
        .fetch(this.dependencies.guildId)
        .catch(() => undefined))
    );
  }

  private async fetchBotMember(guild: Guild): Promise<GuildMember> {
    const cached = guild.members.me;
    if (cached) return cached;
    const botUserId = this.dependencies.client.user?.id;
    if (!botUserId) {
      throw new AgentToolError(
        "bot_not_ready",
        "The Discord bot is not ready",
      );
    }
    return await guild.members.fetch(botUserId);
  }
}
function messageSnapshot(message: Message): DiscordMessageSnapshot {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    username:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    content: message.content.slice(0, 4_000),
    createdAt: message.createdAt.toISOString(),
    ...(message.reference?.messageId
      ? { replyToMessageId: message.reference.messageId }
      : {}),
    attachmentUrls: [...message.attachments.values()]
      .map((attachment) => attachment.url)
      .slice(0, 10),
  };
}

function memberSnapshot(member: GuildMember): DiscordMemberSnapshot {
  return {
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    bot: member.user.bot,
    ...(member.joinedAt ? { joinedAt: member.joinedAt.toISOString() } : {}),
    roles: member.roles.cache
      .filter((role) => role.id !== member.guild.id)
      .map((role) => role.name)
      .slice(0, 30),
  };
}
