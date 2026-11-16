import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

export type Reply = { status: number; body: string };
export type Handler = () => Reply | Promise<Reply>;

export interface LocalServer {
  url(path: string): string;
  /** Number of requests the server received for `path`. */
  hits(path: string): number;
  /** Stops the server; throws if any request had no route or failed. */
  close(): Promise<void>;
}

/** Origin of the docs preview under test, from the project's `baseURL`. */
export function previewOrigin(testInfo: TestInfo): string {
  const { baseURL } = testInfo.project.use;
  if (!baseURL) throw new Error("The Playwright project must set use.baseURL");
  return new URL(baseURL).origin;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Real HTTP server on an ephemeral 127.0.0.1 port that answers GETs from the page at `origin`. */
export async function startLocalServer(origin: string, routes: Record<string, Handler>): Promise<LocalServer> {
  const hits = new Map<string, number>();
  const failures: string[] = [];
  const cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const handler = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (request.method !== "GET" || !handler) throw new Error("no route");
    const { status, body } = await handler();
    response.writeHead(status, { ...cors, "Content-Type": "text/plain; charset=utf-8" }).end(body);
  }

  // Every failure, including a malformed request URL, is recorded for close() instead of escaping as an unhandled rejection.
  const server = createServer((request, response) => {
    respond(request, response).catch((error: unknown) => {
      failures.push(`${request.method} ${request.url}: ${errorMessage(error)}`);
      if (response.headersSent) response.destroy();
      else response.writeHead(500, cors).end();
    });
  });
  const port = await listen(server);

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits: (path) => hits.get(path) ?? 0,
    async close() {
      await close(server);
      if (failures.length) throw new Error(`Local server errors:\n${failures.join("\n")}`);
    },
  };
}

/**
 * Real listener on an ephemeral 127.0.0.1 port that destroys every connection as soon as it
 * opens, so a fetch to it fails with a network error. Holding the port (unlike binding and
 * releasing it) means no other process can take it before the browser connects.
 */
export async function startResettingServer(): Promise<{ url(path: string): string; close(): Promise<void> }> {
  const server = createNetServer((socket) => socket.resetAndDestroy());
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

/** A promise that stays pending until `release()` is called. */
export function createGate(): { opened: Promise<void>; release: () => void } {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

/**
 * Opens `route` with the copy button for `from` fetching `to` instead.
 * CopyEntireFileButton reads data-filepath once, when it binds its click handler on
 * DOMContentLoaded, so the attribute is rewritten by a DOMContentLoaded listener that an
 * init script registers before any page script runs. Fails unless exactly one button was
 * retargeted and then bound with the new URL.
 */
export async function openWithCopyTarget(page: Page, route: string, from: string, to: string): Promise<Locator> {
  await page.addInitScript(
    ({ from, to }) => {
      document.addEventListener("DOMContentLoaded", () => {
        const buttons = [...document.querySelectorAll<HTMLElement>(".copy-entire-file-btn")].filter((button) => button.dataset.filepath === from);
        for (const button of buttons) button.dataset.filepath = to;
        (window as unknown as { __copyTargetRewrites: number }).__copyTargetRewrites = buttons.length;
      });
    },
    { from, to },
  );
  await page.goto(route);
  expect(await page.evaluate(() => (window as unknown as { __copyTargetRewrites?: number }).__copyTargetRewrites)).toBe(1);
  const button = page.locator(`.copy-entire-file-btn[data-filepath="${to}"]`);
  await expect(button).toHaveAttribute("data-copy-handler-attached", "true");
  return button;
}
