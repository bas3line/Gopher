import { describe, expect, test } from "bun:test";
import { commandData } from "../src/discord/commands.ts";

describe("slash commands", () => {
  test("publishes one unique definition for every supported command", () => {
    const names = commandData.map((command) => command.name);
    expect(names).toEqual([
      "ask",
      "search",
      "voice",
      "voicechat",
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

  test("restricts live voice chat controls to server administrators", () => {
    const voiceChat = commandData.find((command) => command.name === "voicechat");
    expect(voiceChat?.dm_permission).toBeFalse();
    expect(voiceChat?.default_member_permissions).toBe("8");
    expect(voiceChat?.options?.map((option) => option.name)).toEqual([
      "join",
      "leave",
      "status",
    ]);
  });

  test("publishes explicit long-term memory controls", () => {
    const memory = commandData.find((command) => command.name === "memory");
    expect(memory?.options?.map((option) => option.name)).toEqual([
      "status",
      "search",
      "remember",
      "forget",
    ]);
    const remember = memory?.options?.find(
      (option) => option.name === "remember",
    );
    const rememberOptions =
      remember && "options" in remember ? remember.options : undefined;
    expect(rememberOptions?.map((option) => option.name)).toEqual([
      "key",
      "content",
      "kind",
      "scope",
    ]);
  });
});
