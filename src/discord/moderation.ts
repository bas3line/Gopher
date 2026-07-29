import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  escapeMarkdown,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
} from "discord.js";
import { z } from "zod";
import type { Coordinator } from "../infra/coordinator.ts";
import type { Logger } from "../logger.ts";

const confirmationSeconds = 120;
const customIdPrefix = "servermod";

const actionCommon = {
  version: z.literal(1),
  guildId: z.string().min(1),
  requestedBy: z.string().min(1),
  requestedByName: z.string().min(1).max(100),
  requestedInChannelId: z.string().min(1),
  reason: z.string().max(512).optional(),
};

export const pendingServerActionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...actionCommon,
    kind: z.literal("ban"),
    targetUserId: z.string().min(1),
    targetLabel: z.string().min(1).max(100),
    deleteMessageSeconds: z.number().int().min(0).max(604_800),
  }),
  z.object({
    ...actionCommon,
    kind: z.literal("kick"),
    targetUserId: z.string().min(1),
    targetLabel: z.string().min(1).max(100),
  }),
  z.object({
    ...actionCommon,
    kind: z.literal("timeout"),
    targetUserId: z.string().min(1),
    targetLabel: z.string().min(1).max(100),
    minutes: z.number().int().min(1).max(40_320),
  }),
  z.object({
    ...actionCommon,
    kind: z.literal("role-create"),
    name: z.string().min(1).max(100),
    color: z.number().int().min(0).max(0xff_ff_ff).optional(),
    mentionable: z.boolean(),
  }),
  z.object({
    ...actionCommon,
    kind: z.literal("role-delete"),
    roleId: z.string().min(1),
    roleName: z.string().min(1).max(100),
  }),
  z.object({
    ...actionCommon,
    kind: z.literal("channel-create"),
    name: z.string().min(1).max(100),
    channelType: z.enum(["text", "voice"]),
    parentId: z.string().min(1).optional(),
  }),
  z.object({
    ...actionCommon,
    kind: z.literal("channel-delete"),
    channelId: z.string().min(1),
    channelName: z.string().min(1).max(100),
  }),
]);

export type PendingServerAction = z.infer<typeof pendingServerActionSchema>;

export type NaturalServerRequest =
  | { kind: "ban"; target: string }
  | { kind: "kick"; target: string }
  | { kind: "timeout"; target: string; minutes: number }
  | { kind: "role-create"; name: string }
  | { kind: "channel-create"; name: string; channelType: "text" | "voice" };

class ModerationInputError extends Error {}

export function parseNaturalServerRequest(input: string): NaturalServerRequest | undefined {
  const command = normalizeNaturalCommand(input);
  if (!command) return undefined;

  const targetFirst = /^(.{1,64}?)\s+ko\s+(ban|kick)\s*(?:kar(?:\s*de)?|kr(?:\s*de)?|karde|krde)?\b/iu.exec(
    command,
  );
  if (targetFirst) {
    return {
      kind: targetFirst[2]!.toLowerCase() as "ban" | "kick",
      target: targetFirst[1]!.trim(),
    };
  }

  const verbFirst = /^(ban|kick)\s+(.{1,64}?)(?:\s+(?:please|pls|ab|abb|now))?$/iu.exec(
    command,
  );
  if (verbFirst) {
    return {
      kind: verbFirst[1]!.toLowerCase() as "ban" | "kick",
      target: verbFirst[2]!.trim(),
    };
  }

  const timeout = /^(.{1,64}?)\s+ko\s+(?:timeout|mute)\s+(\d{1,5})\s*(m|min|minutes?|h|hours?)\s*(?:kar(?:\s*de)?|kr(?:\s*de)?|karde|krde)?\b/iu.exec(
    command,
  );
  if (timeout) {
    const amount = Number.parseInt(timeout[2]!, 10);
    const minutes = /^h/i.test(timeout[3]!) ? amount * 60 : amount;
    if (minutes >= 1 && minutes <= 40_320) {
      return { kind: "timeout", target: timeout[1]!.trim(), minutes };
    }
  }

  const role =
    /^(?:create|make)\s+(?:a\s+)?role(?:\s+(?:named|called))?\s+(.{1,100})$/iu.exec(
      command,
    ) ??
    /^role\s+(.{1,100}?)\s+(?:bana(?:\s+de)?|banao|banade)$/iu.exec(command);
  if (role) {
    return { kind: "role-create", name: cleanNaturalName(role[1]!) };
  }

  const channel =
    /^(?:create|make)\s+(?:a\s+)?(?:(text|voice)\s+)?channel(?:\s+(?:named|called))?\s+(.{1,100})$/iu.exec(
      command,
    ) ??
    /^(?:(text|voice)\s+)?channel\s+(.{1,100}?)\s+(?:bana(?:\s+de)?|banao|banade)$/iu.exec(
      command,
    );
  if (channel) {
    return {
      kind: "channel-create",
      name: cleanNaturalName(channel[2]!),
      channelType: channel[1]?.toLowerCase() === "voice" ? "voice" : "text",
    };
  }

  return undefined;
}

