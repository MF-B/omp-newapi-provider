export type Adapter = "newapi" | "codex";
export type ChatApi = "openai-responses" | "openai-completions" | "openai-codex-responses" | "google-generative-ai" | "anthropic-messages" | "google-decisions" | "openai-decisions";
export type InputModality = "text" | "image";
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface Thinking {
  mode: "effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort";
  efforts: readonly Effort[];
  defaultLevel?: Effort;
  effortMap?: Partial<Record<Effort, string>>;
}
export type CostField = "input" | "output" | "cacheRead" | "cacheWrite";
export interface Cost extends Record<CostField, number> {
  longContext?: Record<CostField, number> & { inputThreshold: number; inputThresholdInclusive?: boolean };
  timeBased?: {
    offPeakMultiplier: number;
    peakWindows: readonly { weekdays: readonly number[]; startMinute: number; endMinute: number }[];
    effectiveRates?: readonly (Record<CostField, number> & { effectiveFrom: number; longContext?: Cost["longContext"] })[];
  };
}
export interface ServiceConfig {
  id: string;
  baseUrl: string;
  adapter: Adapter;
  /** Raw OMP environment-name or !command reference. Only OMP resolves it. */
  apiKey?: string;
  /** Optional unauthenticated, explicit metadata endpoint; unavailable is harmless. */
  limitsUrl?: string;
  remoteCompaction?: { enabled?: boolean; endpoint?: string };
}
export interface PluginConfig { services: ServiceConfig[] }
export interface CatalogModel {
  id: string;
  provider?: string;
  name?: string;
  api?: string;
  kind?: string;
  reasoning?: boolean;
  thinking?: Thinking;
  input?: InputModality[];
  cost?: Partial<Cost>;
  contextWindow?: number | null;
  maxContextWindow?: number | null;
  maxTokens?: number | null;
  supportsTools?: boolean;
  compatConfig?: Record<string, unknown>;
  pricingStatus?: "unknown" | "free" | "included" | "variable";
}
export interface Catalog {
  find(id: string, preferredProviders?: readonly string[]): CatalogModel | undefined;
}
export interface ModelDefinition {
  id: string;
  name: string;
  kind: "chat" | "judge";
  api: ChatApi;
  baseUrl: string;
  input: InputModality[];
  reasoning?: boolean;
  thinking?: Thinking;
  cost: Cost;
  contextWindow: number;
  maxContextWindow?: number;
  maxTokens: number;
  supportsTools?: boolean;
  preferWebsockets: false;
  compat?: Record<string, unknown>;
}
export interface ModelDiagnostic {
  id: string;
  api: ChatApi;
  baseUrl: string;
  sources: Record<string, string>;
  /** USD per million tokens. null means unknown, never free. */
  prices: Record<CostField, number | null>;
  pricingStatus: "fixed" | "free" | "included" | "variable" | "unknown" | "partial";
  warnings: string[];
}
export interface DiscoveryResult {
  models: ModelDefinition[];
  diagnostics: ModelDiagnostic[];
  excluded: string[];
  warnings: string[];
}
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
