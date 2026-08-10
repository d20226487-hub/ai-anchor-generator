"use client";

import * as React from "react";
import { JobForm, type JobFormInitial, type JobFormSubmitArgs } from "@/components/JobForm";
import { actionUpdateJobAndGo } from "@/lib/actions";
import { rowsToCsv } from "@/lib/anchors/csv";
import type { Job, SettingsBlob } from "@/lib/types";
import { useT } from "@/lib/i18n/I18nProvider";

export function EditJobClient({ job, settings }: { job: Job; settings: SettingsBlob }) {
  const { t } = useT();

  const initial: JobFormInitial = React.useMemo(() => ({
    name: job.name,
    mode: job.mode,
    criteria: job.criteria,
    csvText: inputsToCsv(job.inputs ?? []),
  }), [job]);

  // Status-aware primary action: for jobs that have generated some progress and stopped
  // for a non-user reason (partial), or that the user explicitly stopped (paused / cancelled),
  // the safe default is to PRESERVE existing anchors and continue from batches_done.
  // For idle / succeeded / failed / running, "Save & rerun" remains the right default —
  // failed has no anchors to lose, succeeded was a complete run the user is regenerating.
  const isResumable = job.status === "partial" || job.status === "paused" || job.status === "cancelled";

  // All three actions navigate server-side via actionUpdateJobAndGo. A client
  // router.push() after the awaited save was raced by revalidatePath() on this very
  // route and silently dropped, stranding the user on the edit form.
  const saveAndResume = {
    label: t("editJob.saveAndResume"),
    busyLabel: t("editJob.saveAndResumeBusy"),
    onSubmit: async (args: JobFormSubmitArgs) => {
      await actionUpdateJobAndGo({ id: job.id, ...args }, "resume");
    },
  };

  const saveAndRerun = {
    label: t("editJob.saveAndRerun"),
    busyLabel: t("editJob.saveAndRerunBusy"),
    onSubmit: async (args: JobFormSubmitArgs) => {
      // Confirm before destroying existing anchors when we're switching off the
      // resumable default. Without this, "Save & rerun" would silently discard 41 batches
      // of work — the exact bug we just fixed by making Save & resume the new default.
      const anchorsCount = job.anchors?.length ?? 0;
      if (isResumable && anchorsCount > 0) {
        const ok = window.confirm(t("editJob.rerunConfirmDestructive", { n: anchorsCount }));
        if (!ok) return;
      }
      await actionUpdateJobAndGo({ id: job.id, ...args }, "rerun");
    },
  };

  const saveOnly = {
    label: t("editJob.saveOnly"),
    busyLabel: t("editJob.saveOnlyBusy"),
    variant: "outline" as const,
    onSubmit: async (args: JobFormSubmitArgs) => {
      await actionUpdateJobAndGo({ id: job.id, ...args });
    },
  };

  return (
    <JobForm
      settings={settings}
      initial={initial}
      heading={t("editJob.heading", { name: job.name })}
      subheading={t("editJob.sub")}
      // Resumable jobs (partial/paused/cancelled): primary = Save & resume (safe). Save only
      // is the secondary. "Save & rerun" is hidden — users who explicitly want to wipe and
      // restart use the "Rerun all" button on the job page.
      // Other jobs (idle/succeeded/failed): primary = Save & rerun (the existing default).
      primaryAction={isResumable ? saveAndResume : saveAndRerun}
      secondaryAction={saveOnly}
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
