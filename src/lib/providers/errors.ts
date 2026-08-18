/**
 * Node's fetch reports every transport-level failure as a bare `TypeError: fetch failed`
 * and hides the real reason on `.cause` (often nested). That message alone is useless in
 * a job's error banner — "Vertex AI: network error — fetch failed" tells nobody whether
 * DNS failed, a proxy refused the connection, or a TLS handshake was rejected.
 *
 * This walks the cause chain and appends whatever it finds, e.g.
 *   "fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND aiplatform.googleapis.com)"
 */
export function describeFetchError(e: unknown): string {
  const base = e instanceof Error ? e.message : String(e);
  const parts: string[] = [];
  const seen = new Set<unknown>();

  let cur: unknown = (e as { cause?: unknown })?.cause;
  while (cur && !seen.has(cur) && parts.length < 4) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    const msg = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    const piece = [code ? String(code) : "", msg].filter(Boolean).join(": ");
    if (piece && piece !== base) parts.push(piece);
    cur = (cur as { cause?: unknown }).cause;
  }

  return parts.length ? `${base} (${parts.join(" ← ")})` : base;
}
