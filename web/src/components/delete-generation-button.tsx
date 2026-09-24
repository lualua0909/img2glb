"use client";

import { Trash2Icon } from "lucide-react";
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
import { useI18n } from "./i18n-provider";

export function DeleteGenerationButton({
  id,
  disabled,
  compact,
  className,
}: {
  id: string;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const res = await fetch(`/api/generations/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/app/library");
      router.refresh();
    } else {
      setBusy(false);
      toast.error((await res.json().catch(() => ({}))).error ?? t.detail.deleteFailed);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {compact ? (
          <Button
            variant="destructive"
            size="icon-sm"
            aria-label={t.common.delete}
            title={t.common.delete}
            disabled={disabled || busy}
            className={className}
          >
            <Trash2Icon />
          </Button>
        ) : (
          <Button variant="destructive" disabled={disabled || busy} className={className}>
            <Trash2Icon />
            {t.common.delete}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t.detail.deleteTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.detail.deleteBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={remove}>
            {t.common.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
