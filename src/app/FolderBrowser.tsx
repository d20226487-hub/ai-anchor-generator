"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  actionCreateFolder,
  actionDeleteFolder,
  actionDeleteJob,
  actionDeleteJobs,
  actionMoveJobs,
  actionRenameFolder,
  actionRenameJob,
  actionStartGeneration,
} from "@/lib/actions";
import type { Folder, FolderRow, Job, JobStatus } from "@/lib/types";
import {
  AlertTriangle, Ban, CheckCircle2, ChevronLeft, ChevronRight, ChevronRight as Crumb,
  CircleDashed, Folder as FolderIcon, FolderPlus, Home as HomeIcon, Loader2,
  MoreVertical, Move, Pause, Pencil, RefreshCw, Search, Trash2, X, XCircle,
} from "lucide-react";

const PAGE_SIZES: ReadonlyArray<20 | 50 | 100> = [20, 50, 100];
const ALL_STATUSES: JobStatus[] = ["idle", "running", "paused", "succeeded", "partial", "failed", "cancelled"];

interface StatusVisual {
  icon: React.ComponentType<{ className?: string }>;
  activeStyle: React.CSSProperties;
  iconExtraClass?: string;
}

// Mirror of the per-theme CSS-var visuals from the previous JobsList. Kept here so the
// FolderBrowser is self-contained — no shared StatusPill module needed.
const STATUS_VISUALS: Record<JobStatus, StatusVisual> = {
  idle:      { icon: CircleDashed,  activeStyle: { backgroundColor: "var(--status-idle-bg)",      color: "var(--status-idle-fg)",      borderColor: "var(--status-idle-border)" } },
  running:   { icon: Loader2,       activeStyle: { backgroundColor: "var(--status-running-bg)",   color: "var(--status-running-fg)",   borderColor: "var(--status-running-border)" }, iconExtraClass: "animate-spin" },
  paused:    { icon: Pause,         activeStyle: { backgroundColor: "var(--status-paused-bg)",    color: "var(--status-paused-fg)",    borderColor: "var(--status-paused-border)" } },
  succeeded: { icon: CheckCircle2,  activeStyle: { backgroundColor: "var(--status-succeeded-bg)", color: "var(--status-succeeded-fg)", borderColor: "var(--status-succeeded-border)" } },
  partial:   { icon: AlertTriangle, activeStyle: { backgroundColor: "var(--status-partial-bg)",   color: "var(--status-partial-fg)",   borderColor: "var(--status-partial-border)" } },
  failed:    { icon: XCircle,       activeStyle: { backgroundColor: "var(--status-failed-bg)",    color: "var(--status-failed-fg)",    borderColor: "var(--status-failed-border)" } },
  cancelled: { icon: Ban,           activeStyle: { backgroundColor: "var(--status-cancelled-bg)", color: "var(--status-cancelled-fg)", borderColor: "var(--status-cancelled-border)" } },
};

const CHIP_OFF_STYLE: React.CSSProperties = {
  backgroundColor: "transparent",
  color: "var(--color-text-dim)",
  borderColor: "var(--color-border-strong)",
};

export interface FolderBrowserProps {
  currentFolderId: string | null;
  /** Path from root to current folder, including current. Empty when viewing root. */
  breadcrumb: Folder[];
  /** Direct child folders of the current folder, with subtree counts. */
  folders: FolderRow[];
  /** Live jobs in the current folder + all descendants. */
  jobs: Job[];
  /** All live folders flat — used by the Move modal's tree picker. */
  allFolders: Folder[];
}

