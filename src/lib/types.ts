export type ProviderId = "openrouter" | "github" | "gemini" | "vertex";

export type AnchorCategory = "generic" | "branded" | "keyword" | "url";

export const ANCHOR_CATEGORIES: AnchorCategory[] = ["generic", "branded", "keyword", "url"];

export type FollowStatus = "dofollow" | "nofollow";

export type JobMode = "one_site" | "multi_site";

export interface Brand {
  id: string;
  name: string;
  domains: string[];
  /** ISO 639-1 language code the AI should write anchors in for this brand's URLs.
   *  Required for new jobs (UI enforces). Optional in the type to keep older jobs
   *  loadable; when null the prompt falls back to "en" silently. */
  language: string | null;
}

/** Curated list of ISO 639-1 codes shown in the language dropdowns. Display labels
 *  live in i18n (`form.lang.<code>`). Add to this list to surface more in the UI. */
export const SUPPORTED_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ru", "uk",
  "pl", "nl", "tr", "ar", "ja", "ko", "zh", "sv",
  "da", "no", "fi", "cs", "ro", "hu", "el",
] as const;
export type LanguageCode = typeof SUPPORTED_LANGUAGES[number];

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
  /** Single-site mode only: applies to ALL inputs in the job. Required for new jobs
   *  in single-site mode (UI enforces). For multi-site mode this is ignored — language
   *  is per-brand instead. */
  language: string | null;
}

export interface JobInput {
  id: string;
  jobId: string;
  targetUrl: string;
  title: string | null;
  keywords: string | null;
  /** V2 only: per-row config carried alongside Target URL. NULL on V1 inputs. */
  payloadV2?: JobInputPayloadV2 | null;
}

/**
 * V2 input row — one entry of the V2 CSV. Each row is its own AI request:
 * generate `numberOfLinks` anchors for `targetUrl` with the given category mix,
 * Link Type (passed through to output), language, and geographic context.
 */
export interface JobInputPayloadV2 {
  linkType: string;
  numberOfLinks: number;
  /** Per-row category mix. Each component is 0..100; the four must sum to 100. */
  distribution: DistributionPct;
  /** Free-text geo label that flows through to the output. */
  geo: string;
  /** Free-text language label (or ISO code). */
  lang: string;
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
  /** V2 only: linkType / geo / lang echoed through from the input. NULL on V1 anchors. */
  payloadV2?: JobAnchorPayloadV2 | null;
}

export interface JobAnchorPayloadV2 {
  linkType: string;
  geo: string;
  lang: string;
}

export type JobStatus = "idle" | "running" | "paused" | "succeeded" | "partial" | "failed" | "cancelled";

/**
 * V2 job version. 1 = legacy flow (dofollow ratio, job-level distribution sliders,
 * brand list, language picker). 2 = CSV-driven flow with per-row distribution,
 * link type, geo, and lang; no dofollow concept. Stored on `jobs.version`.
 */
export type JobVersion = 1 | 2;

export interface Job {
  id: string;
  name: string;
  /** Schema/UI version. Determines which form, prompts, parser, and Job View to render. */
  version: JobVersion;
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
  /** Containing folder. null = lives at root. */
  folderId: string | null;
  /** Display name of the person who created the job. null on legacy rows → renders as "Unknown". */
  createdBy: string | null;
  /** Soft-delete tombstone. NULL = live; ms-epoch = in trash. Excluded from default reads. */
  deletedAt: number | null;
  /** AI cost tracking — accumulated across batches. Locked in at write time using the
   *  ModelPricing row that existed when each batch was written. Resets on rerun. */
  aiInputTokens: number;
  aiOutputTokens: number;
  /** Subset of aiInputTokens that the provider reported as cache hits (Vertex Gemini's
   *  `cachedContentTokenCount`). Informational only; cost math doesn't discount. */
  aiCachedInputTokens: number;
  aiCostUsd: number;
  inputs?: JobInput[];
  anchors?: JobAnchor[];
}

