import { describe, expect, test } from "bun:test";
import { commandData } from "../src/discord/commands.ts";

describe("slash commands", () => {
  test("publishes one unique definition for every supported command", () => {
    const names = commandData.map((command) => command.name);
    expect(names).toEqual([
      "ask",
      "search",
      "voice",
      "card",
      "memory",
      "about",
      "server",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
