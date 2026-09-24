import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { DEFAULT_LOCALE, dictionaries, isLocale, LOCALE_COOKIE, type Locale } from ".";

/** Cookie set by the language switcher, else the browser's Accept-Language, else English. */
export const getLocale = cache(async (): Promise<Locale> => {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;
  const accepted = ((await headers()).get("accept-language") ?? "")
    .split(",")
    .map((part) => part.split(";")[0].trim().split("-")[0].toLowerCase());
  return accepted.find(isLocale) ?? DEFAULT_LOCALE;
});

export async function getT() {
  return dictionaries[await getLocale()];
}
