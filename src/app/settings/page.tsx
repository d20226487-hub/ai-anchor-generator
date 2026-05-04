import { actionGetSettings } from "@/lib/actions";
import { SettingsClient } from "./SettingsClient";

export default async function SettingsPage() {
  // Use the action (not loadSettings directly) so API keys are REDACTED before
  // they reach the browser — the page hydrates with apiKey="" + apiKeyPreview="sk-...7107".
  const settings = await actionGetSettings();
  return <SettingsClient initial={settings} />;
}
