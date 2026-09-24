import { cn } from "@/lib/utils";

/** Soft color blobs behind hero sections. Parent needs `relative isolate`. */
export function GradientBackdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}>
      <div className="absolute -top-48 -left-40 size-[36rem] rounded-full bg-[#0a84ff]/20 blur-3xl" />
      <div className="absolute -top-32 -right-40 size-[32rem] rounded-full bg-[#bf5af2]/15 blur-3xl" />
      <div className="absolute top-80 left-1/3 size-[28rem] rounded-full bg-[#5ac8fa]/15 blur-3xl" />
    </div>
  );
}
