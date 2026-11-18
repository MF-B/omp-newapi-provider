import { codexBaseUrl, gatewayRoot, object } from "./config.ts";
import type { Catalog, CatalogModel, ChatApi, Cost, CostField, DiscoveryResult, Effort, Fetch, ModelDefinition, ModelDiagnostic, ServiceConfig } from "./types.ts";

const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const COST_FIELDS: readonly CostField[] = ["input", "output", "cacheRead", "cacheWrite"];
const CHAT_APIS: Record<string, true> = { "openai-responses": true, "openai-completions": true, "openai-codex-responses": true, "google-generative-ai": true, "anthropic-messages": true, "google-decisions": true, "openai-decisions": true };
const NON_CHAT_KINDS: Record<string, true> = { image: true, video: true, embedding: true, rerank: true, tts: true, stt: true, audio: true, search: true };
const NON_CHAT_ID = /(?:^|[/_.-])(?:image|imagine|imagen|embedding|embeddings|rerank|whisper|tts|sora|veo|dall-e|flux|stable-diffusion|video|music|suno)(?:$|[/_.-]|\d)|(?:^|[/_.-])(?:text-embedding|bge-|e5-|nomic-embed)|(?:^|[/_.-])(?:realtime|transcribe|transcription|speech)(?:$|[/_.-])/i;

type Row = Record<string, unknown>;
type SourceRow = { row: Row; source: string };

function pick(rows: readonly SourceRow[], names: readonly string[]): { value: unknown; source: string } | undefined {
  for (const { row, source } of rows) {
    for (const name of names) if (row[name] !== undefined && row[name] !== null) return { value: row[name], source: `${source}.${name}` };
  }
  return undefined;
}

