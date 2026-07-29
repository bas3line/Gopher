import { describe, expect, test } from "bun:test";
import {
  formatMusicHistory,
  formatMusicQueue,
  musicDuration,
} from "../src/music/format.ts";
import {
  DEFAULT_MUSIC_SEARCH,
  MusicQueryError,
  musicIdentifier,
  parseMusicTextCommand,
  parseMusicTextPlayRequest,
} from "../src/music/query.ts";

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

describe("plain-language music requests", () => {
  test("turns an explicit request for generic music into a safe default search", () => {
    expect(parseMusicTextPlayRequest("play some music lil bro")).toBe(
      DEFAULT_MUSIC_SEARCH,
    );
    expect(parseMusicTextPlayRequest("could you put on music please")).toBe(
      DEFAULT_MUSIC_SEARCH,
    );
  });

  test("keeps a specific song or artist query and ignores unrelated chat", () => {
    expect(parseMusicTextPlayRequest("play Midnight City please")).toBe(
      "Midnight City",
    );
    expect(parseMusicTextPlayRequest("queue some music by Kendrick Lamar")).toBe(
      "Kendrick Lamar",
    );
    expect(parseMusicTextPlayRequest("why is this music so loud?")).toBeUndefined();
    expect(parseMusicTextPlayRequest("play ".repeat(200))).toBeUndefined();
  });

  test("understands casual direct playback controls before the AI answer path", () => {
    expect(parseMusicTextCommand("stop this bro")).toEqual({ kind: "stop" });
    expect(parseMusicTextCommand("can you pause the music please")).toEqual({ kind: "pause" });
    expect(parseMusicTextCommand("bro play california love")).toEqual({
      kind: "play",
      query: "california love",
    });
    expect(parseMusicTextCommand("how about you play california love lil bro")).toEqual({
      kind: "play",
      query: "california love",
    });
    expect(parseMusicTextCommand("skip this song")).toEqual({ kind: "skip" });
    expect(parseMusicTextCommand("what's playing?")).toEqual({ kind: "now" });
    expect(parseMusicTextCommand("stop being a clown")).toBeUndefined();
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
