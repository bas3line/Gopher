import { describe, expect, test } from "bun:test";
import {
  buildServerEmojiCatalog,
  customEmojiImageUrls,
} from "../src/discord/emojis.ts";

describe("server custom emoji context", () => {
  test("builds exact static and animated Discord markup", () => {
    const catalog = buildServerEmojiCatalog([
      {
        id: "1531809280062259261",
        name: "catjam",
        animated: true,
        available: true,
        imageURL: () => "https://cdn.example/catjam.gif",
      },
      {
        id: "1531809280062259260",
        name: "tuff",
        animated: false,
        available: true,
        imageURL: () => "https://cdn.example/tuff.png",
      },
      {
        id: "1531809280062259262",
        name: "gone",
        animated: false,
        available: false,
        imageURL: () => "https://cdn.example/gone.png",
      },
    ]);

    expect(catalog.map((emoji) => emoji.markup)).toEqual([
      "<a:catjam:1531809280062259261>",
      "<:tuff:1531809280062259260>",
    ]);
  });

  test("passes only catalogued emojis from the current message to vision", () => {
    const catalog = [
      {
        id: "1531809280062259260",
        name: "tuff",
        markup: "<:tuff:1531809280062259260>",
        animated: false,
        imageUrl: "https://cdn.example/tuff.png",
      },
    ];
    expect(
      customEmojiImageUrls(
        "<:tuff:1531809280062259260> <:fake:1531809280062259299>",
        catalog,
      ),
    ).toEqual(["https://cdn.example/tuff.png"]);
  });
});