function positive(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid positive token limit at ${source}`);
  return value;
}

function roster(payload: unknown, adapter: ServiceConfig["adapter"]): Row[] {
  const key = adapter === "codex" ? "models" : "data";
  if (!object(payload) || payload.success === false || payload.error != null || !Array.isArray(payload[key])) {
    throw new Error(`Invalid ${adapter} model discovery response: expected ${key} array`);
  }
  const seen = new Set<string>();
  return payload[key].map((entry, index) => {
    const idKey = adapter === "codex" ? "slug" : "id";
    if (!object(entry) || typeof entry[idKey] !== "string" || !entry[idKey].trim() || /[\r\n]/.test(entry[idKey])) {
      throw new Error(`Invalid ${adapter} model discovery row ${index}`);
    }
    const id = entry[idKey];
    if (seen.has(id)) throw new Error(`Duplicate model id in ${adapter} discovery response`);
    seen.add(id);
    return entry;
  });
}

function endpointApis(row: Row): { apis: ChatApi[]; declared: boolean } {
  const value = row.supported_endpoint_types ?? row.endpoints;
  if (value === undefined || value === null) return { apis: [], declared: false };
  if (!Array.isArray(value) || value.some(x => typeof x !== "string")) throw new Error("Invalid supported endpoint declarations");
  const apis: ChatApi[] = [];
  for (const entry of value as string[]) {
    const endpoint = entry.toLowerCase().replace(/[ _]/g, "-").replace(/^\//, "");
    if (/^(?:google-decisions|google\/decisions)$/.test(endpoint)) apis.push("google-decisions");
    else if (/^(?:openai-decisions|openai\/decisions)$/.test(endpoint)) apis.push("openai-decisions");
    else if (/^(?:gemini|google|google-generative-ai|generatecontent|v1beta\/models)$/.test(endpoint)) apis.push("google-generative-ai");
    else if (/^(?:anthropic|claude|anthropic-messages|messages|v1\/messages)$/.test(endpoint)) apis.push("anthropic-messages");
    else if (/^(?:openai-responses?|responses|v1\/responses)$/.test(endpoint)) apis.push("openai-responses");
    else if (/^(?:openai-completions|openai-chat|chat-completions|chat\/completions|v1\/chat\/completions)$/.test(endpoint)) apis.push("openai-completions");
    // NewAPI's generic "openai" advertises a gateway family, not a restriction to chat/completions.
  }
  return { apis: [...new Set(apis)], declared: value.length > 0 };
}

export function selectProtocol(service: ServiceConfig, id: string, row: Row, reference?: CatalogModel): { api: ChatApi; baseUrl: string; source: string } | undefined {
  if (service.adapter === "codex") return { api: "openai-codex-responses", baseUrl: codexBaseUrl(service.baseUrl), source: "adapter:codex" };
  const root = gatewayRoot(service.baseUrl);
  let api: ChatApi | undefined;
  let source = "family";
  if (row.api !== undefined) {
    if (typeof row.api !== "string") throw new Error("Invalid model api declaration");
    if (!Object.hasOwn(CHAT_APIS, row.api)) return undefined;
    api = row.api as ChatApi;
    source = "channel.api";
  }
  const endpoints = endpointApis(row);
  if (!api && reference?.kind === "judge" && typeof reference.api === "string" && Object.hasOwn(CHAT_APIS, reference.api)) {
    api = reference.api as ChatApi;
    source = `catalog:${reference.provider}/${reference.id}.api`;
  }
  const isGemini = /^(?:google\/)?gemini(?:[-/]|$)/i.test(id);
  const isGPT = /^(?:openai\/)?(?:gpt[-/]|o[1-9](?:[-/]|$)|codex(?:[-/]|$)|chatgpt[-/])/i.test(id);
  const isClaude = /^(?:anthropic\/)?claude[-/]/i.test(id);
  const desired: ChatApi = isGemini ? "google-generative-ai" : isGPT ? "openai-responses" : isClaude ? "anthropic-messages" : "openai-completions";
  if (!api && endpoints.apis.length) {
    api = endpoints.apis.includes(desired) ? desired : endpoints.apis[0];
    source = "channel.supported_endpoint_types";
  }
  if (!api) api = desired;
  return { api, baseUrl: `${root}/${api === "google-generative-ai" || api === "google-decisions" ? "v1beta" : api === "anthropic-messages" ? "" : "v1"}`.replace(/\/$/, ""), source };
}

function explicitPrices(row: Row, warnings: string[]): { values: Partial<Cost>; sources: Partial<Record<CostField, string>>; status?: ModelDiagnostic["pricingStatus"] } {
  const values: Partial<Cost> = {};
  const sources: Partial<Record<CostField, string>> = {};
  let status: ModelDiagnostic["pricingStatus"] | undefined;
  for (const key of ["pricing", "cost"]) {
    const block = row[key];
    if (block === undefined || block === null) continue;
    if (!object(block)) { warnings.push(`channel.${key}: invalid price card ignored`); continue; }
    const currency = typeof block.currency === "string" ? block.currency.toUpperCase() : undefined;
    const unit = typeof block.unit === "string" ? block.unit.toLowerCase().replace(/[ -]/g, "_") : undefined;
    const factors: Record<string, number> = { per_million_tokens: 1, usd_per_million_tokens: 1, per_1m_tokens: 1, per_1k_tokens: 1000, per_thousand_tokens: 1000, per_token: 1_000_000, usd_per_token: 1_000_000 };
    const factor = unit ? factors[unit] : undefined;
    if ((currency !== "USD" && !(currency === undefined && unit?.startsWith("usd_"))) || factor === undefined) {
      warnings.push(`channel.${key}: prices require explicit USD currency and token unit; ignored`);
      continue;
    }
    const names: Record<CostField, string[]> = { input: ["input", "prompt"], output: ["output", "completion"], cacheRead: ["cacheRead", "cache_read", "cached_input"], cacheWrite: ["cacheWrite", "cache_write", "cache_creation"] };
    for (const field of COST_FIELDS) {
      if (values[field] !== undefined) continue;
      const name = names[field].find(name => block[name] !== undefined && block[name] !== null);
      if (!name) continue;
      const raw = block[name];
      const number = typeof raw === "number" ? raw : typeof raw === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : NaN;
      const value = number * factor;
      if (!Number.isFinite(value) || value < 0) { warnings.push(`channel.${key}.${name}: invalid nonnegative price ignored`); continue; }
      values[field] = value;
      sources[field] = `channel.${key}.${name} (${currency ?? "USD"}/${unit})`;
    }
    if (block.status === "free" || block.status === "included" || block.status === "variable" || block.status === "unknown") status = block.status;
  }
  return { values, sources, status };
}

function normalizeModel(service: ServiceConfig, row: Row, catalog: Catalog, limit: Row | undefined): { model: ModelDefinition; diagnostic: ModelDiagnostic } | undefined {
  const id = row[service.adapter === "codex" ? "slug" : "id"] as string;
  const preferred = service.adapter === "codex" ? ["openai-codex", "openai", "google", "anthropic"] : /^(?:google\/)?gemini/i.test(id) ? ["google", "google-gemini-cli", "openrouter"] : /^(?:anthropic\/)?claude/i.test(id) ? ["anthropic", "openrouter"] : ["openai", "openai-codex", "openrouter"];
  const reference = catalog.find(id, preferred);
  if ((typeof row.kind === "string" && Object.hasOwn(NON_CHAT_KINDS, row.kind)) || (reference?.kind && Object.hasOwn(NON_CHAT_KINDS, reference.kind)) || NON_CHAT_ID.test(id)) return undefined;
  if (row.kind !== undefined && row.kind !== "chat" && row.kind !== "tiny" && row.kind !== "judge") return undefined;
  if (row.output_modalities !== undefined) {
    if (!Array.isArray(row.output_modalities) || row.output_modalities.some(x => typeof x !== "string")) throw new Error("Invalid output modalities");
    if (row.output_modalities.length && !row.output_modalities.includes("text")) return undefined;
  }
  const endpoints = row.supported_endpoint_types;
  if (Array.isArray(endpoints) && endpoints.length && endpoints.every(x => typeof x === "string" && /(?:images?|videos?|embeddings?|rerank|speech|transcriptions?|audio)/i.test(x))) return undefined;
  const protocol = selectProtocol(service, id, row, reference);
  if (!protocol) return undefined;
  const sources: Record<string, string> = { id: service.adapter === "codex" ? "channel.slug" : "channel.id", api: protocol.source, baseUrl: `connection:${service.id}` };
  const warnings: string[] = [];
  const records: SourceRow[] = [{ row, source: "channel" }];
  for (const key of ["capabilities", "limits"]) if (object(row[key])) records.push({ row: row[key], source: `channel.${key}` });
  if (limit) records.push({ row: limit, source: "limits" });
  const refSource = reference ? `catalog:${reference.provider}/${reference.id}` : "";
  const tokenLimit = (field: "contextWindow" | "maxContextWindow" | "maxTokens", aliases: string[], fallback: number): number => {
    const explicit = pick(records, aliases);
    if (explicit) { sources[field] = explicit.source; return positive(explicit.value, explicit.source); }
    const known = reference?.[field];
    if (typeof known === "number" && Number.isSafeInteger(known) && known > 0) { sources[field] = `${refSource}.${field}`; return known; }
    sources[field] = "fallback:conservative";
    warnings.push(`${field} unavailable; using conservative ${fallback} tokens`);
    return fallback;
  };
  const contextWindow = tokenLimit("contextWindow", ["context_window", "contextWindow", "input_token_limit", "inputTokenLimit", "max_input_tokens"], 32768);
  const outputLimit = tokenLimit("maxTokens", ["max_output_tokens", "maxTokens", "output_token_limit", "outputTokenLimit", "max_completion_tokens"], 4096);
  const maxTokens = Math.min(outputLimit, contextWindow);
  if (outputLimit > contextWindow) { sources.maxTokens += ":clamped-to-context"; warnings.push("Output token limit exceeds active context; clamped to contextWindow"); }
  const maxContext = pick(records, ["max_context_window", "maxContextWindow"]);
  let maxContextWindow = maxContext ? positive(maxContext.value, maxContext.source) : typeof reference?.maxContextWindow === "number" && reference.maxContextWindow > 0 ? reference.maxContextWindow : contextWindow;
  sources.maxContextWindow = maxContext?.source ?? (reference?.maxContextWindow ? `${refSource}.maxContextWindow` : sources.contextWindow);
  if (maxContextWindow < contextWindow) {
    if (maxContext && !maxContext.source.startsWith("limits.")) throw new Error("Maximum context window is below the active context window");
    maxContextWindow = contextWindow;
    sources.maxContextWindow = sources.contextWindow;
    warnings.push("Smaller optional/catalog maximum context ignored in favor of active channel context");
  }
  const modalities = pick(records, ["input_modalities", "inputModalities", "input"]);
  let input: ("text" | "image")[];
  if (modalities) {
    if (!Array.isArray(modalities.value) || modalities.value.some(x => typeof x !== "string")) throw new Error("Invalid input modalities");
    input = modalities.value.filter((x): x is "text" | "image" => x === "text" || x === "image");
    if (!input.includes("text")) return undefined;
    input = [...new Set(input)];
    sources.input = modalities.source;
  } else {
    input = reference?.input?.length ? [...reference.input] : ["text"];
    sources.input = reference?.input?.length ? `${refSource}.input` : "fallback:text";
  }
  let reasoning = reference?.reasoning;
  let thinking = reference?.thinking ? { ...reference.thinking } : undefined;
  if (reference?.reasoning !== undefined) sources.reasoning = `${refSource}.reasoning`;
  if (reference?.thinking) sources.thinking = `${refSource}.thinking`;
  const nativeEfforts = pick(records, ["supported_reasoning_levels", "reasoning_levels", "supportedReasoningLevels"]);
  const explicitReasoning = pick(records, ["reasoning", "supports_reasoning"]);
  if (nativeEfforts) {
    if (!Array.isArray(nativeEfforts.value)) throw new Error("Invalid supported reasoning levels");
    const efforts: Effort[] = [];
    for (const level of nativeEfforts.value) {
      const effort = typeof level === "string" ? level : object(level) ? level.effort : undefined;
      if (typeof effort !== "string") throw new Error("Invalid supported reasoning level entry");
      if (EFFORTS.includes(effort as Effort)) efforts.push(effort as Effort);
      else warnings.push(`Unsupported host reasoning effort ignored: ${effort}`);
    }
    const supported = EFFORTS.filter(x => efforts.includes(x));
    reasoning = nativeEfforts.value.length > 0;
    thinking = supported.length ? { mode: protocol.api.startsWith("google") ? "google-level" : "effort", efforts: supported } : undefined;
    const defaultLevel = row.default_reasoning_level;
    if (thinking && typeof defaultLevel === "string" && supported.includes(defaultLevel as Effort)) thinking.defaultLevel = defaultLevel as Effort;
    sources.reasoning = nativeEfforts.source;
    sources.thinking = nativeEfforts.source;
  }
  if (explicitReasoning) {
    if (typeof explicitReasoning.value !== "boolean") throw new Error("Invalid reasoning capability");
    reasoning = explicitReasoning.value;
    sources.reasoning = explicitReasoning.source;
    if (!reasoning) { thinking = undefined; sources.thinking = `${explicitReasoning.source}:disabled`; }
  }
  // Catalog thinking controls are transport-specific; don't send a budget through Responses or vice versa.
  if (thinking && protocol.api.startsWith("openai") && thinking.mode !== "effort") { thinking = undefined; sources.thinking = "fallback:transport-mismatch"; }
  const explicitPrice = explicitPrices(row, warnings);
  const prices: ModelDiagnostic["prices"] = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const cost: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const referenceHasPrice = reference?.cost && (COST_FIELDS.some(field => (reference.cost?.[field] ?? 0) > 0) || reference.pricingStatus === "free" || reference.pricingStatus === "included");
  for (const field of COST_FIELDS) {
    if (explicitPrice.values[field] !== undefined) {
      prices[field] = explicitPrice.values[field]!;
      sources[`cost.${field}`] = explicitPrice.sources[field]!;
    } else if (referenceHasPrice && typeof reference?.cost?.[field] === "number" && Number.isFinite(reference.cost[field]) && reference.cost[field]! >= 0) {
      prices[field] = reference.cost[field]!;
      sources[`cost.${field}`] = `${refSource}.cost.${field} (USD/per_million_tokens; list price)`;
    } else sources[`cost.${field}`] = "unknown";
    // OMP's required numeric rate card uses zero placeholders; absent pricingStatus on an all-zero card means UNKNOWN in OMP.
    cost[field] = prices[field] ?? 0;
  }
  const channelPrice = COST_FIELDS.some(field => explicitPrice.values[field] !== undefined);
  if (referenceHasPrice && !channelPrice) {
    if (reference?.cost?.longContext) { cost.longContext = structuredClone(reference.cost.longContext); sources["cost.longContext"] = `${refSource}.cost.longContext`; }
    if (reference?.cost?.timeBased) { cost.timeBased = structuredClone(reference.cost.timeBased); sources["cost.timeBased"] = `${refSource}.cost.timeBased`; }
  } else if (channelPrice && (reference?.cost?.longContext || reference?.cost?.timeBased)) {
    warnings.push("Channel base prices override bundled pricing; incompatible bundled tiers/schedules omitted");
  }
  const known = COST_FIELDS.filter(field => prices[field] !== null).length;
  const pricingStatus: ModelDiagnostic["pricingStatus"] = known === 0 ? "unknown" : known < COST_FIELDS.length ? "partial" : COST_FIELDS.some(field => cost[field] > 0) ? "fixed" : explicitPrice.status ?? reference?.pricingStatus ?? "unknown";
  const display = pick(records, ["display_name", "name"]);
  const name = typeof display?.value === "string" && display.value ? display.value : reference?.name ?? id;
  sources.name = typeof display?.value === "string" && display.value ? display.source : reference?.name ? `${refSource}.name` : "fallback:id";
  const tools = pick(records, ["supports_tools", "supportsTools", "supports_tool_calls"]);
  if (tools && typeof tools.value !== "boolean") throw new Error("Invalid tool capability");
  const supportsTools = tools ? tools.value as boolean : reference?.supportsTools;
  if (supportsTools !== undefined) sources.supportsTools = tools?.source ?? `${refSource}.supportsTools`;
  const kind = protocol.api.endsWith("-decisions") || reference?.kind === "judge" || row.kind === "judge" ? "judge" : "chat";
  sources.kind = protocol.api.endsWith("-decisions") ? "protocol:decisions" : reference?.kind === "judge" ? `${refSource}.kind` : "channel:chat";
  if (kind === "judge") { reasoning = false; thinking = undefined; sources.reasoning = "protocol:judge"; sources.thinking = "protocol:judge"; }
  const compat = protocol.api === "openai-responses" ? { statefulResponses: false } : undefined;
  sources.preferWebsockets = "adapter:http";
  if (compat) sources.compat = "adapter:stateless-responses";
  return {
    model: { id, name, kind, api: protocol.api, baseUrl: protocol.baseUrl, input, cost, contextWindow, maxContextWindow, maxTokens, ...(reasoning !== undefined ? { reasoning } : {}), ...(thinking ? { thinking } : {}), ...(supportsTools !== undefined ? { supportsTools } : {}), preferWebsockets: false, ...(compat ? { compat } : {}) },
    diagnostic: { id, api: protocol.api, baseUrl: protocol.baseUrl, sources, prices, pricingStatus, warnings },
  };
}

export function normalizeDiscovery(service: ServiceConfig, payload: unknown, catalog: Catalog, limitsPayload?: unknown): DiscoveryResult {
  const rows = roster(payload, service.adapter);
  const warnings: string[] = [];
  const limits = new Map<string, Row>();
  if (limitsPayload !== undefined) {
    if (!object(limitsPayload) || !Array.isArray(limitsPayload.models)) warnings.push("Optional limits metadata is malformed; ignored");
    else {
      for (const row of limitsPayload.models) {
        if (!object(row) || typeof row.id !== "string") { warnings.push("Optional limits row is malformed; ignored"); continue; }
        const clean: Row = { id: row.id };
        for (const key of ["contextWindow", "maxContextWindow", "maxTokens"]) {
          if (typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] > 0) clean[key] = row[key];
          else if (row[key] !== undefined) warnings.push(`Optional limits ${key} is invalid; ignored`);
        }
        limits.set(row.id, clean);
      }
    }
  }
  const models: ModelDefinition[] = [];
  const diagnostics: ModelDiagnostic[] = [];
  const excluded: string[] = [];
  for (const row of rows) {
    const id = row[service.adapter === "codex" ? "slug" : "id"] as string;
    const normalized = normalizeModel(service, row, catalog, limits.get(id));
    if (normalized) { models.push(normalized.model); diagnostics.push(normalized.diagnostic); }
    else excluded.push(id);
  }
  return { models, diagnostics, excluded, warnings };
}

async function getJson(fetcher: Fetch, url: string, timeout: number, apiKey?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(timeout), redirect: "error" });
  } catch { throw new Error("Model discovery network request failed or timed out"); }
  if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new Error("Model discovery response is invalid JSON"); }
}

export async function discover(service: ServiceConfig, apiKey: string | undefined, catalog: Catalog, fetcher: Fetch = fetch): Promise<DiscoveryResult> {
  const endpoint = service.adapter === "codex" ? `${codexBaseUrl(service.baseUrl)}/models?client_version=0.101.0` : `${gatewayRoot(service.baseUrl)}/v1/models`;
  // Resolve neither token commands nor credential stores here: OMP supplies the resolved callback key.
  // Optional public limits get no credentials, even when configured on another origin.
  const [payload, optional] = await Promise.all([
    getJson(fetcher, endpoint, 10_000, apiKey),
    service.limitsUrl ? getJson(fetcher, service.limitsUrl, 3_000).then(value => ({ value, failed: false }), () => ({ value: undefined, failed: true })) : Promise.resolve({ value: undefined, failed: false }),
  ]);
  const result = normalizeDiscovery(service, payload, catalog, optional.value);
  if (optional.failed) result.warnings.push("Optional limits metadata unavailable; channel and bundled metadata used");
  return result;
}
