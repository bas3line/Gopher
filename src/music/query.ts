export class MusicQueryError extends Error {}

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
