import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import { I18nProvider } from "@/components/i18n-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_NAME } from "@/lib/config";
import { getLocale, getT } from "@/lib/i18n/server";
import "./globals.css";

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin", "vietnamese"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
    title: { default: t.meta.title(APP_NAME), template: `%s · ${APP_NAME}` },
    description: t.meta.description,
  };
}

export const viewport: Viewport = { themeColor: "#f5f5f7", viewportFit: "cover" };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${montserrat.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <I18nProvider locale={locale}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </I18nProvider>
      </body>
    </html>
  );
}
