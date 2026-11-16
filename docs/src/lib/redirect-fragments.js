// Astro integration: keeps the URL fragment when a static redirect page forwards the visitor.
// Astro's static redirects are meta-refresh pages, and a meta refresh drops `#fragment`, so
// bookmarks like /gh-aw/old-page/#section lose their section. A small script placed before the
// meta refresh forwards the incoming fragment unless the destination sets its own; the meta
// refresh stays as the no-JavaScript fallback.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const META_TAG_RE = /<meta\s[^>]*>/gi;
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the HTML entities Astro writes into attribute values; throws on anything unexpected. */
export function decodeHtmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === "#") return String.fromCodePoint(body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
    const decoded = NAMED_ENTITIES[body.toLowerCase()];
    if (decoded === undefined) throw new Error(`redirect-fragments: unsupported HTML entity ${entity}`);
    return decoded;
  });
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3]) : undefined;
}

/** Returns the destination of the only meta refresh tag in `html` along with the tag itself. */
export function readMetaRefresh(html) {
  const tags = [...html.matchAll(META_TAG_RE)].filter(([tag]) => attribute(tag, "http-equiv")?.trim().toLowerCase() === "refresh");
  if (tags.length !== 1) throw new Error(`expected exactly one meta refresh tag, found ${tags.length}`);
  const [tag] = tags[0];
  const content = attribute(tag, "content") ?? "";
  // Trim first and start the URL at a non-space so no two parts of the pattern compete for the same spaces (linear time).
  const match = /^\d+\s*;\s*url\s*=\s*(\S.*)$/i.exec(content.trim());
  if (!match) throw new Error(`meta refresh has no url: ${tag}`);
  const url = /^(["'])(.*)\1$/.exec(match[1])?.[2] ?? match[1];
  return { tag, index: tags[0].index, url };
}

// Any origin works: it only resolves root-relative destinations so both sides compare as full URLs.
const COMPARISON_BASE = "https://redirect-fragments.invalid/";

/** True when two redirect URLs name the same resource once URL-normalized (case, encoding, empty path). */
export function sameDestination(a, b) {
  return new URL(a, COMPARISON_BASE).href === new URL(b, COMPARISON_BASE).href;
}

/** Throws unless `destination` is a root-relative path or an absolute http(s) URL. */
export function assertSupportedDestination(source, destination) {
  const fail = (reason) => {
    throw new Error(`redirect-fragments: ${source} -> ${JSON.stringify(destination)}: ${reason}`);
  };
  // URL parsing strips or rewrites these (e.g. "java\nscript:", "/\\host"), so reject them up front.
  if (/[\u0000-\u0020\u007f\\]/.test(destination)) fail("whitespace, control characters and backslashes are not supported");
  if (destination.startsWith("/")) {
    if (destination.startsWith("//")) fail("protocol-relative destinations are not supported");
    return;
  }
  let url;
  try {
    url = new URL(destination);
  } catch {
    fail("destinations must be root-relative paths or absolute http(s) URLs");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`unsupported destination scheme "${url.protocol}"`);
}

const SCRIPT_MARKER = "data-redirect-fragments";

/** The script that forwards the incoming fragment; an explicit destination fragment wins. */
export function fragmentScript(destination) {
  const target = JSON.stringify(destination).replace(/</g, "\\u003c");
  return `<script ${SCRIPT_MARKER}>var u=new URL(${target},location.href);if(location.hash&&!u.hash)u.hash=location.hash;location.replace(u.href)</script>`;
}

/** Inserts the fragment script before the meta refresh of a verified redirect page; refuses to inject twice. */
export function addFragmentScript(html, destination) {
  if (html.includes(SCRIPT_MARKER)) throw new Error("page already contains the fragment script");
  const refresh = readMetaRefresh(html);
  if (!sameDestination(refresh.url, destination)) throw new Error(`meta refresh points at ${refresh.url}, expected ${destination}`);
  return html.slice(0, refresh.index) + fragmentScript(destination) + html.slice(refresh.index);
}

/** Static string redirects declared by the project, as `{ source, destination }`. */
export function projectRedirects(routes) {
  return routes
    .filter((route) => route.type === "redirect")
    .map((route) => {
      const source = route.entrypoint;
      if (typeof route.redirect !== "string") throw new Error(`redirect-fragments: ${source}: object-form redirects are not supported`);
      if (route.params.length > 0) throw new Error(`redirect-fragments: ${source}: dynamic redirects are not supported`);
      assertSupportedDestination(source, route.redirect);
      return { source, destination: route.redirect };
    });
}

/** @returns {import("astro").AstroIntegration} */
export default function redirectFragments() {
  /** @type {{ source: string, destination: string }[] | undefined} */
  let redirects;

  return {
    name: "redirect-fragments",
    hooks: {
      "astro:routes:resolved": ({ routes }) => {
        redirects = projectRedirects(routes);
      },
      "astro:build:done": async ({ dir, logger }) => {
        if (!redirects) throw new Error("redirect-fragments: astro:routes:resolved did not run before astro:build:done");
        for (const { source, destination } of redirects) {
          const relative = source.replace(/^\/+/, "");
          const file = new URL(`${relative}${relative === "" || relative.endsWith("/") ? "" : "/"}index.html`, dir);
          let html;
          try {
            html = await readFile(file, "utf8");
          } catch (error) {
            throw new Error(`redirect-fragments: ${source}: cannot read ${fileURLToPath(file)}`, { cause: error });
          }
          try {
            await writeFile(file, addFragmentScript(html, destination));
          } catch (error) {
            throw new Error(`redirect-fragments: ${source} (${fileURLToPath(file)}): ${error.message}`, { cause: error });
          }
        }
        logger.info(`preserved URL fragments on ${redirects.length} redirect pages`);
      },
    },
  };
}
