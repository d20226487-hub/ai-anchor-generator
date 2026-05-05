"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { useToast } from "@/components/ui/Toast";
import { actionDeleteJob, actionDeleteJobs, actionRenameJob, actionStartGeneration } from "@/lib/actions";
import type { Job, JobStatus } from "@/lib/types";
import { AlertTriangle, Ban, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Loader2, Pause, Pencil, RefreshCw, Search, Trash2, X, XCircle } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

const PAGE_SIZES: ReadonlyArray<20 | 50 | 100> = [20, 50, 100];

const ALL_STATUSES: JobStatus[] = ["idle", "running", "paused", "succeeded", "partial", "failed", "cancelled"];

interface StatusVisual {
  icon: React.ComponentType<{ className?: string }>;
  /** Filled style — used for the per-row Status column AND for "selected" filter chips.
   *  Uses inline `style` so per-theme CSS vars apply reliably without depending on
   *  Tailwind v4 utility generation for arbitrary CSS-var background colors. */
  activeStyle: React.CSSProperties;
  /** Spin / animation class on the icon (running only). */
  iconExtraClass?: string;
}

// Each status references CSS vars defined in globals.css (per-theme: --status-{name}-{bg|fg|border}).
const STATUS_VISUALS: Record<JobStatus, StatusVisual> = {
  idle:      { icon: CircleDashed,  activeStyle: { backgroundColor: "var(--status-idle-bg)",      color: "var(--status-idle-fg)",      borderColor: "var(--status-idle-border)" } },
  running:   { icon: Loader2,       activeStyle: { backgroundColor: "var(--status-running-bg)",   color: "var(--status-running-fg)",   borderColor: "var(--status-running-border)" }, iconExtraClass: "animate-spin" },
  paused:    { icon: Pause,         activeStyle: { backgroundColor: "var(--status-paused-bg)",    color: "var(--status-paused-fg)",    borderColor: "var(--status-paused-border)" } },
  succeeded: { icon: CheckCircle2,  activeStyle: { backgroundColor: "var(--status-succeeded-bg)", color: "var(--status-succeeded-fg)", borderColor: "var(--status-succeeded-border)" } },
  // PARTIAL shares the warm bg with paused but uses a danger-tinted BORDER + AlertTriangle
  // icon. The warning-triangle shape + red border immediately read as "needs attention",
  // distinct from the calm Pause icon + plain warn border.
  partial:   { icon: AlertTriangle, activeStyle: { backgroundColor: "var(--status-partial-bg)",   color: "var(--status-partial-fg)",   borderColor: "var(--status-partial-border)" } },
  failed:    { icon: XCircle,       activeStyle: { backgroundColor: "var(--status-failed-bg)",    color: "var(--status-failed-fg)",    borderColor: "var(--status-failed-border)" } },
  cancelled: { icon: Ban,           activeStyle: { backgroundColor: "var(--status-cancelled-bg)", color: "var(--status-cancelled-fg)", borderColor: "var(--status-cancelled-border)" } },
};

// OFF-state inline style — outline only with readable mid-tone text + slightly darker
// border so the chip outline is clearly visible in both themes. Crystal-clear visual
// difference from the filled "selected" state, while staying legible.
const CHIP_OFF_STYLE: React.CSSProperties = {
  backgroundColor: "transparent",
  color: "var(--color-text-dim)",
  borderColor: "var(--color-border-strong)",
};

