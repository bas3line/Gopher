import { describe, expect, test } from "bun:test";
import {
  allowedGuildIds,
  enforceGuildAllowlist,
  isAllowedGuildId,
  leaveIfDisallowedGuild,
  shouldHandleGuildContext,
} from "../src/discord/guild-allowlist.ts";

const TEST_GUILD_ID = "1515356172092178512";

describe("Discord guild allowlist", () => {
  test("keeps only the explicitly allowed guild while preserving DMs", () => {
    expect(isAllowedGuildId(TEST_GUILD_ID)).toBeTrue();
    expect(isAllowedGuildId("111111111111111111")).toBeFalse();
    expect(shouldHandleGuildContext(TEST_GUILD_ID)).toBeTrue();
    expect(shouldHandleGuildContext(null)).toBeTrue();
    expect(shouldHandleGuildContext(undefined)).toBeTrue();
    expect(shouldHandleGuildContext("111111111111111111")).toBeFalse();
  });

  test("the join listener leaves a disallowed guild and keeps the allowed one", async () => {
    let disallowedLeaveCalls = 0;
    let allowedLeaveCalls = 0;
    expect(
      await leaveIfDisallowedGuild({
        id: "111111111111111111",
        leave: async () => {
          disallowedLeaveCalls += 1;
        },
      }),
    ).toBeTrue();
    expect(
      await leaveIfDisallowedGuild({
        id: TEST_GUILD_ID,
        leave: async () => {
          allowedLeaveCalls += 1;
        },
      }),
    ).toBeFalse();
    expect(disallowedLeaveCalls).toBe(1);
    expect(allowedLeaveCalls).toBe(0);
  });

  test("startup leaves every disallowed guild and reports individual failures", async () => {
    const left: string[] = [];
    const result = await enforceGuildAllowlist([
      {
        id: "111111111111111111",
        leave: async () => {
          left.push("111111111111111111");
        },
      },
      {
        id: TEST_GUILD_ID,
        leave: async () => {
          throw new Error("allowed guild must never be left");
        },
      },
      {
        id: "222222222222222222",
        leave: async () => {
          throw new Error("Discord rejected the leave request");
        },
      },
      {
        id: "333333333333333333",
        leave: async () => {
          left.push("333333333333333333");
        },
      },
    ]);

    expect(left).toEqual(["111111111111111111", "333333333333333333"]);
    expect(result.allowedGuildPresent).toBeTrue();
    expect(result.leftGuildIds).toEqual([
      "111111111111111111",
      "333333333333333333",
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.guildId).toBe("222222222222222222");
  });
});
