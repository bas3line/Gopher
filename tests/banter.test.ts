import { describe, expect, test } from "bun:test";
import {
  parseReactionRequest,
  shouldReactWithTuff,
  tuffEmoji,
} from "../src/discord/banter.ts";

describe("tuff reaction", () => {
  test("uses the requested custom emoji for laugh and mog moments", () => {
    expect(tuffEmoji).toBe("<:tuff:1531809280062259260>");
    expect(shouldReactWithTuff("lmao bro got cooked 💀")).toBeTrue();
    expect(shouldReactWithTuff("he mogged the whole lobby")).toBeTrue();
    expect(shouldReactWithTuff("skill issue, pack it up")).toBeTrue();
    expect(shouldReactWithTuff("kya bey gandu")).toBeTrue();
  });

  test("does not react to explanations, code, links, or literal cooking", () => {
    expect(shouldReactWithTuff("what does mogged mean?")).toBeFalse();
    expect(shouldReactWithTuff("explain why people say lmao")).toBeFalse();
    expect(shouldReactWithTuff("I cooked pasta for dinner")).toBeFalse();
    expect(shouldReactWithTuff("```go\nfunc cooked() {}\n```")).toBeFalse();
    expect(shouldReactWithTuff("https://example.com/lol")).toBeFalse();
  });
});

describe("explicit reaction action", () => {
  test("parses the request that previously produced the text-only claim", () => {
    expect(parseReactionRequest("react with a emoji")).toEqual({
      emoji: "👍",
      label: "thumbs up",
    });
  });

  test("honors custom, unicode, and named reactions", () => {
    expect(
      parseReactionRequest("react with <:tuff:1531809280062259260> please"),
    ).toEqual({ emoji: tuffEmoji, label: "custom emoji" });
    expect(parseReactionRequest("react with 🔥")).toEqual({
      emoji: "🔥",
      label: "requested emoji",
    });
    expect(parseReactionRequest("add a tuff reaction")).toEqual({
      emoji: tuffEmoji,
      label: "tuff",
    });
    expect(
      parseReactionRequest("react with catjam", [
        {
          id: "1531809280062259261",
          name: "catjam",
          markup: "<a:catjam:1531809280062259261>",
          animated: true,
          imageUrl: "https://cdn.example/catjam.gif",
        },
      ]),
    ).toEqual({
      emoji: "<a:catjam:1531809280062259261>",
      label: "catjam",
    });
  });

  test("does not turn discussion or removal requests into actions", () => {
    expect(
      parseReactionRequest("how do Discord reactions work?"),
    ).toBeUndefined();
    expect(parseReactionRequest("don't react to this")).toBeUndefined();
    expect(
      parseReactionRequest("this code handles reaction events"),
    ).toBeUndefined();
  });
});
