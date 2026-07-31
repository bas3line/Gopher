import { describe, expect, test } from "bun:test";
import type {
  AgentRequestContext,
  DiscordAgentAdapter,
} from "../src/agent/context.ts";
import { AgentToolError } from "../src/agent/loop.ts";
import {
  createAgentTools,
  hasExplicitDiscordWriteIntent,
  isExplicitForgetRequest,
  isExplicitRememberRequest,
} from "../src/agent/tools.ts";
import type { AgentTool } from "../src/agent/types.ts";
import type { DurableMemory } from "../src/memory/types.ts";
import type { WebSource } from "../src/types.ts";

function memoryFixture(): DurableMemory {
  return {
    id: 42,
    guildId: "guild",
    scope: "user",
    scopeId: "user",
    subjectUserId: "user",
    kind: "preference",
    key: "preference.runtime",
    content: "Kira prefers Bun.",
    importance: 8,
    confidence: 1,
    source: "explicit",
    evidenceMessageIds: ["message"],
    pinned: false,
    version: 1,
    validFrom: new Date("2026-07-31T00:00:00.000Z"),
    lastConfirmedAt: new Date("2026-07-31T00:00:00.000Z"),
    accessCount: 0,
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    score: 3.5,
  };
}

function fakeDiscord(
  overrides: Partial<DiscordAgentAdapter> = {},
): DiscordAgentAdapter {
  return {
    async readMessages() {
      return [];
    },
    async listChannels() {
      return [];
    },
    async findMember() {
      return undefined;
    },
    async react(input) {
      return input;
    },
    async sendMessage() {
      return { messageId: "sent", channelId: "channel" };
    },
    async createThread(input) {
      return { threadId: "thread", name: input.name };
    },
    async editOwnMessage(input) {
      return { messageId: input.messageId };
    },
    async deleteOwnMessage(input) {
      return { messageId: input.messageId };
    },
    async pinMessage(input) {
      return { messageId: input.messageId };
    },
    ...overrides,
  };
}

function fakeContext(
  overrides: Partial<AgentRequestContext> = {},
): AgentRequestContext {
  return {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    username: "Kira",
    requestText: "remember that I prefer Bun",
    discordMessageId: "message",
    isOwner: false,
    isAdministrator: false,
    isDirectMessage: false,
    discordActionsEnabled: true,
    memory: {
      async recall() {
        return [memoryFixture()];
      },
      async upsertMemories() {
        return [memoryFixture()];
      },
      async forgetMemory() {
        return true;
      },
      async saveWebSources() {},
      async recordDiscordEvent() {
        return true;
      },
    },
    web: {
      enabled: true,
      async search() {
        return [];
      },
    },
    discord: fakeDiscord(),
    collectedWebSources: [],
    ...overrides,
  };
}

async function execute(
  tool: AgentTool<AgentRequestContext, any>,
  arguments_: unknown,
  context: AgentRequestContext,
) {
  const parsed = tool.schema.parse(arguments_);
  return await tool.execute(parsed, context, {
    runId: "run",
    callId: "call",
    iteration: 1,
    signal: new AbortController().signal,
  });
}

