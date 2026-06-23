"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, Textarea } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { useT } from "@/lib/i18n/I18nProvider";
import { actionPreviewPromptPirogi, actionStartGeneration, actionUpdateJob } from "@/lib/actions";
import { parseCsvTextV2, type CsvRowV2, v2InputsToCsv } from "@/lib/anchors/csv_v2";
import { PREDEFINED_MODELS } from "@/lib/settings";
import type { Job, ProviderId, SettingsBlob } from "@/lib/types";
import { Eye, Upload, Loader2 } from "lucide-react";

const PROVIDERS: ProviderId[] = ["openrouter", "github", "gemini", "vertex"];

function labelFor(p: ProviderId): string {
  return p === "openrouter" ? "OpenRouter"
    : p === "github" ? "GitHub Models"
    : p === "gemini" ? "Google Gemini"
    : "Google Vertex AI";
}

/**
 * Пироги (v3) edit form. Mirrors NewJobPirogiClient but:
 *  - pre-populates name / site description / provider / model / CSV from the existing job
 *  - swaps the single "Create & generate" CTA for three status-aware buttons:
 *      Save only, Save & resume (for partial/paused/cancelled jobs), Save & rerun.
 *
 * Pattern mirrors V1's EditJobClient so the UX feels consistent across modes. The CSV
 * pre-fill uses v2InputsToCsv (9-column V2 shape — same parser accepts it back).
 */
