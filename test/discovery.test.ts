import test from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../src/catalog.ts";
import { codexBaseUrl, configPath, gatewayRoot, normalizeBaseUrl, parseConfig } from "../src/config.ts";
import { discover, normalizeDiscovery } from "../src/discovery.ts";
import type { CatalogModel, Fetch, ServiceConfig } from "../src/types.ts";

const service: ServiceConfig = { id: "gateway", adapter: "newapi", baseUrl: "https://gateway.example/proxy/v1" };
const bundled: CatalogModel[] = [
  { id: "gpt-example", provider: "openai", api: "openai-responses", name: "GPT Example", input: ["text", "image"], reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"] }, cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16000 },
  { id: "gemini-example", provider: "google", api: "google-generative-ai", input: ["text", "image"], reasoning: false, contextWindow: 1000000, maxTokens: 64000, cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } },
  { id: "gemini-decision-test", provider: "google", api: "google-decisions", kind: "judge", input: ["text", "image"], reasoning: false, contextWindow: 262144, maxTokens: 235929, cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } },
  { id: "catalog-generator", provider: "google", kind: "image", api: "google-generative-ai", contextWindow: 1000, maxTokens: 1000 },
];
const catalog = createCatalog(bundled);

test("connection-only config rejects overrides, duplicate ids, secrets and malformed URLs", () => {
  const connection = { id: "one", baseUrl: "https://gateway.example/v1/", adapter: "newapi", apiKey: "OMP_GATEWAY_KEY" };
  assert.deepEqual(parseConfig({ services: [connection] }).services[0], { ...connection, baseUrl: "https://gateway.example/v1" });
  assert.throws(() => parseConfig({ services: [connection, connection] }), /duplicate/);
  for (const name of ["costMultiplier", "modelOverrides", "models", "groupRatio"]) {
    assert.throws(() => parseConfig({ services: [{ ...connection, [name]: {} }] }), /unsupported setting/);
  }
  assert.throws(() => parseConfig({ services: [{ ...connection, apiKey: "sk-not-a-reference" }] }), /reference/);
  for (const url of ["file:///tmp/models", "https://user:password@gateway.example", "https://gateway.example/?token=hidden", "https://gateway.example/#secret"]) {
    assert.throws(() => normalizeBaseUrl(url), /HTTP|credentials/);
  }
  assert.throws(() => parseConfig({ services: [{ ...connection, adapter: "other" }] }), /adapter/);
  assert.throws(() => parseConfig({ services: [{ ...connection, remoteCompaction: { enabled: "yes" } }] }), /boolean/);
});

test("normalizes root, versioned and Codex URLs with deployment prefixes intact", () => {
  assert.equal(gatewayRoot(service.baseUrl), "https://gateway.example/proxy");
  assert.equal(gatewayRoot("https://gateway.example/proxy/v1beta/models"), "https://gateway.example/proxy");
  assert.equal(codexBaseUrl("https://gateway.example/proxy/v1"), "https://gateway.example/proxy/backend-api/codex");
  assert.equal(codexBaseUrl("https://gateway.example/backend-api/codex/models"), "https://gateway.example/backend-api/codex");
  assert.equal(configPath("/isolated", {}), "/isolated/omp-newapi-provider.json");
  assert.equal(configPath(undefined, { PI_CODING_AGENT_DIR: "/custom" }), "/custom/omp-newapi-provider.json");
});

test("routes Gemini, GPT, explicit endpoints and catalog judges to independent URLs", () => {
  const result = normalizeDiscovery(service, { data: [
    { id: "gemini-example", supported_endpoint_types: ["openai"] },
    { id: "gpt-example", supported_endpoint_types: ["openai"] },
    { id: "custom-model", supported_endpoint_types: ["anthropic"] },
    { id: "gpt-completions-only", supported_endpoint_types: ["chat/completions"] },
    { id: "gemini-decision-test", supported_endpoint_types: ["openai"] },
  ] }, catalog);
  assert.deepEqual(result.models.map(m => [m.api, m.baseUrl, m.kind]), [
    ["google-generative-ai", "https://gateway.example/proxy/v1beta", "chat"],
    ["openai-responses", "https://gateway.example/proxy/v1", "chat"],
    ["anthropic-messages", "https://gateway.example/proxy", "chat"],
    ["openai-completions", "https://gateway.example/proxy/v1", "chat"],
    ["google-decisions", "https://gateway.example/proxy/v1beta", "judge"],
  ]);
  assert.equal(result.models[4].reasoning, false);
  assert.equal(result.models[4].maxTokens, 235929);
  assert.equal(result.models[1].compat?.statefulResponses, false);
});

