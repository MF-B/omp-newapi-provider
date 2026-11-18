import { createCatalog } from "./catalog.ts";
import { object } from "./config.ts";
import type { Catalog, CatalogModel } from "./types.ts";

export async function loadOmpCatalog(): Promise<{ catalog: Catalog; agentDir?: string }> {
  // OMP's virtual modules do not exist in a standalone Node test process, so this host-only boundary loads lazily.
  const ai = await import("@earendil-works/pi-ai") as Record<string, unknown>;
  const providers = ai.getBundledProviders ?? ai.getProviders;
  const models = ai.getModels ?? ai.getBundledModels;
  if (typeof providers !== "function" || typeof models !== "function") {
    throw new Error("omp-newapi-provider requires OMP getBundledProviders/getModels catalog exports");
  }
  const rows: CatalogModel[] = [];
  for (const entry of providers() as unknown[]) {
    const id = typeof entry === "string" ? entry : object(entry) ? entry.id : undefined;
    if (typeof id !== "string") continue;
    const found: unknown = models(id);
    if (!Array.isArray(found)) throw new Error("OMP bundled model catalog returned an invalid model list");
    for (const model of found) rows.push({ ...model, provider: id });
  }
  const agent = await import("@earendil-works/pi-coding-agent") as Record<string, unknown>;
  const agentDir = typeof agent.getAgentDir === "function" ? agent.getAgentDir() as string : undefined;
  return { catalog: createCatalog(rows), agentDir };
}
