import { BoxIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { APP_NAME } from "@/lib/config";

/** App-icon style mark: gradient rounded square with a cube. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[10px] bg-linear-to-br from-[#0a84ff] to-[#5e5ce6] text-white shadow-sm shadow-[#5e5ce6]/30",
        className,
      )}
    >
      <BoxIcon className="size-[55%]" strokeWidth={2.2} />
    </span>
  );
}

export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2.5 text-[17px] font-bold tracking-tight", className)}>
      <LogoMark />
      {APP_NAME}
    </Link>
  );
}
