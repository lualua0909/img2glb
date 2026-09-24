"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page periodically (e.g. while a payment awaits confirmation). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
