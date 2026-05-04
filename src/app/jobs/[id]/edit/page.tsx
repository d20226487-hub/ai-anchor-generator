import { notFound } from "next/navigation";
import { getJob } from "@/lib/jobs";
import { loadSettings } from "@/lib/settings";
import { EditJobClient } from "./EditJobClient";

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, settings] = await Promise.all([getJob(id), loadSettings()]);
  if (!job) notFound();
  return <EditJobClient job={job} settings={settings} />;
}
