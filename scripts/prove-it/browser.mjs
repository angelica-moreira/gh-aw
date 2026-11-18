// Serves a built site on 127.0.0.1 and records where marker scripts run in Chromium.
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, sep } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".xml": "application/xml" };
const REPORT_PATH = "/__prove-it/csp-report";
const MAX_REPORT_BYTES = 64 * 1024;

// Report-only: nothing is blocked, but Chromium itself reports every inline script and event
// handler about to run, with its first 40 characters. Page code cannot stop these reports.
// The Trusted Types directive makes Chromium pass every HTML write to the default policy.
export const CSP = `script-src 'self' 'report-sample'; require-trusted-types-for 'script'; report-uri ${REPORT_PATH}`;
const TT_DIRECTIVE = "require-trusted-types-for";
const MAX_SINK_CHARS = 80;

// Runs before page scripts and claims the only `default` Trusted Types policy, so page code
// cannot replace it. It records HTML writes that hold the marker and returns them unchanged.
// Page code can still skip it with its own named policy, so these writes only ever warn.
export const WRITE_RECORDER = ({ marker, binding }) => {
  const report = globalThis[binding];
  const tt = globalThis.trustedTypes;
  if (!tt) return;
  const pass = value => value;
  const createHTML = (value, type, sink) => {
    if (String(value).includes(marker)) report(String(sink));
    return value;
  };
  tt.createPolicy("default", { createHTML, createScript: pass, createScriptURL: pass });
};

// Runs before page scripts. The marker property cannot be redefined, and each hit is also sent
// to Node through a binding captured here. Built-ins are captured too, and the hit is counted
// before anything page code could have tampered with, so later page code cannot hide a hit.
// `globalThis` is pinned so page code cannot point the attack strings at another object.
export const RECORDER = ({ marker, binding }) => {
  const report = globalThis[binding];
  const E = Error;
  let hits = 0;
  Object.defineProperty(globalThis, "globalThis", { value: globalThis, writable: false, configurable: false });
  // Frames: the Error line, siteOf, the setter, then the code that set the marker.
  const siteOf = () => {
    try {
      return String(new E().stack).split("\n")[3]?.trim() ?? "";
    } catch {
      return "";
    }
  };
  Object.defineProperty(globalThis, marker, {
    configurable: false,
    get: () => hits,
    set() {
      hits++;
      try {
        report(siteOf());
      } catch {
        report("");
      }
    },
  });
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
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "content-security-policy-report-only": CSP });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}

const isOptional = (value, type) => value === undefined || typeof value === type;

// Keeps only the fields takeReports reads, and only when they have the types Chromium sends.
// Trusted Types reports describe HTML writes, not scripts about to run, so they are dropped.
function validReport(report) {
  if (typeof report?.["document-uri"] !== "string" || report["effective-directive"] === TT_DIRECTIVE) return null;
  const { "document-uri": uri, "script-sample": sample, "line-number": line, "column-number": column } = report;
  if (!isOptional(sample, "string") || !isOptional(line, "number") || !isOptional(column, "number")) return null;
  return { "document-uri": uri, "script-sample": sample, "line-number": line, "column-number": column };
}

function collectReport(req, res, reports) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", chunk => {
    body += chunk;
    if (body.length > MAX_REPORT_BYTES) req.destroy();
  });
  req.on("end", () => {
    try {
      const report = validReport(JSON.parse(body)?.["csp-report"]);
      if (report) reports.push(report);
    } catch {}
    res.writeHead(204).end();
  });
}

/** Serves dir under base. `reports` collects the CSP reports Chromium sends for pages it loaded. */
export async function serve(dir, base, extra = {}) {
  const root = normalize(dir);
  const reports = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === REPORT_PATH) return collectReport(req, res, reports);
    if (extra[url.pathname]) return res.writeHead(200, { "content-type": "text/html", "content-security-policy-report-only": CSP }).end(extra[url.pathname]);
    const file = filePathFor(url.pathname, base, root);
    return file ? respond(res, file) : res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, reports, close: () => new Promise(resolve => server.close(resolve)) };
}

/**
 * Takes the reports for `url` out of `reports` and returns the distinct places where a script
 * holding the marker was about to run. Chromium also sends a copy without a location for some
 * event handlers; that copy only counts when no located report exists.
 */
export function takeReports(reports, url, marker) {
  const sites = new Set();
  let unlocated = false;
  for (let i = reports.length - 1; i >= 0; i--) {
    const report = reports[i];
    if (report["document-uri"] !== url) continue;
    reports.splice(i, 1);
    if (!String(report["script-sample"] ?? "").includes(marker)) continue;
    if (report["line-number"]) sites.add(`csp ${url}:${report["line-number"]}:${report["column-number"]}`);
    else unlocated = true;
  }
  return sites.size || !unlocated ? [...sites].reverse() : [`csp ${url}`];
}

function readPage(marker) {
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent ?? "");
  const broken = blocks.filter(text => {
    try {
      JSON.parse(text);
      return false;
    } catch {
      return true;
    }
  });
  return { runs: globalThis[marker] ?? 0, ldJson: blocks.length, ldJsonBroken: broken.length };
}

const SETTLE_MS = 500;

async function visit(context, url, { marker, hits, writes, reports }) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);
    const seen = await page.evaluate(readPage, marker);
    const where = hits.get(page) ?? [];
    const reported = takeReports(reports, page.url(), marker);
    const sinks = writes.get(page) ?? [];
    const runs = Math.max(seen.runs, where.length, reported.length);
    return { ...seen, runs, recorded: where.length, reported: reported.length, where: where.length ? where : reported, writes: sinks.length, sinks: [...new Set(sinks)] };
  } finally {
    await page.close();
    hits.delete(page);
    writes.delete(page);
  }
}

/** Gives page code a binding that appends what it is called with to `store`, per page. */
const recordInto = (store, limit) => ({ page }, value) => store.set(page, [...(store.get(page) ?? []), String(value).slice(0, limit)]);

/** Opens Chromium with the recorder installed and gives `fn` a `visit(url)` helper. */
export async function withBrowser({ nodeModules, origin, marker, reports }, fn) {
  const { chromium } = createRequire(join(nodeModules, "..", "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const hits = new Map();
    const writes = new Map();
    await context.exposeBinding(`${marker}r`, recordInto(hits, Infinity));
    await context.exposeBinding(`${marker}w`, recordInto(writes, MAX_SINK_CHARS));
    await context.addInitScript(RECORDER, { marker, binding: `${marker}r` });
    await context.addInitScript(WRITE_RECORDER, { marker, binding: `${marker}w` });
    await context.route("**/*", route => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    return await fn(url => visit(context, url, { marker, hits, writes, reports }));
  } finally {
    await browser.close();
  }
}
