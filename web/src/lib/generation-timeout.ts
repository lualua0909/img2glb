/** Persist the largest budget seen so draining the queue never shortens a job's deadline. */
export function generationTimeoutMinutes(base: number, state: Record<string, unknown> | null): number {
  const slots = typeof state?.queueSlots === "number" && Number.isFinite(state.queueSlots)
    ? Math.max(1, state.queueSlots) : 1;
  const saved = typeof state?.timeoutMinutes === "number" && Number.isFinite(state.timeoutMinutes)
    ? state.timeoutMinutes : 0;
  return Math.max(base * slots, saved);
}
