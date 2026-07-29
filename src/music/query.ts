export class MusicQueryError extends Error {}

/** A safe, unsurprising default for an explicit "play some music" request. */
export const DEFAULT_MUSIC_SEARCH = "chill music mix";

export type TextMusicCommand =
  | { kind: "play"; query: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip" }
  | { kind: "stop" }
  | { kind: "queue" }
  | { kind: "now" };

/**
 * Recognizes deliberate text music controls. The caller must still be in a
 * voice channel for controls that mutate playback; this parser never turns
 * ordinary background chat into a music action on its own.
 */
export function parseMusicTextCommand(input: string): TextMusicCommand | undefined {
  const cleaned = normalizeTextMusicInput(input);
  if (!cleaned) return undefined;

  const simple = cleanTextMusicControl(cleaned);
  if (/^(?:stop|turn\s+off|kill)(?:\s+(?:(?:(?:this|that|the)\s+)?(?:music|song|track|playback)|(?:this|that|it)))?$/iu.test(simple)) {
    return { kind: "stop" };
  }
  if (/^(?:pause|hold)(?:\s+(?:(?:(?:this|that|the)\s+)?(?:music|song|track|playback)|(?:this|that|it)))?$/iu.test(simple)) {
    return { kind: "pause" };
  }
  if (/^(?:resume|unpause|continue)(?:\s+(?:(?:(?:this|that|the)\s+)?(?:music|song|track|playback)|(?:this|that|it)))?$/iu.test(simple)) {
    return { kind: "resume" };
  }
  if (/^(?:skip|next)(?:\s+(?:(?:(?:this|that|the)\s+)?(?:music|song|track)|(?:this|that|it)))?$/iu.test(simple)) {
    return { kind: "skip" };
  }
  if (/^(?:show\s+)?(?:the\s+)?(?:queue|playlist)(?:\s+(?:please|now))?$/iu.test(simple)) {
    return { kind: "queue" };
  }
  if (/^(?:(?:what(?:'s|\s+is)|whats)\s+(?:playing|on)|now(?:\s+playing)?)$/iu.test(simple)) {
    return { kind: "now" };
  }

  const match =
    /^(?:(?:please|pls|plz)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:play|queue|put\s+on)(?:\s+(.+?))?[.!?]*$/iu.exec(
      cleaned,
    );
  if (!match) return undefined;

  const requested = (match[1] ?? "")
    .replace(/(?:\s+(?:please|pls|plz|bro|lil\s+bro|gopher))+\s*$/iu, "")
    .trim();
  if (!requested) return { kind: "play", query: DEFAULT_MUSIC_SEARCH };

  if (
    /^(?:(?:some|any|a\s+little|something)\s+)?(?:music|songs?|tunes?|beats?|vibes?|a\s+playlist)$/iu.test(
      requested,
    )
  ) {
    return { kind: "play", query: DEFAULT_MUSIC_SEARCH };
  }

  const artistOnly =
    /^(?:(?:some|any)\s+)?music\s+(?:by|from)\s+(.+)$/iu.exec(requested)?.[1];
  const query = (artistOnly ?? requested).trim();
  return query.length > 0 && query.length <= 500 ? { kind: "play", query } : undefined;
}

/** Backward-compatible helper for callers that only want play actions. */
export function parseMusicTextPlayRequest(input: string): string | undefined {
  const command = parseMusicTextCommand(input);
  return command?.kind === "play" ? command.query : undefined;
}

function normalizeTextMusicInput(input: string): string {
  return input
    .trim()
    .replace(/^(?:(?:hey|yo|bro|gopher|dude|man)\s*[,!]*\s*)+/iu, "")
    .replace(/^(?:(?:how\s+about|what\s+if)\s+you\s+)/iu, "")
    .trim();
}

function cleanTextMusicControl(input: string): string {
  return input
    .replace(/^(?:(?:please|pls|plz)\s+)?(?:(?:can|could|would)\s+you\s+)?/iu, "")
    .replace(/(?:\s+(?:please|pls|plz|bro|lil\s+bro|gopher))+(?:\s*[.!?]+)?$/iu, "")
    .replace(/[.!?]+$/u, "")
    .trim();
}

export function musicIdentifier(input: string): string {
  const query = input.trim();
  if (!query) throw new MusicQueryError("give me a song name or an https URL");
  if (/^https:\/\//i.test(query)) {
    let url: URL;
    try {
      url = new URL(query);
    } catch {
      throw new MusicQueryError("use a valid https music URL");
    }
    if (url.username || url.password || !isSupportedMusicHost(url.hostname)) {
      throw new MusicQueryError("use a YouTube, SoundCloud, or Bandcamp URL");
    }
    return query;
  }
  if (/^http:\/\//i.test(query)) {
    throw new MusicQueryError("use an https URL, not plain http");
  }
  if (/^(?:ytsearch|scsearch):/i.test(query)) {
    if (!query.slice(query.indexOf(":") + 1).trim()) {
      throw new MusicQueryError("give me something to search for");
    }
    return query;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(query)) {
    throw new MusicQueryError("that source type isn't allowed here");
  }
  return `ytsearch:${query}`;
}

function isSupportedMusicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ["youtube.com", "youtu.be", "soundcloud.com", "bandcamp.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}
