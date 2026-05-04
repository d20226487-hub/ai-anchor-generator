import type { Brand, JobAnchor } from "../types";

export function hostnameOf(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function matchBrand(targetUrl: string, brands: Brand[]): Brand | null {
  const host = hostnameOf(targetUrl);
  for (const b of brands) {
    for (const d of b.domains) {
      const dh = d.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase();
      if (dh && (host === dh || host.endsWith(`.${dh}`))) {
        return b;
      }
    }
  }
  return null;
}

export function brandKeyOf(a: JobAnchor, brands: Brand[]): string {
  if (a.brandId) {
    const b = brands.find((x) => x.id === a.brandId);
    if (b) return b.id;
  }
  const m = matchBrand(a.targetUrl, brands);
  if (m) return m.id;
  return hostnameOf(a.targetUrl);
}

export function brandLabelOf(key: string, brands: Brand[]): string {
  const b = brands.find((x) => x.id === key);
  return b ? b.name : key;
}
