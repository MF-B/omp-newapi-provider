import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginConfig, ServiceConfig } from "./types.ts";

export const CONFIG_FILENAME = "omp-newapi-provider.json";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${at}: unsupported setting ${key}`);
  }
}

export function normalizeBaseUrl(value: unknown, at = "baseUrl"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at}: expected an HTTP(S) URL`);
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(`${at}: expected an HTTP(S) URL`); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${at}: use an HTTP(S) URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/+$/, "");
}

/** Accept gateway roots and conventional discovery/inference suffixes without double /v1. */
export function gatewayRoot(baseUrl: string): string {
  return baseUrl.replace(/\/(?:backend-api\/codex(?:\/models)?|v1beta(?:\/models)?|v1(?:\/models|\/responses|\/chat\/completions)?|models)\/?$/i, "");
}

export function codexBaseUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/models\/?$/i, "");
  return /\/backend-api\/codex$/i.test(clean) ? clean : `${gatewayRoot(clean)}/backend-api/codex`;
}

export function parseConfig(value: unknown): PluginConfig {
  if (!object(value)) throw new Error("Configuration must be an object");
  keys(value, ["services"], "configuration");
  if (!Array.isArray(value.services)) throw new Error("configuration.services must be an array");
  const seen = new Set<string>();
  const services = value.services.map((row, index): ServiceConfig => {
    const at = `services[${index}]`;
    if (!object(row)) throw new Error(`${at}: expected an object`);
    keys(row, ["id", "baseUrl", "adapter", "apiKey", "limitsUrl", "remoteCompaction"], at);
    if (typeof row.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(row.id)) {
      throw new Error(`${at}.id: expected a provider id without slash or whitespace`);
    }
    if (seen.has(row.id)) throw new Error(`${at}.id: duplicate provider id`);
    seen.add(row.id);
    if (row.adapter !== "newapi" && row.adapter !== "codex") throw new Error(`${at}.adapter: expected newapi or codex`);
    const service: ServiceConfig = { id: row.id, baseUrl: normalizeBaseUrl(row.baseUrl, `${at}.baseUrl`), adapter: row.adapter };
    if (row.apiKey !== undefined) {
      if (typeof row.apiKey !== "string" || !(/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.apiKey) || /^!\S[\s\S]*$/.test(row.apiKey))) {
        throw new Error(`${at}.apiKey: expected an OMP environment-variable name or !command reference; store credentials in OMP`);
      }
      service.apiKey = row.apiKey;
    }
    if (row.limitsUrl !== undefined) {
      if (row.adapter !== "newapi") throw new Error(`${at}.limitsUrl: supported only by newapi`);
      service.limitsUrl = normalizeBaseUrl(row.limitsUrl, `${at}.limitsUrl`);
    }
    if (row.remoteCompaction !== undefined) {
      if (!object(row.remoteCompaction)) throw new Error(`${at}.remoteCompaction: expected an object`);
      keys(row.remoteCompaction, ["enabled", "endpoint"], `${at}.remoteCompaction`);
      const compaction: NonNullable<ServiceConfig["remoteCompaction"]> = {};
      if (row.remoteCompaction.enabled !== undefined) {
        if (typeof row.remoteCompaction.enabled !== "boolean") throw new Error(`${at}.remoteCompaction.enabled: expected boolean`);
        compaction.enabled = row.remoteCompaction.enabled;
      }
      if (row.remoteCompaction.endpoint !== undefined) {
        const endpoint = row.remoteCompaction.endpoint;
        if (typeof endpoint !== "string" || !endpoint || /[\r\n?#]/.test(endpoint)) {
          throw new Error(`${at}.remoteCompaction.endpoint: expected a relative path or HTTP(S) URL`);
        }
        compaction.endpoint = endpoint.startsWith("/") ? endpoint : normalizeBaseUrl(endpoint, `${at}.remoteCompaction.endpoint`);
      }
      service.remoteCompaction = compaction;
    }
    return service;
  });
  return { services };
}

export function configPath(agentDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OMP_NEWAPI_PROVIDER_CONFIG) return resolve(env.OMP_NEWAPI_PROVIDER_CONFIG);
  return join(agentDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), CONFIG_FILENAME);
}

export async function loadConfig(path: string): Promise<PluginConfig> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { services: [] };
    throw new Error("Unable to read omp-newapi-provider configuration");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("omp-newapi-provider configuration is invalid JSON"); }
  return parseConfig(value);
}
