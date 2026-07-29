import { expect, test } from "bun:test";
import pino from "pino";
import { WebResearch } from "../../src/web/firecrawl.ts";

const enabled = process.env.RUN_LIVE_FIRECRAWL_TEST === "1";

test.skipIf(!enabled)(
  "live Firecrawl search returns usable sources",
  async () => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is missing");
    const web = new WebResearch(apiKey, 3, pino({ level: "silent" }));
    const sources = await web.search(
      "official Go programming language documentation",
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((source) => source.url.startsWith("http"))).toBeTrue();
  },
  45_000,
);
