"use client";

import * as React from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useT } from "@/lib/i18n/I18nProvider";
import {
  actionDeleteModelPricing,
  actionListModelPricing,
  actionSaveModelPricing,
} from "@/lib/actions";
import type { ModelPricing, ProviderId } from "@/lib/types";
import { Plus, Save, Trash2 } from "lucide-react";

const PROVIDERS: ProviderId[] = ["openrouter", "github", "gemini", "vertex"];

function providerLabel(p: ProviderId): string {
  return p === "openrouter" ? "OpenRouter"
    : p === "github" ? "GitHub Models"
    : p === "gemini" ? "Google Gemini"
    : "Google Vertex AI";
}

/**
 * Edit per-(provider, model) AI pricing. Rates are USD per 1 MILLION tokens (matches
 * every provider's published pricing page). Default rows are seeded on first DB boot;
 * users can edit, add, or delete here. Costs already locked into past jobs are NEVER
 * recomputed when prices change (Drop Sherlock-style lock-in).
 */
export function PricingTab() {
  const { t } = useT();
  const { toast } = useToast();
  const [rows, setRows] = React.useState<ModelPricing[]>([]);
  const [loading, setLoading] = React.useState(true);

  // Pending edits keyed by `${provider}::${model}` — input rate / output rate as strings
  // so the user can clear the field without it snapping back to "0".
  const [edits, setEdits] = React.useState<Map<string, { input: string; output: string }>>(new Map());
  const [savingKey, setSavingKey] = React.useState<string | null>(null);

  // New-row draft
  const [newProvider, setNewProvider] = React.useState<ProviderId>("openrouter");
  const [newModel, setNewModel] = React.useState("");
  const [newInput, setNewInput] = React.useState("");
  const [newOutput, setNewOutput] = React.useState("");

  async function load() {
    setLoading(true);
    const r = await actionListModelPricing();
    setRows(r);
    setLoading(false);
  }
  React.useEffect(() => { void load(); }, []);

  function keyOf(p: ProviderId, m: string): string { return `${p}::${m}`; }
  function getEdit(p: ProviderId, m: string): { input: string; output: string } {
    const k = keyOf(p, m);
    const e = edits.get(k);
    if (e) return e;
    const row = rows.find((r) => r.providerId === p && r.model === m);
    return { input: row ? String(row.inputPerMillion) : "", output: row ? String(row.outputPerMillion) : "" };
  }
  function setEdit(p: ProviderId, m: string, patch: Partial<{ input: string; output: string }>) {
    setEdits((prev) => {
      const next = new Map(prev);
      const cur = getEdit(p, m);
      next.set(keyOf(p, m), { ...cur, ...patch });
      return next;
    });
  }
  function isDirty(p: ProviderId, m: string): boolean {
    const k = keyOf(p, m);
    const e = edits.get(k);
    if (!e) return false;
    const row = rows.find((r) => r.providerId === p && r.model === m);
    if (!row) return true;
    return e.input !== String(row.inputPerMillion) || e.output !== String(row.outputPerMillion);
  }

  async function saveRow(p: ProviderId, m: string) {
    const e = getEdit(p, m);
    const inputN = Number(e.input);
    const outputN = Number(e.output);
    if (!Number.isFinite(inputN) || inputN < 0) { toast(t("settings.pricing.errInput"), "error"); return; }
    if (!Number.isFinite(outputN) || outputN < 0) { toast(t("settings.pricing.errOutput"), "error"); return; }
    const k = keyOf(p, m);
    setSavingKey(k);
    try {
      const r = await actionSaveModelPricing({ providerId: p, model: m, inputPerMillion: inputN, outputPerMillion: outputN });
      if (!r.ok) { toast(r.message ?? "Save failed", "error"); return; }
      // Drop the edit from the pending map (now matches DB) and reload.
      setEdits((prev) => { const next = new Map(prev); next.delete(k); return next; });
      await load();
      toast(t("settings.pricing.savedToast", { model: m }), "success");
    } finally {
      setSavingKey(null);
    }
  }

  async function deleteRow(p: ProviderId, m: string) {
    if (!confirm(t("settings.pricing.confirmDelete", { model: m }))) return;
    await actionDeleteModelPricing(p, m);
    await load();
    toast(t("settings.pricing.deletedToast", { model: m }), "success");
  }

  async function addNew() {
    const m = newModel.trim();
    const i = Number(newInput);
    const o = Number(newOutput);
    if (!m) { toast(t("settings.pricing.errModel"), "error"); return; }
    if (!Number.isFinite(i) || i < 0) { toast(t("settings.pricing.errInput"), "error"); return; }
    if (!Number.isFinite(o) || o < 0) { toast(t("settings.pricing.errOutput"), "error"); return; }
    const r = await actionSaveModelPricing({ providerId: newProvider, model: m, inputPerMillion: i, outputPerMillion: o });
    if (!r.ok) { toast(r.message ?? "Save failed", "error"); return; }
    setNewModel(""); setNewInput(""); setNewOutput("");
    await load();
    toast(t("settings.pricing.savedToast", { model: m }), "success");
  }

  if (loading) return <div className="text-xs text-[var(--color-text-dim)]">{t("common.loading")}</div>;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="text-xs text-[var(--color-text-dim)] py-3 leading-relaxed">
          {t("settings.pricing.desc")}
        </CardBody>
      </Card>

      {PROVIDERS.map((p) => {
        const ofProvider = rows.filter((r) => r.providerId === p);
        return (
          <Card key={p}>
            <CardBody>
              <div className="text-sm font-semibold mb-2">{providerLabel(p)}</div>
              {ofProvider.length === 0 ? (
                <div className="text-xs text-[var(--color-text-dim)] italic">{t("settings.pricing.providerEmpty")}</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="text-left pb-2">{t("settings.pricing.colModel")}</th>
                      <th className="text-right pb-2 w-32">{t("settings.pricing.colInput")}</th>
                      <th className="text-right pb-2 w-32">{t("settings.pricing.colOutput")}</th>
                      <th className="text-right pb-2 w-32">{t("settings.pricing.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ofProvider.map((row) => {
                      const e = getEdit(p, row.model);
                      const k = keyOf(p, row.model);
                      const dirty = isDirty(p, row.model);
                      return (
                        <tr key={row.model} className="border-b last:border-b-0 border-[var(--color-border)]">
                          <td className="py-2 font-mono text-xs">{row.model}</td>
                          <td className="py-2 text-right">
                            <Input
                              type="number"
                              step="0.001"
                              min="0"
                              value={e.input}
                              onChange={(ev) => setEdit(p, row.model, { input: ev.target.value })}
                              className="h-7 w-24 text-right"
                            />
                          </td>
                          <td className="py-2 text-right">
                            <Input
                              type="number"
                              step="0.001"
                              min="0"
                              value={e.output}
                              onChange={(ev) => setEdit(p, row.model, { output: ev.target.value })}
                              className="h-7 w-24 text-right"
                            />
                          </td>
                          <td className="py-2 text-right">
                            <div className="inline-flex items-center gap-1">
                              <Button size="sm" variant="ghost" onClick={() => saveRow(p, row.model)} disabled={!dirty || savingKey === k} title={t("common.save")}>
                                <Save className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => deleteRow(p, row.model)} title={t("common.delete")}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        );
      })}

      {/* Add-row form */}
      <Card>
        <CardBody className="space-y-3">
          <div className="text-sm font-semibold">{t("settings.pricing.addHeading")}</div>
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-3">
              <Label className="text-xs">{t("settings.pricing.colProvider")}</Label>
              <Select className="mt-1 h-8" value={newProvider} onChange={(e) => setNewProvider(e.target.value as ProviderId)}>
                {PROVIDERS.map((pp) => <option key={pp} value={pp}>{providerLabel(pp)}</option>)}
              </Select>
            </div>
            <div className="col-span-4">
              <Label className="text-xs">{t("settings.pricing.colModel")}</Label>
              <Input className="mt-1 h-8 font-mono text-xs" value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder="e.g. openai/gpt-4o-mini" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">{t("settings.pricing.colInput")}</Label>
              <Input type="number" step="0.001" min="0" className="mt-1 h-8 text-right" value={newInput} onChange={(e) => setNewInput(e.target.value)} placeholder="0.15" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">{t("settings.pricing.colOutput")}</Label>
              <Input type="number" step="0.001" min="0" className="mt-1 h-8 text-right" value={newOutput} onChange={(e) => setNewOutput(e.target.value)} placeholder="0.60" />
            </div>
            <div className="col-span-1">
              <Button size="sm" onClick={addNew} className="w-full">
                <Plus className="h-3 w-3" /> {t("common.add")}
              </Button>
            </div>
          </div>
          <p className="text-[10px] text-[var(--color-text-faint)]">{t("settings.pricing.addHint")}</p>
        </CardBody>
      </Card>
    </div>
  );
}
