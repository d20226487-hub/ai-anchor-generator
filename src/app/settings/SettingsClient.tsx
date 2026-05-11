"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { actionSaveSettings, actionTestProvider } from "@/lib/actions";
import { PREDEFINED_MODELS } from "@/lib/settings";
import { DEFAULT_GENERATION_PROMPT, DEFAULT_REGENERATION_PROMPT } from "@/lib/prompts";
import { KEY_CLEAR_SENTINEL, type ProviderAdvanced, type ProviderId, type SettingsBlob } from "@/lib/types";
import { PROVIDER_LIMIT_BOUNDS, PROVIDER_LIMIT_DEFAULTS } from "@/lib/providers/limits";
import { Eye, EyeOff, Plus, Trash2, RotateCcw, X } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

const PROVIDERS: { id: ProviderId; label: string; helpUrl: string; hint?: string }[] = [
  { id: "openrouter", label: "OpenRouter", helpUrl: "https://openrouter.ai/keys", hint: "Models use lowercase hyphenated IDs, e.g. meta-llama/llama-3.3-70b-instruct" },
  { id: "github", label: "GitHub Models", helpUrl: "https://github.com/settings/personal-access-tokens", hint: "Use a fine-grained PAT with the \"Models\" permission (read), or a classic PAT. Models use mixed-case IDs, e.g. meta/Llama-3.3-70B-Instruct" },
  { id: "gemini", label: "Google Gemini", helpUrl: "https://aistudio.google.com/apikey" },
];

