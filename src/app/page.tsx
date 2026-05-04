import Link from "next/link";
import { listJobs } from "@/lib/jobs";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { JobsList } from "./JobsList";
import { loadSettings } from "@/lib/settings";
import { getMessages, translate } from "@/lib/i18n/messages";

export default async function HomePage() {
  const [jobs, settings] = await Promise.all([listJobs(), loadSettings()]);
  const msgs = getMessages(settings.locale ?? "en");
  const t = (k: string) => translate(msgs, k);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("jobsList.heading")}</h1>
          <p className="text-sm text-[var(--color-text-dim)]">{t("jobsList.sub")}</p>
        </div>
        <Link href="/jobs/new">
          <Button>{t("jobsList.newCta")}</Button>
        </Link>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("jobsList.emptyTitle")}</CardTitle>
            <CardDescription>{t("jobsList.emptyDesc")}</CardDescription>
          </CardHeader>
          <CardBody>
            <Link href="/jobs/new">
              <Button>{t("jobsList.emptyCta")}</Button>
            </Link>
          </CardBody>
        </Card>
      ) : (
        <JobsList jobs={jobs} />
      )}
    </div>
  );
}
