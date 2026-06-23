"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import {
  actionDeleteJob,
  actionGetJobStatus,
  actionPauseGeneration,
  actionRegeneratePirogi,
  actionRenameJob,
  actionStartGeneration,
} from "@/lib/actions";
import { pirogiAnchorsToCsv } from "@/lib/anchors/csv_pirogi";
import { CostPill } from "@/components/CostPill";
import { ANCHOR_CATEGORIES, type AnchorCategory, type Job } from "@/lib/types";
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Download, Info, Pause, Pencil, Play, RefreshCw, Search, Trash2, Wand2, X } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

const POLL_INTERVAL_MS = 2500;
const PAGE_SIZES: ReadonlyArray<50 | 100 | 200 | 500 | 1000> = [50, 100, 200, 500, 1000];

/**
 * Пироги (v3) Job View — leaner than V2.
 * Columns: URL | Anchor | Quantity | Language | Country | Keyword Group | Anchor Type.
 * Filters: text + anchor type (no link-type filter — per design, Пироги output drops
 * Link Type from the deliverable). Keyword Group is computed from the case-insensitive
 * anchor text in arrival order — same logic as the CSV export.
 */
export function JobViewPirogi({ job, pricingMissing = false }: { job: Job; pricingMissing?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useT();
  const [busy, setBusy] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(job.name);

  // Stuck-loop detection — same pattern as V2.
  const [stuckHintShown, setStuckHintShown] = React.useState(false);
  React.useEffect(() => {
    if (job.status !== "running" && job.status !== "paused") return;
    let active = true;
    const tick = async () => {
      const s = await actionGetJobStatus(job.id);
      if (!s || !active) return;
      if (s.batchesDone !== job.batchesDone || s.status !== job.status || s.anchorsCount !== (job.anchors?.length ?? 0)) {
        router.refresh();
      }
      if (s.status === "running") {
        const heartbeatAgeMs = s.runnerHeartbeatAt == null ? null : Date.now() - s.runnerHeartbeatAt;
        const heartbeatStale = heartbeatAgeMs == null || heartbeatAgeMs > 30_000;
        if (!s.loopAlive && heartbeatStale) setStuckHintShown(true);
        else if (s.loopAlive) setStuckHintShown(false);
      } else {
        setStuckHintShown(false);
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(id); };
  }, [job.id, job.status, job.batchesDone, job.anchors?.length, router]);

  const anchors = job.anchors ?? [];

  // Keyword Group = 1-based row index of the FIRST OCCURRENCE of this anchor
  // (case-insensitive). Shares the row-index scale with the export's KEYWORD
  // GROUP helper column so the helper can be used to navigate from a duplicate
  // back to where the anchor first appeared. Identical algorithm to
  // csv_pirogi.ts so what's on screen always matches the CSV export.
  const firstIndexByLowered = React.useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < anchors.length; i++) {
      const k = anchors[i].anchorText.toLowerCase();
      if (!m.has(k)) m.set(k, i + 1);
    }
    return m;
  }, [anchors]);

  function keywordGroupFor(text: string): string {
    return `group ${firstIndexByLowered.get(text.toLowerCase()) ?? "?"}`;
  }

  const [textFilter, setTextFilter] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<AnchorCategory | "">("");
  const [pageSize, setPageSize] = React.useState<50 | 100 | 200 | 500 | 1000>(50);
  const [page, setPage] = React.useState(1);

  const filtered = React.useMemo(() => {
    const q = textFilter.trim().toLowerCase();
    return anchors.filter((a) => {
      if (categoryFilter && a.category !== categoryFilter) return false;
      if (q) {
        const hit =
          a.anchorText.toLowerCase().includes(q) ||
          a.targetUrl.toLowerCase().includes(q) ||
          (a.payloadV2?.geo ?? "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [anchors, textFilter, categoryFilter]);

  React.useEffect(() => { setPage(1); }, [textFilter, pageSize, categoryFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageAnchors = filtered.slice(start, start + pageSize);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [regenBusy, setRegenBusy] = React.useState(false);

  React.useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const visible = new Set(filtered.map((a) => a.id));
      const next = new Set<string>();
      for (const id of s) if (visible.has(id)) next.add(id);
      return next.size === s.size ? s : next;
    });
  }, [filtered]);

  const allOnPageSelected = pageAnchors.length > 0 && pageAnchors.every((a) => selected.has(a.id));
  const someOnPageSelected = pageAnchors.some((a) => selected.has(a.id));

  function toggleAnchor(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAllOnPage() {
    setSelected((s) => {
      const n = new Set(s);
      if (allOnPageSelected) for (const a of pageAnchors) n.delete(a.id);
      else for (const a of pageAnchors) n.add(a.id);
      return n;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  async function regenerateSelected() {
    if (selected.size === 0) return;
    if (!confirm(t("jobView.v2regen.confirm", { n: selected.size }))) return;
    setRegenBusy(true);
    try {
      const ids = Array.from(selected);
      const r = await actionRegeneratePirogi(job.id, ids);
      if (r.ok) {
        toast(r.message, "success");
        setSelected(new Set());
        router.refresh();
      } else {
        toast(r.message, "error");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRegenBusy(false);
    }
  }

  async function rename() {
    const v = name.trim();
    if (!v || v === job.name) { setRenaming(false); return; }
    await actionRenameJob(job.id, v);
    setRenaming(false);
    router.refresh();
  }

  async function rerun() {
    if (!confirm(t("jobView.rerunConfirm"))) return;
    setBusy(true);
    const r = await actionStartGeneration(job.id);
    setBusy(false);
    if (r.ok) toast(t("jobView.toasts.generatingInBatches", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
    else toast(r.message, "error");
    router.refresh();
  }
  async function pause() { await actionPauseGeneration(job.id); router.refresh(); toast(t("jobView.toasts.pausedToast"), "info"); }
  async function resume() {
    setBusy(true);
    const r = await actionStartGeneration(job.id, { resume: true });
    setBusy(false);
    if (r.ok) toast(t("jobView.toasts.savedResume"), "success");
    else toast(r.message, "error");
    router.refresh();
  }
  async function destroy() {
    if (!confirm(t("jobView.deleteConfirm", { name: job.name }))) return;
    await actionDeleteJob(job.id);
    router.push("/");
  }
  function exportCsv() {
    const csv = pirogiAnchorsToCsv(anchors.map((a) => ({
      targetUrl: a.targetUrl,
      anchorText: a.anchorText,
      category: a.category,
      payloadV2: a.payloadV2 ?? { linkType: "", geo: "", lang: "" },
    })));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-pirogi.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  async function copyAll() {
    const csv = pirogiAnchorsToCsv(anchors.map((a) => ({
      targetUrl: a.targetUrl,
      anchorText: a.anchorText,
      category: a.category,
      payloadV2: a.payloadV2 ?? { linkType: "", geo: "", lang: "" },
    })));
    await navigator.clipboard.writeText(csv);
    toast(t("jobView.toasts.copied"), "success");
  }

  const isRunning = job.status === "running";
  const isPaused = job.status === "paused";
  const isPartial = job.status === "partial";

  // Totals for the run-status header — total link count from Quantity, plus unique-anchor count.
  const totalQuantity = anchors.reduce((sum, a) => sum + (a.payloadV2?.quantity ?? 1), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          {renaming ? (
            <div className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="h-9 w-80" />
              <Button size="sm" onClick={rename}>{t("common.save")}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setName(job.name); setRenaming(false); }}>{t("common.cancel")}</Button>
            </div>
          ) : (
            <h1 className="text-xl font-semibold flex items-center gap-2">
              {job.name}
              <Button size="sm" variant="ghost" onClick={() => setRenaming(true)} title={t("common.rename")}>
                <Pencil className="h-3 w-3" />
              </Button>
            </h1>
          )}
          <p className="text-xs text-[var(--color-text-dim)] mt-1">
            Пироги · {job.criteria.providerId} · {job.criteria.model} · {anchors.length} {t("jobView.pirogi.uniqueAnchorsLower")} · {totalQuantity} {t("jobView.pirogi.totalLinksLower")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CostPill job={job} pricingMissing={pricingMissing} />
        </div>
        <div className="flex items-center gap-1.5">
          <Link href={`/jobs/${job.id}/edit`}>
            <Button size="sm" variant="ghost">
              <Pencil className="h-3.5 w-3.5" /> {t("common.edit")}
            </Button>
          </Link>
          <Button size="sm" variant="ghost" onClick={copyAll} disabled={anchors.length === 0}>
            <Copy className="h-3.5 w-3.5" /> {t("common.copy")}
          </Button>
          <Button size="sm" variant="ghost" onClick={exportCsv} disabled={anchors.length === 0}>
            <Download className="h-3.5 w-3.5" /> {t("common.export")}
          </Button>
          <Button size="sm" variant="ghost" onClick={destroy} title={t("common.delete")}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isRunning && !stuckHintShown && (
        <Card className="border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
          <CardBody className="flex items-start gap-3 py-3">
            <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--color-accent)]" />
            <div className="flex-1 min-w-0 text-xs text-[var(--color-text-dim)]">
              {t("jobView.runStatus.backgroundInfo")}
            </div>
          </CardBody>
        </Card>
      )}

      {isRunning && stuckHintShown && (
        <Card className="border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5">
          <CardBody className="flex items-start gap-3 py-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--color-warn)]" />
            <div className="flex-1 min-w-0 text-sm">
              <div className="font-medium">{t("jobView.runStatus.stuckTitle")}</div>
              <div className="text-xs text-[var(--color-text-dim)] mt-0.5">
                {t("jobView.runStatus.stuckBodyPre")}
                <button type="button" className="underline font-medium text-[var(--color-warn)]" onClick={resume}>
                  {t("jobView.runStatus.stuckAction")}
                </button>
                {t("jobView.runStatus.stuckBodyPost")}
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm">
              <span className="font-medium">{t(`jobStatus.${job.status}`)}</span>
              {(isRunning || isPaused) && (
                <span className="text-[var(--color-text-dim)] ml-2">
                  · {t("jobView.runStatus.progress", { done: job.batchesDone, total: job.batchesTotal, anchors: anchors.length, target: "—" })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {isRunning && (
                <Button size="sm" variant="outline" onClick={pause}>
                  <Pause className="h-3.5 w-3.5" /> {t("common.pause")}
                </Button>
              )}
              {(isPaused || isPartial) && (
                <Button size="sm" onClick={resume} disabled={busy}>
                  <Play className="h-3.5 w-3.5" /> {t("common.resume")}
                </Button>
              )}
              {!isRunning && (
                <Button size="sm" variant="outline" onClick={rerun} disabled={busy}>
                  <RefreshCw className="h-3.5 w-3.5" /> {t("common.rerunAll")}
                </Button>
              )}
            </div>
          </div>
          {job.batchesTotal > 0 && (
            <div className="h-2 bg-[var(--color-surface-2)] rounded overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)] transition-all"
                style={{ width: `${Math.min(100, (job.batchesDone / job.batchesTotal) * 100)}%` }}
              />
            </div>
          )}
          {job.lastError && (
            <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)]">
              <strong>{t("jobView.runStatus.lastError")}:</strong> {job.lastError}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("jobView.anchors.title")}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none" />
              <Input
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
                placeholder={t("jobView.anchors.filterText")}
                className="pl-8 pr-8"
              />
              {textFilter && (
                <button
                  type="button"
                  onClick={() => setTextFilter("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
                  aria-label={t("common.clear")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as AnchorCategory | "")}
              className="h-9 w-auto"
              aria-label={t("jobView.anchors.filterAnchorType")}
            >
              <option value="">{t("jobView.anchors.allAnchorTypes")}</option>
              {ANCHOR_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`form.cat.${c}` as Parameters<typeof t>[0])}</option>
              ))}
            </Select>
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-dim)]">
              <span>{t("jobsList.pageSize")}</span>
              <Select
                value={String(pageSize)}
                onChange={(e) => setPageSize(Number(e.target.value) as 50 | 100 | 200 | 500 | 1000)}
                className="h-8 w-20"
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </div>
            {selected.size > 0 && (
              <>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" onClick={clearSelection}>
                  {t("jobsList.clearSelection")}
                </Button>
                <Button size="sm" onClick={regenerateSelected} disabled={regenBusy}>
                  <Wand2 className="h-3 w-3" /> {t("jobView.v2regen.button", { n: selected.size })}
                </Button>
              </>
            )}
          </div>

          {anchors.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
              {t("jobView.anchors.empty")}
            </div>
          ) : pageAnchors.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
              {t("jobView.anchors.noMatch")}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-[var(--color-text-dim)] uppercase">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-3 py-2 text-left w-8">
                    <Checkbox
                      checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                      onCheckedChange={toggleAllOnPage}
                      aria-label={t("jobsList.selectAll")}
                    />
                  </th>
                  <th className="px-3 py-2 text-left">{t("jobView.pirogi.cols.url")}</th>
                  <th className="px-3 py-2 text-left">{t("jobView.pirogi.cols.anchor")}</th>
                  <th className="px-3 py-2 text-right w-20">{t("jobView.pirogi.cols.quantity")}</th>
                  <th className="px-3 py-2 text-left w-20">{t("jobView.pirogi.cols.language")}</th>
                  <th className="px-3 py-2 text-left w-24">{t("jobView.pirogi.cols.country")}</th>
                  <th className="px-3 py-2 text-left w-24">{t("jobView.pirogi.cols.keywordGroup")}</th>
                  <th className="px-3 py-2 text-left w-28">{t("jobView.pirogi.cols.anchorType")}</th>
                </tr>
              </thead>
              <tbody>
                {pageAnchors.map((a) => (
                  <tr
                    key={a.id}
                    className={`border-b border-[var(--color-border)] ${selected.has(a.id) ? "bg-[var(--color-accent)]/5" : "hover:bg-[var(--color-surface-2)]/40"}`}
                  >
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={selected.has(a.id)}
                        onCheckedChange={() => toggleAnchor(a.id)}
                        aria-label={`Select ${a.anchorText}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)] truncate max-w-[280px]" title={a.targetUrl}>{a.targetUrl}</td>
                    <td className="px-3 py-2">{a.anchorText}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{a.payloadV2?.quantity ?? 1}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)]">{a.payloadV2?.lang ?? ""}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)]">{a.payloadV2?.geo ?? ""}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)]">{keywordGroupFor(a.anchorText)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${categoryStyle(a.category)}`}>
                        {a.category}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {filtered.length > 0 && (
            <div className="flex items-center justify-between text-xs text-[var(--color-text-dim)]">
              <div>
                {t("jobView.anchors.pageOf", { a: start + 1, b: Math.min(start + pageSize, filtered.length), n: filtered.length })}
                {filtered.length !== anchors.length && ` ${t("jobView.anchors.filteredFrom", { total: anchors.length })}`}
              </div>
              {pageCount > 1 && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" disabled={safePage === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                    <ChevronLeft className="h-3.5 w-3.5" /> {t("jobsList.prev")}
                  </Button>
                  <span className="px-2 tabular-nums">{safePage} / {pageCount}</span>
                  <Button size="sm" variant="ghost" disabled={safePage === pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
                    {t("jobsList.next")} <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/** Category chip colors — mirrors V1's JobView.categoryStyle (per-theme CSS vars). */
function categoryStyle(c: AnchorCategory): string {
  if (c === "branded") return "bg-[var(--cat-branded-bg)] text-[var(--cat-branded-fg)]";
  if (c === "keyword") return "bg-[var(--cat-keyword-bg)] text-[var(--cat-keyword-fg)]";
  if (c === "url") return "bg-[var(--cat-url-bg)] text-[var(--cat-url-fg)]";
  return "bg-[var(--cat-generic-bg)] text-[var(--cat-generic-fg)]";
}
