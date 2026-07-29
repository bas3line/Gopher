import { Firecrawl, type Document, type SearchResultNews, type SearchResultWeb } from "firecrawl";
import type { Logger } from "../logger.ts";
import type { WebSource } from "../types.ts";

type FirecrawlItem = SearchResultWeb | SearchResultNews | Document;

export class WebResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebResearchError";
  }
}

export class WebResearch {
  private readonly client?: Firecrawl;

  constructor(
    apiKey: string | undefined,
    private readonly maxResults: number,
    private readonly logger: Logger,
  ) {
    if (apiKey) {
      this.client = new Firecrawl({
        apiKey,
        timeoutMs: 35_000,
        maxRetries: 2,
        backoffFactor: 1.8,
      });
    }
  }

  get enabled(): boolean {
    return Boolean(this.client);
  }

  async search(query: string): Promise<WebSource[]> {
    if (!this.client) {
      throw new WebResearchError("Firecrawl web search is not configured");
    }

    try {
      const result = await this.client.search(query, {
        limit: this.maxResults,
        sources: ["web", "news"],
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
          maxAge: 3_600_000,
        },
      });

      const items = [...(result.web ?? []), ...(result.news ?? [])];
      const seen = new Set<string>();
      const sources: WebSource[] = [];
      for (const item of items) {
        const normalized = normalizeFirecrawlItem(item);
        if (!normalized || seen.has(normalized.url)) continue;
        seen.add(normalized.url);
        sources.push(normalized);
        if (sources.length >= this.maxResults) break;
      }
      if (sources.length === 0) {
        throw new WebResearchError("Firecrawl returned no usable web results");
      }
      return sources;
    } catch (error) {
      if (error instanceof WebResearchError) throw error;
      this.logger.warn(
        { err: error instanceof Error ? { name: error.name, message: error.message } : "unknown" },
        "Firecrawl search failed",
      );
      throw new WebResearchError("Firecrawl web search failed");
    }
  }
}

export function normalizeFirecrawlItem(item: FirecrawlItem): WebSource | undefined {
  const record = item as Record<string, unknown>;
  const metadata =
    typeof record.metadata === "object" && record.metadata
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const url = firstString(record.url, metadata?.sourceURL, metadata?.url);
  if (!url || !isHttpUrl(url)) return undefined;

  const title = firstString(record.title, metadata?.title, url) ?? url;
  const description =
    firstString(record.description, record.snippet, metadata?.description) ?? "";
  const content = firstString(record.markdown, record.summary, description) ?? "";
  const publishedAt = firstString(record.date, metadata?.publishedTime, metadata?.modifiedTime);

  return {
    title: title.slice(0, 400),
    url,
    description: description.slice(0, 2_000),
    content: content.slice(0, 12_000),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
