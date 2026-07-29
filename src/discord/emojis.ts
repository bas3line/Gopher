export interface ServerEmoji {
  id: string;
  name: string;
  markup: string;
  animated: boolean;
  imageUrl: string;
}

interface GuildEmojiLike {
  id: string;
  name: string | null;
  animated: boolean | null;
  available: boolean | null;
  imageURL(options?: { size?: 128 }): string;
}

export function buildServerEmojiCatalog(
  emojis: Iterable<GuildEmojiLike>,
): ServerEmoji[] {
  const catalog = new Map<string, ServerEmoji>();
  for (const emoji of emojis) {
    const name = emoji.name?.trim();
    if (!name || emoji.available === false) continue;
    const animated = Boolean(emoji.animated);
    catalog.set(emoji.id, {
      id: emoji.id,
      name,
      markup: `<${animated ? "a" : ""}:${name}:${emoji.id}>`,
      animated,
      imageUrl: emoji.imageURL({ size: 128 }),
    });
  }
  return [...catalog.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function customEmojiImageUrls(
  content: string,
  catalog: readonly ServerEmoji[],
  limit = 4,
): string[] {
  const byId = new Map(catalog.map((emoji) => [emoji.id, emoji.imageUrl]));
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/<a?:[a-z0-9_]+:(\d{17,20})>/gi)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    const url = byId.get(id);
    if (!url) continue;
    urls.push(url);
    seen.add(id);
    if (urls.length >= limit) break;
  }
  return urls;
}
