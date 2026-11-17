// node --test reporter: one JSON line per finished test, named by its full suite path.
// Start events arrive in definition order, so a stack indexed by nesting gives each test's ancestors.
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
    yield `${JSON.stringify({ status: status(event), name, file: event.data.file ?? "" })}\n`;
  }
}