test("Codex discovery parses native limits, modalities and supported effort list", async () => {
  const connection: ServiceConfig = { ...service, adapter: "codex" };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ models: [{ slug: "gpt-example", display_name: "Channel GPT", context_window: 500000, max_context_window: 872000, input_modalities: ["text", "image", "audio"], supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }, { effort: "ultra" }], default_reasoning_level: "xhigh" }] });
  };
  const result = await discover(connection, "resolved-test-key", catalog, fetcher);
  assert.equal(calls[0].url, "https://gateway.example/proxy/backend-api/codex/models?client_version=0.101.0");
  assert.deepEqual(calls[0].init?.headers, { Authorization: "Bearer resolved-test-key" });
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(result.models[0].api, "openai-codex-responses");
  assert.equal(result.models[0].contextWindow, 500000);
  assert.equal(result.models[0].maxContextWindow, 872000);
  assert.equal(result.models[0].maxTokens, 16000);
  assert.deepEqual(result.models[0].input, ["text", "image"]);
  assert.deepEqual(result.models[0].thinking, { mode: "effort", efforts: ["low", "xhigh"], defaultLevel: "xhigh" });
  assert.equal(result.models[0].preferWebsockets, false);
  assert.match(result.diagnostics[0].sources.maxTokens, /^catalog:/);
  assert.match(result.diagnostics[0].sources.contextWindow, /^channel\./);
  assert.ok(result.diagnostics[0].warnings.some(w => w.includes("ultra")));
});

test("excludes runners using ids, endpoint declarations, output modalities and catalog kinds", () => {
  const ids = ["gpt-image-future", "veo-99", "text-embedding-future", "whisper-9", "catalog-generator"];
  const result = normalizeDiscovery(service, { data: [
    ...ids.map(id => ({ id })),
    { id: "unknown-runner", supported_endpoint_types: ["images/generations"] },
    { id: "unknown-renderer", output_modalities: ["image"] },
    { id: "future-chat" },
  ] }, catalog);
  assert.deepEqual(result.models.map(m => m.id), ["future-chat"]);
  assert.equal(result.excluded.length, 7);
});

test("fills each field independently: explicit channel, optional limits, then bundled metadata", () => {
  const result = normalizeDiscovery(service, { data: [{ id: "gpt-example", context_window: 80000, input_modalities: ["text"], reasoning: false, pricing: { currency: "USD", unit: "per_million_tokens", input: 3 } }] }, catalog, { models: [{ id: "gpt-example", contextWindow: 160000, maxTokens: 12000 }] });
  const model = result.models[0];
  assert.equal(model.contextWindow, 80000);
  assert.equal(model.maxTokens, 12000);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.reasoning, false);
  assert.equal(model.thinking, undefined);
  assert.deepEqual(model.cost, { input: 3, output: 8, cacheRead: 0.2, cacheWrite: 0 });
  const sources = result.diagnostics[0].sources;
  assert.equal(sources.contextWindow, "channel.context_window");
  assert.equal(sources.maxTokens, "limits.maxTokens");
  assert.match(sources["cost.input"], /^channel\.pricing/);
  assert.match(sources["cost.output"], /^catalog:/);
});

test("validates monetary currency/unit, normalizes units and never reads gateway ratios", () => {
  const valid = normalizeDiscovery(service, { data: [{ id: "gpt-example", pricing: { currency: "usd", unit: "per_token", input: "0.000003", output: "0.00001" }, model_ratio: 99, completion_ratio: 88 }] }, catalog);
  assert.deepEqual(valid.models[0].cost, { input: 3, output: 10, cacheRead: 0.2, cacheWrite: 0 });
  for (const pricing of [
    { currency: "CNY", unit: "per_million_tokens", input: 100 },
    { currency: "USD", unit: "credits", input: 100 },
    { input: 100, output: 100 },
    { currency: "USD", unit: "per_million_tokens", input: -1 },
  ]) {
    const result = normalizeDiscovery(service, { data: [{ id: "gpt-example", pricing }] }, catalog);
    assert.equal(result.models[0].cost.input, 2);
    assert.match(result.diagnostics[0].sources["cost.input"], /^catalog:/);
    assert.ok(result.diagnostics[0].warnings.length);
  }
});

