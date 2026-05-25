"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { JobForm, type JobFormInitial } from "@/components/JobForm";
import { actionCreateJobAndStart } from "@/lib/actions";
import { useDisplayName } from "@/components/DisplayNameProvider";
import type { SettingsBlob } from "@/lib/types";
import { useT } from "@/lib/i18n/I18nProvider";

export function NewJobClient({ settings }: { settings: SettingsBlob }) {
  const searchParams = useSearchParams();
  const { t, locale } = useT();
  const { name: displayName } = useDisplayName();

  // Folder inherited from the link the user clicked (e.g. "+ New job" inside a folder).
  // null = create at root. We don't validate the id server-side at create time —
  // softDeleteFolder cascades to jobs in the subtree, so the only way folder_id can
  // end up pointing at a tombstoned folder is a concurrent delete during this exact
  // request, which is rare enough to accept.
  const folderId = searchParams.get("folder");

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
      language: null,
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
          // Server-side create + start + redirect. See actionCreateJobAndStart for why a
          // client router.push() here gets swallowed after revalidatePath.
          await actionCreateJobAndStart({ ...args, folderId, createdBy: displayName });
        },
      }}
    />
  );
}
