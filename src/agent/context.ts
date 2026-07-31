import type { MemoryStore } from "../memory/store.ts";
import type { WebSource } from "../types.ts";
import type { WebResearch } from "../web/firecrawl.ts";

export interface DiscordMessageSnapshot {
  id: string;
  channelId: string;
  authorId: string;
  username: string;
  content: string;
  createdAt: string;
  replyToMessageId?: string;
  attachmentUrls: string[];
}
export interface DiscordChannelSnapshot {
  id: string;
  name: string;
  type: string;
  parentId?: string;
}

export interface DiscordThreadSnapshot {
  id: string;
  name: string;
  parentId?: string;
  ownerId?: string;
  archived: boolean;
  locked: boolean;
  messageCount?: number;
}

export interface DiscordMemberSnapshot {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  joinedAt?: string;
  roles: string[];
}

export interface DiscordAgentAdapter {
  readMessages(input: {
    channelId?: string;
    beforeMessageId?: string;
    limit: number;
    query?: string;
  }): Promise<DiscordMessageSnapshot[]>;
  getMessage(input: {
    messageId: string;
  }): Promise<DiscordMessageSnapshot>;
  listChannels(input: {
    query?: string;
    limit: number;
  }): Promise<DiscordChannelSnapshot[]>;
  listThreads(input: {
    query?: string;
    limit: number;
  }): Promise<DiscordThreadSnapshot[]>;
  findMember(input: {
    userId?: string;
    query?: string;
  }): Promise<DiscordMemberSnapshot | undefined>;
  react(input: { messageId: string; emoji: string }): Promise<{
    messageId: string;
    emoji: string;
  }>;
  removeOwnReaction(input: { messageId: string; emoji: string }): Promise<{
    messageId: string;
    emoji: string;
    removed: boolean;
  }>;
  sendMessage(input: {
    channelId?: string;
    content: string;
    nonce: string;
  }): Promise<{
    messageId: string;
    channelId: string;
  }>;
  replyToMessage(input: {
    messageId: string;
    content: string;
    nonce: string;
  }): Promise<{
    messageId: string;
    channelId: string;
    replyToMessageId: string;
  }>;
  createThread(input: {
    messageId?: string;
    name: string;
  }): Promise<{ threadId: string; name: string }>;
  editOwnMessage(input: {
    messageId: string;
    content: string;
  }): Promise<{ messageId: string }>;
  deleteOwnMessage(input: {
    messageId: string;
  }): Promise<{ messageId: string }>;
  pinMessage(input: {
    messageId: string;
  }): Promise<{ messageId: string }>;
  unpinMessage(input: {
    messageId: string;
  }): Promise<{ messageId: string }>;
  editThread(input: {
    threadId?: string;
    name?: string;
    archived?: boolean;
  }): Promise<{
    threadId: string;
    name: string;
    archived: boolean;
  }>;
}

export interface AgentRequestContext {
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  requestText: string;
  discordMessageId: string;
  isOwner: boolean;
  isAdministrator: boolean;
  isDirectMessage: boolean;
  discordActionsEnabled: boolean;
  memory: Pick<
    MemoryStore,
    | "recall"
    | "upsertMemories"
    | "forgetMemory"
    | "saveWebSources"
    | "recordDiscordEvent"
    | "claimAgentAction"
    | "completeAgentAction"
    | "failAgentAction"
  >;
  web: Pick<WebResearch, "enabled" | "search">;
  discord?: DiscordAgentAdapter;
  collectedWebSources: WebSource[];
}
