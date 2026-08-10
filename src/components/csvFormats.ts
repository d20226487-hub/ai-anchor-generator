import type { MessageKey } from "@/lib/i18n/messages";
import type { CsvColumn } from "./CsvFormatHelp";

/**
 * Single source of truth for the CSV shapes the forms accept. Both the textarea
 * placeholder and the CsvFormatHelp block read from here, so the example a user sees
 * is always the example the parser was written against.
 *
 * Column names/rules mirror src/lib/anchors/csv_v2.ts (V2 + Пироги) and
 * src/lib/anchors/csv.ts (V1). Update them together.
 */

export const V2_CSV_EXAMPLE = `Target URL,Link Type,Number of links,URL,Brand,Generic,Keyword,GEO,Lang
https://example.com,Web 2.0,30,100,0,0,0,Russia,RU
https://example.com,Comment,30,0,100,0,0,Kazakhstan/Russia,RU:60/KZ:40
https://example.com,Profile,5,0,0,50,50,CIS,RU/KZ/UZ`;

export const PIROGI_CSV_EXAMPLE = `Target URL,Number of links,URL,Brand,Generic,Keyword,GEO,Lang
https://example1.com,800,0,75,15,10,Russia,RU
https://example2.com,400,0,75,15,10,Russia,RU`;

export const V1_CSV_EXAMPLE = `Target URL,Title,Keywords
https://example.com/page,Best crypto betting,crypto betting; bitcoin odds
https://example.com/other,,world cup odds`;

/** Matches the `t` returned by useT(), so unknown keys are still a compile error. */
type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** V2 and Пироги share a parser; Link Type is required only in V2. */
export function v2Columns(t: T, opts: { linkTypeRequired: boolean }): CsvColumn[] {
  return [
    { name: "Target URL", required: true, desc: t("form.csvColTargetUrl") },
    { name: "Link Type", required: opts.linkTypeRequired, desc: t("form.csvColLinkType") },
    { name: "Number of links", required: true, desc: t("form.csvColNumberOfLinks") },
    { name: "URL", required: true, desc: t("form.csvColDistUrl") },
    { name: "Brand", required: true, desc: t("form.csvColDistBrand") },
    { name: "Generic", required: true, desc: t("form.csvColDistGeneric") },
    { name: "Keyword", required: true, desc: t("form.csvColDistKeyword") },
    { name: "GEO", required: false, desc: t("form.csvColGeo") },
    { name: "Lang", required: false, desc: t("form.csvColLang") },
  ];
}

export function v2Notes(t: T): string[] {
  return [
    t("form.csvNoteDist"),
    t("form.csvNoteLang"),
    t("form.csvNoteAliases"),
    t("form.csvNoteDelimiters"),
  ];
}

export function v1Columns(t: T): CsvColumn[] {
  return [
    { name: "Target URL", required: true, desc: t("form.csvColTargetUrl") },
    { name: "Title", required: false, desc: t("form.csvColTitle") },
    { name: "Keywords", required: false, desc: t("form.csvColKeywords") },
  ];
}

export function v1Notes(t: T): string[] {
  return [t("form.csvNoteV1Row")];
}
