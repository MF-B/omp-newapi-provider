import { configPath, loadConfig } from "./config.ts";
import { discover } from "./discovery.ts";
import { loadOmpCatalog } from "./omp-shim.ts";
import type { Catalog, DiscoveryResult, Fetch, ModelDefinition, PluginConfig, ServiceConfig } from "./types.ts";

interface Context {
  modelRegistry: {
    refreshDiscoverableProviders(ids: Iterable<string>, strategy: "online"): Promise<void>;
    getProviderDiscoveryState?(id: string): { status: string; stale?: boolean } | undefined;
  };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
interface Registration {
  apiKey?: string;
  authHeader: true;
  remoteCompaction?: ServiceConfig["remoteCompaction"];
  fetchDynamicModels(apiKey: string | undefined): Promise<readonly ModelDefinition[]>;
}
export interface ExtensionHost {
  registerProvider(id: string, config: Registration): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: Context): Promise<void> }): void;
  on(event: "session_start", handler: (event: unknown, ctx: Context) => Promise<void>): void;
}
export interface ProviderDiagnostics {
  lastSuccessfulAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  result?: Omit<DiscoveryResult, "models">;
}

/** Dependency boundary for isolated tests; model caching belongs exclusively to OMP. */
export function installExtension(pi: ExtensionHost, config: PluginConfig, catalog: Catalog, fetcher?: Fetch): ReadonlyMap<string, ProviderDiagnostics> {
  const states = new Map<string, ProviderDiagnostics>();
  const ids = config.services.map(service => service.id);
  for (const service of config.services) {
    const state: ProviderDiagnostics = {};
    states.set(service.id, state);
    pi.registerProvider(service.id, {
      // Never set registration-level baseUrl: mixed /v1beta and /v1 rows must keep their own URLs.
      ...(service.apiKey !== undefined ? { apiKey: service.apiKey } : {}),
      // OMP resolves and projects this header at request time, so credentials never enter models.db.
      // Native Gemini/decision requests keep x-goog-api-key and also authenticate to the gateway with Bearer.
      authHeader: true,
      ...(service.remoteCompaction ? { remoteCompaction: service.remoteCompaction } : {}),
      async fetchDynamicModels(apiKey) {
        state.lastAttemptAt = new Date().toISOString();
        try {
          if (service.apiKey && (!apiKey || apiKey === service.apiKey)) throw new Error("OMP credential reference did not resolve");
          const { models, ...result } = await discover(service, apiKey, catalog, fetcher);
          state.result = result;
          state.lastSuccessfulAt = new Date().toISOString();
          delete state.lastError;
          return models;
        } catch (error) {
          // These errors are generated locally; HTTP bodies, credential references and response payloads are never logged.
          state.lastError = error instanceof Error ? error.message : "Model discovery failed";
          throw error; // OMP preserves the previous successful SQLite catalog on a failed refresh.
        }
      },
    });
  }
  const refresh = async (ctx: Context, requested: string[], announce: boolean): Promise<void> => {
    if (!requested.length) return;
    if (typeof ctx.modelRegistry.refreshDiscoverableProviders !== "function") {
      throw new Error("omp-newapi-provider requires OMP refreshDiscoverableProviders (18.22.2 or newer)");
    }
    await ctx.modelRegistry.refreshDiscoverableProviders(requested, "online");
    const failed = requested.filter(id => states.get(id)?.lastError);
    if (failed.length) ctx.ui.notify(`Model refresh failed for ${failed.join(", ")}; OMP retains the last successful catalog. Use /newapi-diagnostics.`, "warning");
    else if (announce) ctx.ui.notify(`Refreshed model discovery: ${requested.join(", ")}`, "info");
  };
  // Await a targeted live refresh after OMP has registered providers. No detached work or extension-owned timers/caches.
  pi.on("session_start", async (_event, ctx) => { await refresh(ctx, ids, false); });
  pi.registerCommand("newapi-refresh", {
    description: "Refresh configured gateway model catalogs online: /newapi-refresh [provider ...]",
    async handler(args, ctx) {
      const requested = args.trim() ? [...new Set(args.trim().split(/[\s,]+/))] : ids;
      const unknown = requested.filter(id => !states.has(id));
      if (unknown.length) { ctx.ui.notify(`Unknown gateway provider: ${unknown.join(", ")}`, "error"); return; }
      await refresh(ctx, requested, true);
    },
  });
  pi.registerCommand("newapi-diagnostics", {
    description: "Show discovery field sources and unknown prices: /newapi-diagnostics [provider[/model]]",
    async handler(args, ctx) {
      const selector = args.trim();
      const separator = selector.indexOf("/");
      const provider = separator < 0 ? selector : selector.slice(0, separator);
      const model = separator < 0 ? undefined : selector.slice(separator + 1);
      if (provider && !states.has(provider)) { ctx.ui.notify("Unknown gateway provider", "error"); return; }
      const output = [...states].filter(([id]) => !provider || provider === id).map(([id, state]) => ({
        provider: id,
        discovery: ctx.modelRegistry.getProviderDiscoveryState?.(id),
        lastSuccessfulAt: state.lastSuccessfulAt,
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
        note: state.result ? "Prices are USD per million tokens; catalog fallback is upstream list price, not the gateway bill. null is unknown. OMP numeric zero placeholders are not a free-price declaration." : "No successful discovery in this process; any models supplied by OMP models.db have no in-process field provenance yet.",
        warnings: state.result?.warnings,
        excluded: state.result?.excluded,
        models: state.result?.diagnostics.filter(row => !model || row.id === model),
      }));
      ctx.ui.notify(JSON.stringify(output, null, 2), "info");
    },
  });
  return states;
}

export default async function ompNewapiProvider(pi: ExtensionHost): Promise<void> {
  const { catalog, agentDir } = await loadOmpCatalog();
  const config = await loadConfig(configPath(agentDir));
  installExtension(pi, config, catalog);
}
