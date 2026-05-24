"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  actionEmptyTrash,
  actionPurgeFolder,
  actionPurgeJob,
  actionRestoreFolder,
  actionRestoreJob,
} from "@/lib/actions";
import type { Folder, Job } from "@/lib/types";
import { ChevronLeft, ChevronRight, Folder as FolderIcon, RotateCcw, Trash2 } from "lucide-react";

const PAGE_SIZES: ReadonlyArray<20 | 50 | 100> = [20, 50, 100];

export function TrashClient({ folders, jobs }: { folders: Folder[]; jobs: Job[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useT();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [emptying, setEmptying] = React.useState(false);

  // Shared page-size selector across both sections — keeps the toolbar compact.
  // Per-section page tracking because folders and jobs grow at very different rates;
  // resetting one when the other paginates would be jarring.
  const [pageSize, setPageSize] = React.useState<20 | 50 | 100>(20);
  const [folderPage, setFolderPage] = React.useState(1);
  const [jobPage, setJobPage] = React.useState(1);

  // Reset both page cursors when the page size changes (so you land on page 1 of the new size).
  React.useEffect(() => { setFolderPage(1); setJobPage(1); }, [pageSize]);

  const folderPageCount = Math.max(1, Math.ceil(folders.length / pageSize));
  const jobPageCount = Math.max(1, Math.ceil(jobs.length / pageSize));
  const safeFolderPage = Math.min(folderPage, folderPageCount);
  const safeJobPage = Math.min(jobPage, jobPageCount);
  const folderStart = (safeFolderPage - 1) * pageSize;
  const jobStart = (safeJobPage - 1) * pageSize;
  const pageFolders = folders.slice(folderStart, folderStart + pageSize);
  const pageJobs = jobs.slice(jobStart, jobStart + pageSize);

  async function restoreFolder(f: Folder) {
    setBusy(`folder:${f.id}`);
    await actionRestoreFolder(f.id);
    toast(t("trash.toasts.folderRestored", { name: f.name }), "success");
    setBusy(null);
    router.refresh();
  }
  async function purgeFolder(f: Folder) {
    if (!confirm(t("trash.confirmPurgeFolder", { name: f.name }))) return;
    setBusy(`folder:${f.id}`);
    await actionPurgeFolder(f.id);
    toast(t("trash.toasts.folderPurged", { name: f.name }), "success");
    setBusy(null);
    router.refresh();
  }
  async function restoreJob(j: Job) {
    setBusy(`job:${j.id}`);
    await actionRestoreJob(j.id);
    toast(t("trash.toasts.jobRestored", { name: j.name }), "success");
    setBusy(null);
    router.refresh();
  }
  async function purgeJob(j: Job) {
    if (!confirm(t("trash.confirmPurgeJob", { name: j.name }))) return;
    setBusy(`job:${j.id}`);
    await actionPurgeJob(j.id);
    toast(t("trash.toasts.jobPurged", { name: j.name }), "success");
    setBusy(null);
    router.refresh();
  }
  async function emptyTrash() {
    if (!confirm(t("trash.confirmEmptyAll", { jobs: jobs.length, folders: folders.length }))) return;
    setEmptying(true);
    try {
      const r = await actionEmptyTrash();
      toast(t("trash.toasts.emptied", { jobs: r.jobs, folders: r.folders }), "success");
      router.refresh();
    } finally {
      setEmptying(false);
    }
  }

  if (folders.length === 0 && jobs.length === 0) {
    return (
      <Card>
        <div className="px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
          {t("trash.empty")}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: per-page selector + Empty trash */}
      <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={emptyTrash} disabled={emptying}>
          <Trash2 className="h-3 w-3" />
          {t("trash.emptyAll")}
        </Button>
      </div>

      {folders.length > 0 && (
        <>
          <Card>
            <div className="px-4 py-2 text-xs uppercase text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
              {t("trash.foldersHeading")} ({folders.length})
            </div>
            <ul>
              {pageFolders.map((f) => (
                <li key={f.id} className="border-b last:border-b-0 border-[var(--color-border)]">
                  <div className="flex items-center px-4 py-2.5 gap-3">
                    <FolderIcon className="h-4 w-4 text-[var(--color-accent)] shrink-0" />
                    <span className="font-medium truncate flex-1">{f.name}</span>
                    <span className="text-xs text-[var(--color-text-dim)] hidden md:inline">
                      {t("trash.deletedAt", { date: formatDate(f.deletedAt, locale) })}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => restoreFolder(f)} disabled={busy === `folder:${f.id}`} title={t("trash.restore")}>
                      <RotateCcw className="h-3 w-3" /> {t("trash.restore")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => purgeFolder(f)} disabled={busy === `folder:${f.id}`} title={t("trash.purge")}>
                      <Trash2 className="h-3 w-3" /> {t("trash.purge")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Pager
            label={t("jobsList.pageOf", { a: folderStart + 1, b: Math.min(folderStart + pageSize, folders.length), n: folders.length })}
            page={safeFolderPage}
            pageCount={folderPageCount}
            onPrev={() => setFolderPage((p) => Math.max(1, p - 1))}
            onNext={() => setFolderPage((p) => Math.min(folderPageCount, p + 1))}
            t={t}
          />
        </>
      )}

      {jobs.length > 0 && (
        <>
          <Card>
            <div className="px-4 py-2 text-xs uppercase text-[var(--color-text-dim)] border-b border-[var(--color-border)]">
              {t("trash.jobsHeading")} ({jobs.length})
            </div>
            <ul>
              {pageJobs.map((j) => (
                <li key={j.id} className="border-b last:border-b-0 border-[var(--color-border)]">
                  <div className="flex items-center px-4 py-2.5 gap-3">
                    <span className="font-medium truncate flex-1">{j.name}</span>
                    <span className="text-xs text-[var(--color-text-dim)] hidden md:inline">
                      {j.createdBy ?? t("folders.unknownCreator")} · {t("trash.deletedAt", { date: formatDate(j.deletedAt, locale) })}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => restoreJob(j)} disabled={busy === `job:${j.id}`} title={t("trash.restore")}>
                      <RotateCcw className="h-3 w-3" /> {t("trash.restore")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => purgeJob(j)} disabled={busy === `job:${j.id}`} title={t("trash.purge")}>
                      <Trash2 className="h-3 w-3" /> {t("trash.purge")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Pager
            label={t("jobsList.pageOf", { a: jobStart + 1, b: Math.min(jobStart + pageSize, jobs.length), n: jobs.length })}
            page={safeJobPage}
            pageCount={jobPageCount}
            onPrev={() => setJobPage((p) => Math.max(1, p - 1))}
            onNext={() => setJobPage((p) => Math.min(jobPageCount, p + 1))}
            t={t}
          />
        </>
      )}
    </div>
  );
}

function Pager({
  label, page, pageCount, onPrev, onNext, t,
}: {
  label: string;
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  t: ReturnType<typeof useT>["t"];
}) {
  if (pageCount <= 1) {
    return <div className="text-xs text-[var(--color-text-dim)]">{label}</div>;
  }
  return (
    <div className="flex items-center justify-between text-xs text-[var(--color-text-dim)]">
      <div>{label}</div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page === 1} onClick={onPrev}>
          <ChevronLeft className="h-3.5 w-3.5" /> {t("jobsList.prev")}
        </Button>
        <span className="px-2 tabular-nums">{page} / {pageCount}</span>
        <Button size="sm" variant="ghost" disabled={page === pageCount} onClick={onNext}>
          {t("jobsList.next")} <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function formatDate(ms: number | null, locale: string): string {
  if (ms == null) return "";
  return new Date(ms).toLocaleString(locale === "ru" ? "ru-RU" : undefined);
}
