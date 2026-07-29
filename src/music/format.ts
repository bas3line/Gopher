import type { MusicQueueSnapshot, QueuedMusicTrack } from "./types.ts";

const MAX_TITLE_LENGTH = 90;

export function musicDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "live";
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function musicTrackLabel(track: Pick<QueuedMusicTrack, "title" | "author" | "durationMs">): string {
  const title = compact(track.title, MAX_TITLE_LENGTH);
  const author = compact(track.author, 48) || "unknown artist";
  return `**${title}** — ${author} \`${musicDuration(track.durationMs)}\``;
}

export function formatMusicQueue(snapshot: MusicQueueSnapshot): string {
  const lines = [`**Music queue** · volume ${snapshot.volume}%`];
  if (snapshot.current) {
    lines.push(`Now: ${musicTrackLabel(snapshot.current)}`);
  } else {
    lines.push("Now: nothing playing");
  }

  if (snapshot.upcoming.length === 0) {
    lines.push("Up next: nothing queued");
    return lines.join("\n");
  }

  lines.push("Up next:");
  for (const [index, track] of snapshot.upcoming.slice(0, 10).entries()) {
    lines.push(`${index + 1}. ${musicTrackLabel(track)}`);
  }
  if (snapshot.upcoming.length > 10) {
    lines.push(`…and ${snapshot.upcoming.length - 10} more`);
  }
  return lines.join("\n");
}

export function formatMusicHistory(items: readonly QueuedMusicTrack[]): string {
  if (items.length === 0) return "No music history in this server yet.";
  return ["**Recently played**", ...items.map((item) => `• ${musicTrackLabel(item)}`)].join("\n");
}

function compact(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}
