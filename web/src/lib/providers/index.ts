import "server-only";
import { env } from "@/lib/env";
import type { AppSettings } from "@/lib/settings";
import { createHunyuanProvider } from "./hunyuan";
import type { GenerationProvider } from "./types";

const g = globalThis as unknown as { __providers?: Map<string, GenerationProvider> };

/** Engines whose worker is configured in env: hunyuan (Hunyuan3D-2.0) and hunyuan21 (Hunyuan3D-2.1). */
export function configuredProviders(): AppSettings["generation"]["provider"][] {
  const e = env();
  if (!e.HUNYUAN_WORKER_URL || !e.HUNYUAN_WORKER_TOKEN) return [];
  return e.HUNYUAN21_WORKER_URL ? ["hunyuan", "hunyuan21"] : ["hunyuan"];
}

/** Jobs from removed or unconfigured engines fail with "Unknown provider". */
export function getProvider(name: string): GenerationProvider {
  g.__providers ??= new Map();
  let p = g.__providers.get(name);
  if (!p) {
    const e = env();
    const url = { hunyuan: e.HUNYUAN_WORKER_URL, hunyuan21: e.HUNYUAN21_WORKER_URL }[name];
    if (!url || !e.HUNYUAN_WORKER_TOKEN) throw new Error(`Unknown provider: ${name}`);
    p = createHunyuanProvider({ name, url, token: e.HUNYUAN_WORKER_TOKEN });
    g.__providers.set(name, p);
  }
  return p;
}

export type { GenerationProvider } from "./types";
