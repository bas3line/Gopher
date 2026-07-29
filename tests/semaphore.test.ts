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
