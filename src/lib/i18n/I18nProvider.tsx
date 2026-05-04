"use client";

import * as React from "react";
import { getMessages, translate, type Messages, type MessageKey } from "./messages";
import type { Locale } from "../types";

interface I18nContextValue {
  locale: Locale;
  msgs: Messages;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = React.useMemo<I18nContextValue>(() => {
    const msgs = getMessages(locale);
    return {
      locale,
      msgs,
      t: (key: MessageKey, vars?: Record<string, string | number>) => translate(msgs, key, vars),
    };
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used inside I18nProvider");
  return ctx;
}
