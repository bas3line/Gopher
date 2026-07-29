export interface ResponseDecisionInput {
  content: string;
  mode: "mentions" | "ambient";
  isDirectMessage: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  isOwner: boolean;
  mentionsOtherRecipients: boolean;
  hasImage: boolean;
  random?: number;
  ambientReplyChance: number;
}

export type ResponseDecision = "direct" | "ambient" | "ignore";

const goSignals =
  /\b(golang|goroutine|goroutines|go\.mod|go\.sum|gofmt|go test|go vet|pprof|channel|mutex|context\.context|interface|struct|panic|data race|race detector)\b/i;
const directAddress =
  /^(?:(?:yo|hey|oi)\s+(?:bot|gopher)\b|bot\b|gopher\b|senior\b|review this\b|help\b)/i;
const questionLead =
  /^(how|why|what|when|where|which|who|can|could|should|would|is|are|do|does|did)\b/i;

export function decideResponse(input: ResponseDecisionInput): ResponseDecision {
  if (input.isDirectMessage || input.isMentioned || input.isReplyToBot)
    return "direct";

  const text = input.content.trim();
  if (directAddress.test(text)) return "direct";
  if (input.mentionsOtherRecipients) return "ignore";
  if (input.isOwner && isOwnerInstruction(text)) return "direct";
  if (input.mode === "mentions") return "ignore";
  if (!text && input.hasImage) return "ambient";
  if ((text.includes("?") || questionLead.test(text)) && goSignals.test(text))
    return "ambient";

  const roll = input.random ?? Math.random();
  const looksLikeQuestion = text.includes("?") || questionLead.test(text);
  const chance = looksLikeQuestion
    ? Math.max(input.ambientReplyChance, 0.7)
    : input.ambientReplyChance;
  return text.length >= 5 && roll < chance ? "ambient" : "ignore";
}

export function isOwnerInstruction(content: string): boolean {
  return /^(?:(?:bro|bhai|gopher)[,\s]+)?(?:please\s+)?(?:do|make|create|add|remove|delete|change|set|use|send|say|reply|react|search|find|look up|explain|tell|show|give|write|draft|translate|summarize|compare|check|fix|update|stop|start|enable|disable|remember|forget|ban|kick|timeout|mute|unmute)\b/i.test(
    content.trim(),
  );
}

export function shouldRespond(input: ResponseDecisionInput): boolean {
  return decideResponse(input) !== "ignore";
}

export function stripBotMention(content: string, botUserId: string): string {
  return content
    .replaceAll(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), "")
    .trim();
}

export function needsWebSearch(content: string): boolean {
  return (
    /\b(search (the )?web|web ?search|look (it )?up|google it|find sources?|cite sources?)\b/i.test(
      content,
    ) ||
    /\b(latest|current|today|this week|recent|news|released?|release notes?|version|deprecated|cve|vulnerability|docs?)\b/i.test(
      content,
    )
  );
}

export function wantsImageCard(content: string): boolean {
  return /\b(make|send|generate|create|give me)\b.{0,24}\b(image|meme|card|poster|receipt)\b/i.test(
    content,
  );
}

export function wantsVoiceReply(content: string): boolean {
  return (
    /\b(?:send|reply|respond|answer|say|speak|talk)\b.{0,32}\b(?:voice(?:\s+(?:message|note|reply))?|audio|out loud)\b/i.test(
      content,
    ) ||
    /\b(?:voice\s+(?:message|note|reply)|audio\s+reply)\b/i.test(content) ||
    /\b(?:voice|audio)\s+(?:mein|me)\b/i.test(content)
  );
}

export function isAnswerRequest(content: string): boolean {
  const text = content.trim();
  return (
    text.includes("?") ||
    questionLead.test(text) ||
    /^(?:explain|tell me|teach me|give me|show me|compare|summarize|write|draft|translate|solve|calculate|recommend|list)\b/i.test(
      text,
    )
  );
}

export function isTechnicalRequest(content: string): boolean {
  return (
    goSignals.test(content) ||
    /```|(?:^|\s)(?:typescript|javascript|rust|python|docker|kubernetes|postgres|redis|api|sdk|database|compiler|stack trace|exception|segfault|code)\b/i.test(
      content,
    )
  );
}

export function requestsConversationContext(content: string): boolean {
  return /\b(remember|remind me|earlier|before|last time|previously|you said|i said|we (?:talked|discussed|were saying)|continue|carry on|pick (?:it )?up|pick up where|where were we|what did (?:i|you|we)|what was (?:that|it)|who was that|what about (?:that|it)|that thing|same thing|and then|then what)\b/i.test(
    content,
  );
}

export type ConversationContextMode = "none" | "recent" | "full";

export function referencesRecentConversation(content: string): boolean {
  return (
    requestsConversationContext(content) ||
    /\b(this|that|it|those|them|he|she|they)\b/i.test(content) ||
    /^(and|but|so|then|why|how so|wdym|same|fr|really|no way|yes|no|nah)\b/i.test(
      content.trim(),
    )
  );
}

export function decideConversationContext(input: {
  ambient: boolean;
  casual: boolean;
  forceRecent: boolean;
  content: string;
}): ConversationContextMode {
  if (input.ambient) return "recent";
  if (!input.casual || requestsConversationContext(input.content))
    return "full";
  if (input.forceRecent || referencesRecentConversation(input.content))
    return "recent";
  return "none";
}

export function buildConversationRetrievalQuery(
  content: string,
  recentHumanMessages: string[],
): string {
  const question = content.trim();
  if (!requestsConversationContext(question)) return question;

  const context = recentHumanMessages
    .map((message) => message.replace(/\s+/g, " ").trim())
    .filter((message) => message.length >= 4 && message !== question)
    .slice(-4);

  return [question, ...context].join(" OR ").slice(0, 2_000);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
