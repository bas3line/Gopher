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
      "music",
      "server",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  test("publishes durable voice playback controls outside DMs", () => {
    const music = commandData.find((command) => command.name === "music");
    expect(music?.dm_permission).toBeFalse();
    expect(music?.options?.map((option) => option.name)).toEqual([
      "play",
      "queue",
      "now",
      "history",
      "pause",
      "resume",
      "skip",
      "remove",
      "shuffle",
      "volume",
      "seek",
      "stop",
    ]);
  });
});