function findTool(
  name: string,
  options?: Parameters<typeof createAgentTools>[0],
) {
  const tool = createAgentTools(options).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("agent tool policy and capabilities", () => {
  test("exposes only capabilities that are actually enabled", () => {
    const names = createAgentTools({
      webEnabled: false,
      discordAvailable: true,
      discordWritesEnabled: false,
    }).map((tool) => tool.name);
    expect(names).not.toContain("web_search");
    expect(names).toContain("discord_read_messages");
    expect(names).not.toContain("discord_send_message");
    expect(names).toContain("memory_search");
  });

  test("recognizes explicit current-message intent and rejects negation", () => {
    expect(isExplicitRememberRequest("remember this for next time")).toBeTrue();
    expect(isExplicitForgetRequest("delete that memory")).toBeTrue();
    expect(
      hasExplicitDiscordWriteIntent(
        "send this message in the releases channel",
        "send",
      ),
    ).toBeTrue();
    expect(
      hasExplicitDiscordWriteIntent(
        "do not send any message anywhere",
        "send",
      ),
    ).toBeFalse();
    expect(
      hasExplicitDiscordWriteIntent("we were discussing reactions", "react"),
    ).toBeFalse();
  });

  test("writes user memory only from an explicit request with current evidence", async () => {
    let savedInput: unknown;
    const context = fakeContext({
      memory: {
        ...fakeContext().memory,
        async upsertMemories(input) {
          savedInput = input;
          return [memoryFixture()];
        },
      },
    });
    const result = await execute(
      findTool("memory_remember"),
      {
        scope: "user",
        kind: "preference",
        key: "preference.runtime",
        content: "Kira prefers Bun.",
        importance: 8,
      },
      context,
    );
    expect(result).toMatchObject({
      saved: [{ id: 42, key: "preference.runtime" }],
    });
    expect(savedInput).toMatchObject({
      source: "explicit",
      candidates: [
        {
          subjectUserId: "user",
          evidenceMessageIds: ["message"],
          confidence: 1,
        },
      ],
    });

    await expect(
      execute(
        findTool("memory_remember"),
        {
          scope: "user",
          kind: "fact",
          key: "fact.random",
          content: "Random fact.",
          importance: 3,
        },
        fakeContext({ requestText: "tell me a joke" }),
      ),
    ).rejects.toMatchObject({
      code: "explicit_memory_request_required",
    });
  });

  test("blocks credentials and non-admin server-wide memory writes", async () => {
    await expect(
      execute(
        findTool("memory_remember"),
        {
          scope: "user",
          kind: "fact",
          key: "secret.provider",
          content: "api_key=sk-secret-value-123456789012345",
          importance: 10,
        },
        fakeContext(),
      ),
    ).rejects.toMatchObject({ code: "sensitive_memory_denied" });

    await expect(
      execute(
        findTool("memory_remember"),
        {
          scope: "guild",
          kind: "decision",
          key: "server.rule",
          content: "Everyone uses Bun.",
          importance: 8,
        },
        fakeContext(),
      ),
    ).rejects.toMatchObject({ code: "memory_scope_denied" });
  });

  test("collects live web evidence and caches it without hiding the source", async () => {
    const source: WebSource = {
      title: "Bun release",
      url: "https://bun.sh/blog/release",
      description: "Current release",
      content: "Release notes",
      publishedAt: "2026-07-30",
    };
    let cachedQuery = "";
    const context = fakeContext({
      web: {
        enabled: true,
        async search(query) {
          expect(query).toBe("latest Bun release");
          return [source];
        },
      },
      memory: {
        ...fakeContext().memory,
        async saveWebSources(query) {
          cachedQuery = query;
        },
      },
    });
    const result = await execute(
      findTool("web_search"),
      { query: "latest Bun release", limit: 3 },
      context,
    );
    expect(result).toMatchObject({
      sources: [{ url: "https://bun.sh/blog/release" }],
    });
    expect(context.collectedWebSources).toEqual([source]);
    expect(cachedQuery).toBe("latest Bun release");
  });

  test("executes a Discord write only for the exact explicit request and audits it", async () => {
    const events: unknown[] = [];
    let sends = 0;
    const context = fakeContext({
      requestText: "send this message in the current channel",
      discord: fakeDiscord({
        async sendMessage() {
          sends += 1;
          return { messageId: "sent", channelId: "channel" };
        },
      }),
      memory: {
        ...fakeContext().memory,
        async recordDiscordEvent(event) {
          events.push(event);
          return true;
        },
      },
    });
    await execute(
      findTool("discord_send_message"),
      { content: "hello" },
      context,
    );
    expect(sends).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        eventKey: "agent:run:call",
        eventType: "agent_action",
        payload: expect.objectContaining({ action: "discord_send_message" }),
      }),
    ]);

    try {
      await execute(
        findTool("discord_send_message"),
        { content: "hello" },
        fakeContext({ requestText: "what messages are here?" }),
      );
      throw new Error("expected policy denial");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolError);
      expect((error as AgentToolError).code).toBe(
        "explicit_action_required",
      );
    }
  });
});