export function parseRoleColor(input: string): number {
  if (!/^#?[0-9a-f]{6}$/i.test(input.trim())) {
    throw new ModerationInputError("color needs six hex digits, like `#22c55e`");
  }
  return Number.parseInt(input.trim().replace(/^#/, ""), 16);
}

export function parseModerationCustomId(
  customId: string,
): { decision: "confirm" | "cancel"; token: string } | undefined {
  const match = /^servermod:(confirm|cancel):([0-9a-f-]{36})$/.exec(customId);
  if (!match) return undefined;
  return {
    decision: match[1] as "confirm" | "cancel",
    token: match[2]!,
  };
}

export function describeServerAction(action: PendingServerAction): string {
  switch (action.kind) {
    case "ban":
      return `ban **${safeDisplay(action.targetLabel)}** and delete ${action.deleteMessageSeconds / 86_400} day(s) of messages`;
    case "kick":
      return `kick **${safeDisplay(action.targetLabel)}**`;
    case "timeout":
      return `timeout **${safeDisplay(action.targetLabel)}** for ${action.minutes} minute(s)`;
    case "role-create":
      return `create role **${safeDisplay(action.name)}**`;
    case "role-delete":
      return `delete role **${safeDisplay(action.roleName)}**`;
    case "channel-create":
      return `create ${action.channelType} channel **${safeDisplay(action.name)}**`;
    case "channel-delete":
      return `delete channel **${safeDisplay(action.channelName)}**`;
  }
}

export class ServerModeration {
  constructor(
    private readonly coordinator: Coordinator,
    private readonly logger: Logger,
  ) {}

  async begin(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const guild = requireAdminGuild(interaction);
      const action = buildAction(interaction);
      await assertActionAllowed(guild, action);

      const token = randomUUID();
      const saved = await this.coordinator.savePendingConfirmation(
        token,
        interaction.user.id,
        JSON.stringify(action),
        confirmationSeconds,
      );
      if (!saved) throw new Error("confirmation token collision");

      await interaction.reply({
        content:
          `confirm: ${describeServerAction(action)}?\n` +
          `reason: ${safeDisplay(action.reason ?? "no reason supplied")}\n` +
          "expires in 2 minutes. this is where the joke becomes an audit log.",
        components: [confirmationButtons(token, isDestructive(action.kind))],
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (!(error instanceof ModerationInputError)) {
        this.logger.warn({ err: error }, "failed to prepare server action");
      }
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content:
            error instanceof ModerationInputError
              ? error.message
              : "discord said no before we even reached the big red button.",
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
      }
    }
  }

  async beginFromMessage(message: Message, content: string): Promise<boolean> {
    if (
      !message.inGuild() ||
      !message.member?.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      return false;
    }

    const request = parseNaturalServerRequest(content);
    if (!request) return false;

    try {
      const action = await buildNaturalAction(message, request);
      await assertActionAllowed(message.guild, action);

      const token = randomUUID();
      const saved = await this.coordinator.savePendingConfirmation(
        token,
        message.author.id,
        JSON.stringify(action),
        confirmationSeconds,
      );
      if (!saved) throw new Error("confirmation token collision");

      await message.reply({
        content:
          `confirm: ${describeServerAction(action)}?\n` +
          "expires in 2 minutes. press it yourself; spectators get nothing.",
        components: [confirmationButtons(token, isDestructive(action.kind))],
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      if (!(error instanceof ModerationInputError)) {
        this.logger.warn({ err: error }, "failed to prepare natural server action");
      }
      await message.reply({
        content:
          error instanceof ModerationInputError
            ? error.message
            : "discord rejected the paperwork before the button spawned.",
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
    return true;
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const parsedId = parseModerationCustomId(interaction.customId);
    if (!parsedId) return false;

    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "server only.", ephemeral: true });
      return true;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: "nice button. admin hands only.",
        ephemeral: true,
      });
      return true;
    }

    const pending = await this.coordinator.consumePendingConfirmation(
      parsedId.token,
      interaction.user.id,
    );
    if (pending.status === "forbidden") {
      await interaction.reply({
        content: "not your button, tiny dictator.",
        ephemeral: true,
      });
      return true;
    }
    if (pending.status === "missing") {
      await interaction.update({
        content: "that confirmation expired or was already used.",
        components: [],
      });
      return true;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(pending.payload);
    } catch {
      decoded = undefined;
    }
    const parsedAction = pendingServerActionSchema.safeParse(decoded);
    if (!parsedAction.success || parsedAction.data.guildId !== interaction.guildId) {
      this.logger.error(
        { validation: parsedAction.success ? "guild_mismatch" : parsedAction.error.issues },
        "invalid pending server action",
      );
      await interaction.update({
        content: "that confirmation was invalid. nothing happened.",
        components: [],
      });
      return true;
    }

    const action = parsedAction.data;
    if (parsedId.decision === "cancel") {
      await interaction.update({
        content: `cancelled: ${describeServerAction(action)}. democracy survives another minute.`,
        components: [],
        allowedMentions: { parse: [] },
      });
      return true;
    }

    await interaction.deferUpdate();
    try {
      const guild = interaction.guild;
      await assertActionAllowed(guild, action);
      const result = await executeAction(guild, action);
      await interaction.editReply({
        content: result,
        components: [],
        allowedMentions: { parse: [] },
      });
      this.logger.info(
        {
          action: action.kind,
          guildId: action.guildId,
          requestedBy: action.requestedBy,
        },
        "confirmed server action completed",
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          action: action.kind,
          guildId: action.guildId,
          requestedBy: action.requestedBy,
        },
        "confirmed server action failed",
      );
      await interaction.editReply({
        content:
          error instanceof ModerationInputError
            ? error.message
            : "discord blocked it. hierarchy or permissions probably said sit down.",
        components: [],
        allowedMentions: { parse: [] },
      });
    }
    return true;
  }
}

function requireAdminGuild(interaction: ChatInputCommandInteraction): Guild {
  if (!interaction.inCachedGuild()) {
    throw new ModerationInputError("server only.");
  }
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    throw new ModerationInputError("admin only. nice try though.");
  }
  return interaction.guild;
}

