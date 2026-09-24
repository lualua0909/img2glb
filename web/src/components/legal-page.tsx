import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-16">
        <article className="rounded-3xl bg-card p-7 shadow-soft ring-1 ring-black/[0.04] sm:p-12">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{title}</h1>
          <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_h2]:pt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground">
            {children}
          </div>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
