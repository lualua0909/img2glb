import { ChevronRightIcon, ClockIcon, CoinsIcon, MinusIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuyButton } from "@/components/buy-button";
import { PackCard } from "@/components/pack-card";
import { CREDIT_PACKS, formatVnd } from "@/lib/config";
import { billingEnabled, isLocal } from "@/lib/env";
import { LOCALE_TAGS } from "@/lib/i18n";
import { getLocale, getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";
import { requireUser } from "@/server/auth";
import { listOrders } from "@/server/billing";
import { getCredits, listLedger } from "@/server/queries";
import { getSettings } from "@/server/settings";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.billing };
}

export default async function BillingPage() {
  const user = await requireUser();
  if (isLocal()) notFound();
  const [t, locale] = [await getT(), await getLocale()];
  const [credits, ledger, orders, { credits: cost }] = await Promise.all([
    getCredits(user.id),
    listLedger(user.id),
    listOrders(user.id),
    getSettings(),
  ]);
  const pending = orders.filter((o) => o.status === "pending");
  const enabled = billingEnabled();

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-bold tracking-tight">{t.billing.title}</h1>

      {pending.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-warning/10 p-4 text-sm">
          <div className="flex gap-2.5 text-warning-foreground">
            <ClockIcon className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-semibold">{t.billing.pendingTitle}</p>
              <p>{t.billing.pendingBody}</p>
            </div>
          </div>
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card">
            {pending.map((o) => (
              <Link
                key={o.id}
                href={`/app/billing/${o.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted"
              >
                <span className="font-mono text-[13px]">{o.code}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {t.common.credits(o.credits)} · {formatVnd(o.amount)}
                  <ChevronRightIcon className="size-4" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="relative isolate overflow-hidden rounded-3xl bg-linear-to-br from-[#0a84ff] to-[#5e5ce6] p-6 text-white shadow-float sm:p-8">
        <CoinsIcon aria-hidden className="absolute -right-6 -bottom-8 -z-10 size-44 text-white/10" />
        <p className="text-sm font-semibold text-white/80">{t.billing.balance}</p>
        <p className="mt-1 text-5xl font-bold tracking-tight tabular-nums">
          {credits.toLocaleString(LOCALE_TAGS[locale])}{" "}
          <span className="text-xl font-semibold text-white/80">{t.billing.creditsUnit}</span>
        </p>
        <p className="mt-4 text-sm text-white/85">{t.billing.costs(cost)}</p>
        <p className="text-sm text-white/70">{t.billing.refundNote}</p>
      </div>

      <section className="flex flex-col gap-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight">{t.billing.packsTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.billing.packsBody}</p>
        </div>
        <div className="grid gap-5 pt-2 md:grid-cols-3">
          {CREDIT_PACKS.map((p) => (
            <PackCard key={p.id} pack={p} texturedCost={cost.textured}>
              <BuyButton packId={p.id} featured={"featured" in p} disabled={!enabled} />
            </PackCard>
          ))}
        </div>
        {!enabled ? <p className="text-sm text-muted-foreground">{t.billing.notConfigured}</p> : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold tracking-tight">{t.billing.history}</h2>
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-black/[0.04]">
          {ledger.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t.billing.noTx}</p> : null}
          {ledger.map((l) => (
            <div key={l.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full",
                  l.delta > 0 ? "bg-success/15 text-success-foreground" : "bg-secondary text-muted-foreground",
                )}
              >
                {l.delta > 0 ? <PlusIcon className="size-4" /> : <MinusIcon className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{t.billing.reasons[l.reason] ?? l.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {l.createdAt.toLocaleString(LOCALE_TAGS[locale], { dateStyle: "medium", timeStyle: "short" })}
                </p>
              </div>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  l.delta > 0 ? "text-success-foreground" : "text-muted-foreground",
                )}
              >
                {l.delta > 0 ? `+${l.delta}` : l.delta}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
