"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

interface ToastItem {
  id: number;
  message: string;
  variant: "info" | "success" | "error";
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastItem["variant"]) => void;
}

const Ctx = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);

  const toast = React.useCallback((message: string, variant: ToastItem["variant"] = "info") => {
    const id = ++idRef.current;
    setItems((s) => [...s, { id, message, variant }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {items.map((it) => (
          <div
            key={it.id}
            className={cn(
              "rounded-md px-4 py-3 text-sm shadow-lg border animate-in slide-in-from-right-5",
              it.variant === "success" && "bg-[var(--color-success)]/10 border-[var(--color-success)]/30 text-[var(--color-success)]",
              it.variant === "error" && "bg-[var(--color-danger)]/10 border-[var(--color-danger)]/30 text-[var(--color-danger)]",
              it.variant === "info" && "bg-[var(--color-surface-2)] border-[var(--color-border)]"
            )}
          >
            {it.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastContextValue {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside ToastProvider");
  return v;
}
