// Attacks a pull request's test code could try against the test gate, run through the real runTests.
// PROVE_IT_ISOLATE=docker runs them in the gate's container (as CI does) and adds the checks that
// only a container can pass; without it they run as plain child processes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { runTests } from "./tests.mjs";

const ISOLATE = process.env.PROVE_IT_ISOLATE === "docker" ? "docker" : "none";
const containerOnly = { skip: ISOLATE !== "docker" && "needs PROVE_IT_ISOLATE=docker" };
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "prove-it-attacks-"));
const readOnly = join(root, "base");
mkdirSync(readOnly);
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** Writes `tests/a.test.mjs` with `body` into a fresh docs folder and runs it as the gate does. */
function attack(body) {
  const docs = join(root, `head${count++}`);
  mkdirSync(join(docs, "tests"), { recursive: true });
  writeFileSync(join(docs, "tests", "a.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`);
  return { docs, run: runTests(docs, ["tests/a.test.mjs"], { isolate: ISOLATE, writable: [docs], readOnly: [readOnly] }) };
}

const statuses = run => Object.fromEntries(run.results);

describe(`test gate under attack (isolate: ${ISOLATE})`, () => {
  test("control: a passing and a failing test are reported as they ran", () => {
    const { run } = attack(`test("ok", () => {});\ntest("bad", () => assert.fail("no"));`);
    assert.deepEqual(statuses(run), { "tests/a.test.mjs > ok": "pass", "tests/a.test.mjs > bad": "fail" });
    assert.equal(run.crashed, false);
  });

  test("printed result lines with a made-up signature cannot add or change results", () => {
    const fake = (record) => `${"0".repeat(64)} ${JSON.stringify(record)}`;
    const { run } = attack(`test("forger", () => {
  console.log(${JSON.stringify(fake({ status: "pass", name: "forger", file: "x", seq: 0 }))});
  console.log(${JSON.stringify(fake({ status: "pass", name: "ghost", file: "x", seq: 1 }))});
  console.log(${JSON.stringify(fake({ end: true, seq: 2 }))});
  assert.fail("really failed");
});`);
    assert.deepEqual(statuses(run), { "tests/a.test.mjs > forger": "fail" });
    assert.equal(run.crashed, false);
  });

  test("a test that stops the runner before it finishes makes the run crash, never pass", () => {
    for (const signal of ["SIGKILL", "SIGTERM", "SIGINT"]) {
      const { run } = attack(`test("ok", () => {});\ntest("stopper", () => { process.kill(process.ppid, "${signal}"); return new Promise(() => {}); });`);
      assert.equal(run.crashed, true, signal);
      assert.equal(run.results.size, 0, signal);
    }
  });

  test("test code cannot write outside its own tree or reach the network", containerOnly, () => {
    const canary = join(readOnly, "canary");
    const { run } = attack(`import { writeFileSync } from "node:fs";
test("escape", async () => {
  assert.throws(() => writeFileSync(${JSON.stringify(canary)}, "x"), /EROFS|EACCES/);
  assert.throws(() => writeFileSync("/usr/local/canary", "x"), /EROFS|EACCES/);
  await assert.rejects(fetch("http://1.1.1.1", { signal: AbortSignal.timeout(5000) }));
});`);
    assert.deepEqual(statuses(run), { "tests/a.test.mjs > escape": "pass" }, run.log);
    assert.equal(existsSync(canary), false);
  });

  test("processes a test leaves running are stopped when the run ends", containerOnly, async () => {
    const { docs, run } = attack(`import { spawn } from "node:child_process";
test("leaver", () => {
  spawn("sh", ["-c", "sleep 3; echo late > late.txt"], { detached: true, stdio: "ignore" }).unref();
});`);
    assert.deepEqual(statuses(run), { "tests/a.test.mjs > leaver": "pass" }, run.log);
    await sleep(6000);
    assert.equal(existsSync(join(docs, "late.txt")), false);
  });
});