function buildAction(interaction: ChatInputCommandInteraction): PendingServerAction {
  if (!interaction.guildId || !interaction.channelId) {
    throw new ModerationInputError("server channel only.");
  }
  const reason = interaction.options.getString("reason")?.trim();
  const common = {
    version: 1 as const,
    guildId: interaction.guildId,
    requestedBy: interaction.user.id,
    requestedByName: interaction.user.username,
    requestedInChannelId: interaction.channelId,
    ...(reason ? { reason } : {}),
  };

  switch (interaction.options.getSubcommand(true)) {
    case "ban": {
      const user = interaction.options.getUser("user", true);
      return {
        ...common,
        kind: "ban",
        targetUserId: user.id,
        targetLabel: user.username,
        deleteMessageSeconds: (interaction.options.getInteger("delete_days") ?? 0) * 86_400,
      };
    }
    case "kick": {
      const user = interaction.options.getUser("user", true);
      return {
        ...common,
        kind: "kick",
        targetUserId: user.id,
        targetLabel: user.username,
      };
    }
    case "timeout": {
      const user = interaction.options.getUser("user", true);
      return {
        ...common,
        kind: "timeout",
        targetUserId: user.id,
        targetLabel: user.username,
        minutes: interaction.options.getInteger("minutes", true),
      };
    }
    case "role-create": {
      const colorInput = interaction.options.getString("color");
      return {
        ...common,
        kind: "role-create",
        name: interaction.options.getString("name", true).trim(),
        mentionable: interaction.options.getBoolean("mentionable") ?? false,
        ...(colorInput ? { color: parseRoleColor(colorInput) } : {}),
      };
    }
    case "role-delete": {
      const role = interaction.options.getRole("role", true);
      return {
        ...common,
        kind: "role-delete",
        roleId: role.id,
        roleName: role.name,
      };
    }
    case "channel-create": {
      const parent = interaction.options.getChannel("category");
      return {
        ...common,
        kind: "channel-create",
        name: interaction.options.getString("name", true).trim(),
        channelType: z
          .enum(["text", "voice"])
          .parse(interaction.options.getString("type", true)),
        ...(parent ? { parentId: parent.id } : {}),
      };
    }
    case "channel-delete": {
      const channel = interaction.options.getChannel("channel", true);
      return {
        ...common,
        kind: "channel-delete",
        channelId: channel.id,
        channelName: channel.name ?? channel.id,
      };
    }
    default:
      throw new ModerationInputError("unknown server action.");
  }
}

