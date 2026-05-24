import { loadSettings } from "@/lib/settings";
import { NewJobLauncher } from "./NewJobLauncher";

export default async function NewJobPage() {
  const settings = await loadSettings();
  return <NewJobLauncher settings={settings} />;
}
