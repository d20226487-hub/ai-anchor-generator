"use client";

import * as React from "react";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { Slider } from "@/components/ui/Slider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { actionPreviewPrompt } from "@/lib/actions";
import { PREDEFINED_MODELS } from "@/lib/settings";
import { parseCsvText, type CsvRow } from "@/lib/anchors/csv";
import type { Brand, JobCriteria, JobMode, ProviderId, SettingsBlob } from "@/lib/types";
import { SUPPORTED_LANGUAGES } from "@/lib/types";
import { uid, clamp } from "@/lib/utils";
import { Eye, Plus, Trash2, Upload, ClipboardPaste } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

const PROVIDERS: ProviderId[] = ["openrouter", "github", "gemini", "vertex"];

export interface JobFormInitial {
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  csvText: string;
}

export interface JobFormSubmitArgs {
  name: string;
  mode: JobMode;
  criteria: JobCriteria;
  inputs: CsvRow[];
}

interface Action {
  label: string;
  busyLabel?: string;
  variant?: "primary" | "secondary" | "outline";
  onSubmit: (args: JobFormSubmitArgs) => Promise<void>;
}

export function JobForm({
  settings,
  initial,
  primaryAction,
  secondaryAction,
  heading,
  subheading,
}: {
  settings: SettingsBlob;
  initial: JobFormInitial;
  primaryAction: Action;
  secondaryAction?: Action;
  heading: string;
  subheading: string;
}) {
  const { toast } = useToast();
  const { t } = useT();

  const [name, setName] = React.useState(initial.name);
  const [mode, setMode] = React.useState<JobMode>(initial.mode);
  const [ratiosEnabled, setRatiosEnabled] = React.useState(initial.criteria.ratiosEnabled);
  const [dofollowPct, setDofollowPct] = React.useState(initial.criteria.dofollowPct);
  const [genericPct, setGenericPct] = React.useState(initial.criteria.distribution.generic);
  const [brandedPct, setBrandedPct] = React.useState(initial.criteria.distribution.branded);
  const [keywordPct, setKeywordPct] = React.useState(initial.criteria.distribution.keyword);
  const [urlPct, setUrlPct] = React.useState(initial.criteria.distribution.url ?? 0);
  const [providerId, setProviderId] = React.useState<ProviderId>(initial.criteria.providerId);
  const [model, setModel] = React.useState<string>(initial.criteria.model);
  const [brands, setBrands] = React.useState<Brand[]>(initial.criteria.brands);
  const [language, setLanguage] = React.useState<string>(initial.criteria.language ?? "");
  const [csvText, setCsvText] = React.useState(initial.csvText);

  const [parseErrors, setParseErrors] = React.useState<string[]>([]);
  const [parseWarnings, setParseWarnings] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<CsvRow[]>([]);
  const [busy, setBusy] = React.useState<"primary" | "secondary" | null>(null);

  const distSum = genericPct + brandedPct + keywordPct + urlPct;
  const distOk = distSum === 100;

  React.useEffect(() => {
    if (!csvText.trim()) {
      setRows([]);
      setParseErrors([]);
      setParseWarnings([]);
      return;
    }
    const r = parseCsvText(csvText);
    setRows(r.rows);
    setParseErrors(r.errors);
    setParseWarnings(r.warnings);
  }, [csvText]);

  function handleProviderChange(next: ProviderId) {
    setProviderId(next);
    const def = settings.defaults.modelByProvider[next] ?? "";
    if (def) setModel(def);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  function buildCriteria(): JobCriteria {
    return {
      ratiosEnabled,
      dofollowPct,
      distribution: { generic: genericPct, branded: brandedPct, keyword: keywordPct, url: urlPct },
      brands,
      providerId,
      model,
      language: mode === "one_site" ? (language || null) : null,
    };
  }

  async function previewPrompt(): Promise<string> {
    return actionPreviewPrompt({ mode, criteria: buildCriteria(), inputs: rows });
  }

  async function runAction(action: Action, kind: "primary" | "secondary") {
    if (rows.length === 0) {
      toast(t("form.needInputs"), "error");
      return;
    }
    if (!distOk) {
      toast(t("form.needDist100", { sum: distSum }), "error");
      return;
    }
    if (!model.trim()) {
      toast(t("form.needModel"), "error");
      return;
    }
    // Language is required. Single-site → criteria.language. Multi-site → every brand.language.
    if (mode === "one_site" && !language) {
      toast(t("form.needLanguage"), "error");
      return;
    }
    if (mode === "multi_site") {
      const missing = brands.find((b) => !b.language);
      if (missing) {
        toast(t("form.needBrandLanguage", { name: missing.name || "(unnamed)" }), "error");
        return;
      }
    }
    setBusy(kind);
    try {
      await action.onSubmit({
        name: name.trim() || t("common.untitled"),
        mode,
        criteria: buildCriteria(),
        inputs: rows,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{heading}</h1>
        <p className="text-sm text-[var(--color-text-dim)]">{subheading}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("form.basics")}</CardTitle>
            </CardHeader>
            <CardBody className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Label>{t("form.jobName")}</Label>
                <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>{t("form.mode")}</Label>
                <Select className="mt-1" value={mode} onChange={(e) => setMode(e.target.value as JobMode)}>
                  <option value="one_site">{t("modes.one_site")}</option>
                  <option value="multi_site">{t("modes.multi_site")}</option>
                </Select>
              </div>
              <div>
                <Label>{t("form.totalAnchors")}</Label>
                <div className="mt-1 h-9 px-3 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-border)] flex items-center text-sm">
                  <span className="font-mono">{rows.length}</span>
                  <span className="text-[var(--color-text-dim)] ml-1.5">{t("form.totalAnchorsHint")}</span>
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <CardTitle>{t("form.ratiosTitle")}</CardTitle>
                <CardDescription>{t("form.ratiosDesc")}</CardDescription>
              </div>
              <Switch checked={ratiosEnabled} onCheckedChange={setRatiosEnabled} />
            </CardHeader>
            {ratiosEnabled && (
              <CardBody>
                <div className="flex items-center gap-4">
                  <Slider
                    value={[dofollowPct]}
                    onValueChange={(v) => setDofollowPct(v[0] ?? 70)}
                    min={0}
                    max={100}
                    step={5}
                    className="flex-1"
                  />
                  <div className="text-sm font-mono w-32 text-right">
                    {dofollowPct}% / {100 - dofollowPct}%
                  </div>
                </div>
                <div className="flex justify-between text-xs text-[var(--color-text-dim)] mt-2">
                  <span>Dofollow</span>
                  <span>Nofollow</span>
                </div>
              </CardBody>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("form.distributionTitle")}</CardTitle>
              <CardDescription>{mode === "multi_site" ? t("form.distributionDescMulti") : t("form.distributionDesc")}</CardDescription>
            </CardHeader>
            <CardBody className="space-y-4">
              <DistRow label={t("form.cat.generic")} value={genericPct} onChange={setGenericPct} />
              <DistRow label={t("form.cat.branded")} value={brandedPct} onChange={setBrandedPct} />
              <DistRow label={t("form.cat.keyword")} value={keywordPct} onChange={setKeywordPct} />
              <DistRow label={t("form.cat.url")} value={urlPct} onChange={setUrlPct} />
              <div className={`text-xs ${distOk ? "text-[var(--color-success)]" : "text-[var(--color-warn)]"}`}>
                {t("form.distTotal", { sum: distSum })} {distOk ? "" : t("form.distMustBe100")}
              </div>
            </CardBody>
          </Card>

          {mode === "one_site" && (
            <Card>
              <CardHeader>
                <CardTitle>{t("form.languageTitle")}</CardTitle>
                <CardDescription>{t("form.languageDescSingle")}</CardDescription>
              </CardHeader>
              <CardBody>
                <LanguageSelect
                  value={language}
                  onChange={setLanguage}
                  placeholder={t("form.langSelectPlaceholder")}
                />
              </CardBody>
            </Card>
          )}

          {mode === "multi_site" && (
            <Card>
              <CardHeader>
                <CardTitle>{t("form.brandsTitle")}</CardTitle>
                <CardDescription>{t("form.brandsDesc")}</CardDescription>
              </CardHeader>
              <CardBody>
                <BrandsManager brands={brands} onChange={setBrands} />
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t("form.inputsTitle")}</CardTitle>
              <CardDescription>{t("form.inputsDesc")}</CardDescription>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex gap-2">
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleFile(f);
                      e.target.value = "";
                    }}
                  />
                  <span className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] transition-colors">
                    <Upload className="h-3.5 w-3.5" /> {t("form.uploadCsv")}
                  </span>
                </label>
                <Button variant="ghost" size="md" onClick={() => setCsvText("Target URL,Title,Keywords\n")}>
                  {t("form.insertHeaders")}
                </Button>
                <Button variant="ghost" size="md" onClick={() => setCsvText("")}>
                  {t("common.clear")}
                </Button>
              </div>
              <Textarea
                rows={10}
                placeholder={`Target URL,Title,Keywords\nhttps://example.com/page,Example page,seo|backlinks`}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />
              {parseErrors.length > 0 && (
                <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)] space-y-1">
                  {parseErrors.map((er, i) => (
                    <div key={i}>{er}</div>
                  ))}
                </div>
              )}
              {parseWarnings.length > 0 && (
                <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)] space-y-1">
                  {parseWarnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
              <div className="text-xs text-[var(--color-text-dim)]">
                {t("form.parsedEntries", { n: rows.length })}
                {rows.length > 0 && ` · ${t("form.withTitle", { n: rows.filter((r) => r.title).length })} · ${t("form.withKeywords", { n: rows.filter((r) => r.keywords).length })}`}
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("form.aiProvider")}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div>
                <Label>{t("form.provider")}</Label>
                <Select className="mt-1" value={providerId} onChange={(e) => handleProviderChange(e.target.value as ProviderId)}>
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>{labelFor(p)}</option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>{t("form.model")}</Label>
                <Input
                  className="mt-1"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list={`models-list-${providerId}`}
                />
                <datalist id={`models-list-${providerId}`}>
                  {Array.from(
                    new Set([...(PREDEFINED_MODELS[providerId] ?? []), ...(settings.customModels[providerId] ?? [])])
                  ).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <p className="text-[10px] text-[var(--color-text-faint)] mt-1">{t("form.modelHint")}</p>
              </div>
              {!settings.providers[providerId]?.apiKey && (
                <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-2 text-xs text-[var(--color-warn)]">
                  {t("form.noApiKey", { provider: labelFor(providerId) })}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-3">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" className="w-full">
                    <Eye className="h-3.5 w-3.5" /> {t("form.previewPrompt")}
                  </Button>
                </DialogTrigger>
                <PromptPreviewDialog getPrompt={previewPrompt} />
              </Dialog>
              <Button
                onClick={() => runAction(primaryAction, "primary")}
                disabled={busy !== null}
                className="w-full"
                size="lg"
                variant={primaryAction.variant ?? "primary"}
              >
                {busy === "primary" ? primaryAction.busyLabel ?? "Working…" : primaryAction.label}
              </Button>
              {secondaryAction && (
                <Button
                  onClick={() => runAction(secondaryAction, "secondary")}
                  disabled={busy !== null}
                  className="w-full"
                  variant={secondaryAction.variant ?? "outline"}
                >
                  {busy === "secondary" ? secondaryAction.busyLabel ?? "Working…" : secondaryAction.label}
                </Button>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function labelFor(p: ProviderId): string {
  return p === "openrouter" ? "OpenRouter" : p === "github" ? "GitHub Models" : "Google Gemini";
}

function DistRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-24 text-xs text-[var(--color-text-dim)]">{label}</div>
      <Slider value={[value]} onValueChange={(v) => onChange(v[0] ?? 0)} min={0} max={100} step={5} className="flex-1" />
      <Input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value || 0), 0, 100))}
        className="w-16 text-right"
      />
      <span className="text-xs w-4">%</span>
    </div>
  );
}

function BrandsManager({ brands, onChange }: { brands: Brand[]; onChange: (b: Brand[]) => void }) {
  const { t } = useT();
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkText, setBulkText] = React.useState("");
  const [bulkMode, setBulkMode] = React.useState<"append" | "replace">("append");

  function applyBulk() {
    const parsed = parseBulkBrands(bulkText);
    if (parsed.length === 0) return;
    onChange(bulkMode === "replace" ? parsed : [...brands, ...parsed]);
    setBulkText("");
    setBulkOpen(false);
  }

  return (
    <div className="space-y-2">
      {brands.map((b, idx) => (
        <div key={b.id} className="grid grid-cols-[1fr_2fr_140px_auto] gap-2 items-center">
          <Input
            value={b.name}
            onChange={(e) => {
              const next = brands.slice();
              next[idx] = { ...b, name: e.target.value };
              onChange(next);
            }}
            placeholder={t("form.brandName")}
          />
          <Input
            value={b.domains.join(", ")}
            onChange={(e) => {
              const next = brands.slice();
              next[idx] = { ...b, domains: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) };
              onChange(next);
            }}
            placeholder="domain1.com, domain2.com"
          />
          <LanguageSelect
            value={b.language ?? ""}
            onChange={(v) => {
              const next = brands.slice();
              next[idx] = { ...b, language: v || null };
              onChange(next);
            }}
            placeholder={t("form.langSelectPlaceholder")}
          />
          <Button variant="ghost" size="sm" onClick={() => onChange(brands.filter((_, j) => j !== idx))}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange([...brands, { id: uid("brand"), name: "", domains: [], language: null }])}
        >
          <Plus className="h-3.5 w-3.5" /> {t("form.addBrand")}
        </Button>
        <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <ClipboardPaste className="h-3.5 w-3.5" /> {t("form.bulkPaste")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("form.bulkPasteTitle")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-xs text-[var(--color-text-dim)]">{t("form.bulkPasteHint")}</p>
              <Textarea
                rows={10}
                placeholder={`Acme | acme.com, acme.io | en\nWidgetCo\twidgetco.com\tfr\nGlobex | globex.example | de`}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
              />
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={bulkMode === "append"}
                    onChange={() => setBulkMode("append")}
                    className="accent-[var(--color-accent)]"
                  />
                  {t("form.appendExisting")}
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={bulkMode === "replace"}
                    onChange={() => setBulkMode("replace")}
                    className="accent-[var(--color-accent)]"
                  />
                  {t("form.replaceAll")}
                </label>
              </div>
              <BulkPreview text={bulkText} />
              <div className="flex justify-end gap-2 mt-3">
                <Button variant="ghost" onClick={() => setBulkOpen(false)}>{t("common.cancel")}</Button>
                <Button onClick={applyBulk} disabled={!bulkText.trim()}>{t("form.addBrands")}</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function BulkPreview({ text }: { text: string }) {
  const { t } = useT();
  const parsed = React.useMemo(() => parseBulkBrands(text), [text]);
  if (!text.trim()) return null;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs">
      <div className="text-[var(--color-text-dim)] mb-1">{t("form.bulkPreview", { count: parsed.length, plural: parsed.length === 1 ? "" : "s" })}</div>
      {parsed.length === 0 ? (
        <div className="text-[var(--color-warn)]">{t("form.bulkNoBrands")}</div>
      ) : (
        <ul className="space-y-0.5 max-h-32 overflow-auto">
          {parsed.map((b) => (
            <li key={b.id} className="font-mono">
              <span className="text-[var(--color-text)]">{b.name || "(no name)"}</span>
              {" — "}
              <span className="text-[var(--color-text-dim)]">{b.domains.join(", ") || "(no domains)"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function parseBulkBrands(text: string): Brand[] {
  const brands: Brand[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on tab first, then |
    const parts = line.includes("\t") ? line.split("\t") : line.split("|");
    const name = (parts[0] ?? "").trim();
    const domainsRaw = (parts[1] ?? "").trim();
    const langRaw = (parts[2] ?? "").trim().toLowerCase();
    const domains = domainsRaw
      .split(",")
      .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""))
      .filter(Boolean);
    if (!name && domains.length === 0) continue;
    // Accept the language column only if it matches our supported list — otherwise null
    // and the user must pick from the dropdown.
    const language = (SUPPORTED_LANGUAGES as readonly string[]).includes(langRaw) ? langRaw : null;
    brands.push({ id: uid("brand"), name, domains, language });
  }
  return brands;
}

/** Reusable language dropdown — uses ISO codes as values, displays localized labels.
 *  Empty value = "not set" and shows the placeholder option. */
function LanguageSelect({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { t } = useT();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {SUPPORTED_LANGUAGES.map((code) => (
        <option key={code} value={code}>{t(`form.lang.${code}`)} ({code})</option>
      ))}
    </Select>
  );
}

function PromptPreviewDialog({ getPrompt }: { getPrompt: () => Promise<string> }) {
  const { t } = useT();
  const [prompt, setPrompt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    setLoading(true);
    getPrompt().then((p) => {
      setPrompt(p);
      setLoading(false);
    });
  }, [getPrompt]);

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t("form.composedPrompt")}</DialogTitle>
      </DialogHeader>
      <div className="max-h-[70vh] overflow-auto rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] p-4">
        <pre className="text-xs whitespace-pre-wrap font-mono">{loading ? t("common.loading") : prompt}</pre>
      </div>
      <div className="flex justify-end mt-3">
        <Button variant="secondary" onClick={() => navigator.clipboard.writeText(prompt ?? "")} disabled={!prompt}>
          {t("common.copy")}
        </Button>
      </div>
    </DialogContent>
  );
}