export interface ModelPricing {
  providerId: ProviderId;
  model: string;
  /** USD per 1 MILLION input tokens (matches every provider's published pricing page). */
  inputPerMillion: number;
  /** USD per 1 MILLION output tokens. */
  outputPerMillion: number;
  updatedAt: number;
}

/** Token counts a provider returned for one AI call. Anything missing defaults to 0. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Vertex Gemini's `usageMetadata.cachedContentTokenCount` — slice of inputTokens
   *  served from implicit prompt cache. Other providers report 0 (no equivalent). */
  cachedInputTokens: number;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  deletedAt: number | null;
}

/** Folder + counts used to render rows in the folder browser. */
export interface FolderRow extends Folder {
  /** Live jobs in this folder + ALL descendants (recursive). */
  jobCount: number;
  /** Live direct child folders. */
  subfolderCount: number;
}

export interface ProviderAdvanced {
  /** Per-call timeout in ms. Default 60_000. Cap a hung AI response from blocking a
   *  batch indefinitely. */
  timeoutMs?: number;
  /** Inter-batch delay in ms after a successful batch. Default 1500. Raise for strict
   *  per-minute quota providers, lower for paid tiers where you want max throughput. */
  interBatchDelayMs?: number;
  /** Max consecutive rate-limit retries before flipping the job to partial/failed.
   *  Default 10. Raise for patient retries on transient outages, lower to fail fast. */
  maxRateRetries?: number;
  /** V2 only — soft cap on anchors per batch. Pack rows (or split a heavy row) until the
   *  running anchor total reaches this. Default 200. Tune to the model's output budget:
   *  Llama 70B ~100, GPT-4o / Claude 3.5 ~200, Gemini 2.5 Pro 400+. */
  v2BatchTargetAnchors?: number;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  // Transport-only (server → client): present only on read via actionGetSettings.
  // Holds a short preview like "sk-or…7107" so the UI can show "•••set, type to replace"
  // without ever shipping the full key to the browser. NEVER persisted; never sent
  // client → server (saveSettings ignores this field).
  apiKeyPreview?: string | null;
  /** Per-provider rate-limit / timeout knobs. All optional — undefined means "use the
   *  default from PROVIDER_LIMIT_DEFAULTS". See src/lib/providers/limits.ts. */
  advanced?: ProviderAdvanced;

  // ----- Vertex AI only (mirrors Drop Sherlock's vertex_ai.py shape) ----------------
  /** Full Service Account JSON. Redacted on read like apiKey; never shipped to browser
   *  unless explicitly fetched for editing. Triggers SA-JSON auth mode (enterprise). */
  serviceAccountJson?: string;
  /** Transport-only: "...@my-project.iam.gserviceaccount.com" preview so the UI can
   *  show "•••set ({email}) — paste to replace" without exposing the private key. */
  serviceAccountJsonPreview?: string | null;
  /** GCP project ID — auto-filled from the SA JSON's `project_id` on paste; user can
   *  override. Required for SA-JSON mode. */
  projectId?: string;
  /** GCP region, e.g. "us-central1". Required for SA-JSON mode. Defaults to
   *  "us-central1" in the UI. */
  location?: string;
}

/** Sentinel the Settings form sends to explicitly remove a stored API key. */
export const KEY_CLEAR_SENTINEL = "__CLEAR__";

export type Locale = "en" | "ru";
export type Theme = "dark" | "light";

export interface SettingsBlob {
  providers: Record<ProviderId, ProviderConfig>;
  customModels: Record<ProviderId, string[]>;
  /**
   * Prompt templates by version. V1 keys (`generation`, `regeneration`) are kept at the
   * top level for backward compatibility with existing stored settings; V2 lives under
   * `v2.*`. `mergeSettings` fills V2 defaults if missing on load.
   */
  prompts: {
    generation: string;
    regeneration: string;
    v2: {
      generation: string;
      regeneration: string;
    };
  };
  defaults: {
    providerId: ProviderId;
    modelByProvider: Record<ProviderId, string>;
  };
  locale: Locale;
  theme: Theme;
}
