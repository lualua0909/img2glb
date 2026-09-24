import { CheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatVnd, type CREDIT_PACKS } from "@/lib/config";
import { getT } from "@/lib/i18n/server";
import { cn } from "@/lib/utils";

/** Credit pack pricing card; `children` is the call to action. */
export async function PackCard({
  pack,
  texturedCost,
  children,
}: {
  pack: (typeof CREDIT_PACKS)[number];
  texturedCost: number;
  children: React.ReactNode;
}) {
  const t = await getT();
  const featured = "featured" in pack;
  const perks = [
    texturedCost > 0 ? t.packs.models(Math.floor(pack.credits / texturedCost)) : null,
    t.packs.neverExpire,
    t.packs.refunded,
  ].filter((p): p is string => Boolean(p));
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-3xl bg-card p-6 ring-1 ring-black/[0.04]",
        featured ? "shadow-float ring-2 ring-primary" : "shadow-soft",
      )}
    >
      {featured ? <Badge className="absolute -top-3 left-6 h-6 px-3 shadow-sm">{t.packs.popular}</Badge> : null}
      <p className="text-sm font-semibold text-muted-foreground">{pack.name}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{formatVnd(pack.priceVnd)}</p>
      <p className="mt-1 text-sm font-semibold text-primary">{t.common.credits(pack.credits)}</p>
      <ul className="mt-5 flex flex-1 flex-col gap-2.5 text-sm">
        {perks.map((perk) => (
          <li key={perk} className="flex items-center gap-2">
            <CheckIcon className="size-4 shrink-0 text-success" strokeWidth={2.5} />
            {perk}
          </li>
        ))}
      </ul>
      <div className="mt-6">{children}</div>
    </div>
  );
}
