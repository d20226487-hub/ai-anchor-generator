import { notFound } from "next/navigation";
import { getJob, getModelPricing } from "@/lib/jobs";
import { JobView } from "./JobView";
import { JobViewPirogi } from "./JobViewPirogi";
import { JobViewV2 } from "./JobViewV2";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();
  // Look up the job's model in the pricing table. Used by the CostPill to flag jobs that
  // spent tokens against a model with no pricing row ($0 cost would be misleading).
  const pricing = await getModelPricing(job.criteria.providerId, job.criteria.model);
  const pricingMissing = pricing == null;
  if (job.version === 3) return <JobViewPirogi job={job} pricingMissing={pricingMissing} />;
  if (job.version === 2) return <JobViewV2 job={job} pricingMissing={pricingMissing} />;
  return <JobView job={job} pricingMissing={pricingMissing} />;
}
