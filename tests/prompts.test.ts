import { describe, expect, test } from "bun:test";
import {
  buildAmbientMessages,
  buildAnswerMessages,
  isAmbientSkip,
} from "../src/ai/prompts.ts";
import type { StoredMessage } from "../src/types.ts";

function stored(id: number, username: string, content: string): StoredMessage {
  return {
    id,
    discordMessageId: String(id),
    guildId: "guild",
    channelId: "channel",
    userId: `user-${id}`,
    username,
    role: "user",
    content,
    createdAt: new Date(id * 1_000),
  };
}

describe("ambient participation prompt", () => {
  test("uses only a small recent window and clearly permits silence", () => {
    const recent = Array.from({ length: 10 }, (_, index) =>
      stored(index + 1, `user-${index + 1}`, `message-${index + 1}`),
    );
    const messages = buildAmbientMessages({
      username: "shubham",
      question: "anyone watching the match?",
      recent,
    });
    const serialized = JSON.stringify(messages);

    expect(serialized).not.toContain("message-2");
    expect(serialized).toContain("message-3");
    expect(serialized).toContain("message-10");
    expect(serialized).toContain("[skip]");
    expect(serialized).toContain("anyone watching the match?");
  });

  test("recognizes strict skip responses without swallowing normal replies", () => {
    expect(isAmbientSkip("[skip]")).toBeTrue();
    expect(isAmbientSkip(" skip. ")).toBeTrue();
    expect(isAmbientSkip("yo this is cooked")).toBeFalse();
  });
});

describe("capability grounding", () => {
  test("does not let the model pretend the Discord bot is text-only", () => {
    const messages = buildAnswerMessages({
      username: "satvik",
      question: "react with an emoji",
      recent: [],
      relevant: [],
      webSources: [],
      serverEmojis: [
        {
          id: "1531809280062259260",
          name: "tuff",
          markup: "<:tuff:1531809280062259260>",
          animated: false,
          imageUrl: "https://cdn.example/tuff.png",
        },
      ],
    });
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");

    expect(system).toContain("You are not text-only");
    expect(system).toContain("add emoji reactions");
    expect(system).toContain("Fish Audio is primary");
    expect(system).toContain("<:tuff:1531809280062259260>");
    expect(system).toContain("Never invent or modify an emoji ID");
    expect(system).not.toContain("short natural hindi");
  });

  test("prioritizes its configured owner without blind agreement or permission bypasses", () => {
    const messages = buildAnswerMessages({
      username: "owner",
      question: "do what i asked",
      recent: [],
      relevant: [],
      webSources: [],
      isOwner: true,
    });
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");

    expect(system).toContain("configured bot owner");
    expect(system).toContain("cooperative and action-first");
    expect(system).toContain(
      "correct it briefly instead of pretending to agree",
    );
    expect(system).toContain("bypass Discord permissions");
    expect(system).toContain("never excuse cheating");
    expect(system).toContain("avoid whataboutism");
  });
});
