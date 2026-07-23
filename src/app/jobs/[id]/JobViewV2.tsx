"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import {
  actionDeleteJob,
  actionGetJobStatus,
  actionPauseGeneration,
  actionRebalanceV2Row,
  actionRegenerateV2,
  actionRenameJob,
  actionStartGeneration,
} from "@/lib/actions";
import type { RebalanceMode } from "@/lib/anchors/rebalance";
import { v2AnchorsToCsv } from "@/lib/anchors/csv_v2";
import { CostPill } from "@/components/CostPill";
import { ANCHOR_CATEGORIES, type AnchorCategory, type Job, type JobAnchor, type JobInput } from "@/lib/types";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, Info, Pause, Pencil, Play, RefreshCw, Search, Trash2, Wand2, X } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

const POLL_INTERVAL_MS = 2500;
const PAGE_SIZES: ReadonlyArray<50 | 100 | 200 | 500 | 1000> = [50, 100, 200, 500, 1000];

/**
 * V2 Job View — leaner than V1. No comparison panel, no rebalance, no quick-fix,
 * no regenerate (yet). Just: job header, run status, and an anchors table with
 * the five V2 columns (URL, Type, Anchor, GEO, Lang).
 */
export function JobViewV2({ job, pricingMissing = false }: { job: Job; pricingMissing?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useT();
  const [busy, setBusy] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(job.name);

  // Server-side loop polls every 2.5s while running/paused — same pattern as V1.
  // We also detect "stuck running" — when status='running' but the server-side loop is
  // gone (e.g. server restart) AND the runner heartbeat is stale > 30s. The visible
  // alternative is waiting for reconcileStuckRunningJobs to fire on a Library load
  // (5min cutoff), which is much worse UX.
  const [stuckHintShown, setStuckHintShown] = React.useState(false);
  React.useEffect(() => {
    if (job.status !== "running" && job.status !== "paused") return;
    let active = true;
    const tick = async () => {
      const s = await actionGetJobStatus(job.id);
      if (!s || !active) return;
      // Refetch the whole job when the snapshot shows progress / new anchors. Cheaper
      // than refetching every poll: we only re-fetch when something visible changed.
      if (s.batchesDone !== job.batchesDone || s.status !== job.status || s.anchorsCount !== (job.anchors?.length ?? 0)) {
        router.refresh();
      }
      // Stuck-loop check: only meaningful while we still think the job is running.
      // The 30s grace prevents a false positive between Resume click and the first
      // heartbeat after the loop respawns.
      if (s.status === "running") {
        const heartbeatAgeMs = s.runnerHeartbeatAt == null ? null : Date.now() - s.runnerHeartbeatAt;
        const heartbeatStale = heartbeatAgeMs == null || heartbeatAgeMs > 30_000;
        if (!s.loopAlive && heartbeatStale) setStuckHintShown(true);
        else if (s.loopAlive) setStuckHintShown(false);
      } else {
        setStuckHintShown(false);
      }
    };
    void tick(); // immediate first poll so the banner appears within ~0s after page load on a stuck job
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(id); };
  }, [job.id, job.status, job.batchesDone, job.anchors?.length, router]);

  const anchors = job.anchors ?? [];

  // Filters: text search + link-type + anchor-type (category) + pagination.
  const [textFilter, setTextFilter] = React.useState("");
  const [linkTypeFilter, setLinkTypeFilter] = React.useState<string>("");
  const [categoryFilter, setCategoryFilter] = React.useState<AnchorCategory | "">("");
  const [pageSize, setPageSize] = React.useState<50 | 100 | 200 | 500 | 1000>(50);
  const [page, setPage] = React.useState(1);

  // Distinct link types present in this job's anchors — drives the Link type dropdown.
  const linkTypeOptions = React.useMemo(() => {
    const s = new Set<string>();
    for (const a of anchors) {
      const lt = a.payloadV2?.linkType ?? "";
      if (lt) s.add(lt);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [anchors]);

  // If a rerun changed the available link types, drop a now-invalid selection so the
  // table doesn't silently show zero rows against a stale filter value.
  React.useEffect(() => {
    if (linkTypeFilter && !linkTypeOptions.includes(linkTypeFilter)) setLinkTypeFilter("");
  }, [linkTypeOptions, linkTypeFilter]);

  // Selection state for the Regenerate flow. Set of anchor ids.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [regenBusy, setRegenBusy] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = textFilter.trim().toLowerCase();
    return anchors.filter((a) => {
      if (linkTypeFilter && (a.payloadV2?.linkType ?? "") !== linkTypeFilter) return false;
      if (categoryFilter && a.category !== categoryFilter) return false;
      if (q) {
        const hit =
          a.anchorText.toLowerCase().includes(q) ||
          a.targetUrl.toLowerCase().includes(q) ||
          (a.payloadV2?.linkType ?? "").toLowerCase().includes(q) ||
          (a.payloadV2?.geo ?? "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [anchors, textFilter, linkTypeFilter, categoryFilter]);

  React.useEffect(() => { setPage(1); }, [textFilter, pageSize, linkTypeFilter, categoryFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageAnchors = filtered.slice(start, start + pageSize);

  // Drop selections that are no longer in the filtered view (e.g. text filter narrowed).
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

  // ----- Rebalance state + sequential runner -----
  // `pendingTargets` = rows picked from the overview, dialog is open while non-null.
  // `progress` = active runner state (one row at a time); null when idle.
  // `stopRef` lets the user request a graceful stop without unmounting the runner.
  const [pendingRebalanceTargets, setPendingRebalanceTargets] = React.useState<RebalanceTarget[] | null>(null);
  const [rebalanceMode, setRebalanceMode] = React.useState<RebalanceMode>("surgical");
  const [rebalanceProgress, setRebalanceProgress] = React.useState<null | {
    current: number;            // 1-based index of the row currently being processed
    total: number;
    succeeded: number;
    failed: number;
    currentLabel: string;       // "url / linkType" for the progress card
    startedAt: number;
  }>(null);
  const rebalanceStopRef = React.useRef(false);

  function handleRebalanceClick(targets: RebalanceTarget[]) {
    if (targets.length === 0) return;
    setPendingRebalanceTargets(targets);
    setRebalanceMode("surgical");
  }

  async function startRebalance() {
    const targets = pendingRebalanceTargets;
    if (!targets || targets.length === 0) return;
    const mode = rebalanceMode;
    setPendingRebalanceTargets(null); // close dialog; runner takes over
    rebalanceStopRef.current = false;
    setRebalanceProgress({
      current: 0,
      total: targets.length,
      succeeded: 0,
      failed: 0,
      currentLabel: "",
      startedAt: Date.now(),
    });

    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (rebalanceStopRef.current) break;
      const target = targets[i];
      setRebalanceProgress((p) => p ? {
        ...p,
        current: i + 1,
        currentLabel: `${target.url} / ${target.linkType || "(none)"}`,
      } : p);
      try {
        const r = await actionRebalanceV2Row(job.id, target.url, target.linkType, { mode });
        if (r.ok) succeeded++; else failed++;
      } catch {
        failed++;
      }
      setRebalanceProgress((p) => p ? { ...p, succeeded, failed } : p);
      // Politeness pause between rows so we don't hammer the provider.
      if (i < targets.length - 1 && !rebalanceStopRef.current) {
        await new Promise((res) => setTimeout(res, 1200));
      }
    }

    router.refresh();
    const stopped = rebalanceStopRef.current;
    setRebalanceProgress(null);
    const plural = succeeded === 1 ? "" : "s";
    const summary =
      `${t("jobView.v2Rebalance.summarySucc", { n: succeeded, plural })}` +
      (failed > 0 ? ` ${t("jobView.v2Rebalance.summaryFail", { n: failed })}` : "") +
      (stopped ? ` ${t("jobView.v2Rebalance.summaryStopped")}` : "");
    toast(summary, failed > 0 ? "info" : "success");
  }
  function stopRebalance() { rebalanceStopRef.current = true; }

  async function regenerateSelected() {
    if (selected.size === 0) return;
    if (!confirm(t("jobView.v2regen.confirm", { n: selected.size }))) return;
    setRegenBusy(true);
    try {
      const ids = Array.from(selected);
      const r = await actionRegenerateV2(job.id, ids);
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
    const csv = v2AnchorsToCsv(anchors.map((a) => ({
      targetUrl: a.targetUrl,
      anchorText: a.anchorText,
      category: a.category,
      payloadV2: a.payloadV2 ?? { linkType: "", geo: "", lang: "" },
    })));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}-v2.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  async function copyAll() {
    // Copy the full V2 table (URL, Type, Anchor, GEO, Lang) so the clipboard matches
    // what Export CSV writes to disk. Same `v2AnchorsToCsv` formatter — pastes into
    // Google Sheets / Excel as a real table.
    const csv = v2AnchorsToCsv(anchors.map((a) => ({
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
            V2 · {job.criteria.providerId} · {job.criteria.model} · {anchors.length} {t("jobsList.columns.anchors").toLowerCase()}
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

      {/* Background-running info banner — only when running and NOT stuck. Reassures
          the user the job will keep going if they close the tab. */}
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

      {/* Stuck-loop warning — server-side loop has died (likely server restart) but the
          job is still marked 'running'. Click Resume to respawn the loop and pick up at
          the existing batches_done. reconcileStuckRunningJobs would eventually flip it
          to 'partial' on the next Library load, but that's a 5min wait; this banner
          surfaces the action inside 30s. */}
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

      {/* Run status panel */}
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

      {/* Active rebalance progress card. Sits above the overview so it's visible without
          scrolling, and provides a Stop-after-current button. */}
      {rebalanceProgress && (
        <RebalanceProgressCard
          progress={rebalanceProgress}
          stopping={rebalanceStopRef.current}
          onStop={stopRebalance}
        />
      )}

      {/* Per-row overview — target vs actual ratios, collapsible. Owns selection state;
          clicking Rebalance bubbles up via onRebalance. */}
      <PerUrlOverview
        inputs={job.inputs ?? []}
        anchors={anchors}
        onRebalance={handleRebalanceClick}
        rebalanceBusy={rebalanceProgress != null}
      />

      {/* Rebalance mode dialog. Opens when the user clicks Rebalance(N) in the overview. */}
      {pendingRebalanceTargets && (
        <RebalanceDialog
          targetsCount={pendingRebalanceTargets.length}
          mode={rebalanceMode}
          onModeChange={setRebalanceMode}
          onCancel={() => setPendingRebalanceTargets(null)}
          onRun={startRebalance}
        />
      )}

      {/* Anchors */}
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
            {linkTypeOptions.length > 0 && (
              <Select
                value={linkTypeFilter}
                onChange={(e) => setLinkTypeFilter(e.target.value)}
                className="h-9 w-auto"
                aria-label={t("jobView.anchors.filterLinkType")}
              >
                <option value="">{t("jobView.anchors.allLinkTypes")}</option>
                {linkTypeOptions.map((lt) => <option key={lt} value={lt}>{lt}</option>)}
              </Select>
            )}
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
                  <th className="px-3 py-2 text-left">{t("jobView.v2cols.url")}</th>
                  <th className="px-3 py-2 text-left w-32">{t("jobView.v2cols.type")}</th>
                  <th className="px-3 py-2 text-left">{t("jobView.v2cols.anchor")}</th>
                  <th className="px-3 py-2 text-left w-28">{t("jobView.v2cols.anchorType")}</th>
                  <th className="px-3 py-2 text-left w-24">{t("jobView.v2cols.geo")}</th>
                  <th className="px-3 py-2 text-left w-20">{t("jobView.v2cols.lang")}</th>
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
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)] truncate max-w-[300px]" title={a.targetUrl}>{a.targetUrl}</td>
                    <td className="px-3 py-2 text-xs">{a.payloadV2?.linkType ?? ""}</td>
                    <td className="px-3 py-2">{a.anchorText}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${categoryStyle(a.category)}`}>
                        {a.category}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)]">{a.payloadV2?.geo ?? ""}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-text-dim)]">{a.payloadV2?.lang ?? ""}</td>
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

// =========================================================================
// Per-row overview panel
// =========================================================================
// Grouped by (Target URL, Link Type) — i.e. one row per V2 input row, since the
// same URL with different Link Types has DIFFERENT per-row distributions. Showing
// actual-vs-target category mix per (URL, Type) is the meaningful unit.
//
// Target per group = weighted average of distributions across input rows in that
// group (weighted by numberOfLinks). If multiple input rows share the same (URL,
// Type) key — unusual but possible if the user duplicated CSV rows — they aggregate.
//
// First DEFAULT_VISIBLE_ROWS shown by default; the rest collapse behind a toggle.

const DEFAULT_VISIBLE_ROWS = 20;
const CATS: AnchorCategory[] = ["generic", "branded", "keyword", "url"];
// Group key for the (URL, Link Type) tuple. `` is ASCII unit-separator — can't appear
// inside a URL or a typed Link Type label, so it makes a safe delimiter without escaping.
const ROW_KEY_SEP = "";
const rowKey = (url: string, linkType: string) => `${url}${ROW_KEY_SEP}${linkType}`;
const decodeRowKey = (k: string): { url: string; linkType: string } => {
  const i = k.indexOf(ROW_KEY_SEP);
  return { url: k.slice(0, i), linkType: k.slice(i + 1) };
};

interface RowStats {
  url: string;
  linkType: string;
  totalAnchors: number;
  /** What the AI actually produced — percentages summing to ~100. */
  actualPct: Record<AnchorCategory, number>;
  /** Per-input target — weighted average across rows for this (URL, Type). */
  targetPct: Record<AnchorCategory, number>;
}

interface RebalanceTarget {
  url: string;
  linkType: string;
}

function PerUrlOverview({
  inputs,
  anchors,
  onRebalance,
  rebalanceBusy = false,
}: {
  inputs: JobInput[];
  anchors: JobAnchor[];
  /** Called when the user clicks Rebalance (N). The parent owns the dialog + runner. */
  onRebalance?: (targets: RebalanceTarget[]) => void;
  /** When the parent is mid-rebalance, disable the button to prevent re-fire. */
  rebalanceBusy?: boolean;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = React.useState(false);
  // Selection set holds row keys (URL + Link Type) so we can match O(1) against table rows.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const stats = React.useMemo<RowStats[]>(() => {
    // Collect every unique (URL, Type) from either side of the join — inputs without
    // anchors yet should still appear; anchors whose input was removed should too.
    const keys = new Set<string>();
    for (const i of inputs) if (i.payloadV2) keys.add(rowKey(i.targetUrl, i.payloadV2.linkType));
    for (const a of anchors) keys.add(rowKey(a.targetUrl, a.payloadV2?.linkType ?? ""));

    const out: RowStats[] = [];
    for (const key of keys) {
      const { url, linkType } = decodeRowKey(key);
      const matchedAnchors = anchors.filter((a) => a.targetUrl === url && (a.payloadV2?.linkType ?? "") === linkType);
      const matchedInputs = inputs.filter((i) => i.targetUrl === url && i.payloadV2?.linkType === linkType);

      // Target: weight each matched input's distribution by numberOfLinks; sum then divide.
      const tw: Record<AnchorCategory, number> = { generic: 0, branded: 0, keyword: 0, url: 0 };
      let weightTotal = 0;
      for (const i of matchedInputs) {
        const p = i.payloadV2;
        if (!p) continue;
        weightTotal += p.numberOfLinks;
        tw.generic += (p.distribution.generic ?? 0) * p.numberOfLinks;
        tw.branded += (p.distribution.branded ?? 0) * p.numberOfLinks;
        tw.keyword += (p.distribution.keyword ?? 0) * p.numberOfLinks;
        tw.url += (p.distribution.url ?? 0) * p.numberOfLinks;
      }
      const targetPct: Record<AnchorCategory, number> = weightTotal === 0
        ? { generic: 0, branded: 0, keyword: 0, url: 0 }
        : {
            generic: Math.round(tw.generic / weightTotal),
            branded: Math.round(tw.branded / weightTotal),
            keyword: Math.round(tw.keyword / weightTotal),
            url: Math.round(tw.url / weightTotal),
          };

      // Actual: count by category, divide by total.
      const total = matchedAnchors.length;
      const actualPct: Record<AnchorCategory, number> = total === 0
        ? { generic: 0, branded: 0, keyword: 0, url: 0 }
        : {
            generic: Math.round((matchedAnchors.filter((a) => a.category === "generic").length / total) * 100),
            branded: Math.round((matchedAnchors.filter((a) => a.category === "branded").length / total) * 100),
            keyword: Math.round((matchedAnchors.filter((a) => a.category === "keyword").length / total) * 100),
            url: Math.round((matchedAnchors.filter((a) => a.category === "url").length / total) * 100),
          };

      out.push({ url, linkType, totalAnchors: total, actualPct, targetPct });
    }

    // Sort: by total anchors desc, then URL alpha, then Type alpha — stable across renders.
    out.sort((a, b) =>
      b.totalAnchors - a.totalAnchors ||
      a.url.localeCompare(b.url) ||
      a.linkType.localeCompare(b.linkType),
    );
    return out;
  }, [inputs, anchors]);

  // Aggregate "Overall" row — same math summed across the whole set. Computed BEFORE
  // any early return so hooks order stays stable across renders.
  const overall = React.useMemo(() => {
    let total = 0;
    const catCounts: Record<AnchorCategory, number> = { generic: 0, branded: 0, keyword: 0, url: 0 };
    for (const a of anchors) {
      catCounts[a.category]++;
      total++;
    }
    const actualPct: Record<AnchorCategory, number> = total === 0
      ? { generic: 0, branded: 0, keyword: 0, url: 0 }
      : {
          generic: Math.round((catCounts.generic / total) * 100),
          branded: Math.round((catCounts.branded / total) * 100),
          keyword: Math.round((catCounts.keyword / total) * 100),
          url: Math.round((catCounts.url / total) * 100),
        };
    // Target overall: weight each input row's distribution by its numberOfLinks across
    // ALL inputs (not just the ones shown). Same shape as per-URL.
    const tw: Record<AnchorCategory, number> = { generic: 0, branded: 0, keyword: 0, url: 0 };
    let wt = 0;
    for (const i of inputs) {
      const p = i.payloadV2;
      if (!p) continue;
      wt += p.numberOfLinks;
      tw.generic += (p.distribution.generic ?? 0) * p.numberOfLinks;
      tw.branded += (p.distribution.branded ?? 0) * p.numberOfLinks;
      tw.keyword += (p.distribution.keyword ?? 0) * p.numberOfLinks;
      tw.url += (p.distribution.url ?? 0) * p.numberOfLinks;
    }
    const targetPct: Record<AnchorCategory, number> = wt === 0
      ? { generic: 0, branded: 0, keyword: 0, url: 0 }
      : {
          generic: Math.round(tw.generic / wt),
          branded: Math.round(tw.branded / wt),
          keyword: Math.round(tw.keyword / wt),
          url: Math.round(tw.url / wt),
        };
    return { totalAnchors: total, actualPct, targetPct };
  }, [inputs, anchors]);

  if (stats.length === 0) return null;

  const visible = expanded ? stats : stats.slice(0, DEFAULT_VISIBLE_ROWS);
  const hiddenCount = stats.length - visible.length;
  const canCollapse = stats.length > DEFAULT_VISIBLE_ROWS;

  // Selection helpers — Overall row is never selectable, only real (URL, Type) rows.
  const visibleKeys = new Set(visible.map((s) => rowKey(s.url, s.linkType)));
  const visibleSelectedCount = visible.filter((s) => selected.has(rowKey(s.url, s.linkType))).length;
  const allVisibleSelected = visible.length > 0 && visibleSelectedCount === visible.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const canRebalance = onRebalance != null;

  function toggleRow(url: string, linkType: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = rowKey(url, linkType);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const k of visibleKeys) next.delete(k);
      else for (const k of visibleKeys) next.add(k);
      return next;
    });
  }
  function clearSelection() { setSelected(new Set()); }
  function triggerRebalance() {
    if (!onRebalance || selected.size === 0) return;
    const targets: RebalanceTarget[] = [];
    for (const k of selected) {
      const { url, linkType } = decodeRowKey(k);
      targets.push({ url, linkType });
    }
    onRebalance(targets);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("jobView.v2Overview.title")}</CardTitle>
        <CardDescription>{t("jobView.v2Overview.desc")}</CardDescription>
      </CardHeader>
      <CardBody className="space-y-3">
        {/* Rebalance toolbar — visible only when at least one row is selected. */}
        {canRebalance && selected.size > 0 && (
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              {t("jobsList.clearSelection")}
            </Button>
            <Button size="sm" onClick={triggerRebalance} disabled={rebalanceBusy}>
              <Wand2 className="h-3 w-3" /> {t("jobView.v2Rebalance.button", { n: selected.size })}
            </Button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-text-dim)] uppercase">
              <tr className="border-b border-[var(--color-border)]">
                {canRebalance && (
                  <th className="px-3 py-2 text-left w-8">
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                      onCheckedChange={toggleAllVisible}
                      aria-label={t("jobsList.selectAll")}
                    />
                  </th>
                )}
                <th className="px-3 py-2 text-left">{t("jobView.v2Overview.url")}</th>
                <th className="px-3 py-2 text-left w-32">{t("jobView.v2Overview.linkType")}</th>
                <th className="px-3 py-2 text-right w-20">{t("jobView.v2Overview.total")}</th>
                {CATS.map((c) => (
                  <th key={c} className="px-3 py-2 text-right w-28">{t(`jobView.v2Overview.cat.${c}` as Parameters<typeof t>[0])}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s, i) => {
                const k = rowKey(s.url, s.linkType);
                const isSelected = selected.has(k);
                return (
                  // Row key combines URL + Type because the same URL appears multiple
                  // times with different link types (different distributions).
                  <tr key={`${k}::${i}`} className={`border-b border-[var(--color-border)] ${isSelected ? "bg-[var(--color-accent)]/5" : "hover:bg-[var(--color-surface-2)]/40"}`}>
                    {canRebalance && (
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRow(s.url, s.linkType)}
                          aria-label={`Select ${s.url} / ${s.linkType}`}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2 truncate max-w-[380px] font-mono text-xs" title={s.url}>{s.url}</td>
                    <td className="px-3 py-2 text-xs">{s.linkType || <span className="italic opacity-60">(none)</span>}</td>
                    <td className="px-3 py-2 text-right font-mono">{s.totalAnchors}</td>
                    {CATS.map((c) => (
                      <td key={c} className="px-3 py-2 text-right font-mono">
                        <V2Cell actual={s.actualPct[c]} target={s.targetPct[c]} />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {/* Overall row — spans the checkbox + URL + Type columns since the aggregate
                  isn't a single (URL, Type) row and shouldn't be selectable. */}
              <tr className="bg-[var(--color-surface-2)]/40">
                <td colSpan={canRebalance ? 3 : 2} className="px-3 py-2 font-medium">{t("jobView.v2Overview.overall")}</td>
                <td className="px-3 py-2 text-right font-mono">{overall.totalAnchors}</td>
                {CATS.map((c) => (
                  <td key={c} className="px-3 py-2 text-right font-mono">
                    <V2Cell actual={overall.actualPct[c]} target={overall.targetPct[c]} />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {canCollapse && (
          <div className="flex justify-center pt-1">
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" /> {t("jobView.v2Overview.collapse")}
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" /> {t("jobView.v2Overview.showAll", { hidden: hiddenCount })}
                </>
              )}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Same actual/target diff-tinting as V1's Cell — green ≤5pp, amber ≤15pp, red beyond. */
function V2Cell({ actual, target }: { actual: number; target: number }) {
  const diff = Math.abs(actual - target);
  let cls: string;
  if (diff <= 5) cls = "text-[var(--color-success)]";
  else if (diff <= 15) cls = "inline-block px-1.5 py-0.5 rounded font-semibold bg-[var(--color-warn)]/15 text-[var(--color-warn)]";
  else cls = "inline-block px-1.5 py-0.5 rounded font-semibold bg-[var(--color-danger)]/15 text-[var(--color-danger)]";
  return (
    <span className={cls}>
      {actual}%<span className="text-[var(--color-text-faint)] font-normal"> / {target}%</span>
    </span>
  );
}

// =========================================================================
// Rebalance dialog — mode picker only. The runner is owned by JobViewV2.
// =========================================================================
function RebalanceDialog({
  targetsCount,
  mode,
  onModeChange,
  onCancel,
  onRun,
}: {
  targetsCount: number;
  mode: RebalanceMode;
  onModeChange: (m: RebalanceMode) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const { t } = useT();
  const plural = targetsCount === 1 ? "" : "s";
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("jobView.v2Rebalance.title", { n: targetsCount, plural })}</DialogTitle>
          <DialogDescription>{t("jobView.v2Rebalance.hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {/* Mode picker — two large cards. Borders highlight the active choice. */}
          {(["surgical", "replace_ai"] as const).map((m) => {
            const active = mode === m;
            const titleKey = m === "surgical" ? "jobView.v2Rebalance.modeSurgicalTitle" : "jobView.v2Rebalance.modeReplaceTitle";
            const descKey = m === "surgical" ? "jobView.v2Rebalance.modeSurgicalDesc" : "jobView.v2Rebalance.modeReplaceDesc";
            return (
              <button
                key={m}
                type="button"
                onClick={() => onModeChange(m)}
                aria-pressed={active}
                className={`w-full text-left rounded-md border px-3 py-2.5 transition-colors ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/8"
                    : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                }`}
              >
                <div className="text-sm font-medium">{t(titleKey)}</div>
                <div className="text-xs text-[var(--color-text-dim)] mt-0.5 leading-relaxed">{t(descKey)}</div>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button onClick={onRun}>
            <Wand2 className="h-3.5 w-3.5" /> {t("jobView.v2Rebalance.run")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================================
// Rebalance progress card — visible while the sequential runner is processing.
// =========================================================================
function RebalanceProgressCard({
  progress,
  stopping,
  onStop,
}: {
  progress: { current: number; total: number; succeeded: number; failed: number; currentLabel: string; startedAt: number };
  stopping: boolean;
  onStop: () => void;
}) {
  const { t } = useT();
  // Tick state so elapsed/ETA update once a second without re-rendering the whole job.
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const completed = progress.succeeded + progress.failed;
  const elapsed = Math.max(0, now - progress.startedAt);
  const pct = progress.total > 0 ? Math.round((completed / progress.total) * 100) : 0;
  const remaining = Math.max(0, progress.total - completed);
  const avgPer = completed > 0 ? elapsed / completed : 0;
  const etaMs = avgPer > 0 ? remaining * avgPer : 0;

  return (
    <Card className="border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5">
      <CardBody className="space-y-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {stopping
                ? t("jobView.v2Rebalance.progressStopping")
                : t("jobView.v2Rebalance.progressTitle", { current: progress.current, total: progress.total })}
            </div>
            <div className="text-xs text-[var(--color-text-dim)] mt-0.5 truncate">
              {t("jobView.v2Rebalance.progressCurrent")}{" "}
              <span className="text-[var(--color-text)] font-mono">{progress.currentLabel}</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onStop} disabled={stopping}>
            {stopping ? t("jobView.v2Rebalance.stopping") : t("jobView.v2Rebalance.stopBtn")}
          </Button>
        </div>
        <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
          <div className="h-full bg-[var(--color-accent)] transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center justify-between text-[11px] text-[var(--color-text-dim)] flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span><span className="text-[var(--color-success)]">✓</span> {t("jobView.v2Rebalance.done", { n: progress.succeeded })}</span>
            {progress.failed > 0 && <span><span className="text-[var(--color-danger)]">✕</span> {t("jobView.v2Rebalance.failed", { n: progress.failed })}</span>}
            <span>{t("jobView.v2Rebalance.remaining", { n: remaining })}</span>
          </div>
          <div className="flex items-center gap-3">
            <span>{t("jobView.v2Rebalance.elapsed", { t: formatDuration(elapsed) })}</span>
            {etaMs > 0 && remaining > 0 && <span>{t("jobView.v2Rebalance.eta", { t: formatDuration(etaMs) })}</span>}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Category chip colors — mirrors V1's JobView.categoryStyle (per-theme CSS vars). */
function categoryStyle(c: AnchorCategory): string {
  if (c === "branded") return "bg-[var(--cat-branded-bg)] text-[var(--cat-branded-fg)]";
  if (c === "keyword") return "bg-[var(--cat-keyword-bg)] text-[var(--cat-keyword-fg)]";
  if (c === "url") return "bg-[var(--cat-url-bg)] text-[var(--cat-url-fg)]";
  return "bg-[var(--cat-generic-bg)] text-[var(--cat-generic-fg)]";
}
