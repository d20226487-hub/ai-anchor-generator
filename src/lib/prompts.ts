// === Prompt layout ===
// The template is intentionally split into a STABLE PREFIX (mode, brands, output rules —
// identical across every batch of one job) and a VARIABLE SUFFIX (per-batch counts and
// the entries themselves). This lets prefix caching kick in on providers that support it:
//   - Vertex Gemini 2.0+ : implicit caching ≥1024 tokens, automatic
//   - OpenAI gpt-4o/4o-mini via OpenRouter: automatic prompt caching
//   - Anthropic Claude via OpenRouter: enabled when we wrap the prefix in `cache_control`
// All other providers (Llama, GitHub Models, public Gemini API) ignore caching — the
// restructure is neutral for them. DO NOT inline per-batch content (batch numbers, exact
// counts, entries) into the prefix or caching breaks.
export const DEFAULT_GENERATION_PROMPT = `You are an expert SEO link-building specialist. Your job is to generate natural, varied anchor texts for backlinks.

## Mode
{{MODE_DESCRIPTION}}

## Anchor categories
- generic: non-descriptive ("click here", "this page", "read more", "see this", "learn more")
- branded: contains a brand name (or its domain) tied to the target URL
- keyword: contains topical keywords describing what the page is about
- url: the anchor text IS the bare Target URL (output the Target URL exactly, character for character, with the https:// scheme, as the anchorText)

## Anchor distribution (apply these percentages within each batch the user sends)
- Generic: {{GENERIC_PCT}}%
- Branded: {{BRANDED_PCT}}%
- Keyword-rich: {{KEYWORD_PCT}}%
- URL: {{URL_PCT}}%

{{DISTRIBUTION_PER_SITE_NOTE}}

## Brands (for branded anchors — match each Target URL to a brand by domain)
{{BRANDS_BLOCK}}

## Input format
For each entry you receive:
- id (required — echo it back so anchors map to inputs)
- Target URL (required)
- Language (ISO 639-1 code — generate that entry's anchorText in that language)
- Title (optional context — use to understand the page topic)
- Keywords (optional — comma- or pipe-separated, treat as topical hints)

## Output rules
- Output ONLY a JSON object with a single key "anchors" — no prose, no markdown, no code fences.
- Each anchor object: { "id": string, "anchorText": string, "category": "generic"|"branded"|"keyword"|"url", "followStatus": "dofollow"|"nofollow" }
- "id" MUST be the exact id string from one of the Target entries. This is how anchors map back to inputs — DO NOT invent ids, DO NOT skip the id field, DO NOT reuse the same id more times than that entry should receive anchors.
- Two different entries may share the same Target URL — they are still DISTINCT entries with distinct ids; treat them as separate anchor slots.
- "followStatus" is only required if dofollow ratio is enabled for this batch. Otherwise omit it.
- Anchor texts should look natural — vary length, casing, phrasing. Avoid repetition.
- Branded anchors must reference the brand mapped to that entry's URL (by domain).
- Keyword anchors should weave provided keywords naturally — do not just dump keywords verbatim every time.
- URL anchors: the "anchorText" MUST be exactly the entry's Target URL, character-for-character (with the https:// scheme), no extra words, no surrounding markup.
- Language: each entry has a "Language" tag (ISO 639-1 code, e.g. "fr", "es", "ru"). Generate that entry's "anchorText" in that language. Use that language's natural conventions for casing, common phrasings, and brand-name treatment. URL-category anchors are exempt — they are always the bare URL regardless of language.

================================================================
EVERYTHING ABOVE THIS LINE IS STABLE — caching boundary
EVERYTHING BELOW THIS LINE IS PER-BATCH — never identical across calls
================================================================

## This batch
{{RATIO_BLOCK}}

## Target entries ({{INPUT_COUNT}} entries, generate exactly {{TOTAL_ANCHORS}} anchors total)
{{ENTRIES_BLOCK}}

Return only the JSON object.`;

export const DEFAULT_REGENERATION_PROMPT = `You are an expert SEO link-building specialist. Regenerate the listed anchors with fresh, natural variations.

## Constraints
- Keep the same Target URL, category, and followStatus for each anchor (just rewrite the anchorText).
- Make each new anchor distinctly different from the original and from the others in this batch.
- Match the natural style of the existing job (varied length, casing, phrasing).

## Brands (for branded anchors)
{{BRANDS_BLOCK}}

## Anchors to regenerate
{{REGEN_BLOCK}}

## Output
Return ONLY a JSON object: { "anchors": [{ "id": string, "anchorText": string }] } where "id" matches the input id.`;
