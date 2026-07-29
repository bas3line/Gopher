import type { ServerEmoji } from "./emojis.ts";

const directedInsult =
  /^(?:(?:kya|abe|abey|oye|oi|hey|yo|haan|aur|chal|sun)\s+)*(?:be+y?\s+)?(?:gandu|chutiya|chutiye|bsdk|bhosdike|lawde|lodu|madarchod|behenchod|mc|bc)\b|\b(?:tu|you|you'?re)\s+(?:bada\s+)?(?:gandu|chutiya|chutiye|bsdk|bhosdike|lawda|lodu)\b/i;

export const tuffEmoji = "<:tuff:1531809280062259260>";

export interface ReactionRequest {
  emoji: string;
  label: string;
}

const explanationLead =
  /^(?:what (?:is|does|do|are)|why|how|define|explain|translate|meaning of)\b/i;
const laughterSignal =
  /(?:^|\s)(?:lmao+|lmfao+|rofl|lol+|nah+h+|i'?m dead|im dead)(?:\s|$)|[😂🤣💀]/i;
const explicitMogSignal =
  /\b(?:mog|mogs|mogged|mogging|ratio|ratioed|skill issue|aura loss|caught in 4k|pack it up)\b/i;
const contextualCookSignal =
  /\b(?:bro|blud|dude|he|she|they|you|this guy|that guy)\b.{0,32}\b(?:got\s+)?(?:cooked|owned|clowned|washed|folded|destroyed)\b/i;
const reactionIntent =
  /\breact\b(?:\s+(?:to|on)\s+(?:this|that|it|the\s+message))?|\b(?:add|put|leave|send)\b.{0,24}\b(?:emoji|reaction)\b/i;
const reactionExplanation =
  /^(?:how|why|what|explain|define|tell me (?:how|why|what))\b/i;
const reactionNegation =
  /\b(?:do not|don'?t|never|stop|remove|delete)\b.{0,18}\b(?:react|reaction)\b/i;
const unicodeEmoji =
  /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*/u;

export function parseReactionRequest(
  content: string,
  serverEmojis: readonly ServerEmoji[] = [],
): ReactionRequest | undefined {
  const text = content.replace(/\s+/g, " ").trim();
  if (
    text.length < 2 ||
    text.length > 500 ||
    !reactionIntent.test(text) ||
    reactionExplanation.test(text) ||
    reactionNegation.test(text) ||
    text.includes("```") ||
    /https?:\/\//i.test(text)
  ) {
    return undefined;
  }

  const custom = text.match(/<a?:[a-z0-9_]+:\d{17,20}>/i)?.[0];
  if (custom) return { emoji: custom, label: "custom emoji" };

  const unicode = text.match(unicodeEmoji)?.[0];
  if (unicode) return { emoji: unicode, label: "requested emoji" };

  const namedServerEmoji = [...serverEmojis]
    .sort((left, right) => right.name.length - left.name.length)
    .find((emoji) => {
      const escaped = emoji.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "i").test(
        text,
      );
    });
  if (namedServerEmoji) {
    return {
      emoji: namedServerEmoji.markup,
      label: namedServerEmoji.name,
    };
  }

  if (/\b(?:tuff|laugh|laughing|funny|mog|mogged|roast)\b/i.test(text)) {
    return { emoji: tuffEmoji, label: "tuff" };
  }
  if (/\b(?:fire|lit)\b/i.test(text)) return { emoji: "🔥", label: "fire" };
  if (/\b(?:heart|love)\b/i.test(text)) return { emoji: "❤️", label: "heart" };
  if (/\b(?:skull|dead)\b/i.test(text)) return { emoji: "💀", label: "skull" };
  if (/\b(?:cry|crying)\b/i.test(text)) return { emoji: "😭", label: "crying" };
  return { emoji: "👍", label: "thumbs up" };
}

export function shouldReactWithTuff(content: string): boolean {
  const text = content.replace(/\s+/g, " ").trim();
  if (
    text.length < 2 ||
    text.length > 1_000 ||
    explanationLead.test(text) ||
    text.includes("```") ||
    /https?:\/\//i.test(text)
  ) {
    return false;
  }
  return (
    directedInsult.test(text) ||
    laughterSignal.test(text) ||
    explicitMogSignal.test(text) ||
    contextualCookSignal.test(text)
  );
}
