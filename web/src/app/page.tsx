import {
  ArrowRightIcon,
  BoxIcon,
  BrushIcon,
  CheckIcon,
  ClapperboardIcon,
  ClockIcon,
  DownloadIcon,
  Gamepad2Icon,
  GraduationCapIcon,
  ImageIcon,
  LightbulbIcon,
  PaletteIcon,
  PrinterIcon,
  ScanEyeIcon,
  ShoppingBagIcon,
  SparklesIcon,
  TypeIcon,
  UploadIcon,
} from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { GradientBackdrop } from "@/components/backdrop";
import { ModelViewer } from "@/components/model-viewer";
import { PackCard } from "@/components/pack-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { CREDIT_PACKS } from "@/lib/config";
import { getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { getSettings } from "@/server/settings";

// Icon + iOS-style tile gradient per feature, in the order of `landing.features`.
const FEATURES = [
  { icon: ImageIcon, tint: "from-[#0a84ff] to-[#0060df]" },
  { icon: TypeIcon, tint: "from-[#bf5af2] to-[#8944ab]" },
  { icon: PaletteIcon, tint: "from-[#ff9f0a] to-[#ff6a00]" },
  { icon: BrushIcon, tint: "from-[#ff375f] to-[#d70f4f]" },
  { icon: DownloadIcon, tint: "from-[#30d158] to-[#1f9d45]" },
  { icon: ScanEyeIcon, tint: "from-[#64d2ff] to-[#0a9bd8]" },
];
const STEP_ICONS = [UploadIcon, SparklesIcon, DownloadIcon];
const USE_ICONS = [Gamepad2Icon, PrinterIcon, ShoppingBagIcon, LightbulbIcon, ClapperboardIcon, GraduationCapIcon];
const TOOLS = ["Blender", "Unity", "Unreal Engine", "Godot", "Three.js", "Cura"];

function SectionHeading({ title, body }: { title: string; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <h2 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {body ? <p className="mt-3 text-muted-foreground text-pretty">{body}</p> : null}
    </div>
  );
}

export default async function Home() {
  await connection(); // credit costs are admin settings (DB), so render per request
  const [t, { credits: cost }] = await Promise.all([getT(), getSettings()]);
  const l = t.landing;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <section className="relative isolate overflow-hidden">
          <GradientBackdrop />
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 pt-14 pb-20 sm:px-6 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:pb-28">
            <div>
              <span className="glass inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-black/5">
                <SparklesIcon className="size-3.5 text-primary" />
                {l.badge}
              </span>
              <h1 className="mt-6 text-[2.5rem] leading-[1.08] font-bold tracking-tight text-balance sm:text-[3.5rem]">
                {l.titleBefore} <span className="text-gradient">{l.titleHighlight}</span> {l.titleAfter}
              </h1>
              <p className="mt-5 max-w-xl text-lg text-muted-foreground text-pretty">{l.body}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href="/sign-up">
                    {l.ctaPrimary}
                    <ArrowRightIcon />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <a href="#how">{l.ctaSecondary}</a>
                </Button>
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                {[l.noCard, cost.signupBonus > 0 ? l.bonus(cost.signupBonus) : null]
                  .filter((s): s is string => Boolean(s))
                  .map((s) => (
                    <li key={s} className="flex items-center gap-1.5">
                      <CheckIcon className="size-4 text-success" strokeWidth={2.5} />
                      {s}
                    </li>
                  ))}
              </ul>
            </div>

            <div className="relative">
              <div className="aspect-square rounded-[2rem] bg-card p-2 shadow-float ring-1 ring-black/5">
                <div className="size-full overflow-hidden rounded-[1.5rem] bg-stage">
                  <ModelViewer src="/samples/sample.glb" alt={l.sampleAlt} />
                </div>
              </div>
              <div className="glass absolute bottom-10 -left-3 flex items-center gap-2.5 rounded-2xl py-2 pr-4 pl-2 text-sm font-semibold shadow-float ring-1 ring-black/5 sm:-left-6">
                <span className="grid size-8 place-items-center rounded-xl bg-primary text-white">
                  <ClockIcon className="size-4" />
                </span>
                {l.chipTime}
              </div>
              <div className="glass absolute top-10 -right-2 rounded-2xl px-4 py-2.5 text-sm font-semibold shadow-float ring-1 ring-black/5 sm:-right-5">
                GLB · STL · OBJ · USDZ
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-black/5 bg-card/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-8 sm:px-6 md:flex-row md:justify-between">
            <p className="text-sm font-semibold text-muted-foreground">{l.worksWith}</p>
            <div className="flex flex-wrap justify-center gap-x-8 gap-y-2 text-base font-bold tracking-tight text-foreground/35">
              {TOOLS.map((tool) => (
                <span key={tool}>{tool}</span>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-24 sm:px-6">
          <SectionHeading title={l.featuresTitle} body={l.featuresBody} />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {l.features.map((f, i) => {
              const { icon: Icon, tint } = FEATURES[i];
              return (
                <div
                  key={f.title}
                  className="rounded-3xl bg-card p-6 shadow-soft ring-1 ring-black/[0.04] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-float"
                >
                  <span className={cn("grid size-11 place-items-center rounded-[12px] bg-linear-to-br text-white shadow-sm", tint)}>
                    <Icon className="size-5" />
                  </span>
                  <p className="mt-5 font-semibold">{f.title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section id="how" className="scroll-mt-16 border-y border-black/5 bg-card">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <SectionHeading title={l.howTitle} body={l.howBody} />
            <ol className="mt-12 grid gap-4 md:grid-cols-3">
              {l.steps.map((s, i) => {
                const Icon = STEP_ICONS[i];
                return (
                  <li key={s.title} className="rounded-3xl bg-background p-6">
                    <div className="flex items-center gap-3">
                      <span className="grid size-10 place-items-center rounded-full bg-primary text-white shadow-sm shadow-primary/30">
                        <Icon className="size-5" />
                      </span>
                      <span className="text-xs font-bold tracking-wider text-primary uppercase">{l.step(i + 1)}</span>
                    </div>
                    <p className="mt-5 text-lg font-semibold">{s.title}</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <SectionHeading title={l.usesTitle} body={l.usesBody} />
          <div className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {l.uses.map((u, i) => {
              const Icon = USE_ICONS[i];
              return (
                <div key={u.title} className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </span>
                  <div>
                    <p className="font-semibold">{u.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{u.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section id="pricing" className="scroll-mt-16 border-y border-black/5 bg-card/60">
          <div className="mx-auto max-w-5xl px-4 py-24 sm:px-6">
            <SectionHeading title={l.pricingTitle} body={l.pricingBody(cost)} />
            <div className="mt-14 grid gap-5 md:grid-cols-3">
              {CREDIT_PACKS.map((p) => (
                <PackCard key={p.id} pack={p} texturedCost={cost.textured}>
                  <Button asChild size="lg" variant={"featured" in p ? "default" : "outline"} className="w-full">
                    <Link href="/sign-up">{l.getStarted}</Link>
                  </Button>
                </PackCard>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-3xl scroll-mt-16 px-4 py-24 sm:px-6">
          <SectionHeading title={l.faqTitle} />
          <Accordion type="single" collapsible className="mt-10 rounded-3xl bg-card px-6 shadow-soft ring-1 ring-black/[0.04]">
            {l.faq.map((f, i) => (
              <AccordionItem key={f.q} value={`q${i}`}>
                <AccordionTrigger className="py-5 text-base font-semibold hover:no-underline">{f.q}</AccordionTrigger>
                <AccordionContent className="pb-5 text-[15px] leading-relaxed text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="relative isolate overflow-hidden rounded-[2rem] bg-linear-to-br from-[#0a84ff] via-[#5e5ce6] to-[#bf5af2] px-6 py-16 text-center text-white shadow-float sm:px-12">
            <BoxIcon aria-hidden className="absolute -top-10 -right-10 -z-10 size-56 text-white/10" strokeWidth={1.2} />
            <BoxIcon aria-hidden className="absolute -bottom-12 -left-8 -z-10 size-40 text-white/10" strokeWidth={1.2} />
            <h2 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">{l.ctaTitle}</h2>
            <p className="mt-3 text-white/85">{l.ctaBody}</p>
            <Button asChild size="lg" className="mt-8 bg-white text-[#0071e3] shadow-none hover:bg-white/90">
              <Link href="/sign-up">
                {l.ctaButton}
                <ArrowRightIcon />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
