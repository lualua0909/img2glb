import Link from "next/link";
import { APP_NAME, OPERATOR_NAME } from "@/lib/config";
import { getT } from "@/lib/i18n/server";
import { Logo } from "./logo";

// Disclosures required by the Tencent Hunyuan 3D 2.0 Community License §3(a), §3(c), §3(e).
// The attribution and license notice stay in English, verbatim, in every language.
export async function SiteFooter() {
  const t = await getT();
  return (
    <footer className="border-t border-black/5 bg-card/60">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1fr_2fr]">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">{t.site.tagline}</p>
        </div>
        <div className="flex flex-col gap-4 text-xs leading-relaxed text-muted-foreground">
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-foreground">
            <Link href="/terms" className="hover:text-primary">
              {t.site.terms}
            </Link>
            <Link href="/privacy" className="hover:text-primary">
              {t.site.privacy}
            </Link>
            <a href="/HUNYUAN3D_LICENSE.txt" className="hover:text-primary">
              {t.site.license}
            </a>
          </nav>
          <p>
            {t.site.operatedBy(APP_NAME, OPERATOR_NAME)} Powered by Tencent Hunyuan. Tencent Hunyuan 3D 2.0 is licensed
            under the Tencent Hunyuan 3D 2.0 Community License Agreement, Copyright © 2025 Tencent. All Rights Reserved.
            The trademark rights of “Tencent Hunyuan” are owned by Tencent or its affiliate. Tencent is not affiliated
            with, associated with, sponsoring, or endorsing this service.
          </p>
          <p>
            © {new Date().getFullYear()} {OPERATOR_NAME}
          </p>
        </div>
      </div>
    </footer>
  );
}
