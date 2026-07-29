export class MusicQueryError extends Error {}

/** A safe, unsurprising default for an explicit "play some music" request. */
export const DEFAULT_MUSIC_SEARCH = "chill music mix";

/**
 * Recognizes a direct text request to queue music. The caller must still be in
 * a voice channel; this parser never turns ordinary background chat into a
 * music action on its own.
 */
export function parseMusicTextPlayRequest(input: string): string | undefined {
  const match =
    /^(?:(?:please|pls|plz)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:play|queue|put\s+on)(?:\s+(.+?))?[.!?]*$/iu.exec(
      input.trim(),
    );
  if (!match) return undefined;

  const requested = (match[1] ?? "")
    .replace(/(?:\s+(?:please|pls|plz|bro|lil\s+bro|gopher))+\s*$/iu, "")
    .trim();
  if (!requested) return DEFAULT_MUSIC_SEARCH;

  if (
    /^(?:(?:some|any|a\s+little|something)\s+)?(?:music|songs?|tunes?|beats?|vibes?|a\s+playlist)$/iu.test(
      requested,
    )
  ) {
    return DEFAULT_MUSIC_SEARCH;
  }

  const artistOnly =
    /^(?:(?:some|any)\s+)?music\s+(?:by|from)\s+(.+)$/iu.exec(requested)?.[1];
  const query = (artistOnly ?? requested).trim();
  return query.length > 0 && query.length <= 500 ? query : undefined;
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