test("unknown future models are discovered with explicit conservative limits and unknown prices", () => {
  const result = normalizeDiscovery(service, { data: [{ id: "gpt-future", model_ratio: 0, pricing: { input: 0, output: 0 } }] }, catalog);
  assert.equal(result.models[0].contextWindow, 32768);
  assert.equal(result.models[0].maxTokens, 4096);
  assert.equal(result.models[0].reasoning, undefined);
  assert.deepEqual(result.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(result.diagnostics[0].prices, { input: null, output: null, cacheRead: null, cacheWrite: null });
  assert.equal(result.diagnostics[0].pricingStatus, "unknown");
  assert.equal(result.diagnostics[0].sources.contextWindow, "fallback:conservative");
  const partial = normalizeDiscovery(service, { data: [{ id: "gpt-future", pricing: { currency: "USD", unit: "per_million_tokens", input: 1 } }] }, catalog);
  assert.equal(partial.diagnostics[0].pricingStatus, "partial");
  assert.equal(partial.diagnostics[0].prices.output, null);
});

test("missing or broken optional public limits cannot break discovery or receive credentials", async () => {
  const connection = { ...service, limitsUrl: "https://metadata.example/limits.json" };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    return url.includes("metadata.example") ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ id: "gpt-example" }] });
  };
  const result = await discover(connection, "resolved-test-key", catalog, fetcher);
  assert.equal(result.models[0].contextWindow, 128000);
  assert.deepEqual(calls.find(x => x.url.includes("metadata.example"))?.init?.headers, {});
  assert.ok(result.warnings.some(w => w.includes("unavailable")));
  const malformed = normalizeDiscovery(service, { data: [{ id: "gpt-example" }] }, catalog, { models: [{ id: "gpt-example", contextWindow: "invalid", maxTokens: -1, maxContextWindow: 5 }] });
  assert.equal(malformed.models[0].contextWindow, 128000);
  assert.equal(malformed.models[0].maxContextWindow, 128000);
});

test("legal empty catalogs differ from damaged, error, duplicate and failed HTTP responses", async () => {
  assert.deepEqual(normalizeDiscovery(service, { data: [] }, catalog).models, []);
  assert.deepEqual(normalizeDiscovery({ ...service, adapter: "codex" }, { models: [] }, catalog).models, []);
  for (const payload of [{}, { data: null }, { success: false, data: [] }, { error: "failed", data: [] }, { data: [null] }, { data: [{ id: "one" }, { id: "one" }] }, { data: [{ id: "gpt-example", context_window: 0 }] }]) {
    assert.throws(() => normalizeDiscovery(service, payload, catalog));
  }
  await assert.rejects(discover(service, undefined, catalog, async () => new Response("{broken")), /invalid JSON/);
  await assert.rejects(discover(service, undefined, catalog, async () => new Response("secret-body-must-not-appear", { status: 403 })), error => error instanceof Error && error.message === "Model discovery HTTP 403");
});

test("catalog matching is exact or reviewed suffix alias; unrelated future IDs get no guessed metadata", () => {
  const other = createCatalog([
    { id: "gpt-example", provider: "openrouter", contextWindow: 42 },
    ...bundled,
  ]);
  assert.equal(other.find("openai/gpt-example", ["openai"])?.contextWindow, 128000);
  assert.equal(other.find("gpt-example-2026-11-18", ["openai"])?.contextWindow, 128000);
  assert.equal(other.find("gpt-future-99", ["openai"]), undefined);
});

test("preserves bundled long-context cards without channel price conflicts", () => {
  const tier = { inputThreshold: 272000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 0 };
  const tiered = createCatalog([{ ...bundled[0], cost: { ...bundled[0].cost, longContext: tier } }]);
  const result = normalizeDiscovery(service, { data: [{ id: "gpt-example" }] }, tiered);
  assert.deepEqual(result.models[0].cost.longContext, tier);
  assert.match(result.diagnostics[0].sources["cost.longContext"], /^catalog:/);
  const overridden = normalizeDiscovery(service, { data: [{ id: "gpt-example", pricing: { currency: "USD", unit: "per_million_tokens", input: 7 } }] }, tiered);
  assert.equal(overridden.models[0].cost.longContext, undefined);
  assert.ok(overridden.diagnostics[0].warnings.some(w => w.includes("tiers/schedules omitted")));
});
