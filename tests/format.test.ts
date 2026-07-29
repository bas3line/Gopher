import { describe, expect, test } from "bun:test";
import {
  casualizeReply,
  quickCasualReply,
  splitDiscordMessage,
  withSources,
} from "../src/discord/format.ts";

describe("Discord formatting", () => {
  test("keeps every chunk below the Discord limit", () => {
    const input = Array.from({ length: 600 }, (_, index) => `line-${index} useful words`).join("\n");
    const chunks = splitDiscordMessage(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBeTrue();
    expect(chunks.join("\n")).toContain("line-599");
  });

  test("adds numbered, non-embedding source links", () => {
    const answer = withSources("Fresh answer.", [
      {
        title: "Docs\nwith noise",
        url: "https://example.com/docs",
        description: "",
        content: "",
      },
    ]);
    expect(answer).toContain("[1] Docs with noise — <https://example.com/docs>");
  });

  test("handles greetings without dragging old conversation into them", () => {
    expect(quickCasualReply("hello")).toBe("yo");
    expect(quickCasualReply("HIII bro!!")).toBe("yo");
    expect(quickCasualReply("good morning")).toBe("gm");
  });

  test("forces casual replies to be short, lowercase, and emoji-free", () => {
    const reply = casualizeReply(
      "YO SATVIK! 😅 This is a giant dramatic reply. It has another sentence! And another one.",
    );
    expect(reply).toBe("yo satvik. this is a giant dramatic reply.");
    expect(reply.length).toBeLessThanOrEqual(180);
  });
});
