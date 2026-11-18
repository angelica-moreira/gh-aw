// node --test reporter: one signed JSON line per finished test, named by its full suite path.
// Start events arrive in definition order, so a stack indexed by nesting gives each test's ancestors.
// The gate sends a one-time key on stdin and this reporter reads it before any test process starts,
// so lines a test prints cannot carry a valid signature. Test code that reads the runner's memory
// could still find the key, and code under test can change its own results anyway, so test results
// are evidence; the JSON-LD and browser checks the gate runs itself decide the escaper verdict.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY = readFileSync(0);
let seq = 0;

function signed(record) {
  const json = JSON.stringify({ ...record, seq: seq++ });
  return `${createHmac("sha256", KEY).update(json).digest("hex")} ${json}\n`;
}

function status(event) {
  if (event.data.skip !== undefined) return "skip";
  if (event.data.todo !== undefined) return "todo";
  return event.type.slice("test:".length);
}

export default async function* jsonLines(source) {
  const path = [];
  for await (const event of source) {
    if (event.type === "test:start") path.splice(event.data.nesting, Infinity, event.data.name);
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    const name = [...path.slice(0, event.data.nesting), event.data.name].join(" > ");
    yield signed({ status: status(event), name, file: event.data.file ?? "" });
  }
  yield signed({ end: true });
}
