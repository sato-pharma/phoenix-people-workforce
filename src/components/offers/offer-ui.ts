// Shared field styling for the offers workspace.
//
// Lifted verbatim from the Contract & Form 1 screen so the two hiring-paperwork screens are
// visibly one family. Kept in a module rather than copied per component so they cannot drift.

/**
 * Who the offer will come from, as shown to HR before they send.
 *
 * Lives here rather than in `offers-manager.tsx` so the composer can name the type without
 * importing its own parent — a cycle that is harmless while it is types only, and stops being
 * harmless the first time somebody adds a value import to it.
 */
export type OfferSenderInfo = { from: string; isConfigured: boolean; replyTo: string };

export const offerInputClassName =
  "h-10 w-full rounded-xl border border-phx-line bg-white/95 px-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-phx-accent-line focus:ring-2 focus:ring-phx-accent/15";

export const offerTextareaClassName =
  "w-full rounded-xl border border-phx-line bg-white/95 px-3 py-2 text-sm leading-6 text-slate-900 shadow-sm outline-none transition focus:border-phx-accent-line focus:ring-2 focus:ring-phx-accent/15";

export const offerLabelClassName =
  "mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

export const offerHintClassName = "mt-1 text-phx-xs leading-4 text-phx-ink-faint";

/** Money as HR reads it — thousands separated, no decimals, never truncated. */
export function offerMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value || 0));
}

/** Africa/Cairo, always — never a raw UTC stamp. */
export function offerWhen(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}