async function buildNaturalAction(
  message: Message<true>,
  request: NaturalServerRequest,
): Promise<PendingServerAction> {
  const common = {
    version: 1 as const,
    guildId: message.guildId,
    requestedBy: message.author.id,
    requestedByName: message.member?.displayName ?? message.author.username,
    requestedInChannelId: message.channelId,
    reason: "requested through admin chat confirmation",
  };

  if (request.kind === "ban" || request.kind === "kick" || request.kind === "timeout") {
    const target = await resolveNaturalMember(message, request.target);
    const memberAction = {
      ...common,
      targetUserId: target.id,
      targetLabel: target.displayName,
    };
    if (request.kind === "ban") {
      return {
        ...memberAction,
        kind: "ban",
        deleteMessageSeconds: 0,
      };
    }
    if (request.kind === "kick") {
      return { ...memberAction, kind: "kick" };
    }
    return {
      ...memberAction,
      kind: "timeout",
      minutes: request.minutes,
    };
  }

  if (request.kind === "role-create") {
    if (!request.name) throw new ModerationInputError("role name is empty.");
    return {
      ...common,
      kind: "role-create",
      name: request.name,
      mentionable: false,
    };
  }

  if (!request.name) throw new ModerationInputError("channel name is empty.");
  return {
    ...common,
    kind: "channel-create",
    name: request.name,
    channelType: request.channelType,
  };
}