export function FolderBrowser(props: FolderBrowserProps) {
  const { currentFolderId, breadcrumb, folders, jobs, allFolders } = props;
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useT();

  // Inline rename (job)
  const [editingJobId, setEditingJobId] = React.useState<string | null>(null);
  const [jobDraft, setJobDraft] = React.useState("");

  // Per-row busy + bulk busy
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  // Search + pagination + status filter (jobs only)
  const [query, setQuery] = React.useState("");
  const [pageSize, setPageSize] = React.useState<20 | 50 | 100>(20);
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState<Set<JobStatus>>(() => new Set());
  const filterActive = statusFilter.size > 0;

  // Job multi-select for bulk delete + bulk move
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // Modals
  const [newFolderOpen, setNewFolderOpen] = React.useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = React.useState<Folder | null>(null);
  const [moveTarget, setMoveTarget] = React.useState<MoveTarget | null>(null);

  const statusCounts = React.useMemo(() => {
    const counts = {} as Record<JobStatus, number>;
    for (const s of ALL_STATUSES) counts[s] = 0;
    for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return counts;
  }, [jobs]);

  const filteredJobs = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (q && !j.name.toLowerCase().includes(q)) return false;
      if (filterActive && !statusFilter.has(j.status)) return false;
      return true;
    });
  }, [jobs, query, statusFilter, filterActive]);

  const pageCount = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageJobs = filteredJobs.slice(start, start + pageSize);

  React.useEffect(() => { setPage(1); }, [query, pageSize, statusFilter]);

  React.useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const visible = new Set(filteredJobs.map((j) => j.id));
      const next = new Set<string>();
      for (const id of s) if (visible.has(id)) next.add(id);
      return next.size === s.size ? s : next;
    });
  }, [filteredJobs]);

  const allOnPageSelected = pageJobs.length > 0 && pageJobs.every((j) => selected.has(j.id));
  const someOnPageSelected = pageJobs.some((j) => selected.has(j.id));

  function toggleStatus(s: JobStatus) {
    setStatusFilter((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s); else n.add(s);
      return n;
    });
  }
  function resetStatusFilter() { setStatusFilter(new Set()); }

  function toggleJob(id: string) {
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

  async function renameJob(id: string) {
    const v = jobDraft.trim();
    if (!v) { setEditingJobId(null); return; }
    await actionRenameJob(id, v);
    setEditingJobId(null);
    router.refresh();
  }

  async function rerunJob(id: string) {
    setBusyId(id);
    const r = await actionStartGeneration(id);
    if (r.ok) toast(t("jobView.toasts.generatingInBatches", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
    else toast(r.message, "error");
    setBusyId(null);
    router.push(`/jobs/${id}`);
  }

  async function deleteJob(id: string, name: string) {
    if (!confirm(t("jobsList.confirmDelete", { name }))) return;
    await actionDeleteJob(id);
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    toast(t("folders.toasts.movedToTrash"), "success");
    router.refresh();
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    const n = selected.size;
    const plural = locale === "ru"
      ? (n % 10 === 1 && n % 100 !== 11 ? "у" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "и" : ""))
      : (n === 1 ? "" : "s");
    if (!confirm(t("jobsList.confirmDeleteBulk", { n, plural }))) return;
    setBulkBusy(true);
    try {
      const ids = Array.from(selected);
      const r = await actionDeleteJobs(ids);
      toast(t("folders.toasts.bulkMovedToTrash", { n: r.deleted, plural }), "success");
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBulkBusy(false);
    }
  }

  async function createNewFolder(name: string) {
    const r = await actionCreateFolder({ name, parentId: currentFolderId });
    if (!r.ok) { toast(r.message ?? t("folders.errors.create"), "error"); return; }
    setNewFolderOpen(false);
    toast(t("folders.toasts.created", { name }), "success");
    router.refresh();
  }

  async function renameFolderTo(id: string, name: string) {
    const r = await actionRenameFolder(id, name);
    if (!r.ok) { toast(r.message ?? t("folders.errors.rename"), "error"); return; }
    setRenameFolderTarget(null);
    router.refresh();
  }

  async function deleteFolder(f: FolderRow) {
    const total = f.jobCount + f.subfolderCount;
    const confirmMsg = total === 0
      ? t("folders.confirmDeleteEmpty", { name: f.name })
      : t("folders.confirmDeleteNonEmpty", { name: f.name, jobs: f.jobCount, sub: f.subfolderCount });
    if (!confirm(confirmMsg)) return;
    await actionDeleteFolder(f.id);
    toast(t("folders.toasts.folderToTrash", { name: f.name }), "success");
    router.refresh();
  }

  async function applyMove(target: MoveTarget, destFolderId: string | null) {
    if (target.kind === "jobs") {
      const r = await actionMoveJobs(target.ids, destFolderId);
      if (r.ok) toast(t("folders.toasts.movedJobs", { n: r.moved }), "success");
      else toast(t("folders.errors.move"), "error");
    }
    setMoveTarget(null);
    setSelected(new Set());
    router.refresh();
  }

  const noJobs = filteredJobs.length === 0 && (query.trim().length > 0 || filterActive);
  const showStatusChips = jobs.length > 0;
  const showJobsTable = jobs.length > 0;

  return (
    <div className="space-y-4">
      {/* Breadcrumb + new-folder */}
      <BreadcrumbBar
        currentFolderId={currentFolderId}
        breadcrumb={breadcrumb}
        onNewFolder={() => setNewFolderOpen(true)}
        onRenameFolder={() => { const cur = breadcrumb[breadcrumb.length - 1]; if (cur) setRenameFolderTarget(cur); }}
      />

      {/* Toolbar: search + page size + bulk actions */}
      {showJobsTable && (
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
              <Button size="sm" variant="outline" onClick={() => setMoveTarget({ kind: "jobs", ids: Array.from(selected) })} disabled={bulkBusy}>
                <Move className="h-3 w-3" />
                {t("folders.moveSelected", { n: selected.size })}
              </Button>
              <Button size="sm" variant="outline" onClick={bulkDelete} disabled={bulkBusy}>
                <Trash2 className="h-3 w-3" />
                {t("jobsList.deleteSelected", { n: selected.size })}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Status chips (jobs) */}
      {showStatusChips && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-[var(--color-text-dim)] mr-1">{t("jobsList.statusFilterLabel")}</span>
          {ALL_STATUSES.map((s) => {
            const v = STATUS_VISUALS[s];
            const Icon = v.icon;
            const count = statusCounts[s];
            const isSelected = statusFilter.has(s);
            const empty = count === 0;
            const interactable = !empty || isSelected;
            return (
              <button
                key={s}
                type="button"
                onClick={() => interactable && toggleStatus(s)}
                disabled={!interactable}
                style={isSelected ? v.activeStyle : CHIP_OFF_STYLE}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${isSelected ? "font-semibold" : "font-normal hover:bg-[var(--color-surface-2)]/40"} ${empty ? "opacity-40" : ""} ${interactable ? "cursor-pointer" : "cursor-not-allowed"}`}
                title={`${t(`jobStatus.${s}`)} — ${t(`jobStatusHelp.${s}`)}`}
              >
                <Icon className={`h-3 w-3 ${isSelected && v.iconExtraClass ? v.iconExtraClass : ""}`} />
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
      )}

      {/* Folders section */}
      {folders.length > 0 && (
        <Card>
          <div className="px-4 py-2 text-xs uppercase text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
            {t("folders.foldersHeading")} ({folders.length})
          </div>
          <ul>
            {folders.map((f) => (
              <FolderRowItem
                key={f.id}
                folder={f}
                onRename={() => setRenameFolderTarget(f)}
                onDelete={() => deleteFolder(f)}
              />
            ))}
          </ul>
        </Card>
      )}

      {/* Jobs section */}
      {showJobsTable && (
        <Card>
          {noJobs ? (
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
                  <th className="px-4 py-3 text-left w-28">{t("jobsList.columns.mode")}</th>
                  <th className="px-4 py-3 text-left w-28">{t("form.provider")}</th>
                  <th className="px-4 py-3 text-left w-28">{t("folders.columns.creator")}</th>
                  <th className="px-4 py-3 text-right w-24">{t("jobsList.columns.created")}</th>
                  <th className="px-4 py-3 text-right w-52">{t("jobsList.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {pageJobs.map((j) => (
                  <tr key={j.id} className={`border-b border-[var(--color-border)] ${selected.has(j.id) ? "bg-[var(--color-accent)]/5" : "hover:bg-[var(--color-surface-2)]/40"}`}>
                    <td className="px-4 py-2.5">
                      <Checkbox
                        checked={selected.has(j.id)}
                        onCheckedChange={() => toggleJob(j.id)}
                        aria-label={`Select ${j.name}`}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      {editingJobId === j.id ? (
                        <div className="flex gap-1.5">
                          <Input value={jobDraft} onChange={(e) => setJobDraft(e.target.value)} autoFocus className="h-8" />
                          <Button size="sm" onClick={() => renameJob(j.id)}>{t("common.save")}</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingJobId(null)}>{t("common.cancel")}</Button>
                        </div>
                      ) : (
                        <Link href={`/jobs/${j.id}`} className="hover:text-[var(--color-accent)] font-medium">
                          {j.name}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill status={j.status} label={t(`jobStatus.${j.status}`)} />
                    </td>
                    <td className="px-4 py-2.5 text-[var(--color-text-dim)]">{t(j.mode === "one_site" ? "modes.one_site" : "modes.multi_site")}</td>
                    <td className="px-4 py-2.5 text-[var(--color-text-dim)] font-mono text-xs">
                      {j.criteria.providerId}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[var(--color-text-dim)]">
                      {j.createdBy ?? <span className="italic opacity-60">{t("folders.unknownCreator")}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-[var(--color-text-dim)]">
                      {timeAgo(j.updatedAt, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { setEditingJobId(j.id); setJobDraft(j.name); }} title={t("common.rename")}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setMoveTarget({ kind: "jobs", ids: [j.id] })} title={t("folders.moveTo")}>
                          <Move className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => rerunJob(j.id)} disabled={busyId === j.id} title={t("jobsList.rerun")}>
                          <RefreshCw className={`h-3 w-3 ${busyId === j.id ? "animate-spin" : ""}`} />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteJob(j.id, j.name)} title={t("common.delete")}>
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
      )}

      {/* Empty subfolder hint */}
      {folders.length === 0 && jobs.length === 0 && (
        <Card>
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
            {t("folders.emptyFolder")}
          </div>
        </Card>
      )}

      {/* Pagination */}
      {filteredJobs.length > 0 && (
        <div className="flex items-center justify-between text-xs text-[var(--color-text-dim)]">
          <div>
            {t("jobsList.pageOf", { a: start + 1, b: Math.min(start + pageSize, filteredJobs.length), n: filteredJobs.length })}
            {filteredJobs.length !== jobs.length && ` ${t("jobsList.filteredFrom", { total: jobs.length })}`}
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

      {/* Modals */}
      {newFolderOpen && (
        <NameModal
          title={t("folders.newFolderTitle")}
          desc={t("folders.newFolderDesc")}
          placeholder={t("folders.namePlaceholder")}
          submitLabel={t("common.add")}
          onClose={() => setNewFolderOpen(false)}
          onSubmit={createNewFolder}
        />
      )}
      {renameFolderTarget && (
        <NameModal
          title={t("folders.renameFolderTitle")}
          desc={t("folders.renameFolderDesc")}
          placeholder={t("folders.namePlaceholder")}
          submitLabel={t("common.save")}
          initial={renameFolderTarget.name}
          onClose={() => setRenameFolderTarget(null)}
          onSubmit={(v) => renameFolderTo(renameFolderTarget.id, v)}
        />
      )}
      {moveTarget && (
        <MoveModal
          target={moveTarget}
          allFolders={allFolders}
          currentFolderId={currentFolderId}
          onClose={() => setMoveTarget(null)}
          onPick={(destFolderId) => applyMove(moveTarget, destFolderId)}
        />
      )}
    </div>
  );
}

// =========================================================
// Sub-components
// =========================================================

function BreadcrumbBar({
  currentFolderId, breadcrumb, onNewFolder, onRenameFolder,
}: {
  currentFolderId: string | null;
  breadcrumb: Folder[];
  onNewFolder: () => void;
  onRenameFolder: () => void;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <nav className="flex items-center gap-1 text-sm text-[var(--color-text-dim)] flex-wrap">
        <Link href="/" className="inline-flex items-center gap-1 hover:text-[var(--color-text)]">
          <HomeIcon className="h-3.5 w-3.5" /> {t("folders.root")}
        </Link>
        {breadcrumb.map((f, i) => {
          const isLast = i === breadcrumb.length - 1;
          return (
            <React.Fragment key={f.id}>
              <Crumb className="h-3 w-3 opacity-50" />
              {isLast ? (
                <span className="text-[var(--color-text)] font-medium">{f.name}</span>
              ) : (
                <Link href={`/?folder=${encodeURIComponent(f.id)}`} className="hover:text-[var(--color-text)]">
                  {f.name}
                </Link>
              )}
            </React.Fragment>
          );
        })}
      </nav>
      <div className="flex items-center gap-1.5">
        {currentFolderId !== null && (
          <Button size="sm" variant="ghost" onClick={onRenameFolder} title={t("folders.renameCurrentFolder")}>
            <Pencil className="h-3 w-3" />
            {t("common.rename")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onNewFolder}>
          <FolderPlus className="h-3 w-3" />
          {t("folders.newFolder")}
        </Button>
      </div>
    </div>
  );
}

function FolderRowItem({
  folder, onRename, onDelete,
}: {
  folder: FolderRow;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <li className="border-b last:border-b-0 border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/40 group">
      <div className="flex items-center px-4 py-2.5 gap-3">
        <Link href={`/?folder=${encodeURIComponent(folder.id)}`} className="flex items-center gap-2 flex-1 min-w-0">
          <FolderIcon className="h-4 w-4 text-[var(--color-accent)] shrink-0" />
          <span className="font-medium truncate">{folder.name}</span>
          <span className="text-xs text-[var(--color-text-dim)] tabular-nums">
            {t("folders.contentsHint", { jobs: folder.jobCount, sub: folder.subfolderCount })}
          </span>
        </Link>
        <div className="relative">
          <Button size="sm" variant="ghost" onClick={() => setMenuOpen((v) => !v)} title={t("folders.rowActions")}>
            <MoreVertical className="h-3 w-3" />
          </Button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-40 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1 text-sm">
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)] flex items-center gap-2"
                  onClick={() => { setMenuOpen(false); onRename(); }}
                >
                  <Pencil className="h-3 w-3" /> {t("common.rename")}
                </button>
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)] flex items-center gap-2 text-[var(--color-danger)]"
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                >
                  <Trash2 className="h-3 w-3" /> {t("folders.deleteFolder")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

type MoveTarget = { kind: "jobs"; ids: string[] };

function MoveModal({
  target, allFolders, currentFolderId, onClose, onPick,
}: {
  target: MoveTarget;
  allFolders: Folder[];
  currentFolderId: string | null;
  onClose: () => void;
  onPick: (destFolderId: string | null) => void;
}) {
  const { t } = useT();

  // Build the tree from the flat folder list.
  type Node = Folder & { children: Node[] };
  const tree = React.useMemo<Node[]>(() => {
    const byId = new Map<string, Node>();
    for (const f of allFolders) byId.set(f.id, { ...f, children: [] });
    const roots: Node[] = [];
    for (const n of byId.values()) {
      if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId)!.children.push(n);
      else roots.push(n);
    }
    const sortRec = (xs: Node[]) => {
      xs.sort((a, b) => a.name.localeCompare(b.name));
      for (const c of xs) sortRec(c.children);
    };
    sortRec(roots);
    return roots;
  }, [allFolders]);

  const title = target.kind === "jobs"
    ? t("folders.moveModalTitleJobs", { n: target.ids.length })
    : "";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("folders.moveModalDesc")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded border border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => onPick(null)}
            className={`w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] flex items-center gap-2 ${currentFolderId === null ? "bg-[var(--color-accent)]/5" : ""}`}
          >
            <HomeIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" />
            {t("folders.root")}
            {currentFolderId === null && <span className="text-xs text-[var(--color-text-dim)] ml-auto">{t("folders.currentLabel")}</span>}
          </button>
          {tree.map((n) => (
            <TreeNode key={n.id} node={n} depth={0} currentFolderId={currentFolderId} onPick={onPick} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TreeNode({
  node, depth, currentFolderId, onPick,
}: {
  node: { id: string; name: string; children: { id: string; name: string; children: unknown[] }[] };
  depth: number;
  currentFolderId: string | null;
  onPick: (destFolderId: string | null) => void;
}) {
  const { t } = useT();
  const isCurrent = node.id === currentFolderId;
  return (
    <>
      <button
        type="button"
        onClick={() => onPick(node.id)}
        className={`w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-2)] flex items-center gap-2 ${isCurrent ? "bg-[var(--color-accent)]/5" : ""}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <FolderIcon className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="truncate">{node.name}</span>
        {isCurrent && <span className="text-xs text-[var(--color-text-dim)] ml-auto">{t("folders.currentLabel")}</span>}
      </button>
      {node.children.map((c) => (
        <TreeNode
          key={(c as { id: string }).id}
          node={c as { id: string; name: string; children: { id: string; name: string; children: unknown[] }[] }}
          depth={depth + 1}
          currentFolderId={currentFolderId}
          onPick={onPick}
        />
      ))}
    </>
  );
}

function NameModal({
  title, desc, placeholder, submitLabel, initial = "", onClose, onSubmit,
}: {
  title: string;
  desc: string;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useT();
  const [value, setValue] = React.useState(initial);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{desc}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); const v = value.trim(); if (v.length > 0) onSubmit(v); }}
          className="space-y-3"
        >
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} maxLength={80} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={value.trim().length === 0}>{submitLabel}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================
// Misc helpers
// =========================================================

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
