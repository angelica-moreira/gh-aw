import { readFileSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { expectedClipboardText, grantClipboard, readClipboard } from "./helpers/clipboard";
import { createGate, openWithCopyTarget, previewOrigin, startLocalServer, startResettingServer, type LocalServer } from "./helpers/local-server";

const PAGE = "/gh-aw/setup/working-with-workflows/";
const DICTATION_URL = "https://raw.githubusercontent.com/github/gh-aw/main/DICTATION.md";
const LABEL = "Copy dictation instructions";
const dictation = readFileSync(new URL("../../DICTATION.md", import.meta.url), "utf8");

const gate = createGate();
let server: LocalServer;

test.beforeAll(async ({}, testInfo) => {
  server = await startLocalServer(previewOrigin(testInfo), {
    "/DICTATION.md": () => ({ status: 200, body: dictation }),
    "/gated/DICTATION.md": async () => {
      await gate.opened;
      return { status: 200, body: dictation };
    },
    "/missing/DICTATION.md": () => ({ status: 404, body: "Not Found" }),
  });
});

test.afterAll(async () => {
  gate.release();
  await server?.close();
});

test.beforeEach(async ({ context }) => {
  await grantClipboard(context);
});

const openDictationButton = (page: Page, url: string) => openWithCopyTarget(page, PAGE, DICTATION_URL, url);

async function expectErrorModal(page: Page, button: Locator, detail: string) {
  await expect(button.locator(".btn-text")).toHaveText("Error");
  const overlay = page.locator(".error-modal-overlay");
  const modal = overlay.locator(".error-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator("#error-modal-title")).toHaveText("Error Copying File");
  await expect(modal.locator(".error-modal-body")).toContainText("An error occurred while trying to copy the file:");
  await expect(modal.locator(".error-modal-details")).toContainText(detail);
  return { overlay, modal };
}

// Tracks keydown listeners added to and removed from document, so tests can spot leftovers.
async function trackKeydownListeners(page: Page) {
  await page.addInitScript(() => {
    const live = new Set<unknown>();
    const add = document.addEventListener;
    const remove = document.removeEventListener;
    document.addEventListener = function (type: string, listener: unknown, options?: unknown) {
      if (type === "keydown") live.add(listener);
      return add.call(this, type, listener as EventListener, options as AddEventListenerOptions);
    };
    document.removeEventListener = function (type: string, listener: unknown, options?: unknown) {
      if (type === "keydown") live.delete(listener);
      return remove.call(this, type, listener as EventListener, options as EventListenerOptions);
    };
    (window as unknown as { __keydownListeners: () => number }).__keydownListeners = () => live.size;
  });
  return () => page.evaluate(() => (window as unknown as { __keydownListeners: () => number }).__keydownListeners());
}

const closeErrorModal: Record<string, (page: Page, overlay: Locator) => Promise<void>> = {
  "the close button": (_page, overlay) => overlay.locator(".error-modal-close").click(),
  "a click outside": (_page, overlay) => overlay.click({ position: { x: 5, y: 5 } }),
  "the Escape key": (page) => page.keyboard.press("Escape"),
};

test.describe("Copy Entire File Button", () => {
  test("points the dictation button at the published DICTATION.md", async ({ page }) => {
    await page.goto(PAGE);
    const button = page.locator(`.copy-entire-file-btn[data-filepath="${DICTATION_URL}"]`);
    await expect(button).toHaveCount(1);
    await expect(button.locator(".btn-text")).toHaveText(LABEL);
  });

  test("copies the file content and reports progress", async ({ page }) => {
    const path = "/gated/DICTATION.md";
    const button = await openDictationButton(page, server.url(path));
    const text = button.locator(".btn-text");

    await button.click();
    await expect(text).toHaveText("Copying…");
    await expect.poll(() => server.hits(path)).toBeGreaterThan(0);
    gate.release();
    await expect(text).toHaveText("Copied!");

    expect(await readClipboard(page)).toBe(expectedClipboardText(dictation));
    await expect(text).toHaveText(LABEL, { timeout: 4000 });
  });

  test("shows a fixed error dialog for HTTP errors and closes it from outside", async ({ page }) => {
    const path = "/missing/DICTATION.md";
    const button = await openDictationButton(page, server.url(path));

    await button.click();
    const { overlay, modal } = await expectErrorModal(page, button, "Failed to fetch file: 404");
    expect(server.hits(path)).toBeGreaterThan(0);
    await expect(overlay).toHaveCSS("position", "fixed");
    // Reference box: a fixed element spanning the viewport's fixed containing block (which excludes the scrollbar).
    const viewport = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;inset:0;visibility:hidden";
      document.body.append(probe);
      const { x, y, width, height } = probe.getBoundingClientRect();
      probe.remove();
      return { x, y, width, height };
    });
    expect(viewport).toMatchObject({ x: 0, y: 0 });
    expect(await overlay.boundingBox()).toEqual(viewport);

    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(modal).toHaveCount(0);
    await expect(button.locator(".btn-text")).toHaveText(LABEL, { timeout: 4000 });
  });

  test("shows the error dialog when the connection is reset", async ({ page }) => {
    const resetting = await startResettingServer();
    try {
      const button = await openDictationButton(page, resetting.url("/DICTATION.md"));

      await button.click();
      const { modal } = await expectErrorModal(page, button, "Failed to fetch");
      await modal.locator(".error-modal-close").click();
      await expect(modal).toHaveCount(0);
      await expect(button.locator(".btn-text")).toHaveText(LABEL, { timeout: 4000 });
    } finally {
      await resetting.close();
    }
  });

  test("binds one click handler per button", async ({ page }) => {
    const path = "/DICTATION.md";
    const button = await openDictationButton(page, server.url(path));
    const before = server.hits(path);

    await button.click();
    await expect(button.locator(".btn-text")).toHaveText("Copied!");
    expect(server.hits(path) - before).toBe(1);
  });

  for (const [how, close] of Object.entries(closeErrorModal)) {
    test(`removes the error dialog's keydown listener when closed with ${how}`, async ({ page }) => {
      const keydownListeners = await trackKeydownListeners(page);
      const button = await openDictationButton(page, server.url("/missing/DICTATION.md"));
      const before = await keydownListeners();

      await button.click();
      const { overlay, modal } = await expectErrorModal(page, button, "Failed to fetch file: 404");
      expect(await keydownListeners()).toBe(before + 1);

      await close(page, overlay);
      await expect(modal).toHaveCount(0);
      expect(await keydownListeners()).toBe(before);
    });
  }
});