export function SettingsClient({ initial }: { initial: SettingsBlob }) {
  const [s, setS] = React.useState<SettingsBlob>(initial);
  const [saving, setSaving] = React.useState(false);
  const { toast } = useToast();
  const { t } = useT();

  async function save() {
    setSaving(true);
    try {
      await actionSaveSettings(s);
      toast(t("settings.saved"), "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("settings.heading")}</h1>
        </div>
        <Button onClick={save} disabled={saving}>{saving ? t("common.saving") : t("settings.save")}</Button>
      </div>

      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">{t("settings.tabs.providers")}</TabsTrigger>
          <TabsTrigger value="models">{t("settings.tabs.models")}</TabsTrigger>
          <TabsTrigger value="prompts">{t("settings.tabs.prompts")}</TabsTrigger>
          <TabsTrigger value="defaults">{t("settings.tabs.defaults")}</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="mt-6 space-y-4">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              providerId={p.id}
              label={p.label}
              helpUrl={p.helpUrl}
              hint={p.hint}
              cfg={s.providers[p.id]}
              currentSettings={s}
              onChange={(next) => setS({ ...s, providers: { ...s.providers, [p.id]: next } })}
            />
          ))}
        </TabsContent>

        <TabsContent value="models" className="mt-6 space-y-4">
          {PROVIDERS.map((p) => (
            <ModelsCard
              key={p.id}
              providerId={p.id}
              label={p.label}
              custom={s.customModels[p.id]}
              onChange={(next) => setS({ ...s, customModels: { ...s.customModels, [p.id]: next } })}
            />
          ))}
        </TabsContent>

        <TabsContent value="prompts" className="mt-6 space-y-4">
          <Card>
            <CardBody className="text-xs text-[var(--color-text-dim)] py-3">
              {t("settings.promptsDesc")}
            </CardBody>
          </Card>
          <PromptCard
            title={t("settings.promptGeneration")}
            description="Sent when generating anchors for a new job. Uses placeholders like {{ENTRIES_BLOCK}}, {{RATIO_BLOCK}} which are filled in automatically."
            value={s.prompts.generation}
            onChange={(v) => setS({ ...s, prompts: { ...s.prompts, generation: v } })}
            defaultValue={DEFAULT_GENERATION_PROMPT}
          />
          <PromptCard
            title={t("settings.promptRegeneration")}
            description="Sent when regenerating selected anchors inside a job."
            value={s.prompts.regeneration}
            onChange={(v) => setS({ ...s, prompts: { ...s.prompts, regeneration: v } })}
            defaultValue={DEFAULT_REGENERATION_PROMPT}
          />
        </TabsContent>

        <TabsContent value="defaults" className="mt-6 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("settings.defaultsHeading")}</CardTitle>
              <CardDescription>{t("settings.defaultsDesc")}</CardDescription>
            </CardHeader>
            <CardBody>
              <div className="max-w-sm">
                <Label>{t("form.provider")}</Label>
                <Select
                  className="mt-1"
                  value={s.defaults.providerId}
                  onChange={(e) =>
                    setS({ ...s, defaults: { ...s.defaults, providerId: e.target.value as ProviderId } })
                  }
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </Select>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("settings.defaultsModelsHeading")}</CardTitle>
              <CardDescription>{t("settings.defaultsModelsDesc")}</CardDescription>
            </CardHeader>
            <CardBody className="space-y-4">
              {PROVIDERS.map((p) => (
                <div key={p.id} className="grid grid-cols-[140px_1fr] gap-4 items-center">
                  <Label>{p.label}</Label>
                  <div>
                    <Input
                      value={s.defaults.modelByProvider[p.id] ?? ""}
                      onChange={(e) =>
                        setS({
                          ...s,
                          defaults: {
                            ...s.defaults,
                            modelByProvider: { ...s.defaults.modelByProvider, [p.id]: e.target.value },
                          },
                        })
                      }
                      list={`default-models-${p.id}`}
                      placeholder="(none)"
                    />
                    <datalist id={`default-models-${p.id}`}>
                      {Array.from(
                        new Set([...(PREDEFINED_MODELS[p.id] ?? []), ...(s.customModels[p.id] ?? [])])
                      ).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProviderCard({
  providerId,
  label,
  helpUrl,
  hint,
  cfg,
  currentSettings,
  onChange,
}: {
  providerId: ProviderId;
  label: string;
  helpUrl: string;
  hint?: string;
  cfg: { apiKey: string; baseUrl?: string; apiKeyPreview?: string | null; advanced?: ProviderAdvanced };
  currentSettings: SettingsBlob;
  onChange: (next: { apiKey: string; baseUrl?: string; apiKeyPreview?: string | null; advanced?: ProviderAdvanced }) => void;
}) {
  const [show, setShow] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const { toast } = useToast();
  const { t } = useT();

  // True only when the form was hydrated with a redacted preview (i.e. the server has
  // a key on file) AND the user hasn't typed a replacement yet.
  const hasStoredKey = !!cfg.apiKeyPreview && cfg.apiKey === "";

  async function test() {
    setTesting(true);
    try {
      const r = await actionTestProvider(providerId, currentSettings);
      toast(r.message, r.ok ? "success" : "error");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div>
          <CardTitle>{label}</CardTitle>
          <CardDescription>
            <a href={helpUrl} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">{t("settings.docs")}</a>
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={test} disabled={testing || (!cfg.apiKey && !hasStoredKey) || cfg.apiKey === KEY_CLEAR_SENTINEL}>
          {testing ? t("settings.testing") : t("settings.test")}
        </Button>
      </CardHeader>
      <CardBody className="space-y-3">
        {hint && (
          <p className="text-[11px] text-[var(--color-text-dim)] bg-[var(--color-surface-2)]/40 border border-[var(--color-border)] rounded p-2 leading-relaxed">
            {hint}
          </p>
        )}
        <div>
          <Label>{t("settings.apiKey")}</Label>
          <div className="flex gap-2 mt-1">
            <Input
              type={show ? "text" : "password"}
              value={cfg.apiKey}
              onChange={(e) => onChange({ ...cfg, apiKey: e.target.value })}
              placeholder={hasStoredKey ? `•••set (${cfg.apiKeyPreview}) — type to replace` : "sk-…"}
              autoComplete="off"
            />
            <Button variant="ghost" size="md" onClick={() => setShow((v) => !v)} type="button">
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          {hasStoredKey && (
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-[11px] text-[var(--color-text-faint)]">
                The current key is hidden. Leave blank to keep it; type a new key to replace.
              </p>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => onChange({ ...cfg, apiKey: KEY_CLEAR_SENTINEL, apiKeyPreview: null })}
              >
                <X className="h-3 w-3" /> Remove key
              </Button>
            </div>
          )}
          {cfg.apiKey === KEY_CLEAR_SENTINEL && (
            <p className="mt-1 text-[11px] text-[var(--color-warn)]">
              Key will be removed when you save. <button type="button" className="underline" onClick={() => onChange({ ...cfg, apiKey: "" })}>Undo</button>
            </p>
          )}
        </div>
        {providerId !== "gemini" && (
          <div>
            <Label>{t("settings.baseUrl")}</Label>
            <Input
              className="mt-1"
              value={cfg.baseUrl ?? ""}
              onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value })}
            />
          </div>
        )}
        <AdvancedProviderSection
          advanced={cfg.advanced}
          onChange={(next) => onChange({ ...cfg, advanced: next })}
        />
      </CardBody>
    </Card>
  );
}

/** Collapsible Advanced expander on each provider card. Three knobs: per-call timeout,
 *  inter-batch delay, max consecutive rate-limit retries. All optional — empty input
 *  means "use default" and the saved settings won't include the field. */
function AdvancedProviderSection({
  advanced,
  onChange,
}: {
  advanced: ProviderAdvanced | undefined;
  onChange: (next: ProviderAdvanced | undefined) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = React.useState(false);

  const a = advanced ?? {};
  // True when at least one knob differs from defaults — used to badge the toggle so the
  // user can tell at a glance whether this provider is using custom limits.
  const hasOverride = a.timeoutMs != null || a.interBatchDelayMs != null || a.maxRateRetries != null;

  function setField<K extends keyof ProviderAdvanced>(key: K, raw: string) {
    const next: ProviderAdvanced = { ...a };
    if (raw === "") {
      delete next[key];
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) next[key] = n;
    }
    // If all three are unset, drop the whole `advanced` object entirely so saved settings
    // stay clean.
    const empty = next.timeoutMs == null && next.interBatchDelayMs == null && next.maxRateRetries == null;
    onChange(empty ? undefined : next);
  }

  return (
    <div className="border-t border-[var(--color-border)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] cursor-pointer"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{t("settings.advancedTitle")}</span>
        {hasOverride && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
            {t("settings.advancedCustom")}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-[var(--color-text-faint)] leading-relaxed">
            {t("settings.advancedHint")}
          </p>
          <AdvancedField
            label={t("settings.timeoutLabel")}
            hint={t("settings.timeoutHint", { def: PROVIDER_LIMIT_DEFAULTS.timeoutMs / 1000 })}
            value={a.timeoutMs == null ? "" : String(a.timeoutMs / 1000)}
            placeholder={String(PROVIDER_LIMIT_DEFAULTS.timeoutMs / 1000)}
            min={PROVIDER_LIMIT_BOUNDS.timeoutMs.min / 1000}
            max={PROVIDER_LIMIT_BOUNDS.timeoutMs.max / 1000}
            unit="s"
            onChange={(v) => setField("timeoutMs", v === "" ? "" : String(Math.round(Number(v) * 1000)))}
          />
          <AdvancedField
            label={t("settings.interBatchDelayLabel")}
            hint={t("settings.interBatchDelayHint", { def: PROVIDER_LIMIT_DEFAULTS.interBatchDelayMs })}
            value={a.interBatchDelayMs == null ? "" : String(a.interBatchDelayMs)}
            placeholder={String(PROVIDER_LIMIT_DEFAULTS.interBatchDelayMs)}
            min={PROVIDER_LIMIT_BOUNDS.interBatchDelayMs.min}
            max={PROVIDER_LIMIT_BOUNDS.interBatchDelayMs.max}
            unit="ms"
            onChange={(v) => setField("interBatchDelayMs", v)}
          />
          <AdvancedField
            label={t("settings.maxRateRetriesLabel")}
            hint={t("settings.maxRateRetriesHint", { def: PROVIDER_LIMIT_DEFAULTS.maxRateRetries })}
            value={a.maxRateRetries == null ? "" : String(a.maxRateRetries)}
            placeholder={String(PROVIDER_LIMIT_DEFAULTS.maxRateRetries)}
            min={PROVIDER_LIMIT_BOUNDS.maxRateRetries.min}
            max={PROVIDER_LIMIT_BOUNDS.maxRateRetries.max}
            unit=""
            onChange={(v) => setField("maxRateRetries", v)}
          />
          {hasOverride && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-[11px] text-[var(--color-text-dim)] underline hover:text-[var(--color-text)] cursor-pointer"
            >
              {t("settings.resetAdvanced")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AdvancedField({
  label, hint, value, placeholder, min, max, unit, onChange,
}: {
  label: string; hint: string; value: string; placeholder: string;
  min: number; max: number; unit: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          type="number"
          min={min}
          max={max}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="max-w-[140px]"
        />
        {unit && <span className="text-xs text-[var(--color-text-dim)]">{unit}</span>}
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-text-faint)] leading-relaxed">{hint}</p>
    </div>
  );
}

function ModelsCard({
  providerId,
  label,
  custom,
  onChange,
}: {
  providerId: ProviderId;
  label: string;
  custom: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = React.useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{t("settings.customModelsDesc")}</CardDescription>
      </CardHeader>
      <CardBody className="space-y-3">
        <div>
          <Label>{t("settings.predefinedTitle")}</Label>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {(PREDEFINED_MODELS[providerId] ?? []).map((m) => (
              <li key={m} className="rounded bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-text-dim)] font-mono">
                {m}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <Label>{t("settings.customModelsTitle")}</Label>
          <div className="mt-1 flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. anthropic/claude-3-opus"
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  onChange([...custom, draft.trim()]);
                  setDraft("");
                }
              }}
            />
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                if (draft.trim()) {
                  onChange([...custom, draft.trim()]);
                  setDraft("");
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" /> {t("common.add")}
            </Button>
          </div>
          {custom.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {custom.map((m, i) => (
                <li key={`${m}-${i}`} className="rounded bg-[var(--color-surface-2)] px-2 py-1 text-xs font-mono inline-flex items-center gap-1.5">
                  {m}
                  <button
                    type="button"
                    onClick={() => onChange(custom.filter((_, j) => j !== i))}
                    className="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function PromptCard({
  title,
  description,
  value,
  onChange,
  defaultValue,
}: {
  title: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  defaultValue: string;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <PromptResetButton onReset={() => onChange(defaultValue)} />
      </CardHeader>
      <CardBody>
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={20} />
      </CardBody>
    </Card>
  );
}

function PromptResetButton({ onReset }: { onReset: () => void }) {
  const { t } = useT();
  return (
    <Button variant="ghost" size="sm" onClick={onReset}>
      <RotateCcw className="h-3.5 w-3.5" /> {t("common.reset")}
    </Button>
  );
}
