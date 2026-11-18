import type { Catalog, CatalogModel } from "./types.ts";

function identity(id: string): string {
  return id.toLowerCase().replace(/^(?:openai|google|anthropic)\//, "");
}

function aliases(id: string): string[] {
  const value = identity(id);
  return [...new Set([
    value,
    value.replace(/(?:@[^/]+|:(?:thinking|high|medium|low|xhigh|max))$/, ""),
    value.replace(/[-@](?:20\d{2}-?\d{2}-?\d{2})$/, ""),
  ])];
}

export function createCatalog(models: readonly CatalogModel[]): Catalog {
  const index = new Map<string, CatalogModel[]>();
  for (const model of models) {
    if (!model || typeof model.id !== "string") continue;
    const key = identity(model.id);
    const entries = index.get(key) ?? [];
    entries.push(model);
    index.set(key, entries);
  }
  return {
    find(id, preferredProviders = []) {
      for (const key of aliases(id)) {
        const rows = index.get(key);
        if (!rows?.length) continue;
        return [...rows].sort((a, b) => {
          const rank = (m: CatalogModel) => {
            const at = preferredProviders.indexOf(m.provider ?? "");
            return at < 0 ? preferredProviders.length : at;
          };
          return rank(a) - rank(b);
        })[0];
      }
      return undefined;
    },
  };
}
