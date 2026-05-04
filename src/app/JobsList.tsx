"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { actionDeleteJob, actionRenameJob, actionStartGeneration } from "@/lib/actions";
import type { Job } from "@/lib/types";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n/I18nProvider";

export function JobsList({ jobs }: { jobs: Job[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useT();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function rename(id: string) {
    const v = draft.trim();
    if (!v) {
      setEditing(null);
      return;
    }
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
    router.refresh();
  }

  return (
    <Card>
      <table className="w-full text-sm">
        <thead className="text-xs text-[var(--color-text-dim)] uppercase">
          <tr className="border-b border-[var(--color-border)]">
            <th className="px-4 py-3 text-left">{t("jobsList.columns.name")}</th>
            <th className="px-4 py-3 text-left w-32">{t("jobsList.columns.mode")}</th>
            <th className="px-4 py-3 text-left w-32">{t("form.provider")}</th>
            <th className="px-4 py-3 text-right w-24">{t("jobsList.columns.created")}</th>
            <th className="px-4 py-3 text-right w-48">{t("jobsList.columns.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/40">
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
    </Card>
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
