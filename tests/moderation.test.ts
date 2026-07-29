import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { commandData } from "../src/discord/commands.ts";
import {
  describeServerAction,
  parseNaturalServerRequest,
  parseModerationCustomId,
  parseRoleColor,
  pendingServerActionSchema,
} from "../src/discord/moderation.ts";

describe("server moderation commands", () => {
  test("registers admin-only server subcommands outside DMs", () => {
    const command = commandData.find((entry) => entry.name === "server");
    expect(command).toBeDefined();
    expect(command?.default_member_permissions).toBe(
      PermissionFlagsBits.Administrator.toString(),
    );
    expect(command?.dm_permission).toBe(false);
    expect(command?.options?.map((option) => option.name)).toEqual([
      "ban",
      "kick",
      "timeout",
      "role-create",
      "role-delete",
      "channel-create",
      "channel-delete",
    ]);
  });

  test("accepts only six-digit role colors", () => {
    expect(parseRoleColor("#22c55e")).toBe(0x22c55e);
    expect(parseRoleColor("FF00aa")).toBe(0xff00aa);
    expect(() => parseRoleColor("#fff")).toThrow("six hex digits");
    expect(() => parseRoleColor("not-a-color")).toThrow("six hex digits");
  });

  test("parses explicit admin chat imperatives without hijacking discussion", () => {
    expect(
      parseNaturalServerRequest("bhai drexy ko ban karde abb admin perms dediye"),
    ).toEqual({
      kind: "ban",
      target: "drexy",
    });
    expect(parseNaturalServerRequest("<@&123> bhai drexy ko kick kar de")).toEqual({
      kind: "kick",
      target: "drexy",
    });
    expect(parseNaturalServerRequest("drexy ko timeout 2 hours karde")).toEqual({
      kind: "timeout",
      target: "drexy",
      minutes: 120,
    });
    expect(parseNaturalServerRequest("create role unemployed")).toEqual({
      kind: "role-create",
      name: "unemployed",
    });
    expect(parseNaturalServerRequest("voice channel bakchodi bana de")).toEqual({
      kind: "channel-create",
      name: "bakchodi",
      channelType: "voice",
    });
    expect(parseNaturalServerRequest("what if we ban drexy?")).toBeUndefined();
    expect(parseNaturalServerRequest("can you create roles?")).toBeUndefined();
  });

  test("parses only scoped confirmation button IDs", () => {
    const token = "00000000-0000-4000-8000-000000000000";
    expect(parseModerationCustomId(`servermod:confirm:${token}`)).toEqual({
      decision: "confirm",
      token,
    });
    expect(parseModerationCustomId(`servermod:cancel:${token}`)).toEqual({
      decision: "cancel",
      token,
    });
    expect(parseModerationCustomId(`other:confirm:${token}`)).toBeUndefined();
    expect(parseModerationCustomId("servermod:confirm:not-a-uuid")).toBeUndefined();
  });

  test("validates bounded pending actions and describes them without mentions", () => {
    const action = pendingServerActionSchema.parse({
      version: 1,
      kind: "ban",
      guildId: "guild",
      requestedBy: "admin",
      requestedByName: "shubham",
      requestedInChannelId: "channel",
      targetUserId: "target",
      targetLabel: "@everyone",
      deleteMessageSeconds: 86_400,
      reason: "being deeply unemployed",
    });
    expect(describeServerAction(action)).toContain("@\u200beveryone");
    expect(() =>
      pendingServerActionSchema.parse({
        ...action,
        deleteMessageSeconds: 604_801,
      }),
    ).toThrow();
  });
});
