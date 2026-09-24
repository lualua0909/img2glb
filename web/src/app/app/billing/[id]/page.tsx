import { ChevronLeftIcon, CircleCheckIcon, CircleXIcon, ClockIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Button } from "@/components/ui/button";
import { formatVnd } from "@/lib/config";
import { billingEnabled, isLocal } from "@/lib/env";
import { getT } from "@/lib/i18n/server";
import { requireUser } from "@/server/auth";
import { bankInfo, getOrder, vietQrImageUrl } from "@/server/billing";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT()).meta.order };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold select-all">{value}</span>
    </div>
  );
}

export default async function OrderPage({ params }: PageProps<"/app/billing/[id]">) {
  const user = await requireUser();
  if (isLocal() || !billingEnabled()) notFound();
  const { id } = await params;
  const order = await getOrder(user.id, id);
  if (!order) notFound();
  const t = await getT();
  const bank = bankInfo();

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <Button asChild variant="ghost" className="-ml-3 self-start text-primary hover:text-primary">
        <Link href="/app/billing">
          <ChevronLeftIcon className="size-5" />
          {t.order.back}
        </Link>
      </Button>
      <div className="flex flex-col gap-5 rounded-3xl bg-card p-6 shadow-soft ring-1 ring-black/[0.04]">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">{t.common.credits(order.credits)}</h1>
          <p className="mt-0.5 text-lg font-semibold text-primary tabular-nums">{formatVnd(order.amount)}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t.order.scan}</p>
        </div>

        {order.status === "pending" ? (
          <>
            <AutoRefresh seconds={15} />
            <div className="mx-auto w-full max-w-72 rounded-3xl bg-white p-3 ring-1 ring-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={vietQrImageUrl(order)} alt={t.order.qrAlt} className="w-full rounded-2xl" />
            </div>
          </>
        ) : null}

        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl bg-secondary/50">
          <Row label={t.order.bank} value={bank.bankId} />
          <Row label={t.order.accountNo} value={bank.accountNo} />
          {bank.accountName ? <Row label={t.order.accountName} value={bank.accountName} /> : null}
          <Row label={t.order.amount} value={formatVnd(order.amount)} />
          <Row label={t.order.content} value={order.code} />
        </div>

        {order.status === "pending" ? (
          <p className="flex gap-2.5 rounded-2xl bg-primary/8 px-4 py-3 text-sm text-primary">
            <ClockIcon className="mt-0.5 size-4 shrink-0" />
            {t.order.waiting}
          </p>
        ) : order.status === "paid" ? (
          <p className="flex gap-2.5 rounded-2xl bg-success/10 px-4 py-3 text-sm text-success-foreground">
            <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
            {t.order.paid(order.credits)}
          </p>
        ) : (
          <p className="flex gap-2.5 rounded-2xl bg-secondary px-4 py-3 text-sm text-muted-foreground">
            <CircleXIcon className="mt-0.5 size-4 shrink-0" />
            {t.order.cancelled(order.code)}
          </p>
        )}
      </div>
    </div>
  );
}
