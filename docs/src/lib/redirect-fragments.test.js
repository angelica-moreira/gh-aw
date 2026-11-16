// Unit tests for redirect-fragments.js against Astro's own redirect page template.
// Run with: node --test docs/src/lib/redirect-fragments.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import { addFragmentScript, assertSupportedDestination, projectRedirects, readMetaRefresh } from "./redirect-fragments.js";

const { redirectTemplate } = await import(new URL("../../node_modules/astro/dist/core/routing/3xx.js", import.meta.url).href);

// Astro URI-encodes internal destinations before rendering (core/redirects/render.js).
const page = (destination, status = 301) =>
  redirectTemplate({ status, relativeLocation: destination.startsWith("/") ? encodeURI(destination) : destination, absoluteLocation: destination, from: "/old/" });

test("accepts Astro's rendering of valid destinations", () => {
  for (const destination of ["/gh-aw/new/", "/gh-aw/new/#section", "/gh-aw/new?a=1&b=2", "/gh-aw/café/", "https://example.com", "https://EXAMPLE.com/x"]) {
    const html = addFragmentScript(page(destination), destination);
    assert.ok(html.indexOf("<script data-redirect-fragments>") < html.indexOf('http-equiv="refresh"'), destination);
  }
  assert.doesNotThrow(() => addFragmentScript(page("/gh-aw/new/", 302), "/gh-aw/new/"));
});

test("rejects a refresh pointing elsewhere, missing or duplicate refresh tags, and double injection", () => {
  assert.throws(() => addFragmentScript(page("/gh-aw/other/"), "/gh-aw/new/"), /meta refresh points at/);
  assert.throws(() => addFragmentScript("<title>x</title>", "/gh-aw/new/"), /found 0/);
  const twice = page("/gh-aw/new/").replace("<meta name", '<meta http-equiv="refresh" content="0;url=/gh-aw/new/"><meta name');
  assert.throws(() => addFragmentScript(twice, "/gh-aw/new/"), /found 2/);
  assert.throws(() => addFragmentScript(addFragmentScript(page("/gh-aw/new/"), "/gh-aw/new/"), "/gh-aw/new/"), /already contains/);
});

test("escapes the destination so it cannot close the script", () => {
  const destination = "/gh-aw/new/</script><script>alert(1)//";
  const html = addFragmentScript(page(destination), destination);
  assert.equal(html.match(/<\/script>/g).length, 1);
});

test("rejects unsupported or ambiguous destinations", () => {
  for (const destination of ["javascript:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "//evil.example/x", "/\\evil.example/x", "relative/path", "mailto:a@b.c", "/a b/"]) {
    assert.throws(() => assertSupportedDestination("/old/", destination), /redirect-fragments/, JSON.stringify(destination));
  }
});

test("only accepts static string redirects", () => {
  const route = (extra) => ({ type: "redirect", entrypoint: "/old/", params: [], redirect: "/gh-aw/new/", ...extra });
  assert.deepEqual(projectRedirects([route({}), { type: "page" }]), [{ source: "/old/", destination: "/gh-aw/new/" }]);
  assert.throws(() => projectRedirects([route({ redirect: { status: 302, destination: "/gh-aw/new/" } })]), /object-form/);
  assert.throws(() => projectRedirects([route({ params: ["slug"] })]), /dynamic/);
});

test("reads the refresh url however the content attribute is spaced, quoted or encoded", () => {
  const read = (content) => readMetaRefresh(`<meta http-equiv="refresh" content="${content}">`).url;
  assert.equal(read("0;url=/gh-aw/new/"), "/gh-aw/new/");
  assert.equal(read(" \n 5 ; URL =\t/gh-aw/new/ \n"), "/gh-aw/new/");
  assert.equal(read("0;url='/gh-aw/a b/'"), "/gh-aw/a b/");
  assert.equal(read("0;url=&#47;gh-aw&#x2F;new/?a=1&amp;b=2"), "/gh-aw/new/?a=1&b=2");
  for (const content of ["0;url=", "0;url=   ", "0;url=/a\n/b", "x;url=/a", "0url=/a"]) {
    assert.throws(() => read(content), /meta refresh has no url/, JSON.stringify(content));
  }
});

test("a blank refresh url does not count as a redirect to the site root", () => {
  const html = '<meta http-equiv="refresh" content="0;url= ">';
  assert.throws(() => addFragmentScript(html, "/"), /meta refresh has no url/);
});

test("parses hostile refresh content in linear time", () => {
  const started = performance.now();
  assert.throws(() => readMetaRefresh(`<meta http-equiv="refresh" content="0;url=${" ".repeat(5000)}x\nz">`), /no url/);
  assert.ok(performance.now() - started < 1000, "refresh parsing should not backtrack");
});
