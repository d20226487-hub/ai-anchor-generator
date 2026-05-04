import { loadSettings } from "@/lib/settings";
import { NewJobClient } from "./NewJobClient";

export default async function NewJobPage() {
  const settings = await loadSettings();
  return <NewJobClient settings={settings} />;
}
