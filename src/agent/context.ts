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
  listChannels(input: {
    query?: string;
    limit: number;
  }): Promise<DiscordChannelSnapshot[]>;
  findMember(input: {
    userId?: string;
    query?: string;
  }): Promise<DiscordMemberSnapshot | undefined>;
  react(input: { messageId: string; emoji: string }): Promise<{
    messageId: string;
    emoji: string;
  }>;
  sendMessage(input: { channelId?: string; content: string }): Promise<{
    messageId: string;
    channelId: string;
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
  >;
  web: Pick<WebResearch, "enabled" | "search">;
  discord?: DiscordAgentAdapter;
  collectedWebSources: WebSource[];
}
