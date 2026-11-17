// Proof stage: builds a small site with the revision's own Head component, puts attack
// strings in page fields, and counts real script runs in Chromium.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { inspect, serve, withBrowser } from "./browser.mjs";

const MARK = "globalThis.__proveIt=(globalThis.__proveIt||0)+1";
export const PAYLOADS = [`</ScRiPt><script>${MARK}</script><!--`, `"><img src=x onerror="${MARK}">`, `<svg/onload=${MARK}>`];
const FIELDS = ["title", "description"];
const CONTROL_TITLE = "Ordinary control title";
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** Finds Starlight's Head override in astro.config.mjs text. */
export function findHeadComponent(configText) {
  return /\bHead\s*:\s*["'`]([^"'`]+)["'`]/.exec(configText)?.[1] ?? null;
}

function siteConfig(headPath) {
  const authors = Object.fromEntries(PAYLOADS.map((p, i) => [`a${i}`, { name: p }]));
  return `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightBlog from "starlight-blog";
export default defineConfig({
  site: "https://example.invalid",
  base: "/gh-aw/",
  integrations: [starlight({
    title: "Proof site",
    components: { Head: ${JSON.stringify(headPath)} },
    plugins: [starlightBlog({ authors: ${JSON.stringify(authors)} })],
  })],
});
`;
}

const CONTENT_CONFIG = `import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { blogSchema } from "starlight-blog/schema";
export const collections = { docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: blogSchema }) }) };
`;

const BUILD_SCRIPT = `import { build } from "astro";
await build({ root: process.cwd(), logLevel: "error" });
`;

function page(data) {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${key === "date" ? value : JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\nProof page.\n`;
}

/** @returns {{file: string, text: string}[]} probe pages plus one harmless control page. */
export function probePages() {
  const pages = [{ file: "index.md", text: page({ title: CONTROL_TITLE }) }];
  PAYLOADS.forEach((payload, i) => {
    for (const field of FIELDS) {
      const data = { title: "Ordinary title", description: "Ordinary description", [field]: payload };
      pages.push({ file: `p${i}-${field}.md`, text: page(data) });
      pages.push({ file: `blog/p${i}-${field}.md`, text: page({ ...data, date: "2026-01-13", authors: [`a${i}`], tags: [payload] }) });
    }
  });
  return pages;
}

async function writeSite(root, headPath) {
  const content = join(root, "src/content/docs");
  await mkdir(join(content, "blog"), { recursive: true });
  await writeFile(join(root, "astro.config.mjs"), siteConfig(headPath));
  await writeFile(join(root, "src/content.config.ts"), CONTENT_CONFIG);
  await writeFile(join(root, "build.mjs"), BUILD_SCRIPT);
  for (const { file, text } of probePages()) await writeFile(join(content, file), text);
}

function buildSite(root) {
  const run = spawnSync(process.execPath, ["build.mjs"], { cwd: root, encoding: "utf8", timeout: BUILD_TIMEOUT_MS });
  return { ok: run.status === 0, log: `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}` };
}

async function htmlFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter(e => e.isFile() && e.name.endsWith(".html")).map(e => join(e.parentPath, e.name));
}

const BASE = "/gh-aw/";
const CONTROL_PATH = "/__prove-it/positive-control.html";
const CONTROL_HTML = `<!doctype html><html><head><script type="application/ld+json">{"x":"${PAYLOADS[0]}"}</script></head><body></body></html>`;

/** Turns a recorded call site ("at http://host/gh-aw/a/:98:795") into the HTML around it. */
export function snippetAt(site, html) {
  const match = /:(\d+):(\d+)\)?$/.exec(site);
  if (!match) return "";
  const line = html.split("\n")[Number(match[1]) - 1] ?? "";
  const col = Number(match[2]) - 1;
  return line.slice(Math.max(0, col - 160), col + 40);
}

async function pageResult(context, origin, dist, file) {
  const page = relative(dist, file).replaceAll("\\", "/");
  const result = await inspect(context, `${origin}${BASE}${page}`);
  if (result.runs === 0) return { page, ...result };
  const html = await readFile(file, "utf8");
  return { page, ...result, context: [...new Set(result.where.map(site => snippetAt(site, html)))] };
}

function verdictOf(pages, controlOk, hits) {
  const control = pages.find(p => p.page === "index.html");
  if (!controlOk) return { verdict: "inconclusive", reason: "the known-bad control page did not run its script, so the browser check is not working" };
  if (!control || control.runs > 0 || control.ldJsonBroken > 0) return { verdict: "inconclusive", reason: "the harmless control page did not render cleanly" };
  if (hits.length) return { verdict: "proven", reason: `attack strings ran as script on ${hits.length} page(s)` };
  return { verdict: "not-proven", reason: "no attack string ran as script on any probe page" };
}

// Pages that ran script are kept even when the verdict is inconclusive, so nothing recorded is lost.
function verdict(pages, controlOk) {
  const hits = pages.filter(p => p.runs > 0).map(p => p.page);
  return { ...verdictOf(pages, controlOk, hits), pages: hits };
}

async function checkSite(docsDir, root) {
  const dist = join(root, "dist");
  const server = await serve(dist, BASE, { [CONTROL_PATH]: CONTROL_HTML });
  try {
    return await withBrowser(docsDir, server.origin, async context => {
      const controlOk = (await inspect(context, `${server.origin}${CONTROL_PATH}`)).runs > 0;
      const pages = [];
      for (const file of await htmlFiles(dist)) pages.push(await pageResult(context, server.origin, dist, file));
      return { ...verdict(pages, controlOk), checked: pages.length, results: pages };
    });
  } finally {
    await server.close();
  }
}

/** Runs the proof for one checked-out docs folder. */
export async function prove({ docsDir }) {
  const head = findHeadComponent(await readFile(join(docsDir, "astro.config.mjs"), "utf8"));
  if (!head) return { verdict: "inconclusive", reason: "no Head override found in docs/astro.config.mjs" };
  await mkdir(join(docsDir, ".astro"), { recursive: true });
  const root = await mkdtemp(join(docsDir, ".astro", "prove-it-"));
  try {
    await writeSite(root, join(docsDir, head));
    const built = buildSite(root);
    if (!built.ok) return { verdict: "inconclusive", reason: "the proof site did not build", log: built.log.slice(-4000) };
    return { head, ...(await checkSite(docsDir, root)) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
