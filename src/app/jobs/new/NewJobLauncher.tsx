"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { NewJobClient } from "./NewJobClient";
import { NewJobV2Client } from "./NewJobV2Client";
import type { SettingsBlob, JobVersion } from "@/lib/types";

/**
 * Top-of-page V1/V2 toggle. State is local to this page — picking V2 doesn't
 * persist anywhere. Each created job is locked to whatever was selected at submit.
 * Reusing this page (e.g. back button after creating a V2 job) starts fresh on V1.
 */
export function NewJobLauncher({ settings }: { settings: SettingsBlob }) {
  const { t } = useT();
  const [version, setVersion] = React.useState<JobVersion>(1);

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)] text-xs">
        {([1, 2] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVersion(v)}
            aria-pressed={version === v}
            className={cn(
              "px-3 h-8 font-medium uppercase tracking-wider transition-colors",
              version === v
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            )}
            title={v === 1 ? t("newJob.versionV1Hint") : t("newJob.versionV2Hint")}
          >
            {v === 1 ? t("newJob.versionV1") : t("newJob.versionV2")}
          </button>
        ))}
      </div>
      {version === 1 ? <NewJobClient settings={settings} /> : <NewJobV2Client settings={settings} />}
    </div>
  );
}
