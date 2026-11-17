// Serves a built site on 127.0.0.1 and records where marker scripts run in Chromium.
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, sep } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".xml": "application/xml" };

// Runs before page scripts: records the call site each time the marker fires.
const RECORDER = () => {
  let count = 0;
  const where = [];
  Object.defineProperty(globalThis, "__proveIt", {
    configurable: true,
    get: () => count,
    set(value) {
      count = value;
      where.push(new Error().stack.split("\n")[2]?.trim() ?? "");
    },
  });
  globalThis.__proveItWhere = where;
};

/** Maps a URL path under `base` to a file under `dir`, refusing anything outside it. */
export function filePathFor(urlPath, base, dir) {
  if (!urlPath.startsWith(base)) return null;
  const rest = decodeURIComponent(urlPath.slice(base.length).split("?")[0]);
  const full = normalize(join(dir, rest.endsWith("/") || rest === "" ? `${rest}index.html` : rest));
  return full === dir || full.startsWith(dir + sep) ? full : null;
}

async function respond(res, file) {
  try {
    const info = await stat(file);
    const path = info.isDirectory() ? join(file, "index.html") : file;
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}

export async function serve(dir, base, extra = {}) {
  const root = normalize(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (extra[url.pathname]) return res.writeHead(200, { "content-type": "text/html" }).end(extra[url.pathname]);
    const file = filePathFor(url.pathname, base, root);
    return file ? respond(res, file) : res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

function readPage() {
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent ?? "");
  const broken = blocks.filter(text => {
    try {
      JSON.parse(text);
      return false;
    } catch {
      return true;
    }
  });
  return { runs: globalThis.__proveIt ?? 0, where: globalThis.__proveItWhere ?? [], ldJson: blocks.length, ldJsonBroken: broken.length };
}

export async function inspect(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(150);
    return await page.evaluate(readPage);
  } finally {
    await page.close();
  }
}

export async function withBrowser(docsDir, origin, fn) {
  const { chromium } = createRequire(join(docsDir, "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(RECORDER);
    await context.route("**/*", route => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    return await fn(context);
  } finally {
    await browser.close();
  }
}
