import { WebhookClient } from "discord.js";
import type { Logger } from "../logger.ts";

export interface WebhookLogChannel {
  name: string;
  webhookUrl: string;
  /** Log levels this channel should receive (default: all) */
  levels?: Array<"info" | "warn" | "error" | "debug">;
  /** Topic filter — only log entries with matching topics */
  topics?: string[];
}

const MAX_DISCORD_MESSAGE = 1_900;

export function createDiscordLogStream(
  channels: WebhookLogChannel[],
  _logger?: Logger | null,
) {
  const webhooks = channels.map((ch) => ({
    ...ch,
    client: new WebhookClient({ url: ch.webhookUrl }),
  }));

  return {
    write(line: string) {
      void forwardToWebhooks(line, webhooks);
    },
  };
}

async function forwardToWebhooks(
  line: string,
  webhooks: Array<WebhookLogChannel & { client: WebhookClient }>,
): Promise<void> {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const level = String(parsed.level ?? "info");
  const message = String(parsed.msg ?? parsed.message ?? "");
  const time = String(parsed.time ?? "").slice(0, 19).replace("T", " ");

  // Extract known fields
  const status = parsed.status as number | undefined;
  const provider = parsed.provider as string | undefined;
  const kind = parsed.kind as string | undefined;
  const latencyMs = parsed.latencyMs as number | undefined;
  const model = parsed.model as string | undefined;
  const success = parsed.success as boolean | undefined;
  const guildId = parsed.guildId as string | undefined;
  const err = parsed.err as Record<string, unknown> | undefined;

  // Pick the right channel
  for (const wh of webhooks) {
    if (wh.levels && !wh.levels.includes(level as "info" | "warn" | "error" | "debug")) {
      continue;
    }

    // Topic routing
    const chosenTopic = pickTopic(parsed, wh.topics);
    if (wh.topics && wh.topics.length > 0 && !chosenTopic) continue;

    let content = formatLogEntry({
      level,
      message,
      time,
      ...(status !== undefined ? { status } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(success !== undefined ? { success } : {}),
      ...(guildId !== undefined ? { guildId } : {}),
      ...(err !== undefined ? { err } : {}),
      topic: chosenTopic,
    } as Parameters<typeof formatLogEntry>[0]);

    // Truncate to Discord limit
    if (content.length > MAX_DISCORD_MESSAGE) {
      content = content.slice(0, MAX_DISCORD_MESSAGE - 3) + "...";
    }

    try {
      await wh.client.send({ content, allowedMentions: { parse: [] } });
    } catch {
      // webhook failures are silent to avoid feedback loops
    }
    break; // only send to first matching channel
  }
}

function pickTopic(
  parsed: Record<string, unknown>,
  topics?: string[],
): string | undefined {
  if (!topics || topics.length === 0) return "general";

  const msg = String(parsed.msg ?? parsed.message ?? "");
  const eventKind = String(parsed.kind ?? "");

  for (const topic of topics) {
    if (topic === "voice" && eventKind === "voice_chat") return topic;
    if (topic === "tts" && (msg.includes("voice synthesis") || msg.includes("Fish Audio") || msg.includes("Cloudflare Aura") || msg.includes("OpenRouter"))) return topic;
    if (topic === "api" && (parsed.status !== undefined || msg.includes("HTTP") || msg.includes("returned"))) return topic;
    if (topic === "chat" && (eventKind === "chat" || eventKind === "voice_chat" || msg.includes("completion") || msg.includes("tool"))) return topic;
    if (topic === "error" && (parsed.level === "error" || parsed.level === "warn" || parsed.err)) return topic;
  }

  return undefined;
}

function formatLogEntry(fields: {
  level: string;
  message: string;
  time: string;
  status?: number;
  provider?: string;
  kind?: string;
  latencyMs?: number;
  model?: string;
  success?: boolean;
  guildId?: string;
  err?: Record<string, unknown>;
  topic?: string;
}): string {
  const parts: string[] = [];
  const emoji = levelEmoji(fields.level);

  // Header
  let header = `${emoji} \`${fields.time}\``;
  if (fields.guildId) header += ` \`G:${fields.guildId.slice(-6)}\``;
  parts.push(header);

  // Main message
  parts.push(`**${fields.message}**`);

  // Details
  const details: string[] = [];
  if (fields.status) details.push(`HTTP ${fields.status}`);
  if (fields.provider) details.push(fields.provider);
  if (fields.model) details.push(`\`${fields.model.slice(0, 30)}\``);
  if (fields.kind) details.push(fields.kind);
  if (fields.latencyMs !== undefined) details.push(`${fields.latencyMs}ms`);
  if (fields.success !== undefined) {
    details.push(fields.success ? "✅" : "❌");
  }
  if (details.length) parts.push(details.join(" · "));

  // Error detail
  if (fields.err) {
    const errMsg = String(fields.err.message ?? fields.err.name ?? "");
    const errCode = String(fields.err.code ?? "");
    if (errMsg) {
      parts.push(`\`\`\`${errMsg.slice(0, 200)}${errCode ? ` [${errCode}]` : ""}\`\`\``);
    }
  }

  return parts.join("\n");
}

function levelEmoji(level: string): string {
  switch (level) {
    case "error": return "🔴";
    case "warn": return "🟡";
    case "info": return "🔵";
    case "debug": return "⚪";
    default: return "📝";
  }
}
