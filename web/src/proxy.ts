import { NextResponse, type NextRequest } from "next/server";

// Tencent Hunyuan 3D 2.0 Community License excludes the EU, UK and South Korea from the
// licensed Territory (§1.l, §5.c). Override with BLOCKED_COUNTRIES (comma-separated ISO codes).
const DEFAULT_BLOCKED =
  "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,GB,KR";
const BLOCKED = new Set(
  (process.env.BLOCKED_COUNTRIES ?? DEFAULT_BLOCKED)
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean),
);

function country(req: NextRequest) {
  // Vercel / Cloudflare / custom edge header.
  return (
    req.headers.get("x-vercel-ip-country") ??
    req.headers.get("cf-ipcountry") ??
    req.headers.get("x-country-code") ??
    ""
  ).toUpperCase();
}

const LOCAL = process.env.APP_ENV === "local";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Personal/local mode: skip marketing + geo-block, go straight to the studio.
  if (LOCAL && pathname === "/") return NextResponse.redirect(new URL("/app", req.url));
  const isCron = pathname.startsWith("/api/cron/");

  if (!LOCAL && !isCron && pathname !== "/unavailable" && BLOCKED.has(country(req))) {
    if (pathname.startsWith("/api/")) return Response.json({ error: "Service unavailable in your region" }, { status: 451 });
    return NextResponse.rewrite(new URL("/unavailable", req.url), { status: 451 });
  }

  // Optimistic auth redirect; pages and APIs still verify the session server-side.
  if (pathname.startsWith("/app") && !req.cookies.has("__session")) {
    const url = new URL("/sign-in", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|samples/|.*\\.(?:png|jpg|svg|glb|txt)$).*)"],
};
