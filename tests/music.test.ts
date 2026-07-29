import { describe, expect, test } from "bun:test";
import {
  formatMusicHistory,
  formatMusicQueue,
  musicDuration,
} from "../src/music/format.ts";
import { MusicQueryError, musicIdentifier } from "../src/music/query.ts";

describe("music source guardrails", () => {
  test("uses YouTube search for plain text and accepts explicit supported search prefixes", () => {
    expect(musicIdentifier("gopher soundtrack")).toBe("ytsearch:gopher soundtrack");
    expect(musicIdentifier("ytsearch:night drive")).toBe("ytsearch:night drive");
    expect(musicIdentifier("scsearch:lofi")).toBe("scsearch:lofi");
    expect(musicIdentifier("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  test("rejects unsafe or unsupported scheme selectors", () => {
    expect(() => musicIdentifier("http://example.com/track")).toThrow(MusicQueryError);
    expect(() => musicIdentifier("file:///etc/passwd")).toThrow(MusicQueryError);
    expect(() => musicIdentifier("local:track")).toThrow(MusicQueryError);
    expect(() => musicIdentifier("https://example.com/track")).toThrow(MusicQueryError);
    expect(() => musicIdentifier("https://")).toThrow(MusicQueryError);
    expect(() => musicIdentifier("ytsearch:   ")).toThrow(MusicQueryError);
  });
});

describe("music presentation", () => {
  test("formats compact durations and a bounded queue", () => {
    expect(musicDuration(65_000)).toBe("1:05");
    expect(musicDuration(3_665_000)).toBe("1:01:05");
    const track = {
      id: 1,
      guildId: "guild",
      requestedByUserId: "user",
      requestedByUsername: "gopher",
      sourceQuery: "query",
      encodedTrack: "encoded",
      title: "A track",
      author: "An artist",
      durationMs: 65_000,
      state: "queued" as const,
      queueOrder: 1,
      createdAt: new Date(),
    };
    expect(formatMusicQueue({ upcoming: [track], volume: 65 })).toContain("A track");
    expect(formatMusicHistory([{ ...track, state: "played" }])).toContain("Recently played");
  });
});
