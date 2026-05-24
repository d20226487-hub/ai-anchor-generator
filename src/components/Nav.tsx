"use client";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Anchor, BookOpen, Home, Moon, Plus, Settings, Sun, Trash2, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/I18nProvider";
import { actionSetLocale, actionSetTheme } from "@/lib/actions";
import { useDisplayName } from "@/components/DisplayNameProvider";
import type { Locale, Theme } from "@/lib/types";
import * as React from "react";

export function Nav({ locale, theme }: { locale: Locale; theme: Theme }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useT();
  const { name: displayName, ready: displayNameReady, openEditor: openDisplayNameEditor } = useDisplayName();
  const [pending, setPending] = React.useState(false);
  const [themePending, setThemePending] = React.useState(false);

  const links = [
    { href: "/", label: t("nav.home"), icon: Home },
    { href: "/jobs/new", label: t("nav.newJob"), icon: Plus },
    { href: "/trash", label: t("nav.trash"), icon: Trash2 },
    { href: "/docs", label: t("nav.docs"), icon: BookOpen },
    { href: "/settings", label: t("nav.settings"), icon: Settings },
  ];

  async function setLocale(next: Locale) {
    if (next === locale || pending) return;
    setPending(true);
    await actionSetLocale(next);
    router.refresh();
    setPending(false);
  }

  async function toggleTheme() {
    if (themePending) return;
    setThemePending(true);
    const next: Theme = theme === "dark" ? "light" : "dark";
    await actionSetTheme(next);
    router.refresh();
    setThemePending(false);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold text-sm">
          <Anchor className="h-4 w-4 text-[var(--color-accent)]" />
          {t("app.title")}
        </Link>
        <div className="flex items-center gap-3">
          <nav className="flex items-center gap-1">
            {links.map((l) => {
              const active = pathname === l.href || (l.href !== "/" && pathname.startsWith(l.href));
              const Icon = l.icon;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={cn(
                    "flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium transition-colors",
                    active
                      ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                      : "text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" /> {l.label}
                </Link>
              );
            })}
          </nav>
          <button
            type="button"
            onClick={openDisplayNameEditor}
            title={displayName ? t("displayName.headerTitleSet", { name: displayName }) : t("displayName.headerTitleEmpty")}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors text-xs max-w-[160px]"
          >
            <User className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {displayNameReady && displayName ? displayName : t("displayName.headerEmpty")}
            </span>
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            disabled={themePending}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className={cn(
              "h-7 w-7 inline-flex items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors",
              themePending && "opacity-50 cursor-wait"
            )}
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <div className="flex items-center rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
            {(["en", "ru"] as const).map((loc) => (
              <button
                key={loc}
                type="button"
                onClick={() => setLocale(loc)}
                disabled={pending}
                aria-pressed={locale === loc}
                className={cn(
                  "px-2.5 h-7 text-[11px] uppercase font-bold tracking-wider transition-colors",
                  locale === loc
                    ? "bg-[var(--color-accent)] text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.25)]"
                    : "text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
                  pending && "opacity-50 cursor-wait"
                )}
                title={loc === "en" ? "English" : "Русский"}
              >
                {loc}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
