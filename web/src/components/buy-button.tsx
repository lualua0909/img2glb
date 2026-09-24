"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { CreditPackId } from "@/lib/config";
import { useI18n } from "./i18n-provider";

export function BuyButton({ packId, featured, disabled }: { packId: CreditPackId; featured?: boolean; disabled?: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size="lg"
        variant={featured ? "default" : "outline"}
        disabled={disabled || busy}
        className="w-full"
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch("/api/billing/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ packId }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.id) router.push(`/app/billing/${data.id}`);
          else {
            setError(data.error ?? t.billing.checkoutFailed);
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : null}
        {t.billing.buy}
      </Button>
      {error ? <p className="text-center text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
