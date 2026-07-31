import { ALLOWED_GUILD_ID } from "./guild-policy.ts";

export { ALLOWED_GUILD_ID };

export interface LeaveableGuild {
  readonly id: string;
  leave(): Promise<unknown>;
}

export interface GuildAllowlistResult {
  allowedGuildPresent: boolean;
  leftGuildIds: string[];
  failures: Array<{ guildId: string; error: unknown }>;
}

export function isAllowedGuildId(guildId: string): boolean {
  return guildId === ALLOWED_GUILD_ID;
}

export function shouldHandleGuildContext(
  guildId: string | null | undefined,
): boolean {
  return guildId == null || isAllowedGuildId(guildId);
}

export async function leaveIfDisallowedGuild(
  guild: LeaveableGuild,
): Promise<boolean> {
  if (isAllowedGuildId(guild.id)) return false;
  await guild.leave();
  return true;
}

export async function enforceGuildAllowlist(
  guilds: Iterable<LeaveableGuild>,
): Promise<GuildAllowlistResult> {
  const result: GuildAllowlistResult = {
    allowedGuildPresent: false,
    leftGuildIds: [],
    failures: [],
  };

  for (const guild of guilds) {
    if (isAllowedGuildId(guild.id)) {
      result.allowedGuildPresent = true;
      continue;
    }
    try {
      await guild.leave();
      result.leftGuildIds.push(guild.id);
    } catch (error) {
      result.failures.push({ guildId: guild.id, error });
    }
  }

  return result;
}
