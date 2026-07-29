import { randomUUID } from "node:crypto";
import Redis from "ioredis";

const releaseLockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

const fixedWindowScript = `
  local count = redis.call("INCR", KEYS[1])
  if count == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end
  return count
`;

const consumeConfirmationScript = `
  local value = redis.call("GET", KEYS[1])
  if not value then
    return "__MISSING__"
  end
  local prefix = ARGV[1] .. "\\n"
  if string.sub(value, 1, string.len(prefix)) ~= prefix then
    return "__FORBIDDEN__"
  end
  redis.call("DEL", KEYS[1])
  return string.sub(value, string.len(prefix) + 1)
`;

export type ConfirmationResult =
  | { status: "ok"; payload: string }
  | { status: "missing" }
  | { status: "forbidden" };

export class Coordinator {
  readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      connectTimeout: 8_000,
      commandTimeout: 5_000,
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  async markMessageSeen(messageId: string): Promise<boolean> {
    const result = await this.redis.set(`seen:${messageId}`, "1", "EX", 86_400, "NX");
    return result === "OK";
  }

  async consumeUserRequest(userId: string, maximum: number): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    const count = Number(
      await this.redis.eval(fixedWindowScript, 1, `rate:user:${userId}:${minute}`, "90"),
    );
    return count <= maximum;
  }

  async consumeVisionRequest(maximum: number): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    const count = Number(
      await this.redis.eval(fixedWindowScript, 1, `rate:vision:${minute}`, "90"),
    );
    return count <= maximum;
  }

  async claimAmbientEvaluation(channelId: string, cooldownSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `cooldown:ambient:${channelId}`,
      "1",
      "EX",
      cooldownSeconds,
      "NX",
    );
    return result === "OK";
  }

  async savePendingConfirmation(
    token: string,
    ownerUserId: string,
    payload: string,
    ttlSeconds = 120,
  ): Promise<boolean> {
    const result = await this.redis.set(
      `confirmation:server:${token}`,
      `${ownerUserId}\n${payload}`,
      "EX",
      ttlSeconds,
      "NX",
    );
    return result === "OK";
  }

  async consumePendingConfirmation(
    token: string,
    ownerUserId: string,
  ): Promise<ConfirmationResult> {
    const result = String(
      await this.redis.eval(
        consumeConfirmationScript,
        1,
        `confirmation:server:${token}`,
        ownerUserId,
      ),
    );
    if (result === "__MISSING__") return { status: "missing" };
    if (result === "__FORBIDDEN__") return { status: "forbidden" };
    return { status: "ok", payload: result };
  }

  async withChannelLock<T>(
    channelId: string,
    operation: () => Promise<T>,
    waitMs = 0,
  ): Promise<T | undefined> {
    const key = `lock:channel:${channelId}`;
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    let acquired = await this.redis.set(key, token, "EX", 300, "NX");
    while (acquired !== "OK" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      acquired = await this.redis.set(key, token, "EX", 300, "NX");
    }
    if (acquired !== "OK") return undefined;

    try {
      return await operation();
    } finally {
      await this.redis.eval(releaseLockScript, 1, key, token);
    }
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
