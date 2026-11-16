import type { Page } from "@playwright/test";

export type JsonLdEntity = Record<string, unknown> & { "@type"?: string | string[] };

/** Every JSON-LD entity on the page, across all ld+json scripts, with `@graph` containers flattened. */
export async function jsonLdEntities(page: Page): Promise<JsonLdEntity[]> {
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  return scripts.flatMap((raw, index) => {
    if (!raw.trim()) throw new Error(`ld+json script #${index} is empty`);
    const data: unknown = JSON.parse(raw);
    const roots = Array.isArray(data) ? data : [data];
    return roots.flatMap((root) => {
      const entity = asEntity(root, `ld+json script #${index}`);
      const graph = entity["@graph"];
      if (graph === undefined) return [entity];
      if (!Array.isArray(graph)) throw new Error(`ld+json script #${index} has a non-array @graph`);
      return graph.map((member, position) => asEntity(member, `ld+json script #${index} @graph[${position}]`));
    });
  });
}

function asEntity(value: unknown, where: string): JsonLdEntity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} is not an object: ${JSON.stringify(value)}`);
  return value as JsonLdEntity;
}

/** Entities whose `@type` is or includes `type`. */
export function entitiesOfType(entities: JsonLdEntity[], type: string): JsonLdEntity[] {
  return entities.filter((entity) => [entity["@type"]].flat().includes(type));
}
