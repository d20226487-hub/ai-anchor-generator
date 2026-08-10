"use client";

import * as React from "react";
import Papa from "papaparse";
import { Button } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/I18nProvider";
import { Check, ChevronRight, ClipboardPaste, Copy } from "lucide-react";

/**
 * Collapsible "what goes in this box" helper shown directly under every CSV textarea.
 *
 * Before this existed the only hint was the textarea's own greyed-out `placeholder`,
 * which vanishes the moment you type and never appeared at all on the edit forms (they
 * pre-fill the box from the saved job). People had to open /docs in another tab to
 * recall the column order — so the format lives next to the field now.
 *
 * The example is rendered as a real TABLE by default: a row of comma-separated values
 * is genuinely hard to read once there are nine columns, and lining the values up under
 * their headers is the whole point. The raw CSV stays one click away (and behind Copy)
 * because that's what you actually paste.
 *
 * `example` is the same string used as the textarea placeholder, so the two can't drift.
 */

export interface CsvColumn {
  name: string;
  required: boolean;
  desc: string;
}

/** Split the example into header + body. Papa (already bundled for the forms) handles
 *  quoted commas, so an example can contain them without silently mis-rendering. */
function parseExample(csv: string): { header: string[]; body: string[][] } {
  const res = Papa.parse<string[]>(csv.trim(), { skipEmptyLines: true });
  const rows = (res.data ?? []).filter((r) => Array.isArray(r));
  return { header: rows[0] ?? [], body: rows.slice(1) };
}

export function CsvFormatHelp({
  columns,
  example,
  notes,
  onInsertExample,
}: {
  columns: CsvColumn[];
  example: string;
  /** Format rules that don't belong to a single column (percent sum, Lang syntax, …). */
  notes?: string[];
  /** Omitted on forms where clobbering the textarea would destroy the user's saved rows. */
  onInsertExample?: (csv: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const { header, body } = React.useMemo(() => parseExample(example), [example]);

  async function copyExample() {
    try {
      await navigator.clipboard.writeText(example);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure origin / permissions) — the raw view is still there */
    }
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          aria-expanded={open}
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          {t("form.csvHelpTitle")}
        </button>
        <div className="flex-1" />
        {onInsertExample && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onInsertExample(example)}>
            <ClipboardPaste className="h-3 w-3" /> {t("form.csvHelpInsert")}
          </Button>
        )}
      </div>

      {open && (
        <div className="border-t border-[var(--color-border)] px-3 py-3 space-y-4">
          {/* ---- Column reference ---- */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                  <th className="font-medium py-1 pr-3 whitespace-nowrap">{t("form.csvHelpColumn")}</th>
                  <th className="font-medium py-1 pr-3 whitespace-nowrap">{t("form.csvHelpNeeded")}</th>
                  <th className="font-medium py-1">{t("form.csvHelpMeaning")}</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.name} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1 pr-3 font-mono text-[var(--color-text)] whitespace-nowrap">{c.name}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">
                      <span className={c.required ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}>
                        {c.required ? t("form.csvHelpRequired") : t("form.csvHelpOptional")}
                      </span>
                    </td>
                    <td className="py-1 text-[var(--color-text-dim)]">{c.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {notes && notes.length > 0 && (
            <ul className="space-y-1 border-t border-[var(--color-border)] pt-2">
              {notes.map((n, i) => (
                <li key={i} className="text-[11px] text-[var(--color-text-dim)]">• {n}</li>
              ))}
            </ul>
          )}

          {/* ---- Worked example: table by default, raw CSV on demand ---- */}
          <div className="border-t border-[var(--color-border)] pt-3">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">
                {t("form.csvHelpExample")}
              </div>
              <div className="flex-1" />
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? t("form.csvHelpViewTable") : t("form.csvHelpViewRaw")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={copyExample}>
                {copied
                  ? <><Check className="h-3 w-3" /> {t("form.csvHelpCopied")}</>
                  : <><Copy className="h-3 w-3" /> {t("common.copy")}</>}
              </Button>
            </div>

            {showRaw ? (
              <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[11px] font-mono leading-relaxed">
                {example}
              </pre>
            ) : (
              <div className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="bg-[var(--color-surface-2)]">
                      {header.map((h, i) => (
                        <th
                          key={i}
                          className="text-left font-medium px-2 py-1.5 whitespace-nowrap border-b border-[var(--color-border)] text-[var(--color-text)]"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.map((row, ri) => (
                      <tr key={ri} className={ri > 0 ? "border-t border-[var(--color-border)]" : ""}>
                        {header.map((_, ci) => (
                          <td
                            key={ci}
                            className="px-2 py-1.5 font-mono whitespace-nowrap text-[var(--color-text-dim)]"
                          >
                            {row[ci] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
