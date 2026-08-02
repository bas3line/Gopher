import type { DatabasePool } from "../db/pool.ts";

// Primary guild from config — always allowed.
let configGuildIds = new Set<string>(["1515356172092178512"]);

// Additional guilds loaded from the database.
const dbGuildIds = new Set<string>();

let pool: DatabasePool | undefined;

export function initAllowlist(
  dbPool: DatabasePool,
  configGuilds: string[],
): void {
  pool = dbPool;
  configGuildIds = new Set(configGuilds);
}

/** Load additional allowed guild IDs from the database. */
export async function loadDbAllowlist(): Promise<void> {
  if (!pool) return;
  const result = await pool.query<{ guild_id: string }>(
    "SELECT guild_id FROM guild_allowlist",
  );
  for (const row of result.rows) {
    dbGuildIds.add(row.guild_id);
  }
}

export function isAllowedGuildId(guildId: string): boolean {
  return configGuildIds.has(guildId) || dbGuildIds.has(guildId);
}

export function allowedGuildIds(): string[] {
  return [...configGuildIds, ...dbGuildIds];
}

export function shouldHandleGuildContext(
  guildId: string | null | undefined,
): boolean {
  return guildId == null || isAllowedGuildId(guildId);
}

export async function addGuildToAllowlist(
  guildId: string,
  addedBy: string,
): Promise<boolean> {
  if (!pool) throw new Error("Allowlist not initialised");
  if (isAllowedGuildId(guildId)) return false;
  await pool.query(
    "INSERT INTO guild_allowlist (guild_id, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [guildId, addedBy],
  );
  dbGuildIds.add(guildId);
  return true;
}

export async function removeGuildFromAllowlist(
  guildId: string,
): Promise<boolean> {
  if (!pool) throw new Error("Allowlist not initialised");
  if (configGuildIds.has(guildId)) return false; // can't remove config guilds
  const result = await pool.query(
    "DELETE FROM guild_allowlist WHERE guild_id = $1",
    [guildId],
  );
  if ((result.rowCount ?? 0) > 0) {
    dbGuildIds.delete(guildId);
    return true;
  }
  return false;
}

export interface LeaveableGuild {
  readonly id: string;
  leave(): Promise<unknown>;
}

export interface GuildAllowlistResult {
  allowedGuildPresent: boolean;
  leftGuildIds: string[];
  failures: Array<{ guildId: string; error: unknown }>;
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
