import { z } from "zod";
import type { StoredMessage } from "../types.ts";

export const memoryScopeSchema = z.enum(["user", "channel", "guild"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryKindSchema = z.enum([
  "profile",
  "preference",
  "fact",
  "decision",
  "project",
  "relationship",
  "commitment",
  "event",
  "skill",
  "correction",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memorySourceSchema = z.enum([
  "extracted",
  "explicit",
  "agent_tool",
  "imported",
]);
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryRelationSchema = z.enum([
  "supports",
  "contradicts",
  "updates",
  "part_of",
  "caused_by",
  "related_to",
]);
export type MemoryRelation = z.infer<typeof memoryRelationSchema>;

export interface MemoryIdentity {
  scope: MemoryScope;
  subjectUserId?: string;
  kind: MemoryKind;
  key: string;
}

export interface MemoryRelationCandidate {
  from: MemoryIdentity;
  to: MemoryIdentity;
  relation: MemoryRelation;
  confidence: number;
  evidenceMessageIds: string[];
}

export interface DurableMemory {
  id: number;
  guildId: string;
  scope: MemoryScope;
  scopeId: string;
  subjectUserId?: string;
  kind: MemoryKind;
  key: string;
  content: string;
  importance: number;
  confidence: number;
  source: MemorySource;
  evidenceMessageIds: string[];
  pinned: boolean;
  version: number;
  validFrom: Date;
  expiresAt?: Date;
  lastConfirmedAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
  score: number;
  semanticSimilarity?: number;
  embeddingModel?: string;
  embeddedAt?: Date;
  linkedFromMemoryId?: number;
  linkRelation?: MemoryRelation;
  linkConfidence?: number;
  linkDirection?: "outbound" | "inbound";
}
export interface MemoryCandidate {
  scope: MemoryScope;
  subjectUserId?: string;
  kind: MemoryKind;
  key: string;
  content: string;
  importance: number;
  confidence: number;
  ttlDays?: number;
  evidenceMessageIds: string[];
  reason: string;
}

export interface MemoryRecallInput {
  guildId: string;
  channelId: string;
  userId: string;
  query: string;
  limit: number;
  includeGuild?: boolean;
  includeUser?: boolean;
  includeChannel?: boolean;
  kinds?: MemoryKind[];
}

export interface MemoryContextPack {
  durable: DurableMemory[];
  commitments: DurableMemory[];
}

export interface MemoryIngestionJob {
  id: number;
  guildId: string;
  channelId: string;
  throughMessageId: number;
  attempts: number;
}

export interface MemoryIngestionBatch {
  job: MemoryIngestionJob;
  messages: StoredMessage[];
  existing: DurableMemory[];
  knownUserIds: string[];
  checkpoint: number;
  reachedTarget: boolean;
}

export interface MemoryEmbeddingJob {
  memoryItemId: number;
  guildId: string;
  channelId: string;
  memoryVersion: number;
  kind: MemoryKind;
  key: string;
  content: string;
  attempts: number;
}

export interface DiscordEventInput {
  eventKey: string;
  guildId: string;
  channelId: string;
  actorUserId?: string;
  eventType:
    | "message_create"
    | "message_edit"
    | "message_delete"
    | "reaction_add"
    | "reaction_remove"
    | "thread_create"
    | "thread_update"
    | "agent_action";
  payload?: Record<string, unknown>;
  occurredAt: Date;
}

export interface AgentRunStart {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  discordMessageId: string;
  model: string;
}

export interface AgentRunFinish {
  id: string;
  status: "completed" | "failed" | "cancelled";
  iterations: number;
  toolCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  errorCode?: string;
}
