import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

type DB = ReturnType<typeof drizzle<typeof schema>>;

// Reuse the pool across hot reloads in dev.
const g = globalThis as unknown as { __db?: DB };

function create(): DB {
  const client = postgres(env().DATABASE_URL, { max: 10, prepare: false });
  return drizzle(client, { schema });
}

export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    g.__db ??= create();
    const value = Reflect.get(g.__db, prop);
    return typeof value === "function" ? value.bind(g.__db) : value;
  },
});

export { schema };
