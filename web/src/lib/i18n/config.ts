// Shared (client + server) i18n settings. The locale lives in a cookie; no locale in the URL.
export const LOCALES = ["en", "vi"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", vi: "Tiếng Việt" };
/** BCP 47 tags for Intl date/number formatting. */
export const LOCALE_TAGS: Record<Locale, string> = { en: "en-US", vi: "vi-VN" };

export const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);
