import { expect, test } from "bun:test";
import { renderEngineerCard } from "../src/discord/images.ts";

test("renders a Discord-ready PNG card", async () => {
  const image = await renderEngineerCard({
    title: "Verdict <script>",
    body: "This mutex is emotional support. Replace it with ownership.",
    author: "test-user",
  });
  expect(image.byteLength).toBeGreaterThan(10_000);
  expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});
