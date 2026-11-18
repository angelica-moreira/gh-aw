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
// Each page is visited once per mode, on its own server, so no report is credited to the wrong mode.
// - behavior: no Trusted Types, so page code runs exactly as it does for users. Script runs here are authoritative.
// - policy: Chromium passes every HTML write to the gate's default policy, and reports the name of every
//   policy page code creates (only `default` is allowed), including a second `default`.
const SCRIPT_CSP = `script-src 'self' 'report-sample'; report-uri ${REPORT_PATH}`;
export const CSP = { behavior: SCRIPT_CSP, policy: `${SCRIPT_CSP}; require-trusted-types-for 'script'; trusted-types default` };
export const MODES = Object.keys(CSP);
const TT_DIRECTIVE = "require-trusted-types-for";
const POLICY_DIRECTIVE = "trusted-types";
const MAX_SINK_CHARS = 80;

// Runs before page scripts in policy mode and claims the only `default` Trusted Types policy, so
// page code cannot replace it. It records HTML writes that hold the marker and returns them unchanged.
// Page code can still skip it with its own named policy; Chromium reports that policy's name.
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
// It also tells Node it started, so a page where it never ran is not mistaken for a clean page.
export const RECORDER = ({ marker, binding, started }) => {
  const report = globalThis[binding];
  const E = Error;
  let hits = 0;
  globalThis[started]?.("");
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

async function respond(res, file, csp) {
  try {
    const info = await stat(file);
    const path = info.isDirectory() ? join(file, "index.html") : file;
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "content-security-policy-report-only": csp });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}

const isOptional = (value, type) => value === undefined || typeof value === type;

// Keeps only the fields the gate reads, and only when they have the types Chromium sends.
// HTML-write reports are dropped: the default policy records those. Policy-creation reports are
// kept and flagged; their sample is the policy name.
function validReport(report) {
  if (typeof report?.["document-uri"] !== "string" || report["effective-directive"] === TT_DIRECTIVE) return null;
  const { "document-uri": uri, "script-sample": sample, "line-number": line, "column-number": column } = report;
  if (!isOptional(sample, "string") || !isOptional(line, "number") || !isOptional(column, "number")) return null;
  const policy = report["effective-directive"] === POLICY_DIRECTIVE ? { policy: true } : {};
  return { "document-uri": uri, "script-sample": sample, "line-number": line, "column-number": column, ...policy };
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

/** Serves dir under base with the CSP of `mode`. `reports` collects the CSP reports Chromium sends. */
export async function serve(dir, base, extra = {}, mode = "policy") {
  const root = normalize(dir);
  const csp = CSP[mode];
  const reports = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === REPORT_PATH) return collectReport(req, res, reports);
    if (extra[url.pathname]) return res.writeHead(200, { "content-type": "text/html", "content-security-policy-report-only": csp }).end(extra[url.pathname]);
    const file = filePathFor(url.pathname, base, root);
    return file ? respond(res, file, csp) : res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { mode, origin: `http://127.0.0.1:${server.address().port}`, reports, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Removes and returns, in arrival order, the reports Chromium sent for `url`. */
function takeFor(reports, url) {
  const taken = [];
  for (let i = reports.length - 1; i >= 0; i--) if (reports[i]["document-uri"] === url) taken.unshift(...reports.splice(i, 1));
  return taken;
}

/**
 * The distinct places where a script holding the marker was about to run. Chromium also sends
 * a copy without a location for some event handlers; that copy only counts when no located one exists.
 */
function scriptSites(taken, url, marker) {
  const hits = taken.filter(r => !r.policy && String(r["script-sample"] ?? "").includes(marker));
  const sites = new Set(hits.filter(r => r["line-number"]).map(r => `csp ${url}:${r["line-number"]}:${r["column-number"]}`));
  return sites.size || !hits.length ? [...sites] : [`csp ${url}`];
}

export const takeReports = (reports, url, marker) => scriptSites(takeFor(reports, url), url, marker);
const policyNames = taken => [...new Set(taken.filter(r => r.policy).map(r => String(r["script-sample"] ?? "").slice(0, MAX_SINK_CHARS)))];

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
// Page timers run on a fake clock that is moved this far ahead, so delayed writes are seen too.
const CLOCK_MS = 10_000;
const pageMaps = state => [state.hits, state.writes, state.starts];

async function visit(context, url, state) {
  const { marker, hits, writes, starts, reports } = state;
  const page = await context.newPage();
  try {
    await page.clock.install();
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.clock.runFor(CLOCK_MS);
    await page.waitForTimeout(SETTLE_MS);
    const seen = await page.evaluate(readPage, marker);
    const where = hits.get(page) ?? [];
    const taken = takeFor(reports, page.url());
    const reported = scriptSites(taken, page.url(), marker);
    const sinks = writes.get(page) ?? [];
    const runs = Math.max(seen.runs, where.length, reported.length);
    const found = { recorded: where.length, reported: reported.length, where: where.length ? where : reported };
    return { ...seen, runs, ...found, started: starts.get(page)?.length ?? 0, writes: sinks.length, sinks: [...new Set(sinks)], policies: policyNames(taken) };
  } finally {
    await page.close();
    for (const map of pageMaps(state)) map.delete(page);
  }
}

/** Gives page code a binding that appends what it is called with to `store`, per page. */
const recordInto = (store, limit) => ({ page }, value) => store.set(page, [...(store.get(page) ?? []), String(value).slice(0, limit)]);

/** Opens one browser context for `site`'s mode; only the policy mode installs the write recorder. */
async function openMode(browser, site, marker) {
  const context = await browser.newContext();
  const state = { marker, reports: site.reports, hits: new Map(), writes: new Map(), starts: new Map() };
  await context.exposeBinding(`${marker}r`, recordInto(state.hits, Infinity));
  await context.exposeBinding(`${marker}s`, recordInto(state.starts, 0));
  await context.addInitScript(RECORDER, { marker, binding: `${marker}r`, started: `${marker}s` });
  if (site.mode === "policy") {
    await context.exposeBinding(`${marker}w`, recordInto(state.writes, MAX_SINK_CHARS));
    await context.addInitScript(WRITE_RECORDER, { marker, binding: `${marker}w` });
  }
  await context.route("**/*", route => (route.request().url().startsWith(site.origin) ? route.continue() : route.abort()));
  return path => visit(context, `${site.origin}${path}`, state);
}

/**
 * Joins one page's results from both modes. Script runs count from whichever mode saw more, so
 * policy mode can never clear a run. `recorded`, `reported` and `started` keep the lower value,
 * meaning "seen in every mode". HTML writes and policy names only exist in policy mode.
 */
export function joinModes(behavior, policy) {
  return {
    ...behavior,
    runs: Math.max(behavior.runs, policy.runs),
    recorded: Math.min(behavior.recorded, policy.recorded),
    reported: Math.min(behavior.reported, policy.reported),
    started: Math.min(behavior.started, policy.started),
    where: behavior.where.length ? behavior.where : policy.where,
    writes: policy.writes,
    sinks: policy.sinks,
    policies: policy.policies,
  };
}

/**
 * Opens Chromium with one context per site (one per mode, see CSP) and gives `fn` a `visit(path)`
 * helper that loads the path in every mode and joins the results.
 */
export async function withBrowser({ nodeModules, marker, sites }, fn) {
  const { chromium } = createRequire(join(nodeModules, "..", "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const open = Object.fromEntries(await Promise.all(sites.map(async site => [site.mode, await openMode(browser, site, marker)])));
    return await fn(async path => joinModes(await open.behavior(path), await open.policy(path)));
  } finally {
    await browser.close();
  }
}
