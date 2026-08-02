import { EmbedBuilder, WebhookClient } from "discord.js";

export interface WebhookLogChannel {
  name: string;
  webhookUrl: string;
  /** Log levels this channel should receive (default: all) */
  levels?: Array<"info" | "warn" | "error" | "debug">;
  /** Topic filter — only log entries with matching topics */
  topics?: string[];
}

const EMBED_LIMIT = 4_096;
const FIELD_LIMIT = 1_024;
const AUTHOR_NAME_LIMIT = 256;

export function createDiscordLogStream(
  channels: WebhookLogChannel[],
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
  const timestamp = String(parsed.time ?? "");

  // Skip uninteresting internal noise
  if (message.includes("health server") || message.includes("worker started")) return;

  // Extract structured fields
  const status = parsed.status as number | undefined;
  const provider = parsed.provider as string | undefined;
  const kind = parsed.kind as string | undefined;
  const latencyMs = parsed.latencyMs as number | undefined;
  const model = parsed.model as string | undefined;
  const success = parsed.success as boolean | undefined;
  const guildId = parsed.guildId as string | undefined;
  const err = parsed.err as Record<string, unknown> | undefined;
  const botUser = parsed.botUser as string | undefined;
  const guilds = parsed.guilds as number | undefined;
  const leftGuildIds = parsed.leftGuildIds as string[] | undefined;
  const failedGuilds = parsed.failedGuilds as number | undefined;
  const emojis = parsed.emojis as number | undefined;
  const signal = parsed.signal as string | undefined;

  // Route to the right webhook channel
  for (const wh of webhooks) {
    if (wh.levels && !wh.levels.includes(level as "info" | "warn" | "error" | "debug")) {
      continue;
    }

    const chosenTopic = pickTopic(parsed, wh.topics);
    if (wh.topics && wh.topics.length > 0 && !chosenTopic) continue;

    const embed = new EmbedBuilder()
      .setTimestamp(new Date(timestamp).getTime() || Date.now())
      .setColor(levelColor(level))
      .setFooter({ text: `Gopher` });

    // Build embed content
    buildEmbed(embed, {
      level,
      message,
      ...(status !== undefined ? { status } : {} as { status?: number }),
      ...(provider !== undefined ? { provider } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(success !== undefined ? { success } : {}),
      ...(guildId !== undefined ? { guildId } : {}),
      ...(err !== undefined ? { err } : {}),
      ...(botUser !== undefined ? { botUser } : {}),
      ...(guilds !== undefined ? { guilds } : {}),
      ...(leftGuildIds !== undefined ? { leftGuildIds } : {}),
      ...(failedGuilds !== undefined ? { failedGuilds } : {}),
      ...(emojis !== undefined ? { emojis } : {}),
      ...(signal !== undefined ? { signal } : {}),
    } as Parameters<typeof buildEmbed>[1]);

    // Truncate oversized fields
    for (const field of embed.data.fields ?? []) {
      if (field.value.length > FIELD_LIMIT) {
        field.value = field.value.slice(0, FIELD_LIMIT - 3) + "...";
      }
    }

    try {
      await wh.client.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch {
      // Silently drop webhook failures to avoid feedback loops
    }
    break;
  }
}

function buildEmbed(
  embed: EmbedBuilder,
  fields: {
    level: string;
    message: string;
    status?: number;
    provider?: string;
    kind?: string;
    latencyMs?: number;
    model?: string;
    success?: boolean;
    guildId?: string;
    err?: Record<string, unknown>;
    botUser?: string;
    guilds?: number;
    leftGuildIds?: string[];
    failedGuilds?: number;
    emojis?: number;
    signal?: string;
  },
): void {
  // Title: the log message itself
  embed.setTitle(truncate(fields.message, AUTHOR_NAME_LIMIT));

  // Build description from details
  const details: string[] = [];

  // Bot lifecycle events
  if (fields.botUser) {
    details.push(`**Bot:** ${fields.botUser}`);
    details.push(`**Guilds:** ${fields.guilds ?? "?"}`);
    embed.setTitle("Bot Online");
  }

  // Shutdown
  if (fields.signal) {
    details.push(`**Signal:** ${fields.signal}`);
    embed.setTitle("Bot Shutting Down");
  }

  // Allowlist enforcement
  if (fields.leftGuildIds !== undefined) {
    if (fields.leftGuildIds.length > 0) {
      details.push(`**Left:** ${fields.leftGuildIds.map((id) => `\`${id}\``).join(", ")}`);
    }
    if (fields.failedGuilds !== undefined && fields.failedGuilds > 0) {
      details.push(`**Failed leaves:** ${fields.failedGuilds}`);
    }
  }

  // Emoji catalog
  if (fields.emojis !== undefined) {
    details.push(`**Emojis loaded:** ${fields.emojis}`);
  }

  // HTTP status
  if (fields.status !== undefined) {
    const statusText = fields.status >= 500 ? "Server Error"
      : fields.status >= 400 ? "Client Error"
      : fields.status >= 300 ? "Redirect"
      : fields.status >= 200 ? "Success"
      : "Info";
    details.push(`**HTTP:** ${fields.status} ${statusText}`);
  }

  // Provider / model
  if (fields.provider) {
    details.push(`**Provider:** ${fields.provider}`);
  }
  if (fields.model) {
    details.push(`**Model:** \`${fields.model.slice(0, 60)}\``);
  }

  // Kind / event type
  if (fields.kind) {
    details.push(`**Event:** ${fields.kind}`);
  }

  // Latency
  if (fields.latencyMs !== undefined) {
    details.push(`**Latency:** ${fields.latencyMs}ms`);
  }

  // Success / failure
  if (fields.success !== undefined) {
    details.push(`**Result:** ${fields.success ? "Success" : "Failure"}`);
  }

  // Guild context
  if (fields.guildId) {
    details.push(`**Guild:** \`${fields.guildId}\``);
  }

  if (details.length > 0) {
    embed.setDescription(details.join("\n"));
  }

  // Error details as a separate field
  if (fields.err) {
    const errMsg = String(fields.err.message ?? fields.err.name ?? "Unknown error");
    const errCode = fields.err.code ? `[${fields.err.code}] ` : "";
    const errStack = String(fields.err.stack ?? "").split("\n").slice(0, 3).join("\n");

    embed.addFields({
      name: "Error",
      value: truncate(`\`\`\`${errCode}${errMsg}\`\`\``, FIELD_LIMIT),
    });

    if (errStack.trim()) {
      embed.addFields({
        name: "Stack",
        value: truncate(`\`\`\`${errStack}\`\`\``, FIELD_LIMIT),
      });
    }
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
    if (topic === "tts" && (
      msg.includes("voice synthesis") ||
      msg.includes("Fish Audio") ||
      msg.includes("Cloudflare Aura") ||
      msg.includes("OpenRouter")
    )) return topic;
    if (topic === "api" && (
      parsed.status !== undefined ||
      msg.includes("HTTP") ||
      msg.includes("returned")
    )) return topic;
    if (topic === "chat" && (
      eventKind === "chat" ||
      eventKind === "voice_chat" ||
      msg.includes("completion") ||
      msg.includes("tool")
    )) return topic;
    if (topic === "error" && (
      parsed.level === "error" ||
      parsed.level === "warn" ||
      parsed.err
    )) return topic;
  }

  return undefined;
}

function levelColor(level: string): number {
  switch (level) {
    case "fatal":
    case "error":   return 0xDC2626; // red
    case "warn":    return 0xD97706; // amber
    case "info":    return 0x3B82F6; // blue
    case "debug":   return 0x6B7280; // gray
    default:         return 0x6B7280;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
