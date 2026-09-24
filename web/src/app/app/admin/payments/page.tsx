import { AdminPaymentActions } from "@/components/admin-payment-actions";
import { formatVnd } from "@/lib/config";
import { LOCALE_TAGS } from "@/lib/i18n";
import { getLocale, getT } from "@/lib/i18n/server";
import { requireAdmin } from "@/server/auth";
import { listOrdersForAdmin } from "@/server/billing";

const LIST = "flex flex-col divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-black/[0.04]";

export default async function AdminPaymentsPage() {
  await requireAdmin();
  const [t, locale] = [await getT(), await getLocale()];
  const tp = t.admin.payments;
  const when = (d: Date | null) => d?.toLocaleString(LOCALE_TAGS[locale], { dateStyle: "medium", timeStyle: "short" });
  const [pending, paid] = await Promise.all([listOrdersForAdmin("pending"), listOrdersForAdmin("paid", 30)]);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="px-1">
          <h2 className="text-lg font-bold tracking-tight">{tp.pendingTitle}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{tp.pendingHint}</p>
        </div>
        <div className={LIST}>
          {pending.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{tp.noPending}</p> : null}
          {pending.map(({ order: o, email }) => (
            <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-sm">
              <div className="flex min-w-0 flex-col">
                <span className="font-semibold">
                  <span className="font-mono">{o.code}</span> · {formatVnd(o.amount)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {email} · {t.common.credits(o.credits)} · {when(o.createdAt)}
                </span>
              </div>
              <AdminPaymentActions id={o.id} />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="px-1 text-lg font-bold tracking-tight">{tp.recent}</h2>
        <div className={LIST}>
          {paid.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{tp.none}</p> : null}
          {paid.map(({ order: o, email }) => (
            <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-sm">
              <span className="font-semibold">
                <span className="font-mono">{o.code}</span> · {formatVnd(o.amount)}
              </span>
              <span className="text-xs text-muted-foreground">
                {email} · {tp.by(o.resolvedBy ?? "—")} · {when(o.resolvedAt)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