async function resolveNaturalMember(
  message: Message<true>,
  targetText: string,
): Promise<GuildMember> {
  const mentioned = [...message.mentions.users.values()].filter(
    (user) => user.id !== message.client.user.id,
  );
  if (mentioned.length > 1) {
    throw new ModerationInputError("mention exactly one target. firing squad syntax is disabled.");
  }
  if (mentioned.length === 1) {
    return fetchMember(message.guild, mentioned[0]!.id, "that member is not in this server.");
  }

  const mentionId = /^<@!?(\d+)>$/.exec(targetText.trim())?.[1];
  if (mentionId) {
    return fetchMember(message.guild, mentionId, "that member is not in this server.");
  }

  const query = targetText.trim().replace(/^@/, "");
  if (!query) throw new ModerationInputError("mention the target or give their exact name.");

  const exactMatches = (members: Iterable<GuildMember>): GuildMember[] => {
    const wanted = query.toLocaleLowerCase();
    return [...members].filter((member) =>
      [member.displayName, member.user.username, member.user.globalName]
        .filter((name): name is string => Boolean(name))
        .some((name) => name.toLocaleLowerCase() === wanted),
    );
  };

  let matches = exactMatches(message.guild.members.cache.values());
  if (matches.length !== 1) {
    try {
      const fetched = await message.guild.members.fetch({
        query: query.slice(0, 32),
        limit: 25,
        time: 10_000,
      });
      matches = exactMatches(fetched.values());
    } catch {
      matches = [];
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ModerationInputError("that name matches multiple people. mention the exact user.");
  }
  throw new ModerationInputError(
    `cannot find an exact member named **${safeDisplay(query)}**. mention them or use \`/server\`.`,
  );
}

async function assertActionAllowed(guild: Guild, action: PendingServerAction): Promise<void> {
  const [requester, botMember] = await Promise.all([
    fetchMember(guild, action.requestedBy, "requesting admin left the server."),
    guild.members.fetchMe(),
  ]);
  if (!requester.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new ModerationInputError("you are not an administrator anymore.");
  }

  const requiredPermission = permissionFor(action.kind);
  if (!botMember.permissions.has(requiredPermission)) {
    throw new ModerationInputError(`Gopher is missing ${permissionName(action.kind)}.`);
  }

  if (action.kind === "ban" || action.kind === "kick" || action.kind === "timeout") {
    if (action.targetUserId === action.requestedBy) {
      throw new ModerationInputError("not doing admin self-harm today.");
    }
    if (action.targetUserId === botMember.id) {
      throw new ModerationInputError("bro tried to make me moderate myself.");
    }
    const target = await fetchMember(guild, action.targetUserId, "that member is no longer here.");
    if (
      requester.id !== guild.ownerId &&
      requester.roles.highest.comparePositionTo(target.roles.highest) <= 0
    ) {
      throw new ModerationInputError("your role is not above that member.");
    }
    if (action.kind === "ban" && !target.bannable) {
      throw new ModerationInputError("i cannot ban that member because of role hierarchy.");
    }
    if (action.kind === "kick" && !target.kickable) {
      throw new ModerationInputError("i cannot kick that member because of role hierarchy.");
    }
    if (action.kind === "timeout" && !target.moderatable) {
      throw new ModerationInputError("i cannot timeout that member because of role hierarchy.");
    }
  }

  if (action.kind === "role-delete") {
    const role = await guild.roles.fetch(action.roleId);
    if (!role) throw new ModerationInputError("that role no longer exists.");
    if (role.id === guild.id || role.managed) {
      throw new ModerationInputError("that role is managed by Discord and cannot be deleted.");
    }
    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      throw new ModerationInputError("that role is above my highest role.");
    }
    if (
      requester.id !== guild.ownerId &&
      requester.roles.highest.comparePositionTo(role) <= 0
    ) {
      throw new ModerationInputError("that role is not below your highest role.");
    }
  }

  if (action.kind === "channel-create" && action.parentId) {
    const parent = await guild.channels.fetch(action.parentId);
    if (!parent || parent.type !== ChannelType.GuildCategory) {
      throw new ModerationInputError("that category no longer exists.");
    }
  }

  if (action.kind === "channel-delete") {
    if (action.channelId === action.requestedInChannelId) {
      throw new ModerationInputError(
        "not deleting the channel holding the confirmation. choose another channel.",
      );
    }
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel) throw new ModerationInputError("that channel no longer exists.");
  }
}

