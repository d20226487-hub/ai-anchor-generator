"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useT } from "@/lib/i18n/I18nProvider";
import { DISPLAY_NAME_LS_KEY, normalizeDisplayName, validateDisplayName } from "@/lib/displayName";

interface DisplayNameContext {
  /** Current name, or null until ready+set. Treat null as "no attribution available". */
  name: string | null;
  /** True after the initial localStorage read on mount (avoids SSR hydration mismatch). */
  ready: boolean;
  /** Persist a new name. Pass null to clear (re-triggers the first-visit modal). */
  setName: (next: string | null) => void;
  /** Open the editor (the pill in Nav uses this). */
  openEditor: () => void;
}

const Ctx = React.createContext<DisplayNameContext | null>(null);

export function useDisplayName(): DisplayNameContext {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useDisplayName must be used inside <DisplayNameProvider>");
  return c;
}

export function DisplayNameProvider({ children }: { children: React.ReactNode }) {
  const [name, setNameState] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);

  // Read on mount. Browser-only; the server render always sees ready=false / name=null
  // so the modal won't appear in SSR (which would otherwise hydration-mismatch).
  React.useEffect(() => {
    try {
      const stored = normalizeDisplayName(localStorage.getItem(DISPLAY_NAME_LS_KEY));
      setNameState(stored);
    } catch {
      // localStorage can throw in Safari private mode etc. Treat as "no name".
    }
    setReady(true);
  }, []);

  const setName = React.useCallback((next: string | null) => {
    const norm = normalizeDisplayName(next);
    setNameState(norm);
    try {
      if (norm == null) localStorage.removeItem(DISPLAY_NAME_LS_KEY);
      else localStorage.setItem(DISPLAY_NAME_LS_KEY, norm);
    } catch {
      // Best-effort; the in-memory state is still valid for the session.
    }
  }, []);

  const value = React.useMemo<DisplayNameContext>(() => ({
    name,
    ready,
    setName,
    openEditor: () => setEditorOpen(true),
  }), [name, ready, setName]);

  // First-visit modal: ready + no name = block the UI until the user provides one.
  // This is a hard requirement per the org design — every job/folder needs attribution.
  const requireFirstVisit = ready && name == null;

  return (
    <Ctx.Provider value={value}>
      {children}
      {requireFirstVisit && <FirstVisitModal onSubmit={setName} />}
      {editorOpen && (
        <EditorModal
          initial={name ?? ""}
          onClose={() => setEditorOpen(false)}
          onSubmit={(v) => { setName(v); setEditorOpen(false); }}
        />
      )}
    </Ctx.Provider>
  );
}

/** Non-dismissable modal — no close X, no escape, no outside-click. The user MUST enter a name. */
function FirstVisitModal({ onSubmit }: { onSubmit: (name: string) => void }) {
  const { t } = useT();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  function submit() {
    const errKey = validateDisplayName(value);
    if (errKey) { setError(t(errKey as Parameters<typeof t>[0])); return; }
    onSubmit(value);
  }

  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <DialogPrimitive.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[60] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl focus:outline-none"
        >
          <DialogPrimitive.Title className="text-base font-semibold">
            {t("displayName.firstVisitTitle")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-[var(--color-text-dim)] mt-1">
            {t("displayName.firstVisitDesc")}
          </DialogPrimitive.Description>
          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="mt-4 space-y-3"
          >
            <Input
              autoFocus
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null); }}
              placeholder={t("displayName.placeholder")}
              maxLength={60}
              aria-invalid={error != null}
            />
            {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit">{t("displayName.confirm")}</Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Editor — dismissable. Opened from the header pill. */
function EditorModal({ initial, onClose, onSubmit }: { initial: string; onClose: () => void; onSubmit: (name: string) => void }) {
  const { t } = useT();
  const [value, setValue] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);

  function submit() {
    const errKey = validateDisplayName(value);
    if (errKey) { setError(t(errKey as Parameters<typeof t>[0])); return; }
    onSubmit(value);
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl focus:outline-none">
          <DialogPrimitive.Title className="text-base font-semibold">
            {t("displayName.editorTitle")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-[var(--color-text-dim)] mt-1">
            {t("displayName.editorDesc")}
          </DialogPrimitive.Description>
          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="mt-4 space-y-3"
          >
            <Input
              autoFocus
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null); }}
              placeholder={t("displayName.placeholder")}
              maxLength={60}
              aria-invalid={error != null}
            />
            {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
              <Button type="submit">{t("common.save")}</Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
