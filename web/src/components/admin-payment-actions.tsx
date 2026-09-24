"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "./i18n-provider";

export function AdminPaymentActions({ id }: { id: string }) {
  const { t } = useI18n();
  const tp = t.admin.payments;
  const router = useRouter();
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);

  async function resolve(action: "confirm" | "cancel") {
    setBusy(action);
    const res = await fetch(`/api/admin/payments/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) toast.error(data.error ?? tp.failed);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy !== null}>
            {busy === "cancel" ? <Spinner /> : null}
            {tp.cancel}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{tp.cancelTitle}</AlertDialogTitle>
            <AlertDialogDescription>{tp.cancelBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tp.keep}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => resolve("cancel")}>
              {tp.cancel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Button size="sm" disabled={busy !== null} onClick={() => resolve("confirm")}>
        {busy === "confirm" ? <Spinner /> : null}
        {tp.confirm}
      </Button>
    </div>
  );
}
