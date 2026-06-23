import { notFound } from "next/navigation";
import { getJob } from "@/lib/jobs";
import { loadSettings } from "@/lib/settings";
import { EditJobClient } from "./EditJobClient";
import { EditJobPirogiClient } from "./EditJobPirogiClient";

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, settings] = await Promise.all([getJob(id), loadSettings()]);
  if (!job) notFound();
  // Пироги (v3) has its own edit flow — same V2 CSV input shape but with the
  // optional site description and Пироги-specific copy. V2 currently shares the
  // V1 EditJobClient as a stop-gap (its CSV format would need a parallel form).
  if (job.version === 3) return <EditJobPirogiClient job={job} settings={settings} />;
  return <EditJobClient job={job} settings={settings} />;
}
