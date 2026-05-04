"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { JobForm, type JobFormInitial } from "@/components/JobForm";
import { actionCreateJob, actionStartGeneration } from "@/lib/actions";
import type { SettingsBlob } from "@/lib/types";
import { useT } from "@/lib/i18n/I18nProvider";

export function NewJobClient({ settings }: { settings: SettingsBlob }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t, locale } = useT();

  const initial: JobFormInitial = React.useMemo(() => ({
    name: t("newJob.namePlaceholder", { date: new Date().toLocaleDateString(locale === "ru" ? "ru-RU" : undefined) }),
    mode: "one_site",
    criteria: {
      ratiosEnabled: true,
      dofollowPct: 70,
      distribution: { generic: 30, branded: 30, keyword: 40, url: 0 },
      brands: [],
      providerId: settings.defaults.providerId,
      model: settings.defaults.modelByProvider[settings.defaults.providerId] ?? "",
    },
    csvText: "",
  }), [settings, t, locale]);

  return (
    <JobForm
      settings={settings}
      initial={initial}
      heading={t("newJob.heading")}
      subheading={t("newJob.sub")}
      primaryAction={{
        label: t("newJob.create"),
        busyLabel: t("newJob.creating"),
        onSubmit: async (args) => {
          const id = await actionCreateJob(args);
          const r = await actionStartGeneration(id);
          if (r.ok) {
            toast(t("jobView.toasts.generatingInBatches", { n: r.batchesTotal, plural: r.batchesTotal === 1 ? "" : "es" }), "info");
          } else {
            toast(r.message, "error");
          }
          router.push(`/jobs/${id}`);
        },
      }}
    />
  );
}
