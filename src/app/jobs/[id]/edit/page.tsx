import { notFound } from "next/navigation";
import { getJob } from "@/lib/jobs";
import { loadSettings } from "@/lib/settings";
import { EditJobClient } from "./EditJobClient";
import { EditJobPirogiClient } from "./EditJobPirogiClient";
import { EditJobV2Client } from "./EditJobV2Client";

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, settings] = await Promise.all([getJob(id), loadSettings()]);
  if (!job) notFound();
  // Each version has its own edit form matching its input model:
  //   3 = Пироги (deduped anchors + quantities), 2 = V2 (per-row CSV), 1 = legacy form.
  // V2/Пироги must NOT fall through to the V1 form — it can't round-trip payloadV2.
  if (job.version === 3) return <EditJobPirogiClient job={job} settings={settings} />;
  if (job.version === 2) return <EditJobV2Client job={job} settings={settings} />;
  return <EditJobClient job={job} settings={settings} />;
}
