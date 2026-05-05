"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import {
  actionDeleteJob,
  actionEditAnchorFollow,
  actionEditAnchorText,
  actionGetJobStatus,
  actionPauseGeneration,
  actionQuickFixRatio,
  actionRebalanceBrand,
  actionRegenerate,
  actionRenameJob,
  actionStartGeneration,
} from "@/lib/actions";
import { rowsToCsv } from "@/lib/anchors/csv";
import { brandKeyOf, brandLabelOf } from "@/lib/anchors/brands";
import type { Brand, Job, JobAnchor, AnchorCategory, FollowStatus } from "@/lib/types";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, Filter, Info, Pause, Pencil, Play, RefreshCw, Search, Settings2, Trash2, Wand2, X } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

const CATEGORIES: AnchorCategory[] = ["generic", "branded", "keyword", "url"];

function sleep(ms: number): Promise<void> {
  return new Promise<void>((res) => setTimeout(res, ms));
}

export function JobView({ job }: { job: Job }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useT();
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(job.name);

  const anchors = job.anchors ?? [];
  const ratiosOn = job.criteria.ratiosEnabled;

  // ----- Filters + pagination -----
  const [categoryFilter, setCategoryFilter] = React.useState<Set<AnchorCategory>>(new Set(CATEGORIES));
  const [textFilter, setTextFilter] = React.useState("");
  const [brandFilter, setBrandFilter] = React.useState<Set<string>>(new Set());
  const [brandPickerOpen, setBrandPickerOpen] = React.useState(false);
  const [pageSize, setPageSize] = React.useState<50 | 100 | 200 | 500 | 1000>(50);
  const [page, setPage] = React.useState(1);

  // Build brand-key list once for the filter dropdown.
  const brandKeysInData = React.useMemo(() => {
    const keys = new Set<string>();
    for (const a of anchors) keys.add(brandKeyOf(a, job.criteria.brands));
    return Array.from(keys);
  }, [anchors, job.criteria.brands]);

  // Brand filter semantic: empty set = no constraint (show all). Non-empty = show only those.
  // The picker UI treats "no constraint" and "all picked" as identical; we always store
  // the empty set when the user wants everything to keep state minimal.
  const filteredAnchors = React.useMemo(() => {
    const q = textFilter.trim().toLowerCase();
    return anchors.filter((a) => {
      if (!categoryFilter.has(a.category)) return false;
      if (brandFilter.size > 0) {
        const k = brandKeyOf(a, job.criteria.brands);
        if (!brandFilter.has(k)) return false;
      }
      if (q && !a.anchorText.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [anchors, categoryFilter, brandFilter, textFilter, job.criteria.brands]);

  const pageCount = Math.max(1, Math.ceil(filteredAnchors.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedAnchors = React.useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredAnchors.slice(start, start + pageSize);
  }, [filteredAnchors, safePage, pageSize]);

  // Reset to page 1 whenever filters or page-size change.
  React.useEffect(() => {
    setPage(1);
  }, [textFilter, pageSize, categoryFilter, brandFilter]);

  function toggleCategory(c: AnchorCategory) {
    setCategoryFilter((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  }
  function toggleBrandFilter(key: string) {
    setBrandFilter((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
  function clearFilters() {
    setCategoryFilter(new Set(CATEGORIES));
    setTextFilter("");
    setBrandFilter(new Set());
  }
  const brandFilterActive = brandFilter.size > 0;
  const filtersActive = categoryFilter.size !== CATEGORIES.length || textFilter.trim().length > 0 || brandFilterActive;

  // Live progress state — seeded from server props; refreshed by the orchestrator and polling.
  const [status, setStatus] = React.useState(job.status);
  const [batchesDone, setBatchesDone] = React.useState(job.batchesDone);
  const [batchesTotal, setBatchesTotal] = React.useState(job.batchesTotal);
  const [lastError, setLastError] = React.useState<string | null>(job.lastError);
  const [anchorsCount, setAnchorsCount] = React.useState(anchors.length);

  React.useEffect(() => {
    setStatus(job.status);
    setBatchesDone(job.batchesDone);
    setBatchesTotal(job.batchesTotal);
    setLastError(job.lastError);
    setAnchorsCount((job.anchors ?? []).length);
  }, [job]);

  const isRunning = status === "running";
  const isFailed = status === "failed" || status === "partial";
  const isPaused = status === "paused";

  // Server-side background loop drives generation. The browser is a passive viewer that
  // polls actionGetJobStatus every 2.5s while status==="running" to refresh progress.
  // Closing/refreshing the tab does NOT stop generation — the loop keeps running on the
  // server until completion, pause, or server restart.
  //
  // "Stuck" detection: if status is running but the lease heartbeat hasn't advanced in
  // 30s, the server-side loop is likely dead (server restart). Show a Resume hint.
  const [stuckHintShown, setStuckHintShown] = React.useState(false);

  React.useEffect(() => {
    if (status !== "running") { setStuckHintShown(false); return; }
    let cancelled = false;
    let lastBatchesDone = batchesDone;
    let lastAnchorsCount = anchorsCount;
    const tick = async () => {
      const snap = await actionGetJobStatus(job.id);
      if (cancelled || !snap) return;

      const advanced = snap.batchesDone !== lastBatchesDone || snap.anchorsCount !== lastAnchorsCount;
      lastBatchesDone = snap.batchesDone;
      lastAnchorsCount = snap.anchorsCount;

      setBatchesDone(snap.batchesDone);
      setAnchorsCount(snap.anchorsCount);
      setLastError(snap.lastError);

      // Status changed off "running" → propagate, refresh page so anchor table loads in full.
      if (snap.status !== status) {
        setStatus(snap.status as typeof status);
        if (snap.status === "succeeded" || snap.status === "partial" || snap.status === "failed") {
          router.refresh();
        }
      }

      // Stuck detection: status=running, server reports no live loop, AND heartbeat is stale
      // (or never existed). This catches "server restarted mid-run" without false-firing on
      // the brief gap between Resume and the first heartbeat.
      const heartbeatAgeMs = snap.runnerHeartbeatAt == null ? null : Date.now() - snap.runnerHeartbeatAt;
      const heartbeatStale = heartbeatAgeMs == null || heartbeatAgeMs > 30_000;
      if (!advanced && !snap.loopAlive && heartbeatStale) {
        setStuckHintShown(true);
      } else if (advanced || snap.loopAlive) {
        setStuckHintShown(false);
      }
    };
    void tick(); // immediate first poll
    const id = window.setInterval(tick, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, job.id]);

  async function pause() {
    await actionPauseGeneration(job.id);
    setStatus("paused");
    toast(t("jobView.toasts.pausedToast"), "info");
    router.refresh();
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    // Operates on the filtered set so users can "select all branded matching X" easily.
    const allFilteredSelected = filteredAnchors.length > 0 && filteredAnchors.every((a) => selected.has(a.id));
    if (allFilteredSelected) {
      setSelected((s) => {
        const n = new Set(s);
        for (const a of filteredAnchors) n.delete(a.id);
        return n;
      });
    } else {
      setSelected((s) => {
        const n = new Set(s);
        for (const a of filteredAnchors) n.add(a.id);
        return n;
      });
    }
  }

  async function rerun() {
    if (!confirm(t("jobView.rerunConfirm"))) return;
    setBusy(true);
    const r = await actionStartGeneration(job.id);
    if (r.ok) {
      setStatus("running");
      setBatchesTotal(r.batchesTotal);
      setBatchesDone(0);
      setAnchorsCount(0);
      setLastError(null);
      toast(t("jobView.toasts.generatingInBatches", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
    } else {
      toast(r.message, "error");
    }
    setBusy(false);
    router.refresh();
  }

  async function resume() {
    setBusy(true);
    const r = await actionStartGeneration(job.id, { resume: true });
    if (r.ok) {
      setStatus("running");
      setLastError(null);
    } else {
      toast(r.message, "error");
    }
    setBusy(false);
  }

  async function regenSelected() {
    if (selected.size === 0) return;
    setBusy(true);
    const r = await actionRegenerate(job.id, Array.from(selected));
    toast(r.message, r.ok ? "success" : "error");
    setBusy(false);
    setSelected(new Set());
    router.refresh();
  }

  async function quickFix() {
    setBusy(true);
    const r = await actionQuickFixRatio(job.id);
    toast(r.message, r.ok ? "success" : "error");
    setBusy(false);
    router.refresh();
  }

  async function saveEdit() {
    if (!editing) return;
    await actionEditAnchorText(job.id, editing.id, editing.text);
    setEditing(null);
    router.refresh();
  }

  async function changeFollow(id: string, follow: FollowStatus) {
    await actionEditAnchorFollow(job.id, id, follow);
    router.refresh();
  }

  function exportCsv() {
    const headers = ratiosOn ? ["Target URL", "Follow", "Anchor", "Category"] : ["Target URL", "Anchor", "Category"];
    const data = anchors.map((a) => {
      const base: Record<string, string> = { "Target URL": a.targetUrl, Anchor: a.anchorText, Category: a.category };
      if (ratiosOn) base.Follow = a.followStatus ?? "";
      return base;
    });
    const csv = rowsToCsv(data, headers);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job.name.replace(/[^a-z0-9-_]+/gi, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyTable() {
    const lines = anchors.map((a) =>
      ratiosOn
        ? `${a.targetUrl}\t${a.followStatus ?? ""}\t${a.anchorText}`
        : `${a.targetUrl}\t${a.anchorText}`
    );
    navigator.clipboard.writeText(lines.join("\n"));
    toast(t("jobView.toasts.copied"), "success");
  }

  async function saveRename() {
    if (!name.trim() || name === job.name) {
      setRenaming(false);
      return;
    }
    await actionRenameJob(job.id, name.trim());
    setRenaming(false);
    router.refresh();
  }

  async function deleteJob() {
    if (!confirm(t("jobView.deleteConfirm", { name: job.name }))) return;
    await actionDeleteJob(job.id);
    router.push("/");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {renaming ? (
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="text-lg font-semibold h-10" />
              <Button onClick={saveRename}>{t("common.save")}</Button>
              <Button variant="ghost" onClick={() => { setName(job.name); setRenaming(false); }}>{t("common.cancel")}</Button>
            </div>
          ) : (
            <h1
              className="text-xl font-semibold cursor-pointer hover:text-[var(--color-text-dim)] inline-flex items-center gap-2"
              onClick={() => setRenaming(true)}
              title={t("common.rename")}
            >
              {job.name}
              <Pencil className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
            </h1>
          )}
          <p className="text-xs text-[var(--color-text-dim)] mt-1">
            {t(job.mode === "one_site" ? "modes.one_site" : "modes.multi_site")} ·{" "}
            {anchors.length} {t("jobsList.columns.anchors").toLowerCase()} · {job.criteria.providerId} / {job.criteria.model}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link href={`/jobs/${job.id}/edit`}>
            <Button variant="outline" disabled={isRunning}>
              <Settings2 className="h-3.5 w-3.5" /> {t("jobView.editJob")}
            </Button>
          </Link>
          {isRunning ? (
            <Button variant="outline" onClick={pause}>
              <Pause className="h-3.5 w-3.5" /> {t("common.pause")}
            </Button>
          ) : isPaused ? (
            <Button onClick={resume} disabled={busy}>
              <Play className="h-3.5 w-3.5" /> {t("common.resume")}
            </Button>
          ) : (
            <Button variant="outline" onClick={rerun} disabled={busy}>
              <RefreshCw className="h-3.5 w-3.5" /> {t("common.rerunAll")}
            </Button>
          )}
          <Button variant="ghost" onClick={deleteJob} disabled={isRunning}>
            <Trash2 className="h-3.5 w-3.5" /> {t("common.delete")}
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

      <RunStatusPanel
        status={status}
        batchesDone={batchesDone}
        batchesTotal={batchesTotal}
        anchorsCount={anchorsCount}
        lastError={lastError}
        targetTotal={(job.inputs ?? []).length}
        onResume={resume}
        onClearError={() => setLastError(null)}
        canResume={(isFailed || isPaused) && batchesDone < batchesTotal}
      />

      <ComparisonPanel job={job} />

      <Card>
        <CardHeader className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle>{t("jobView.anchors.title")}</CardTitle>
            <CardDescription>{t("jobView.anchors.desc")}</CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {ratiosOn && (
              <Button variant="outline" size="sm" onClick={quickFix} disabled={busy} title={t("jobView.anchors.quickFixHint")}>
                <Wand2 className="h-3.5 w-3.5" /> {t("jobView.anchors.quickFix")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={regenSelected} disabled={busy || selected.size === 0}>
              <RefreshCw className="h-3.5 w-3.5" /> {t("jobView.anchors.regenerate", { n: selected.size })}
            </Button>
            <Button variant="ghost" size="sm" onClick={copyTable}>
              <Copy className="h-3.5 w-3.5" /> {t("common.copy")}
            </Button>
            <Button variant="ghost" size="sm" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" /> {t("common.export")}
            </Button>
          </div>
        </CardHeader>
        {anchors.length > 0 && (
          <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 text-xs">
              <Filter className="h-3.5 w-3.5 text-[var(--color-text-dim)]" />
              <span className="text-[var(--color-text-dim)] mr-1">{t("jobView.anchors.filterCategory")}</span>
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCategory(c)}
                  className={`px-2 py-1 rounded text-[10px] uppercase tracking-wide transition-colors ${categoryFilter.has(c) ? categoryStyle(c) : "bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"}`}
                >
                  {c}
                </button>
              ))}
            </div>
            {job.mode === "multi_site" && brandKeysInData.length > 1 && (
              <BrandFilterPicker
                allKeys={brandKeysInData}
                selected={brandFilter}
                brands={job.criteria.brands}
                onToggle={toggleBrandFilter}
                onSelectAll={() => setBrandFilter(new Set())}
                open={brandPickerOpen}
                setOpen={setBrandPickerOpen}
              />
            )}
            <div className="flex items-center gap-1.5 flex-1 min-w-[180px] max-w-md">
              <Search className="h-3.5 w-3.5 text-[var(--color-text-dim)]" />
              <Input
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
                placeholder={t("jobView.anchors.filterText")}
                className="h-8 text-xs"
              />
            </div>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] inline-flex items-center gap-1"
              >
                <X className="h-3 w-3" /> {t("jobView.anchors.clearFilters")}
              </button>
            )}
            <div className="ml-auto flex items-center gap-1.5 text-xs">
              <span className="text-[var(--color-text-dim)]">{t("common.perPage")}:</span>
              <Select
                value={String(pageSize)}
                onChange={(e) => setPageSize(Number(e.target.value) as 50 | 100 | 200 | 500 | 1000)}
                className="h-8 w-20 text-xs"
              >
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
              </Select>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-text-dim)] uppercase">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-3 text-left w-8">
                  <Checkbox
                    checked={filteredAnchors.length > 0 && filteredAnchors.every((a) => selected.has(a.id))}
                    onCheckedChange={toggleAll}
                  />
                </th>
                <th className="px-4 py-3 text-left">{t("jobView.anchors.colTargetUrl")}</th>
                {ratiosOn && <th className="px-4 py-3 text-left w-32">{t("jobView.anchors.colFollow")}</th>}
                <th className="px-4 py-3 text-left w-28">{t("jobView.anchors.colCategory")}</th>
                <th className="px-4 py-3 text-left">{t("jobView.anchors.colAnchor")}</th>
              </tr>
            </thead>
            <tbody>
              {pagedAnchors.map((a) => (
                <AnchorRow
                  key={a.id}
                  a={a}
                  brands={job.criteria.brands}
                  ratiosOn={ratiosOn}
                  selected={selected.has(a.id)}
                  onToggle={() => toggle(a.id)}
                  onEdit={() => setEditing({ id: a.id, text: a.anchorText })}
                  onChangeFollow={(f) => changeFollow(a.id, f)}
                />
              ))}
              {anchors.length === 0 && (
                <tr>
                  <td colSpan={ratiosOn ? 5 : 4} className="px-4 py-8 text-center text-[var(--color-text-dim)] text-sm">
                    {t("jobView.anchors.empty")}
                  </td>
                </tr>
              )}
              {anchors.length > 0 && filteredAnchors.length === 0 && (
                <tr>
                  <td colSpan={ratiosOn ? 5 : 4} className="px-4 py-8 text-center text-[var(--color-text-dim)] text-sm">
                    {t("jobView.anchors.noMatch")}{" "}
                    <button onClick={clearFilters} className="text-[var(--color-accent)] hover:underline">
                      {t("jobView.anchors.clearFilters")}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filteredAnchors.length > 0 && (
          <div className="px-5 py-3 border-t border-[var(--color-border)] flex items-center justify-between text-xs">
            <div className="text-[var(--color-text-dim)]">
              {t("common.showing")}{" "}
              <span className="text-[var(--color-text)] font-medium">
                {t("jobView.anchors.pageOf", { a: (safePage - 1) * pageSize + 1, b: Math.min(safePage * pageSize, filteredAnchors.length), n: filteredAnchors.length })}
              </span>
              {filteredAnchors.length !== anchors.length && (
                <span className="text-[var(--color-text-faint)]"> {t("jobView.anchors.filteredFrom", { total: anchors.length })}</span>
              )}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
                  <ChevronLeft className="h-3.5 w-3.5" /> {t("common.prev")}
                </Button>
                <span className="font-mono">
                  {safePage} / {pageCount}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={safePage >= pageCount}>
                  {t("common.next")} <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("jobView.edit.anchorTitle")}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <Input
                value={editing.text}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                <Button onClick={saveEdit}>{t("common.save")}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AnchorRow({
  a,
  brands,
  ratiosOn,
  selected,
  onToggle,
  onEdit,
  onChangeFollow,
}: {
  a: JobAnchor;
  brands: Brand[];
  ratiosOn: boolean;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onChangeFollow: (f: FollowStatus) => void;
}) {
  const brandLabel = a.brandId ? brandLabelOf(a.brandId, brands) : null;
  return (
    <tr className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/50">
      <td className="px-4 py-2">
        <Checkbox checked={selected} onCheckedChange={onToggle} />
      </td>
      <td className="px-4 py-2 font-mono text-xs max-w-md truncate" title={a.targetUrl}>
        {a.targetUrl}
        {brandLabel && <div className="text-[10px] text-[var(--color-text-faint)] truncate">{brandLabel}</div>}
      </td>
      {ratiosOn && (
        <td className="px-4 py-2">
          <Select
            value={a.followStatus ?? "dofollow"}
            onChange={(e) => onChangeFollow(e.target.value as FollowStatus)}
            className="h-7 text-xs"
          >
            <option value="dofollow">dofollow</option>
            <option value="nofollow">nofollow</option>
          </Select>
        </td>
      )}
      <td className="px-4 py-2">
        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${categoryStyle(a.category)}`}>
          {a.category}
        </span>
      </td>
      <td className="px-4 py-2">
        <button
          className="text-left hover:text-[var(--color-accent)] transition-colors flex items-center gap-1.5 group"
          onClick={onEdit}
        >
          <span>{a.anchorText}</span>
          {a.manuallyEdited === 1 && <span className="text-[9px] text-[var(--color-text-faint)]">(edited)</span>}
          <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100 text-[var(--color-text-faint)]" />
        </button>
      </td>
    </tr>
  );
}

function categoryStyle(c: AnchorCategory): string {
  if (c === "branded") return "bg-[var(--cat-branded-bg)] text-[var(--cat-branded-fg)]";
  if (c === "keyword") return "bg-[var(--cat-keyword-bg)] text-[var(--cat-keyword-fg)]";
  if (c === "url") return "bg-[var(--cat-url-bg)] text-[var(--cat-url-fg)]";
  return "bg-[var(--cat-generic-bg)] text-[var(--cat-generic-fg)]";
}

function RebalanceProgress({
  progress,
  onCancel,
  cancelled,
}: {
  progress: { current: number; total: number; brand: string; succeeded: number; failed: number; startedAt: number };
  onCancel: () => void;
  cancelled: boolean;
}) {
  const { t } = useT();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.max(0, now - progress.startedAt);
  const completed = progress.succeeded + progress.failed;
  const pct = progress.total > 0 ? Math.round((completed / progress.total) * 100) : 0;
  const avgPerBrand = completed > 0 ? elapsed / completed : 0;
  const remaining = Math.max(0, progress.total - completed);
  const etaMs = avgPerBrand > 0 ? remaining * avgPerBrand : 0;

  return (
    <div className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {cancelled ? t("jobView.rebalance.progressStopping") : t("jobView.rebalance.progressTitle", { current: progress.current, total: progress.total })}
          </div>
          <div className="text-xs text-[var(--color-text-dim)] mt-0.5 truncate">
            {t("jobView.rebalance.progressCurrent")} <span className="text-[var(--color-text)] font-mono">{progress.brand}</span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={cancelled}>
          {cancelled ? t("jobView.rebalance.stopping") : t("jobView.rebalance.stopBtn")}
        </Button>
      </div>
      <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
        <div className="h-full bg-[var(--color-accent)] transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-[var(--color-text-dim)] flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span><span className="text-[var(--color-success)]">✓</span> {t("jobView.rebalance.done", { n: progress.succeeded })}</span>
          {progress.failed > 0 && <span><span className="text-[var(--color-danger)]">✕</span> {t("jobView.rebalance.failed", { n: progress.failed })}</span>}
          <span>{t("jobView.rebalance.remaining", { n: remaining })}</span>
        </div>
        <div className="flex items-center gap-3">
          <span>{t("jobView.rebalance.elapsed", { t: formatDuration(elapsed) })}</span>
          {etaMs > 0 && remaining > 0 && <span>{t("jobView.rebalance.eta", { t: formatDuration(etaMs) })}</span>}
        </div>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function BrandFilterPicker({
  allKeys,
  selected,
  brands,
  onToggle,
  onSelectAll,
  open,
  setOpen,
}: {
  allKeys: string[];
  selected: Set<string>;
  brands: Brand[];
  onToggle: (k: string) => void;
  onSelectAll: () => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { t } = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, setOpen]);

  // Empty selected = no filter (show everything). Non-empty = show only those.
  const showingAll = selected.size === 0;
  const label =
    showingAll
      ? t("jobView.anchors.allSites")
      : selected.size === 1
        ? brandLabelOf(Array.from(selected)[0], brands)
        : t("jobView.anchors.ofSites", { n: selected.size, total: allKeys.length });

  const filteredKeys = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allKeys;
    return allKeys.filter((k) => brandLabelOf(k, brands).toLowerCase().includes(q));
  }, [allKeys, search, brands]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs transition-colors border ${
          showingAll
            ? "bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] border-[var(--color-border)]"
            : "bg-[var(--color-accent)]/10 border-[var(--color-accent)]/40 text-[var(--color-text)]"
        }`}
      >
        <span className="text-[var(--color-text-dim)]">{t("jobView.anchors.site")}</span>
        <span className="text-[var(--color-text)] font-medium max-w-[140px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 text-[var(--color-text-faint)]" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-1">
          <div className="px-2 py-1.5 border-b border-[var(--color-border)] mb-1 space-y-1.5">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("jobView.anchors.siteSearchPlaceholder")}
              className="h-7 text-xs"
              autoFocus
            />
            <button
              onClick={onSelectAll}
              className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
            >
              {t("jobView.anchors.siteResetAll")}
            </button>
          </div>
          <div className="max-h-64 overflow-auto">
            {filteredKeys.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-faint)] text-center">{t("jobView.anchors.noSitesMatch")}</div>
            ) : (
              filteredKeys.map((k) => {
                const isOn = selected.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onToggle(k)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] text-left text-xs"
                  >
                    <span className={`inline-block w-3.5 h-3.5 rounded border flex-shrink-0 ${isOn ? "bg-[var(--color-accent)] border-[var(--color-accent)]" : "border-[var(--color-border-strong)]"} flex items-center justify-center`}>
                      {isOn && <span className="text-white text-[8px] leading-none">✓</span>}
                    </span>
                    <span className="truncate flex-1">{brandLabelOf(k, brands)}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ComparisonPanel({ job }: { job: Job }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useT();
  const anchors = job.anchors ?? [];
  const c = job.criteria;

  const [selectedBrands, setSelectedBrands] = React.useState<Set<string>>(new Set());
  const [rebalanceOpen, setRebalanceOpen] = React.useState(false);
  const [rebalanceMode, setRebalanceMode] = React.useState<"replace_ai" | "surgical">("surgical");
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{
    current: number;
    total: number;
    brand: string;
    succeeded: number;
    failed: number;
    startedAt: number;
  } | null>(null);
  const cancelRebalanceRef = React.useRef(false);
  const [rebalanceCancelling, setRebalanceCancelling] = React.useState(false);

  function cancelRebalance() {
    cancelRebalanceRef.current = true;
    setRebalanceCancelling(true);
  }

  const groups = React.useMemo(() => {
    const map = new Map<string, JobAnchor[]>();
    if (job.mode === "one_site") {
      map.set("__all__", anchors);
    } else {
      for (const a of anchors) {
        const k = brandKeyOf(a, c.brands);
        const list = map.get(k) ?? [];
        list.push(a);
        map.set(k, list);
      }
    }
    return map;
  }, [anchors, c.brands, job.mode]);

  if (anchors.length === 0) return null;

  function toggleBrand(key: string) {
    setSelectedBrands((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  function toggleAllBrands() {
    if (selectedBrands.size === groups.size) setSelectedBrands(new Set());
    else setSelectedBrands(new Set(groups.keys()));
  }

  async function runRebalance() {
    const keys = Array.from(selectedBrands);
    if (keys.length === 0) return;
    setRebalanceOpen(false);
    setRunning(true);
    cancelRebalanceRef.current = false;
    setRebalanceCancelling(false);
    const startedAt = Date.now();
    let succeeded = 0;
    let failed = 0;
    let stoppedEarly = false;
    for (let i = 0; i < keys.length; i++) {
      if (cancelRebalanceRef.current) {
        stoppedEarly = true;
        break;
      }
      const key = keys[i];
      setProgress({
        current: i + 1,
        total: keys.length,
        brand: brandLabelOf(key, c.brands),
        succeeded,
        failed,
        startedAt,
      });
      const r = await actionRebalanceBrand(job.id, key, { mode: rebalanceMode });
      if (r.ok) succeeded += 1;
      else {
        failed += 1;
        toast(`${brandLabelOf(key, c.brands)}: ${r.message}`, "error");
      }
      setProgress((p) => (p ? { ...p, succeeded, failed } : p));
      if (cancelRebalanceRef.current) {
        stoppedEarly = true;
        break;
      }
      // brief pause between brands to be polite to rate limits
      if (i + 1 < keys.length) await sleep(1200);
    }
    setRunning(false);
    setProgress(null);
    setRebalanceCancelling(false);
    setSelectedBrands(new Set());
    const summary = `${t("jobView.rebalance.summarySucc", { n: succeeded, plural: succeeded === 1 ? "" : "s" })}${failed > 0 ? ` ${t("jobView.rebalance.summaryFail", { n: failed })}` : ""}${stoppedEarly ? ` ${t("jobView.rebalance.summaryStopped")}` : ""}.`;
    toast(summary, failed === 0 && !stoppedEarly ? "success" : "info");
    router.refresh();
  }

  const overall = stats(anchors);
  const allSelected = groups.size > 0 && selectedBrands.size === groups.size;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <CardTitle>{t("jobView.comparison.title")}</CardTitle>
          <CardDescription>
            {job.mode === "multi_site" ? t("jobView.comparison.descMulti") : t("jobView.comparison.descSingle")}
          </CardDescription>
        </div>
        {job.mode === "multi_site" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRebalanceOpen(true)}
              disabled={selectedBrands.size === 0 || running}
            >
              <Wand2 className="h-3.5 w-3.5" /> {t("jobView.comparison.rebalance")} ({selectedBrands.size})
            </Button>
          </div>
        )}
      </CardHeader>
      <CardBody className="space-y-4">
        {running && progress && (
          <RebalanceProgress progress={progress} onCancel={cancelRebalance} cancelled={rebalanceCancelling} />
        )}
        {job.mode === "multi_site" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-[var(--color-text-dim)] uppercase">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-3 py-2 text-left w-8">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAllBrands} />
                  </th>
                  <th className="px-3 py-2 text-left">{t("jobView.comparison.brand")}</th>
                  <th className="px-3 py-2 text-right">{t("jobView.comparison.count")}</th>
                  {c.ratiosEnabled && <th className="px-3 py-2 text-right">{t("jobView.comparison.dofollow")}</th>}
                  <th className="px-3 py-2 text-right">{t("jobView.comparison.generic")}</th>
                  <th className="px-3 py-2 text-right">{t("jobView.comparison.branded")}</th>
                  <th className="px-3 py-2 text-right">{t("jobView.comparison.keyword")}</th>
                  <th className="px-3 py-2 text-right">{t("jobView.comparison.url")}</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(groups.entries()).map(([key, list]) => {
                  const s = stats(list);
                  const label = brandLabelOf(key, c.brands);
                  const checked = selectedBrands.has(key);
                  return (
                    <tr key={key} className={`border-b border-[var(--color-border)] ${checked ? "bg-[var(--color-accent)]/5" : ""}`}>
                      <td className="px-3 py-2">
                        <Checkbox checked={checked} onCheckedChange={() => toggleBrand(key)} />
                      </td>
                      <td className="px-3 py-2 truncate max-w-xs">{label}</td>
                      <td className="px-3 py-2 text-right font-mono">{list.length}</td>
                      {c.ratiosEnabled && (
                        <td className="px-3 py-2 text-right font-mono">
                          <Cell actual={s.dofollowPct} target={c.dofollowPct} />
                        </td>
                      )}
                      <td className="px-3 py-2 text-right font-mono"><Cell actual={s.generic} target={c.distribution.generic} /></td>
                      <td className="px-3 py-2 text-right font-mono"><Cell actual={s.branded} target={c.distribution.branded} /></td>
                      <td className="px-3 py-2 text-right font-mono"><Cell actual={s.keyword} target={c.distribution.keyword} /></td>
                      <td className="px-3 py-2 text-right font-mono"><Cell actual={s.url} target={c.distribution.url} /></td>
                    </tr>
                  );
                })}
                <tr className="bg-[var(--color-surface-2)]/40">
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 font-medium">{t("jobView.comparison.overall")}</td>
                  <td className="px-3 py-2 text-right font-mono">{anchors.length}</td>
                  {c.ratiosEnabled && (
                    <td className="px-3 py-2 text-right font-mono">
                      <Cell actual={overall.dofollowPct} target={c.dofollowPct} />
                    </td>
                  )}
                  <td className="px-3 py-2 text-right font-mono"><Cell actual={overall.generic} target={c.distribution.generic} /></td>
                  <td className="px-3 py-2 text-right font-mono"><Cell actual={overall.branded} target={c.distribution.branded} /></td>
                  <td className="px-3 py-2 text-right font-mono"><Cell actual={overall.keyword} target={c.distribution.keyword} /></td>
                  <td className="px-3 py-2 text-right font-mono"><Cell actual={overall.url} target={c.distribution.url} /></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {job.mode === "one_site" && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {c.ratiosEnabled && (
              <Stat label={t("jobView.comparison.dofollow")} actual={overall.dofollowPct} target={c.dofollowPct} unit="%" />
            )}
            <Stat label={t("jobView.comparison.generic")} actual={overall.generic} target={c.distribution.generic} unit="%" />
            <Stat label={t("jobView.comparison.branded")} actual={overall.branded} target={c.distribution.branded} unit="%" />
            <Stat label={t("jobView.comparison.keyword")} actual={overall.keyword} target={c.distribution.keyword} unit="%" />
            <Stat label={t("jobView.comparison.url")} actual={overall.url} target={c.distribution.url} unit="%" />
          </div>
        )}
      </CardBody>

      <Dialog open={rebalanceOpen} onOpenChange={setRebalanceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("jobView.rebalance.title", { n: selectedBrands.size, plural: selectedBrands.size === 1 ? "" : "s" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-[var(--color-text-dim)]">{t("jobView.rebalance.hint")}</p>
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer rounded-md border border-[var(--color-border)] p-3 hover:bg-[var(--color-surface-2)]/50 transition-colors">
                <input
                  type="radio"
                  checked={rebalanceMode === "surgical"}
                  onChange={() => setRebalanceMode("surgical")}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">{t("jobView.rebalance.modeSurgicalTitle")}</div>
                  <div className="text-xs text-[var(--color-text-dim)]">{t("jobView.rebalance.modeSurgicalDesc")}</div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer rounded-md border border-[var(--color-border)] p-3 hover:bg-[var(--color-surface-2)]/50 transition-colors">
                <input
                  type="radio"
                  checked={rebalanceMode === "replace_ai"}
                  onChange={() => setRebalanceMode("replace_ai")}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">{t("jobView.rebalance.modeReplaceTitle")}</div>
                  <div className="text-xs text-[var(--color-text-dim)]">{t("jobView.rebalance.modeReplaceDesc")}</div>
                </div>
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="ghost" onClick={() => setRebalanceOpen(false)}>{t("common.cancel")}</Button>
              <Button onClick={runRebalance}>{t("jobView.rebalance.run")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Stat({ label, actual, target, unit }: { label: string; actual: number; target: number; unit?: string }) {
  const diff = actual - target;
  const tone = Math.abs(diff) <= 5 ? "text-[var(--color-success)]" : Math.abs(diff) <= 15 ? "text-[var(--color-warn)]" : "text-[var(--color-danger)]";
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-dim)]">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold">{actual}{unit}</span>
        <span className="text-xs text-[var(--color-text-faint)]">/ {target}{unit}</span>
      </div>
      <div className={`text-xs ${tone}`}>{diff === 0 ? "on target" : `${diff > 0 ? "+" : ""}${diff}${unit ?? ""}`}</div>
    </div>
  );
}

function Cell({ actual, target }: { actual: number; target: number }) {
  const diff = Math.abs(actual - target);
  let cls: string;
  if (diff <= 5) {
    cls = "text-[var(--color-success)]";
  } else if (diff <= 15) {
    cls = "inline-block px-1.5 py-0.5 rounded font-semibold bg-[var(--color-warn)]/15 text-[var(--color-warn)]";
  } else {
    cls = "inline-block px-1.5 py-0.5 rounded font-semibold bg-[var(--color-danger)]/15 text-[var(--color-danger)]";
  }
  return (
    <span className={cls}>
      {actual}% <span className="text-[var(--color-text-faint)] font-normal">/ {target}%</span>
    </span>
  );
}

function stats(list: JobAnchor[]): { generic: number; branded: number; keyword: number; url: number; dofollowPct: number } {
  const total = list.length || 1;
  const g = list.filter((a) => a.category === "generic").length;
  const b = list.filter((a) => a.category === "branded").length;
  const k = list.filter((a) => a.category === "keyword").length;
  const u = list.filter((a) => a.category === "url").length;
  const dof = list.filter((a) => a.followStatus === "dofollow").length;
  return {
    generic: Math.round((g / total) * 100),
    branded: Math.round((b / total) * 100),
    keyword: Math.round((k / total) * 100),
    url: Math.round((u / total) * 100),
    dofollowPct: Math.round((dof / total) * 100),
  };
}

function RunStatusPanel({
  status,
  batchesDone,
  batchesTotal,
  anchorsCount,
  lastError,
  targetTotal,
  onResume,
  onClearError,
  canResume,
}: {
  status: string;
  batchesDone: number;
  batchesTotal: number;
  anchorsCount: number;
  lastError: string | null;
  targetTotal: number;
  onResume: () => void;
  onClearError: () => void;
  canResume: boolean;
}) {
  const { t } = useT();
  const showProgress = status === "running" || (status !== "succeeded" && status !== "idle" && batchesTotal > 0);
  if (!showProgress && !lastError) return null;

  const pct = batchesTotal > 0 ? Math.round((batchesDone / batchesTotal) * 100) : 0;

  const tone =
    status === "running" ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5" :
    status === "paused" ? "border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5" :
    status === "failed" ? "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5" :
    status === "partial" ? "border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5" :
    status === "cancelled" ? "border-[var(--color-border)] bg-[var(--color-surface)]" :
    "border-[var(--color-border)]";

  const label =
    status === "running" ? t("jobView.runStatus.generating") :
    status === "paused" ? t("jobView.runStatus.paused") :
    status === "failed" ? t("jobView.runStatus.failed") :
    status === "partial" ? t("jobView.runStatus.partial") :
    status === "cancelled" ? t("jobView.runStatus.cancelled") :
    status;

  return (
    <Card className={tone}>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {(status === "failed" || status === "partial") && (
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-[var(--color-warn)]" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-[var(--color-text-dim)]">
                {t("jobView.runStatus.progress", { done: batchesDone, total: batchesTotal, anchors: anchorsCount, target: targetTotal })}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canResume && (
              <Button variant="outline" size="sm" onClick={onResume}>
                <RefreshCw className="h-3.5 w-3.5" /> {t("common.resume")}
              </Button>
            )}
          </div>
        </div>
        <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
          <div
            className={`h-full transition-all ${status === "running" ? "bg-[var(--color-accent)]" : status === "failed" ? "bg-[var(--color-danger)]" : status === "partial" ? "bg-[var(--color-warn)]" : "bg-[var(--color-success)]"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {lastError && (
          <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)] flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium mb-0.5">{t("jobView.runStatus.lastError")}</div>
              <div className="font-mono break-all whitespace-pre-wrap">{lastError}</div>
            </div>
            <button
              onClick={onClearError}
              className="text-[var(--color-text-faint)] hover:text-[var(--color-text)] flex-shrink-0"
              aria-label={t("jobView.runStatus.dismiss")}
              type="button"
            >
              ×
            </button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
