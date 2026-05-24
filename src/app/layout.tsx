import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ToastProvider } from "@/components/ui/Toast";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { DisplayNameProvider } from "@/components/DisplayNameProvider";
import { loadSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "AI Anchor Generator",
  description: "Generate natural anchor texts for link building",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const settings = await loadSettings();
  const locale = settings.locale ?? "en";
  const theme = settings.theme ?? "dark";
  return (
    <html lang={locale} data-theme={theme} className="h-full">
      <body className="min-h-full">
        <I18nProvider locale={locale}>
          <DisplayNameProvider>
            <ToastProvider>
              <Nav locale={locale} theme={theme} />
              <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
            </ToastProvider>
          </DisplayNameProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
