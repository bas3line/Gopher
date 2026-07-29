import type { WebSource } from "../types.ts";

const discordLimit = 2_000;
const safeChunkSize = 1_900;

export function withSources(answer: string, sources: WebSource[]): string {
  if (sources.length === 0) return answer.trim();
  const sourceList = sources
    .map((source, index) => `[${index + 1}] ${cleanTitle(source.title)} — <${source.url}>`)
    .join("\n");
  return `${answer.trim()}\n\n**sources**\n${sourceList}`;
}

export function quickCasualReply(input: string): string | undefined {
  const text = input.trim().toLowerCase();
  if (/^(?:h+i+|h+e+l+o+|h+e+y+|yo+)(?:\s+(?:bro|bhai|gopher))?[.?!]*$/.test(text)) {
    return "yo";
  }
  if (/^(?:good\s+morning|gm)[.?!]*$/.test(text)) return "gm";
  if (/^(?:good\s+night|gn)[.?!]*$/.test(text)) return "gn";
  if (/^(?:thanks|thank\s+you|thx|ty)[.?!]*$/.test(text)) return "gotchu";
  return undefined;
}

export function casualizeReply(input: string, maxCharacters = 180): string {
  let text = input
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/!+/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const sentenceEnds = [...text.matchAll(/[.?](?:\s|$)/g)];
  const secondEnd = sentenceEnds[1]?.index;
  if (secondEnd !== undefined) text = text.slice(0, secondEnd + 1).trim();

  if (text.length > maxCharacters) {
    const boundary = text.lastIndexOf(" ", maxCharacters - 3);
    text = `${text.slice(0, boundary > 80 ? boundary : maxCharacters - 3).trimEnd()}...`;
  }
  return text || "nah";
}

export function splitDiscordMessage(input: string): string[] {
  const text = input.trim();
  if (text.length <= discordLimit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > safeChunkSize) {
    let splitAt = remaining.lastIndexOf("\n", safeChunkSize);
    if (splitAt < safeChunkSize * 0.55) splitAt = remaining.lastIndexOf(" ", safeChunkSize);
    if (splitAt < safeChunkSize * 0.55) splitAt = safeChunkSize;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function cleanTitle(title: string): string {
  return title.replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").slice(0, 180);
}
