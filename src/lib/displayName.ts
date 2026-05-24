// Display-name attribution. Single source of truth for the localStorage key and
// the normalize/validate rules used by the picker UI and any code reading the name
// before passing it to a server action.
//
// No real auth — this is a "who created this" stamp inside an internal-VPN deployment.
// The value lives only in the user's browser; server stores whatever the client sends.

export const DISPLAY_NAME_LS_KEY = "anchor-gen-display-name";

/** Trim + clamp length. Empty → null so callers treat it as "no name yet". */
export function normalizeDisplayName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().slice(0, 60);
  return trimmed.length === 0 ? null : trimmed;
}

/** Validation for the picker form: returns an i18n key or null when valid. */
export function validateDisplayName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "displayName.errors.required";
  if (trimmed.length > 60) return "displayName.errors.tooLong";
  return null;
}
