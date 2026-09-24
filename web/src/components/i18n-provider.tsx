"use client";

import { createContext, use, type ReactNode } from "react";
import { dictionaries, type Dictionary, type Locale } from "@/lib/i18n";

const I18nContext = createContext<{ locale: Locale; t: Dictionary } | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <I18nContext value={{ locale, t: dictionaries[locale] }}>{children}</I18nContext>;
}

export function useI18n() {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}
