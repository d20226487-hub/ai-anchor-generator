export type ProviderId = "openrouter" | "github" | "gemini";

export type AnchorCategory = "generic" | "branded" | "keyword" | "url";

export const ANCHOR_CATEGORIES: AnchorCategory[] = ["generic", "branded", "keyword", "url"];

export type FollowStatus = "dofollow" | "nofollow";

export type JobMode = "one_site" | "multi_site";

export interface Brand {
  id: string;
  name: string;
  domains: string[];
}

export interface DistributionPct {
  generic: number;
  branded: number;
  keyword: number;
  url: number;
}

export function normalizeDistribution(d: Partial<DistributionPct> | undefined | null): DistributionPct {
  return {
    generic: d?.generic ?? 0,
    branded: d?.branded ?? 0,
    keyword: d?.keyword ?? 0,
    url: d?.url ?? 0,
  };
}

export interface JobCriteria {
  ratiosEnabled: boolean;
  dofollowPct: number;
  distribution: DistributionPct;
  brands: Brand[];
  providerId: ProviderId;
  model: string;
}

export interface JobInput {
  id: string;
  jobId: string;
  targetUrl: string;
  title: string | null;
  keywords: string | null;
}

export interface JobAnchor {
  id: string;
  jobId: string;
  inputId: string | null;
  targetUrl: string;
  brandId: string | null;
  followStatus: FollowStatus | null;
  anchorText: string;
  category: AnchorCategory;
  manuallyEdited: 0 | 1;
}

export type JobStatus = "idle" | "running" | "paused" | "succeeded" | "partial" | "failed" | "cancelled";

export interface Job {
  id: string;
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  lastError: string | null;
  batchSize: number;
  batchesDone: number;
  batchesTotal: number;
  runStartedAt: number | null;
  // Runner lease (audit High #7 fix). Set while a client orchestrator is actively driving
  // batches; cleared on pause/cancel/start. Only one runner can hold the lease at a time.
  runnerId: string | null;
  runnerHeartbeatAt: number | null;
  inputs?: JobInput[];
  anchors?: JobAnchor[];
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  // Transport-only (server → client): present only on read via actionGetSettings.
  // Holds a short preview like "sk-or…7107" so the UI can show "•••set, type to replace"
  // without ever shipping the full key to the browser. NEVER persisted; never sent
  // client → server (saveSettings ignores this field).
  apiKeyPreview?: string | null;
}

/** Sentinel the Settings form sends to explicitly remove a stored API key. */
export const KEY_CLEAR_SENTINEL = "__CLEAR__";

export type Locale = "en" | "ru";
export type Theme = "dark" | "light";

export interface SettingsBlob {
  providers: Record<ProviderId, ProviderConfig>;
  customModels: Record<ProviderId, string[]>;
  prompts: {
    generation: string;
    regeneration: string;
  };
  defaults: {
    providerId: ProviderId;
    modelByProvider: Record<ProviderId, string>;
  };
  locale: Locale;
  theme: Theme;
}
