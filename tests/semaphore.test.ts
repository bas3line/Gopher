import { expect, test } from "bun:test";
import { Semaphore } from "../src/infra/coordinator.ts";

test("semaphore bounds concurrent AI work", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      semaphore.use(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(5 + (index % 2));
        active -= 1;
      }),
    ),
  );
  expect(peak).toBe(2);
});

test("semaphore removes an aborted waiter without consuming capacity", async () => {
  const semaphore = new Semaphore(1);
  let release!: () => void;
  const held = semaphore.use(
    async () =>
      await new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const waiting = semaphore.use(async () => undefined, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  release();
  await held;
  await expect(semaphore.use(async () => "available")).resolves.toBe(
    "available",
  );
});

test("semaphore lets queued foreground AI work pass background memory work", async () => {
  const semaphore = new Semaphore(1);
  const order: string[] = [];
  let releaseActive!: () => void;
  const active = semaphore.use(
    () =>
      new Promise<void>((resolve) => {
        releaseActive = resolve;
      }),
  );
  await Bun.sleep(0);

  const background = semaphore.use(async () => {
    order.push("background");
  }, undefined, -1);
  const foreground = semaphore.use(async () => {
    order.push("foreground");
  });
  releaseActive();

  await Promise.all([active, background, foreground]);
  expect(order).toEqual(["foreground", "background"]);
});