export function JobsList({ jobs }: { jobs: Job[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useT();

  // Inline rename state
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Search + pagination
  const [query, setQuery] = React.useState("");
  const [pageSize, setPageSize] = React.useState<20 | 50 | 100>(20);
  const [page, setPage] = React.useState(1);

  // Status filter (multi-select). Default = empty Set = no filter active = show all jobs.
  // When user clicks a chip it joins the filter; click again removes it. Empty filter
  // matches everything (semantically: "no filter applied").
  const [statusFilter, setStatusFilter] = React.useState<Set<JobStatus>>(() => new Set());
  const filterActive = statusFilter.size > 0;

  // Bulk selection (Set of job ids)
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);

  // Per-status counts on the FULL list (so chip counts don't shift with search).
  const statusCounts = React.useMemo(() => {
    const counts = {} as Record<JobStatus, number>;
    for (const s of ALL_STATUSES) counts[s] = 0;
    for (const j of jobs) counts[j.status as JobStatus] = (counts[j.status as JobStatus] ?? 0) + 1;
    return counts;
  }, [jobs]);

  // Combined filter: search + status. Empty statusFilter = no status filter (matches all).
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (q && !j.name.toLowerCase().includes(q)) return false;
      if (filterActive && !statusFilter.has(j.status as JobStatus)) return false;
      return true;
    });
  }, [jobs, query, statusFilter, filterActive]);

  /** Toggle a single status in the filter. Pure multi-select: click adds, click again removes. */
  function toggleStatus(s: JobStatus) {
    setStatusFilter((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s); else n.add(s);
      return n;
    });
  }
  function resetStatusFilter() { setStatusFilter(new Set()); }

  // Pagination math
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageJobs = filtered.slice(start, start + pageSize);

  // Reset to page 1 when filters or page-size change
  React.useEffect(() => { setPage(1); }, [query, pageSize, statusFilter]);

  // Drop selections that are no longer in the filtered set (e.g. after search)
  React.useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const visibleIds = new Set(filtered.map((j) => j.id));
      const next = new Set<string>();
      for (const id of s) if (visibleIds.has(id)) next.add(id);
      return next.size === s.size ? s : next;
    });
  }, [filtered]);

  const allOnPageSelected = pageJobs.length > 0 && pageJobs.every((j) => selected.has(j.id));
  const someOnPageSelected = pageJobs.some((j) => selected.has(j.id));

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAllOnPage() {
    setSelected((s) => {
      const n = new Set(s);
      if (allOnPageSelected) for (const j of pageJobs) n.delete(j.id);
      else for (const j of pageJobs) n.add(j.id);
      return n;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  async function rename(id: string) {
    const v = draft.trim();
    if (!v) { setEditing(null); return; }
    await actionRenameJob(id, v);
    setEditing(null);
    router.refresh();
  }

  async function rerun(id: string) {
    setBusyId(id);
    const r = await actionStartGeneration(id);
    if (r.ok) toast(t("jobView.toasts.generatingInBatches", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
    else toast(r.message, "error");
    setBusyId(null);
    router.push(`/jobs/${id}`);
  }

  async function remove(id: string, name: string) {
    if (!confirm(t("jobsList.confirmDelete", { name }))) return;
    await actionDeleteJob(id);
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    router.refresh();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    const n = selected.size;
    const plural = locale === "ru" ? (n % 10 === 1 && n % 100 !== 11 ? "у" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "и" : "")) : (n === 1 ? "" : "s");
    if (!confirm(t("jobsList.confirmDeleteBulk", { n, plural }))) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const r = await actionDeleteJobs(ids);
      toast(t("jobsList.bulkDeletedToast", { n: r.deleted, plural }), "success");
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBulkBusy(false);
    }
  }

  const noMatches = filtered.length === 0 && (query.trim().length > 0 || filterActive);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("jobsList.searchPlaceholder")}
            className="pl-8 pr-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              aria-label={t("common.clear")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-dim)]">
          <span>{t("jobsList.pageSize")}</span>
          <Select
            value={String(pageSize)}
            onChange={(e) => setPageSize(Number(e.target.value) as 20 | 50 | 100)}
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
            <Button size="sm" variant="outline" onClick={bulkDelete} disabled={bulkBusy}>
              <Trash2 className="h-3 w-3" />
              {t("jobsList.deleteSelected", { n: selected.size })}
            </Button>
          </>
        )}
      </div>

      {/* Status filter chips — pure multi-select toggle.
          Default state: empty filter → ALL chips outline-only (no filter applied, all jobs shown).
          Selected: filled with status color + bold. Unselected: outline + dim text.
          Click any chip with count>0 to add/remove from filter. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-[var(--color-text-dim)] mr-1">{t("jobsList.statusFilterLabel")}</span>
        {ALL_STATUSES.map((s) => {
          const v = STATUS_VISUALS[s];
          const Icon = v.icon;
          const count = statusCounts[s];
          const selected = statusFilter.has(s);
          const empty = count === 0;
          // Empty chips are non-interactive (can't filter to zero), but if previously
          // selected we still let user click to remove.
          const interactable = !empty || selected;
          return (
            <button
              key={s}
              type="button"
              onClick={() => interactable && toggleStatus(s)}
              disabled={!interactable}
              style={selected ? v.activeStyle : CHIP_OFF_STYLE}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${selected ? "font-semibold" : "font-normal hover:bg-[var(--color-surface-2)]/40"} ${empty ? "opacity-40" : ""} ${interactable ? "cursor-pointer" : "cursor-not-allowed"}`}
              title={`${t(`jobStatus.${s}`)} — ${t(`jobStatusHelp.${s}`)}`}
            >
              <Icon className={`h-3 w-3 ${selected && v.iconExtraClass ? v.iconExtraClass : ""}`} />
              <span>{t(`jobStatus.${s}`)}</span>
              <span className="tabular-nums opacity-90">({count})</span>
            </button>
          );
        })}
        {filterActive && (
          <button
            type="button"
            onClick={resetStatusFilter}
            className="ml-1 text-xs text-[var(--color-text-dim)] underline hover:text-[var(--color-text)]"
          >
            {t("jobsList.resetFilters")}
          </button>
        )}
      </div>

      {/* Table */}
      <Card>
        {noMatches ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
            {t("jobsList.noMatches")}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-text-dim)] uppercase">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-3 text-left w-8">
                  <Checkbox
                    checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                    onCheckedChange={toggleAllOnPage}
                    aria-label={t("jobsList.selectAll")}
                  />
                </th>
                <th className="px-4 py-3 text-left">{t("jobsList.columns.name")}</th>
                <th className="px-4 py-3 text-left w-32">{t("jobsList.columns.status")}</th>
                <th className="px-4 py-3 text-left w-32">{t("jobsList.columns.mode")}</th>
                <th className="px-4 py-3 text-left w-32">{t("form.provider")}</th>
                <th className="px-4 py-3 text-right w-24">{t("jobsList.columns.created")}</th>
                <th className="px-4 py-3 text-right w-48">{t("jobsList.columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {pageJobs.map((j) => (
                <tr key={j.id} className={`border-b border-[var(--color-border)] ${selected.has(j.id) ? "bg-[var(--color-accent)]/5" : "hover:bg-[var(--color-surface-2)]/40"}`}>
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selected.has(j.id)}
                      onCheckedChange={() => toggle(j.id)}
                      aria-label={`Select ${j.name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    {editing === j.id ? (
                      <div className="flex gap-1.5">
                        <Input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus className="h-8" />
                        <Button size="sm" onClick={() => rename(j.id)}>{t("common.save")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                      </div>
                    ) : (
                      <Link href={`/jobs/${j.id}`} className="hover:text-[var(--color-accent)] font-medium">
                        {j.name}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={j.status as JobStatus} label={t(`jobStatus.${j.status}`)} />
                  </td>
                  <td className="px-4 py-2.5 text-[var(--color-text-dim)]">{t(j.mode === "one_site" ? "modes.one_site" : "modes.multi_site")}</td>
                  <td className="px-4 py-2.5 text-[var(--color-text-dim)] font-mono text-xs">
                    {j.criteria.providerId}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-[var(--color-text-dim)]">
                    {timeAgo(j.updatedAt, locale)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(j.id); setDraft(j.name); }} title={t("common.rename")}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => rerun(j.id)} disabled={busyId === j.id} title={t("jobsList.rerun")}>
                        <RefreshCw className={`h-3 w-3 ${busyId === j.id ? "animate-spin" : ""}`} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(j.id, j.name)} title={t("common.delete")}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Pagination footer */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between text-xs text-[var(--color-text-dim)]">
          <div>
            {t("jobsList.pageOf", { a: start + 1, b: Math.min(start + pageSize, filtered.length), n: filtered.length })}
            {filtered.length !== jobs.length && ` ${t("jobsList.filteredFrom", { total: jobs.length })}`}
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
    </div>
  );
}

function timeAgo(ms: number, locale: string): string {
  const d = Date.now() - ms;
  const m = Math.floor(d / 60000);
  if (locale === "ru") {
    if (m < 1) return "только что";
    if (m < 60) return `${m} мин назад`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч назад`;
    const days = Math.floor(h / 24);
    if (days < 30) return `${days} дн назад`;
    return new Date(ms).toLocaleDateString("ru-RU");
  }
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function StatusPill({ status, label }: { status: JobStatus; label: string }) {
  const v = STATUS_VISUALS[status];
  const Icon = v.icon;
  return (
    <span style={v.activeStyle} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
      <Icon className={`h-3 w-3 ${v.iconExtraClass ?? ""}`} />
      {label}
    </span>
  );
}
