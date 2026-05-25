"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, Textarea } from "@/components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { useT } from "@/lib/i18n/I18nProvider";
import { useDisplayName } from "@/components/DisplayNameProvider";
import { actionCreateJobAndStart, actionPreviewPromptV2 } from "@/lib/actions";
import { parseCsvTextV2, type CsvRowV2 } from "@/lib/anchors/csv_v2";
import { PREDEFINED_MODELS } from "@/lib/settings";
import type { ProviderId, SettingsBlob } from "@/lib/types";
import { Eye, Upload, Loader2 } from "lucide-react";

const PROVIDERS: ProviderId[] = ["openrouter", "github", "gemini", "vertex"];

function labelFor(p: ProviderId): string {
  return p === "openrouter" ? "OpenRouter"
    : p === "github" ? "GitHub Models"
    : p === "gemini" ? "Google Gemini"
    : "Google Vertex AI";
}

const V2_CSV_PLACEHOLDER = `Target URL,Link Type,Number of links,URL,Brand,Generic,Keyword,GEO,Lang
https://example.com,Web 2.0,30,100,0,0,0,Russia,RU
https://example.com,Comment,30,100,0,0,0,Russia,RU
https://example.com,Profile,5,0,100,0,0,Russia,RU`;

export function NewJobV2Client({ settings }: { settings: SettingsBlob }) {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { t, locale } = useT();
  const { name: displayName } = useDisplayName();
  const folderId = searchParams.get("folder");

  const [name, setName] = React.useState(() =>
    t("newJob.namePlaceholder", { date: new Date().toLocaleDateString(locale === "ru" ? "ru-RU" : undefined) })
  );
  const [providerId, setProviderId] = React.useState<ProviderId>(settings.defaults.providerId);
  const [model, setModel] = React.useState<string>(
    settings.defaults.modelByProvider[settings.defaults.providerId] ?? ""
  );
  const [csvText, setCsvText] = React.useState("");
  const [siteDescription, setSiteDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Re-parse on every csvText change. Cheap and gives immediate feedback.
  const parsed = React.useMemo(() => {
    if (!csvText.trim()) return { rows: [] as CsvRowV2[], errors: [] as string[], warnings: [] as string[], skipped: 0 };
    return parseCsvTextV2(csvText);
  }, [csvText]);

  function handleProviderChange(p: ProviderId) {
    setProviderId(p);
    // Auto-fill model with this provider's default — keeps users from sending GPT model
    // strings to Gemini etc.
    const def = settings.defaults.modelByProvider[p] ?? "";
    setModel(def);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    setCsvText(text);
  }

  /** Derived per-LinkType anchor totals + unique-URL count for the Summary side card. */
  const summary = React.useMemo(() => {
    const byLinkType = new Map<string, number>();
    const urls = new Set<string>();
    let totalAnchors = 0;
    for (const r of parsed.rows) {
      urls.add(r.targetUrl);
      const n = r.payloadV2.numberOfLinks;
      totalAnchors += n;
      byLinkType.set(r.payloadV2.linkType, (byLinkType.get(r.payloadV2.linkType) ?? 0) + n);
    }
    return {
      rowCount: parsed.rows.length,
      uniqueUrls: urls.size,
      totalAnchors,
      byLinkType: Array.from(byLinkType.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [parsed.rows]);

  async function previewPrompt(): Promise<string> {
    return actionPreviewPromptV2({
      inputs: parsed.rows.map((r) => ({ targetUrl: r.targetUrl, payloadV2: r.payloadV2 })),
      providerId,
      siteDescription: siteDescription.trim() || null,
    });
  }

  async function submit() {
    if (parsed.rows.length === 0) {
      toast(t("form.needInputs"), "error");
      return;
    }
    if (parsed.errors.length > 0) {
      toast(parsed.errors[0], "error");
      return;
    }
    if (!model.trim()) {
      toast(t("form.needModel"), "error");
      return;
    }
    setBusy(true);
    try {
      // V2 stores per-row payload on inputs. Criteria carries provider/model but the
      // job-level distribution/dofollow fields are ignored by V2 codepaths — they're
      // kept on the object so the V1-shaped DB type still accepts the row.
      // actionCreateJobAndStart redirects server-side to /jobs/[id]; the previous
      // client router.push() raced with revalidatePath and was swallowed (the freeze).
      await actionCreateJobAndStart({
        name: name.trim() || t("common.untitled"),
        mode: "one_site",
        criteria: {
          ratiosEnabled: false,
          dofollowPct: 100,
          distribution: { generic: 0, branded: 0, keyword: 0, url: 0 },
          brands: [],
          providerId,
          model,
          language: null,
          siteDescription: siteDescription.trim() || null,
        },
        inputs: parsed.rows.map((r) => ({
          targetUrl: r.targetUrl,
          title: null,
          keywords: null,
          payloadV2: r.payloadV2,
        })),
        folderId,
        createdBy: displayName,
        version: 2,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setBusy(false);
    }
  }

  const noKey = !settings.providers[providerId]?.apiKey;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t("newJob.headingV2")}</h1>
        <p className="text-sm text-[var(--color-text-dim)]">{t("newJob.subV2")}</p>
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
              <CardDescription>{t("newJob.v2InputsDesc")}</CardDescription>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-2 px-3 h-8 rounded-md border border-[var(--color-border)] cursor-pointer text-xs hover:bg-[var(--color-surface-2)]">
                  <Upload className="h-3 w-3" />
                  {t("form.uploadCsv")}
                  <input type="file" accept=".csv,.tsv,.txt" onChange={handleFileUpload} className="hidden" />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCsvText(V2_CSV_PLACEHOLDER.split("\n")[0])}
                  title={t("form.insertHeaders")}
                >
                  {t("form.insertHeaders")}
                </Button>
                <div className="flex-1" />
                <Button type="button" variant="ghost" size="sm" onClick={() => setCsvText("")}>
                  {t("common.clear")}
                </Button>
              </div>
              <Textarea rows={12} placeholder={V2_CSV_PLACEHOLDER} value={csvText} onChange={(e) => setCsvText(e.target.value)} />

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
          {/* Summary side card — visible at all times so you can see the job's shape
              while editing the CSV. Empty state shows "Paste a CSV…" hint. */}
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
                    <div className="text-3xl font-semibold tabular-nums text-[var(--color-text)]">{summary.totalAnchors.toLocaleString(locale === "ru" ? "ru-RU" : undefined)}</div>
                    <div className="text-xs text-[var(--color-text-dim)] mt-0.5">{t("newJob.v2SummaryAnchors")}</div>
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
                  list={`v2-models-list-${providerId}`}
                />
                <datalist id={`v2-models-list-${providerId}`}>
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
              <Button className="w-full" disabled={busy || parsed.rows.length === 0 || parsed.errors.length > 0} onClick={submit}>
                {busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("newJob.creating")}</> : t("newJob.create")}
              </Button>
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
