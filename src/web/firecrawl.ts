import { Firecrawl, type Document, type SearchResultNews, type SearchResultWeb } from "firecrawl";
import type { Logger } from "../logger.ts";
import type { WebSource } from "../types.ts";

type FirecrawlItem = SearchResultWeb | SearchResultNews | Document;
export type WebResearchClient = Pick<Firecrawl, "scrape" | "search">;

export class WebResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebResearchError";
  }
}

export class WebResearch {
  private readonly client?: WebResearchClient;

  constructor(
    apiKey: string | undefined,
    private readonly maxResults: number,
    private readonly logger: Logger,
    client?: WebResearchClient,
  ) {
    if (client) {
      this.client = client;
    } else if (apiKey) {
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

  async search(
    query: string,
    options: { limit?: number } = {},
  ): Promise<WebSource[]> {
    if (!this.client) {
      throw new WebResearchError("Firecrawl web search is not configured");
    }

    try {
      const limit = Math.max(
        1,
        Math.min(options.limit ?? this.maxResults, this.maxResults),
      );
      const explicitUrls = explicitHttpUrls(query).slice(0, limit);
      if (explicitUrls.length > 0) {
        const results = await Promise.allSettled(
          explicitUrls.map((url) =>
            this.client!.scrape(url, {
              formats: ["markdown"],
              onlyMainContent: true,
              maxAge: 3_600_000,
            }),
          ),
        );
        const directSources: WebSource[] = [];
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            this.logger.warn(
              {
                hostname: new URL(explicitUrls[index]!).hostname,
                err:
                  result.reason instanceof Error
                    ? {
                        name: result.reason.name,
                        message: result.reason.message,
                      }
                    : "unknown",
              },
              "Firecrawl direct URL scrape failed",
            );
            continue;
          }
          const normalized = normalizeFirecrawlItem(result.value);
          if (normalized) directSources.push(normalized);
        }
        if (directSources.length > 0) return directSources;
      }

      const result = await this.client.search(query, {
        limit,
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
        if (sources.length >= limit) break;
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

export function explicitHttpUrls(input: string): string[] {
  const matches = input.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const candidate = match.replace(/[\])},.!?;:]+$/g, "");
    try {
      const url = new URL(candidate);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username ||
        url.password
      ) {
        continue;
      }
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    } catch {
      continue;
    }
  }
  return urls;
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
