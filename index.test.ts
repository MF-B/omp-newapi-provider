import test from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "./catalog.ts";
import { installExtension } from "./index.ts";
import type { ExtensionHost } from "./index.ts";
import type { Fetch, PluginConfig } from "./types.ts";

test("registers dynamic callbacks, preserves OMP key references and compaction, and refreshes only configured ids online", async () => {
  const registrations = new Map<string, Parameters<ExtensionHost["registerProvider"]>[1]>();
  const commands = new Map<string, Parameters<ExtensionHost["registerCommand"]>[1]>();
  let start: Parameters<ExtensionHost["on"]>[1] | undefined;
  const host: ExtensionHost = {
    registerProvider(id, config) { registrations.set(id, config); },
    registerCommand(name, command) { commands.set(name, command); },
    on(_event, handler) { start = handler; },
  };
  const config: PluginConfig = { services: [
    { id: "krill-test", baseUrl: "https://codex.example", adapter: "codex", apiKey: "!credential-helper test", remoteCompaction: { enabled: true, endpoint: "/responses/compact" } },
    { id: "jing-test", baseUrl: "https://newapi.example", adapter: "newapi", apiKey: "OMP_TEST_API_KEY" },
  ] };
  const states = installExtension(host, config, createCatalog([]));
  assert.equal(registrations.size, 2);
  const codex = registrations.get("krill-test")!;
  assert.equal(codex.apiKey, "!credential-helper test");
  assert.deepEqual(codex.remoteCompaction, { enabled: true, endpoint: "/responses/compact" });
  for (const registration of registrations.values()) {
    assert.equal(Object.hasOwn(registration, "baseUrl"), false);
    assert.equal(Object.hasOwn(registration, "models"), false);
    assert.equal(registration.authHeader, true);
    assert.equal(typeof registration.fetchDynamicModels, "function");
  }
  const refreshes: { ids: string[]; strategy: string }[] = [];
  const notifications: string[] = [];
  const ctx = {
    modelRegistry: { async refreshDiscoverableProviders(ids: Iterable<string>, strategy: "online") { refreshes.push({ ids: [...ids], strategy }); } },
    ui: { notify(message: string) { notifications.push(message); } },
  };
  assert.ok(start);
  await start({}, ctx);
  assert.deepEqual(refreshes, [{ ids: ["krill-test", "jing-test"], strategy: "online" }]);
  await commands.get("newapi-refresh")!.handler("jing-test", ctx);
  assert.deepEqual(refreshes[1], { ids: ["jing-test"], strategy: "online" });
  await commands.get("newapi-refresh")!.handler("unrelated", ctx);
  assert.equal(refreshes.length, 2);
  assert.match(notifications.at(-1)!, /Unknown gateway provider/);
  await commands.get("newapi-diagnostics")!.handler("jing-test", ctx);
  assert.match(notifications.at(-1)!, /no in-process field provenance/);
  assert.equal(states.get("jing-test")?.result, undefined);
});

test("each callback reflects roster additions/removals, accepts valid empty, and rejects broken refreshes", async () => {
  let payload: unknown = { data: [{ id: "gpt-first" }] };
  const requests: RequestInit[] = [];
  const fetcher: Fetch = async (_url, init) => { requests.push(init ?? {}); return Response.json(payload); };
  let registration: Parameters<ExtensionHost["registerProvider"]>[1] | undefined;
  const commands = new Map<string, Parameters<ExtensionHost["registerCommand"]>[1]>();
  const host: ExtensionHost = {
    registerProvider(_id, config) { registration = config; },
    registerCommand(name, command) { commands.set(name, command); },
    on() {},
  };
  const states = installExtension(host, { services: [{ id: "test", baseUrl: "https://gateway.example", adapter: "newapi", apiKey: "OMP_TEST_KEY" }] }, createCatalog([]), fetcher);
  assert.ok(registration);
  const initial = await registration.fetchDynamicModels("resolved-test-key");
  assert.deepEqual(initial.map(x => x.id), ["gpt-first"]);
  payload = { data: [{ id: "gpt-first" }, { id: "gemini-new" }] };
  const added = await registration.fetchDynamicModels("resolved-test-key");
  assert.deepEqual(added.map(x => x.id), ["gpt-first", "gemini-new"]);
  assert.equal(added[1].baseUrl, "https://gateway.example/v1beta");
  payload = { data: [{ id: "gemini-new" }] };
  assert.deepEqual((await registration.fetchDynamicModels("resolved-test-key")).map(x => x.id), ["gemini-new"]);
  const lastSuccessful = states.get("test")!.result;
  payload = { invalid: true };
  await assert.rejects(registration.fetchDynamicModels("resolved-test-key"), /expected data array/);
  assert.equal(states.get("test")!.result, lastSuccessful);
  assert.match(states.get("test")!.lastError!, /Invalid newapi/);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(init => JSON.stringify(init.headers) === JSON.stringify({ Authorization: "Bearer resolved-test-key" })));
  payload = { data: [] };
  assert.deepEqual(await registration.fetchDynamicModels("resolved-test-key"), []);
  assert.equal(states.get("test")!.lastError, undefined);
  assert.deepEqual(states.get("test")!.result?.diagnostics, []);
  const beforeUnresolved = requests.length;
  await assert.rejects(registration.fetchDynamicModels(undefined), /did not resolve/);
  await assert.rejects(registration.fetchDynamicModels("OMP_TEST_KEY"), /did not resolve/);
  assert.equal(requests.length, beforeUnresolved);
  const notifications: string[] = [];
  await commands.get("newapi-diagnostics")!.handler("test", {
    modelRegistry: { async refreshDiscoverableProviders() {} },
    ui: { notify(message: string) { notifications.push(message); } },
  });
  assert.ok(!notifications[0].includes("resolved-test-key"));
  assert.ok(!notifications[0].includes("OMP_TEST_KEY"));
});