export function EditJobPirogiClient({ job, settings }: { job: Job; settings: SettingsBlob }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useT();

  const [name, setName] = React.useState(job.name);
  const [providerId, setProviderId] = React.useState<ProviderId>(job.criteria.providerId);
  const [model, setModel] = React.useState<string>(job.criteria.model);
  const [siteDescription, setSiteDescription] = React.useState(job.criteria.siteDescription ?? "");
  const [csvText, setCsvText] = React.useState(() => v2InputsToCsv(job.inputs ?? []));
  const [busy, setBusy] = React.useState<"saveOnly" | "saveResume" | "saveRerun" | null>(null);

  // Status-aware default: partial/paused/cancelled jobs keep anchors (Save & resume);
  // idle/succeeded/failed/running default to Save & rerun (fresh start).
  const isResumable = job.status === "partial" || job.status === "paused" || job.status === "cancelled";

  const parsed = React.useMemo(() => {
    if (!csvText.trim()) return { rows: [] as CsvRowV2[], errors: [] as string[], warnings: [] as string[], skipped: 0 };
    return parseCsvTextV2(csvText, { linkTypeRequired: false });
  }, [csvText]);

  function handleProviderChange(p: ProviderId) {
    setProviderId(p);
    const def = settings.defaults.modelByProvider[p] ?? "";
    if (def) setModel(def);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    setCsvText(text);
  }

  /** Same summary shape as NewJobPirogiClient — total links + breakdown by Link Type (skipping empty). */
  const summary = React.useMemo(() => {
    const byLinkType = new Map<string, number>();
    const urls = new Set<string>();
    let totalLinks = 0;
    for (const r of parsed.rows) {
      urls.add(r.targetUrl);
      const n = r.payloadV2.numberOfLinks;
      totalLinks += n;
      const lt = r.payloadV2.linkType.trim();
      if (lt) byLinkType.set(lt, (byLinkType.get(lt) ?? 0) + n);
    }
    return {
      rowCount: parsed.rows.length,
      uniqueUrls: urls.size,
      totalLinks,
      byLinkType: Array.from(byLinkType.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [parsed.rows]);

  async function previewPrompt(): Promise<string> {
    return actionPreviewPromptPirogi({
      inputs: parsed.rows.map((r) => ({ targetUrl: r.targetUrl, payloadV2: r.payloadV2 })),
      siteDescription: siteDescription.trim() || null,
    });
  }

  /** Common update — writes job criteria + inputs back to the DB. Doesn't change version. */
  async function persist() {
    await actionUpdateJob({
      id: job.id,
      name: name.trim() || t("common.untitled"),
      mode: "one_site",
      criteria: {
        ...job.criteria,
        providerId,
        model,
        siteDescription: siteDescription.trim() || null,
      },
      inputs: parsed.rows.map((r) => ({
        targetUrl: r.targetUrl,
        title: null,
        keywords: null,
        payloadV2: r.payloadV2,
      })),
    });
  }

  function validate(): boolean {
    if (parsed.rows.length === 0) { toast(t("form.needInputs"), "error"); return false; }
    if (parsed.errors.length > 0) { toast(parsed.errors[0], "error"); return false; }
    if (!model.trim()) { toast(t("form.needModel"), "error"); return false; }
    return true;
  }

  async function saveOnly() {
    if (!validate()) return;
    setBusy("saveOnly");
    try {
      await persist();
      toast(t("jobView.toasts.savedOnly"), "success");
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(null);
    }
  }

  async function saveAndResume() {
    if (!validate()) return;
    setBusy("saveResume");
    try {
      await persist();
      const r = await actionStartGeneration(job.id, { resume: true });
      if (r.ok) toast(t("jobView.toasts.savedResume"), "info");
      else toast(r.message, "error");
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(null);
    }
  }

  async function saveAndRerun() {
    if (!validate()) return;
    // Mirror V1's safety prompt: switching off the resumable default destroys progress.
    const anchorsCount = job.anchors?.length ?? 0;
    if (isResumable && anchorsCount > 0) {
      const ok = window.confirm(t("editJob.rerunConfirmDestructive", { n: anchorsCount }));
      if (!ok) return;
    }
    setBusy("saveRerun");
    try {
      await persist();
      const r = await actionStartGeneration(job.id);
      if (r.ok) toast(t("jobView.toasts.savedRerun", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
      else toast(r.message, "error");
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(null);
    }
  }

  const noKey = !settings.providers[providerId]?.apiKey;
  const anyBusy = busy !== null;
  const submitDisabled = anyBusy || parsed.rows.length === 0 || parsed.errors.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t("editJob.headingPirogi", { name: job.name })}</h1>
        <p className="text-sm text-[var(--color-text-dim)]">{t("editJob.sub")}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("form.basics")}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <div>
                <Label>{t("form.jobName")}</Label>
                <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>{t("newJob.v2SiteDescTitle")}</Label>
                <Textarea
                  className="mt-1"
                  rows={3}
                  value={siteDescription}
                  onChange={(e) => setSiteDescription(e.target.value)}
                  placeholder={t("newJob.v2SiteDescPlaceholder")}
                />
                <p className="text-[10px] text-[var(--color-text-faint)] mt-1">{t("newJob.v2SiteDescHint")}</p>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("form.inputsTitle")}</CardTitle>
              <CardDescription>{t("newJob.v3InputsDesc")}</CardDescription>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-2 px-3 h-8 rounded-md border border-[var(--color-border)] cursor-pointer text-xs hover:bg-[var(--color-surface-2)]">
                  <Upload className="h-3 w-3" />
                  {t("form.uploadCsv")}
                  <input type="file" accept=".csv,.tsv,.txt" onChange={handleFileUpload} className="hidden" />
                </label>
                <div className="flex-1" />
                <Button type="button" variant="ghost" size="sm" onClick={() => setCsvText("")}>
                  {t("common.clear")}
                </Button>
              </div>
              <Textarea rows={12} value={csvText} onChange={(e) => setCsvText(e.target.value)} />

              {parsed.errors.length > 0 && (
                <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)] space-y-1">
                  {parsed.errors.map((er, i) => <div key={i}>{er}</div>)}
                </div>
              )}
              {parsed.warnings.length > 0 && (
                <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)] space-y-1">
                  {parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("newJob.v2SummaryTitle")}</CardTitle>
            </CardHeader>
            <CardBody>
              {summary.rowCount === 0 ? (
                <p className="text-xs text-[var(--color-text-dim)]">{t("newJob.v2SummaryEmpty")}</p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="text-3xl font-semibold tabular-nums text-[var(--color-text)]">{summary.totalLinks}</div>
                    <div className="text-xs text-[var(--color-text-dim)] mt-0.5">{t("newJob.v3SummaryLinks")}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-[var(--color-text-dim)] border-t border-[var(--color-border)] pt-3">
                    <div>
                      <div className="font-medium text-[var(--color-text)] tabular-nums">{summary.rowCount}</div>
                      <div>{t("newJob.v2SummaryRows")}</div>
                    </div>
                    <div>
                      <div className="font-medium text-[var(--color-text)] tabular-nums">{summary.uniqueUrls}</div>
                      <div>{t("newJob.v2SummaryUniqueUrls")}</div>
                    </div>
                  </div>
                  {summary.byLinkType.length > 0 && (
                    <div className="border-t border-[var(--color-border)] pt-3">
                      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">
                        {t("newJob.v2SummaryByLinkType")}
                      </div>
                      <ul className="space-y-1 text-xs">
                        {summary.byLinkType.map(([type, count]) => (
                          <li key={type} className="flex items-center justify-between">
                            <span className="truncate">{type}</span>
                            <span className="tabular-nums text-[var(--color-text-dim)]">{count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("form.aiProvider")}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div>
                <Label>{t("form.provider")}</Label>
                <Select className="mt-1" value={providerId} onChange={(e) => handleProviderChange(e.target.value as ProviderId)}>
                  {PROVIDERS.map((p) => <option key={p} value={p}>{labelFor(p)}</option>)}
                </Select>
              </div>
              <div>
                <Label>{t("form.model")}</Label>
                <Input
                  className="mt-1"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  list={`edit-v3-models-list-${providerId}`}
                />
                <datalist id={`edit-v3-models-list-${providerId}`}>
                  {Array.from(new Set([...(PREDEFINED_MODELS[providerId] ?? []), ...(settings.customModels[providerId] ?? [])])).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <p className="text-[10px] text-[var(--color-text-faint)] mt-1">{t("form.modelHint")}</p>
              </div>
              {noKey && (
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
                  <Button variant="outline" className="w-full" disabled={parsed.rows.length === 0}>
                    <Eye className="h-3.5 w-3.5" /> {t("form.previewPrompt")}
                  </Button>
                </DialogTrigger>
                <PromptPreviewDialog getPrompt={previewPrompt} />
              </Dialog>

              {/* Status-aware primary CTA — resumable jobs default to Save & resume so
                  we don't silently discard partial progress. Otherwise default to
                  Save & rerun (fresh start). */}
              {isResumable ? (
                <>
                  <Button className="w-full" disabled={submitDisabled} onClick={saveAndResume}>
                    {busy === "saveResume" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("editJob.saveAndResumeBusy")}</> : t("editJob.saveAndResume")}
                  </Button>
                  <Button variant="outline" className="w-full" disabled={submitDisabled} onClick={saveOnly}>
                    {busy === "saveOnly" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("editJob.saveOnlyBusy")}</> : t("editJob.saveOnly")}
                  </Button>
                  {/* Destructive option hidden behind a less-prominent variant + confirm dialog. */}
                  <Button variant="ghost" className="w-full" disabled={submitDisabled} onClick={saveAndRerun}>
                    {busy === "saveRerun" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("editJob.saveAndRerunBusy")}</> : t("editJob.saveAndRerun")}
                  </Button>
                </>
              ) : (
                <>
                  <Button className="w-full" disabled={submitDisabled} onClick={saveAndRerun}>
                    {busy === "saveRerun" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("editJob.saveAndRerunBusy")}</> : t("editJob.saveAndRerun")}
                  </Button>
                  <Button variant="outline" className="w-full" disabled={submitDisabled} onClick={saveOnly}>
                    {busy === "saveOnly" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("editJob.saveOnlyBusy")}</> : t("editJob.saveOnly")}
                  </Button>
                </>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function PromptPreviewDialog({ getPrompt }: { getPrompt: () => Promise<string> }) {
  const { t } = useT();
  const [prompt, setPrompt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPrompt().then((p) => { if (!cancelled) { setPrompt(p); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setPrompt(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [getPrompt]);

  return (
    <DialogContent className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{t("form.composedPrompt")}</DialogTitle>
        <DialogDescription>{t("form.previewPrompt")}</DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs font-mono whitespace-pre-wrap">
        {loading ? t("common.loading") : prompt ?? ""}
      </div>
    </DialogContent>
  );
}
