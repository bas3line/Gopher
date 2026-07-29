export interface StoredMessage {
  id: number;
  discordMessageId: string;
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface RelevantMemory {
  username: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  rank: number;
}

export interface ConversationSummary {
  summary: string;
  lastMessageId: number;
  updatedAt: Date;
}

export interface WebSource {
  title: string;
  url: string;
  description: string;
  content: string;
  publishedAt?: string;
}
