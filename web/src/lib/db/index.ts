import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;

// Reuse the pool across hot reloads in dev. The drizzle wrapper is rebuilt per module load so a schema
// change (new table) is picked up without restarting the dev server.
const g = globalThis as unknown as { __pg?: ReturnType<typeof postgres> };
let instance: DB | undefined;

function create(): DB {
  g.__pg ??= postgres(env().DATABASE_URL, { max: 10, prepare: false });
  return drizzle(g.__pg, { schema });
}

export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    instance ??= create();
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export { schema };
