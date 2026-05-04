"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { JobForm, type JobFormInitial } from "@/components/JobForm";
import { actionStartGeneration, actionUpdateJob } from "@/lib/actions";
import { rowsToCsv } from "@/lib/anchors/csv";
import type { Job, SettingsBlob } from "@/lib/types";
import { useT } from "@/lib/i18n/I18nProvider";

export function EditJobClient({ job, settings }: { job: Job; settings: SettingsBlob }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useT();

  const initial: JobFormInitial = React.useMemo(() => ({
    name: job.name,
    mode: job.mode,
    criteria: job.criteria,
    csvText: inputsToCsv(job.inputs ?? []),
  }), [job]);

  return (
    <JobForm
      settings={settings}
      initial={initial}
      heading={t("editJob.heading", { name: job.name })}
      subheading={t("editJob.sub")}
      primaryAction={{
        label: t("editJob.saveAndRerun"),
        busyLabel: t("editJob.saveAndRerunBusy"),
        onSubmit: async (args) => {
          await actionUpdateJob({ id: job.id, ...args });
          const r = await actionStartGeneration(job.id);
          if (r.ok) {
            toast(t("jobView.toasts.savedRerun", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
          } else {
            toast(r.message, "error");
          }
          router.push(`/jobs/${job.id}`);
        },
      }}
      secondaryAction={{
        label: t("editJob.saveOnly"),
        busyLabel: t("editJob.saveOnlyBusy"),
        variant: "outline",
        onSubmit: async (args) => {
          await actionUpdateJob({ id: job.id, ...args });
          toast(t("jobView.toasts.savedOnly"), "success");
          router.push(`/jobs/${job.id}`);
        },
      }}
    />
  );
}

function inputsToCsv(inputs: Array<{ targetUrl: string; title: string | null; keywords: string | null }>): string {
  if (inputs.length === 0) return "";
  const headers = ["Target URL", "Title", "Keywords"];
  return rowsToCsv(
    inputs.map((i) => ({ "Target URL": i.targetUrl, Title: i.title ?? "", Keywords: i.keywords ?? "" })),
    headers
  );
}
