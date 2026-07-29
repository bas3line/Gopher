export type MusicQueueState =
  | "queued"
  | "playing"
  | "played"
  | "skipped"
  | "failed";

export interface ResolvedMusicTrack {
  encodedTrack: string;
  title: string;
  author: string;
  uri?: string;
  artworkUrl?: string;
  durationMs: number;
}

export interface QueuedMusicTrack extends ResolvedMusicTrack {
  id: number;
  guildId: string;
  requestedByUserId: string;
  requestedByUsername: string;
  sourceQuery: string;
  state: MusicQueueState;
  queueOrder: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface MusicQueueSnapshot {
  current?: QueuedMusicTrack;
  upcoming: QueuedMusicTrack[];
  volume: number;
}
