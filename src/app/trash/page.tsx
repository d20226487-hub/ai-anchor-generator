import { listTrash } from "@/lib/jobs";
import { loadSettings } from "@/lib/settings";
import { getMessages, translate } from "@/lib/i18n/messages";
import { TrashClient } from "./TrashClient";

export default async function TrashPage() {
  const [trash, settings] = await Promise.all([listTrash(), loadSettings()]);
  const msgs = getMessages(settings.locale ?? "en");
  const t = (k: Parameters<typeof translate>[1]) => translate(msgs, k);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t("trash.heading")}</h1>
        <p className="text-sm text-[var(--color-text-dim)]">{t("trash.sub")}</p>
      </div>
      <TrashClient folders={trash.folders} jobs={trash.jobs} />
    </div>
  );
}
