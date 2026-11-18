// Proof stage: builds a small site with the revision's own Starlight component overrides and
// real site address, puts attack strings in page fields, and counts real script runs in Chromium.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { MODES, serve, withBrowser } from "./browser.mjs";
import { checkJsonLd } from "./jsonld.mjs";
import { blankComments, blankStrings, matchClose } from "./lex.mjs";
import { loadTrusted, moduleAgrees } from "./parse.mjs";
import { runNode } from "./sandbox.mjs";

// Page fields that get an attack string, and how each is written in frontmatter.
const FIELDS = { title: p => p, description: p => p, sidebar: p => ({ label: p }) };
const CONTROL_TITLE = "Ordinary control title";
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SITE = { site: "https://localhost", base: "/" };

/** A fresh marker name per run, so a component cannot recognise the probe by a fixed name. */
export function newMarker() {
  return `__pi${randomBytes(6).toString("hex")}`;
}

/**
 * Attack strings that set the marker when they run as script. The bare name starts the script, so
 * it stays inside Chromium's 40-character CSP sample, and page code cannot shadow a name it does not know.
 * They break out of a script block, a double- or single-quoted attribute, and plain text, and two
 * are mutation XSS forms that only run after the browser re-parses markup that looked safe.
 */
export function payloads(marker) {
  const mark = `${marker}=1`;
  return [
    `</ScRiPt><script>${mark}</script><!--`,
    `"><img src=x onerror="${mark}">`,
    `<svg/onload=${mark}>`,
    `'><svg onload=${mark}>`,
    `<noscript><p title="</noscript><img src=x onerror=${mark}>">`,
    `<math><mtext><table><mglyph><style><img src=x onerror=${mark}>`,
  ];
}

