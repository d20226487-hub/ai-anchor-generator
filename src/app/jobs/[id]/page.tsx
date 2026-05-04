import { notFound } from "next/navigation";
import { getJob } from "@/lib/jobs";
import { JobView } from "./JobView";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();
  return <JobView job={job} />;
}
