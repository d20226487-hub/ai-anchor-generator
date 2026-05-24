import Link from "next/link";
import { notFound } from "next/navigation";
import { getFolder, getFolderBreadcrumb, listAllFolders, listFolderRows, listJobs } from "@/lib/jobs";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { FolderBrowser } from "./FolderBrowser";
import { loadSettings } from "@/lib/settings";
import { getMessages, translate } from "@/lib/i18n/messages";

interface PageProps {
  searchParams?: Promise<{ folder?: string }>;
}

export default async function HomePage({ searchParams }: PageProps) {
  const sp = (await searchParams) ?? {};
  const folderId = sp.folder ?? null;

  // Validate that the URL-provided folder still exists and isn't trashed.
  // Bad/stale id → 404 so users can't end up "inside" a deleted folder.
  let currentFolder = null;
  let breadcrumb: Awaited<ReturnType<typeof getFolderBreadcrumb>> = [];
  if (folderId !== null) {
    currentFolder = await getFolder(folderId);
    if (!currentFolder) notFound();
    breadcrumb = (await getFolderBreadcrumb(folderId)).filter((f) => f.deletedAt == null);
  }

  // Direct children only — each folder shows its own jobs; subfolders are separate rows.
  const [jobs, childFolders, allFolders, settings] = await Promise.all([
    listJobs({ folderId }),
    listFolderRows(folderId),
    listAllFolders(),
    loadSettings(),
  ]);

  const msgs = getMessages(settings.locale ?? "en");
  const t = (k: Parameters<typeof translate>[1]) => translate(msgs, k);

  // newJob URL inherits the current folder so the form can default to it.
  const newJobHref = folderId ? `/jobs/new?folder=${encodeURIComponent(folderId)}` : "/jobs/new";

  const isEmpty = jobs.length === 0 && childFolders.length === 0;
  const isRootEmpty = isEmpty && folderId === null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {currentFolder ? currentFolder.name : t("jobsList.heading")}
          </h1>
          <p className="text-sm text-[var(--color-text-dim)]">
            {currentFolder ? t("folders.subInFolder") : t("jobsList.sub")}
          </p>
        </div>
        <Link href={newJobHref}>
          <Button>{t("jobsList.newCta")}</Button>
        </Link>
      </div>

      {isRootEmpty ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("jobsList.emptyTitle")}</CardTitle>
            <CardDescription>{t("jobsList.emptyDesc")}</CardDescription>
          </CardHeader>
          <CardBody>
            <Link href={newJobHref}>
              <Button>{t("jobsList.emptyCta")}</Button>
            </Link>
          </CardBody>
        </Card>
      ) : (
        <FolderBrowser
          currentFolderId={folderId}
          breadcrumb={breadcrumb}
          folders={childFolders}
          jobs={jobs}
          allFolders={allFolders}
        />
      )}
    </div>
  );
}