const OVERRIDE = /^\s*(\w+)\s*:\s*(["'])([^"'`\n]+)\2\s*$/;
const KEY = /(?<![\w$])components(\s*:\s*\{)?(?![\w$])/g;
const QUOTED_KEY = /["'`]components["'`]/;

// Index of the `{` after the one `components:` key in code (strings and comments blanked, so a
// copy inside a string is not found), undefined when there is none, or -1 when it is ambiguous:
// a second mention (a decoy, or a shorthand property for the real one), a quoted key, or any
// backslash outside comments, since escapes can spell `components` in a key no text search sees.
function componentsBrace(configText) {
  const code = blankStrings(configText);
  if (code === null || QUOTED_KEY.test(configText) || blankComments(configText).includes("\\")) return -1;
  const found = [...code.matchAll(KEY)];
  if (!found.length) return undefined;
  return found.length === 1 && found[0][1] ? found[0].index + found[0][0].length - 1 : -1;
}

function overrides(body) {
  const entries = body.split(",").filter(part => part.trim()).map(part => OVERRIDE.exec(part));
  if (entries.some(m => !m)) return null;
  const names = entries.map(m => m[1]);
  return new Set(names).size === names.length ? Object.fromEntries(entries.map(m => [m[1], m[3]])) : null;
}

/**
 * Reads every Starlight component override (name to path) from astro.config.mjs text. Null when
 * `components` is ambiguous or any entry is not a plain `Name: "path"`.
 */
export function findComponents(configText) {
  const open = componentsBrace(configText);
  if (open === undefined) return {};
  const close = open < 0 ? -1 : matchClose(configText, open);
  return close < 0 ? null : overrides(configText.slice(open + 1, close));
}

/** Reads the top-level `site` and `base` strings, falling back to neutral values. */
export function findSite(configText) {
  const read = key => new RegExp(`^\\s*${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, "m").exec(configText)?.[1];
  return { site: read("site") ?? DEFAULT_SITE.site, base: read("base") ?? DEFAULT_SITE.base };
}

function siteConfig({ components, site, base, marker }) {
  const authors = Object.fromEntries(payloads(marker).map((p, i) => [`a${i}`, { name: p }]));
  return `import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightBlog from "starlight-blog";
export default defineConfig({
  site: ${JSON.stringify(site)},
  base: ${JSON.stringify(base)},
  integrations: [starlight({
    title: "Docs",
    components: ${JSON.stringify(components)},
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
export function probePages(marker) {
  const pages = [{ file: "index.md", text: page({ title: CONTROL_TITLE }) }];
  const slug = marker.slice(-6);
  payloads(marker).forEach((payload, i) => {
    for (const [field, value] of Object.entries(FIELDS)) {
      const data = { title: "Ordinary title", description: "Ordinary description", [field]: value(payload) };
      pages.push({ file: `${slug}${i}-${field}.md`, text: page(data) });
      pages.push({ file: `blog/${slug}${i}-${field}.md`, text: page({ ...data, date: "2026-01-13", authors: [`a${i}`], tags: [payload] }) });
    }
  });
  return pages;
}

async function writeSite(root, setup) {
  const content = join(root, "src/content/docs");
  await mkdir(join(content, "blog"), { recursive: true });
  await writeFile(join(root, "astro.config.mjs"), siteConfig(setup));
  await writeFile(join(root, "src/content.config.ts"), CONTENT_CONFIG);
  await writeFile(join(root, "build.mjs"), BUILD_SCRIPT);
  for (const { file, text } of probePages(setup.marker)) await writeFile(join(content, file), text);
}

function buildSite(root, sandbox) {
  const run = runNode(["build.mjs"], { cwd: root, sandbox, timeoutMs: BUILD_TIMEOUT_MS });
  return { ok: run.status === 0, log: `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? String(run.error) : ""}` };
}

async function htmlFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter(e => e.isFile() && e.name.endsWith(".html")).map(e => join(e.parentPath, e.name));
}

const CONTROL_PATH = "/__prove-it/positive-control.html";
const controlHtml = marker => `<!doctype html><html><head><script type="application/ld+json">{"x":"${payloads(marker)[0]}"}</script></head><body></body></html>`;

/** Turns a recorded call site ("at http://host/gh-aw/a/:98:795") into the HTML around it. */
export function snippetAt(site, html) {
  const match = /:(\d+):(\d+)\)?$/.exec(site);
  if (!match) return "";
  const line = html.split("\n")[Number(match[1]) - 1] ?? "";
  const col = Number(match[2]) - 1;
  return line.slice(Math.max(0, col - 160), col + 40);
}

async function pageResult(visit, base, dist, file, { marker, html5 }) {
  const page = relative(dist, file).replaceAll("\\", "/");
  const html = await readFile(file, "utf8");
  const result = { page, ...(await visit(`${base}${page}`)), ld: checkJsonLd(html, payloads(marker), html5) };
  return result.runs === 0 ? result : { ...result, context: [...new Set(result.where.map(site => snippetAt(site, html)))] };
}

/** The HTML file each probe page builds to, as `checkSite` names pages. */
export const expectedPages = marker => probePages(marker).map(({ file }) => (file === "index.md" ? "index.html" : `${file.slice(0, -3)}/index.html`));

/** Why the checked pages do not cover the probe, or null when they do. */
export function coverageGap(pages, marker) {
  const built = new Set(pages.map(p => p.page));
  const missing = expectedPages(marker).filter(page => !built.has(page));
  if (missing.length) return `${missing.length} probe page(s) were not built where expected, e.g. ${missing[0]}`;
  const silent = pages.filter(p => !p.started).map(p => p.page);
  return silent.length ? `the recorder did not start on ${silent.length} page(s), e.g. ${silent[0]}` : null;
}

function verdictOf(pages, controlOk, hits, marker) {
  const control = pages.find(p => p.page === "index.html");
  if (!controlOk) return { verdict: "inconclusive", reason: "the known-bad control page was not seen running its script by both the recorder and the browser's CSP reports in every browser mode, so the browser check is not working" };
  if (!control || control.runs > 0 || control.ldJsonBroken > 0) return { verdict: "inconclusive", reason: "the harmless control page did not render cleanly" };
  const gap = coverageGap(pages, marker);
  if (gap) return { verdict: "inconclusive", reason: gap };
  if (hits.length) return { verdict: "proven", reason: `attack strings ran as script on ${hits.length} page(s)` };
  return { verdict: "not-proven", reason: "no attack string ran as script on any probe page" };
}

// Pages that ran script are kept even when the verdict is inconclusive, so nothing recorded is lost.
function verdict(pages, controlOk, marker) {
  const hits = pages.filter(p => p.runs > 0).map(p => p.page);
  return { ...verdictOf(pages, controlOk, hits, marker), pages: hits };
}

async function checkSite(root, { base, marker, nodeModules, html5 }) {
  const dist = join(root, "dist");
  const sites = await Promise.all(MODES.map(mode => serve(dist, base, { [CONTROL_PATH]: controlHtml(marker) }, mode)));
  try {
    return await withBrowser({ nodeModules, marker, sites }, async visit => {
      const control = await visit(CONTROL_PATH);
      const controlOk = control.recorded > 0 && control.reported > 0;
      const pages = [];
      for (const file of await htmlFiles(dist)) pages.push(await pageResult(visit, base, dist, file, { marker, html5 }));
      return { ...verdict(pages, controlOk, marker), checked: pages.length, results: pages };
    });
  } finally {
    await Promise.all(sites.map(site => site.close()));
  }
}

function absoluteComponents(docsDir, components) {
  return Object.fromEntries(Object.entries(components).map(([name, path]) => [name, join(docsDir, path)]));
}

/**
 * Runs the proof for one checked-out docs folder. Base and head get the same marker, so page
 * names (which contain it) line up. Playwright is loaded from the trusted `nodeModules`.
 */
export async function prove({ docsDir, marker, nodeModules, sandbox, parser }) {
  const html5 = loadTrusted(nodeModules, "parse5");
  if (!html5) return { verdict: "inconclusive", reason: `no parse5 under ${nodeModules}; the JSON-LD check needs it to read the built pages` };
  const rawConfig = await readFile(join(docsDir, "astro.config.mjs"), "utf8");
  if (!moduleAgrees(rawConfig, "astro.config.mjs", parser)) return { verdict: "inconclusive", reason: "the gate's lexer and a JavaScript parser read docs/astro.config.mjs differently" };
  const configText = blankComments(rawConfig);
  if (configText === null) return { verdict: "inconclusive", reason: "docs/astro.config.mjs could not be read as code" };
  const components = findComponents(configText);
  if (!components) return { verdict: "inconclusive", reason: "docs/astro.config.mjs must name `components` once, as an object of plain `Name: \"path\"` entries" };
  if (!Object.keys(components).length) return { verdict: "inconclusive", reason: "no component overrides found in docs/astro.config.mjs" };
  const setup = { ...findSite(configText), components: absoluteComponents(docsDir, components), marker, nodeModules, html5 };
  await mkdir(join(docsDir, ".astro"), { recursive: true });
  const root = await mkdtemp(join(docsDir, ".astro", "prove-it-"));
  try {
    await writeSite(root, setup);
    const built = buildSite(root, sandbox);
    if (!built.ok) return { verdict: "inconclusive", reason: "the proof site did not build", log: built.log.slice(-4000) };
    return { components: Object.keys(components), ...(await checkSite(root, setup)) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}