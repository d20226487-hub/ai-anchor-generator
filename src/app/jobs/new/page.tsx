import { Suspense } from "react";
import { loadSettings } from "@/lib/settings";
import { NewJobLauncher } from "./NewJobLauncher";

export default async function NewJobPage() {
  const settings = await loadSettings();
  // The launcher's forms read ?folder= via useSearchParams(), which opts the subtree into
  // client-side rendering. Without a Suspense boundary `next build` fails to prerender
  // this route ("useSearchParams() should be wrapped in a suspense boundary") and the
  // whole production build aborts — dev mode never surfaces it.
  return (
    <Suspense>
      <NewJobLauncher settings={settings} />
    </Suspense>
  );
}
