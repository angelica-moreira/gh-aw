import type { BrowserContext, Page } from "@playwright/test";

/**
 * Text that navigator.clipboard.readText() returns after the page writes `text`.
 * Chromium on Windows normalises clipboard text to CRLF line endings.
 */
export function expectedClipboardText(text: string): string {
  return process.platform === "win32" ? text.replace(/\r?\n/g, "\r\n") : text;
}

export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
