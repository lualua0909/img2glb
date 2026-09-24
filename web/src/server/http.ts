import "server-only";
import { getSession, isAdmin } from "./auth";
import { InsufficientCreditsError } from "./credits";
import { UserFacingError } from "./generations";

export const jsonError = (message: string, status: number) => Response.json({ error: message }, { status });

/** Wraps an authenticated route handler with session lookup and uniform error mapping. */
export function withUser<Ctx>(
  handler: (req: Request, user: { id: string; email: string }, ctx: Ctx) => Promise<Response>,
  opts: { admin?: boolean } = {},
) {
  return async (req: Request, ctx: Ctx) => {
    const session = await getSession();
    if (!session) return jsonError("Unauthorized", 401);
    if (opts.admin && !isAdmin(session.user)) return jsonError("Not found", 404);
    try {
      return await handler(req, session.user, ctx);
    } catch (err) {
      if (err instanceof UserFacingError) return jsonError(err.message, err.status);
      if (err instanceof InsufficientCreditsError) return jsonError("Not enough credits", 402);
      console.error(`[api] ${req.method} ${new URL(req.url).pathname}`, err);
      return jsonError("Internal server error", 500);
    }
  };
}

/** Same as withUser, restricted to ADMIN_EMAILS. */
export const withAdmin = <Ctx>(handler: Parameters<typeof withUser<Ctx>>[0]) => withUser(handler, { admin: true });
