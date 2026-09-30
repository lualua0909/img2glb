import "server-only";
import { env } from "@/lib/env";
import { createHunyuanProvider } from "./hunyuan";
import type { GenerationProvider } from "./types";

const g = globalThis as unknown as { __providers?: Map<string, GenerationProvider> };

/** The only engine: the Hunyuan3D-2.1 worker at HUNYUAN_WORKER_URL. Stored in `generation.provider`. */
export const PROVIDER = "hunyuan21";

/** Jobs from removed engines (e.g. Hunyuan3D-2.0, `hunyuan`) fail with "Unknown provider". */
export function getProvider(name: string): GenerationProvider {
  g.__providers ??= new Map();
  let p = g.__providers.get(name);
  if (!p) {
    const e = env();
    if (name !== PROVIDER || !e.HUNYUAN_WORKER_URL || !e.HUNYUAN_WORKER_TOKEN) throw new Error(`Unknown provider: ${name}`);
    p = createHunyuanProvider({ name, url: e.HUNYUAN_WORKER_URL, token: e.HUNYUAN_WORKER_TOKEN });
    g.__providers.set(name, p);
  }
  return p;
}

export type { GenerationProvider } from "./types";
