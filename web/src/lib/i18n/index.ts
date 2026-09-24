import type { Locale } from "./config";
import { en, type Dictionary } from "./dictionaries/en";
import { vi } from "./dictionaries/vi";

export type { Dictionary };
export * from "./config";

export const dictionaries: Record<Locale, Dictionary> = { en, vi };