async function executeAction(guild: Guild, action: PendingServerAction): Promise<string> {
  const reason = auditReason(action);
  switch (action.kind) {
    case "ban":
      await guild.bans.create(action.targetUserId, {
        deleteMessageSeconds: action.deleteMessageSeconds,
        reason,
      });
      return `banned **${safeDisplay(action.targetLabel)}**. bro got evicted from the jpeg.`;
    case "kick": {
      const member = await fetchMember(guild, action.targetUserId, "that member already left.");
      await member.kick(reason);
      return `kicked **${safeDisplay(action.targetLabel)}**. gravity update installed.`;
    }
    case "timeout": {
      const member = await fetchMember(guild, action.targetUserId, "that member already left.");
      await member.timeout(action.minutes * 60_000, reason);
      return `timed out **${safeDisplay(action.targetLabel)}** for ${action.minutes} minute(s). touch-grass protocol active.`;
    }
    case "role-create": {
      const role = await guild.roles.create({
        name: action.name,
        mentionable: action.mentionable,
        reason,
        ...(action.color === undefined ? {} : { color: action.color }),
      });
      return `created role **${safeDisplay(role.name)}**. fresh bureaucracy just dropped.`;
    }
    case "role-delete": {
      const role = await guild.roles.fetch(action.roleId);
      if (!role) throw new ModerationInputError("that role already vanished.");
      await role.delete(reason);
      return `deleted role **${safeDisplay(action.roleName)}**. unemployment speedrun complete.`;
    }
    case "channel-create": {
      const channel = await guild.channels.create({
        name: action.name,
        type:
          action.channelType === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText,
        reason,
        ...(action.parentId ? { parent: action.parentId } : {}),
      });
      return `created **${safeDisplay(channel.name)}**. another room for zero productivity.`;
    }
    case "channel-delete": {
      const channel = await guild.channels.fetch(action.channelId);
      if (!channel) throw new ModerationInputError("that channel already vanished.");
      await channel.delete(reason);
      return `deleted **${safeDisplay(action.channelName)}**. digital real estate demolished.`;
    }
  }
}

function confirmationButtons(
  token: string,
  destructive: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:confirm:${token}`)
      .setLabel("confirm")
      .setStyle(destructive ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:cancel:${token}`)
      .setLabel("cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function isDestructive(kind: PendingServerAction["kind"]): boolean {
  return new Set<PendingServerAction["kind"]>([
    "ban",
    "kick",
    "timeout",
    "role-delete",
    "channel-delete",
  ]).has(kind);
}

function permissionFor(kind: PendingServerAction["kind"]): bigint {
  switch (kind) {
    case "ban":
      return PermissionFlagsBits.BanMembers;
    case "kick":
      return PermissionFlagsBits.KickMembers;
    case "timeout":
      return PermissionFlagsBits.ModerateMembers;
    case "role-create":
    case "role-delete":
      return PermissionFlagsBits.ManageRoles;
    case "channel-create":
    case "channel-delete":
      return PermissionFlagsBits.ManageChannels;
  }
}

function permissionName(kind: PendingServerAction["kind"]): string {
  switch (kind) {
    case "ban":
      return "Ban Members";
    case "kick":
      return "Kick Members";
    case "timeout":
      return "Moderate Members";
    case "role-create":
    case "role-delete":
      return "Manage Roles";
    case "channel-create":
    case "channel-delete":
      return "Manage Channels";
  }
}

async function fetchMember(guild: Guild, userId: string, message: string): Promise<GuildMember> {
  try {
    return await guild.members.fetch(userId);
  } catch {
    throw new ModerationInputError(message);
  }
}

function auditReason(action: PendingServerAction): string {
  return `Gopher /server by ${action.requestedByName} (${action.requestedBy}): ${action.reason ?? "no reason supplied"}`.slice(
    0,
    512,
  );
}

function safeDisplay(value: string): string {
  return escapeMarkdown(value).replaceAll("@", "@\u200b");
}

function normalizeNaturalCommand(value: string): string {
  return value
    .trim()
    .replace(/^(?:(?:<@!?\d+>|<@&\d+>)\s*)+/u, "")
    .replace(/^(?:(?:bhai|bro|abe|oye|oi|gopher|please)\b[\s,:-]*)+/iu, "")
    .trim();
}

function cleanNaturalName(value: string): string {
  return value.trim().replace(/^(["'`])(.+)\1$/u, "$2").trim();
}
