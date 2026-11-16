import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { expectedClipboardText, grantClipboard, readClipboard } from "./helpers/clipboard";
import { openWithCopyTarget, previewOrigin, startLocalServer, type LocalServer } from "./helpers/local-server";

const pages = [
  { route: "/gh-aw/setup/working-with-workflows/", count: 2 },
  { route: "/gh-aw/reference/custom-agent-for-aw/", count: 3 },
];

for (const width of [390, 1280, 1920]) {
  for (const { route, count } of pages) {
    test(`copy controls stay inside the prose column at ${width}px on ${route}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      await page.goto(route);

      const buttons = page.locator(".sl-markdown-content .copy-entire-file-btn");
      await expect(buttons).toHaveCount(count);
      const layout = await buttons.evaluateAll(buttons => {
        const heading = document.querySelector(".sl-markdown-content h2");
        if (!heading) throw new Error("Missing prose heading");
        const prose = heading.getBoundingClientRect();
        return buttons.map(button => {
          const box = button.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            proseLeft: prose.left,
            proseRight: prose.right,
            inParagraph: button.parentElement?.tagName === "P",
          };
        });
      });
      for (const button of layout) {
        expect(button.inParagraph).toBe(true);
        expect(button.left).toBeGreaterThanOrEqual(button.proseLeft - 1);
        expect(button.right).toBeLessThanOrEqual(button.proseRight + 1);
      }

      const debugButton = buttons.filter({ hasText: "Copy debug instructions" });
      const debugBox = await debugButton.boundingBox();
      expect(debugBox).not.toBeNull();
      expect(Math.abs(debugBox!.x - layout[0].proseLeft)).toBeLessThanOrEqual(1);
    });
  }
}

test.describe("aligned debug button", () => {
  const DEBUG_URL = "https://raw.githubusercontent.com/github/gh-aw/main/debug.md";
  const instructions = readFileSync(new URL("../../debug.md", import.meta.url), "utf8");
  let server: LocalServer;

  test.beforeAll(async ({}, testInfo) => {
    server = await startLocalServer(previewOrigin(testInfo), { "/debug.md": () => ({ status: 200, body: instructions }) });
  });

  test.afterAll(async () => {
    await server?.close();
  });

  test("still copies the fetched instructions", async ({ page, context }) => {
    await grantClipboard(context);
    const button = await openWithCopyTarget(page, "/gh-aw/setup/working-with-workflows/", DEBUG_URL, server.url("/debug.md"));
    await button.click();
    await expect(button).toContainText("Copied!");
    expect(server.hits("/debug.md")).toBe(1);
    expect(await readClipboard(page)).toBe(expectedClipboardText(instructions));
  });
});
