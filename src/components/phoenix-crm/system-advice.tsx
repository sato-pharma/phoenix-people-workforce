/**
 * Phoenix CRM — the system's recommendation on one place check, and its reason (owner, 2026-10-17:
 * "add system recommendations to approve or no on every validation … and the reason of system
 * recommendation"). The rules are `place-check-advice.ts`; this only draws them.
 *
 * 🔴 THE SUPER ADMIN'S ALONE. Every caller draws it only in `mode === "company"`: a district manager's
 * board says nothing about who decides (owner, 2026-10-13), and the rep never sees a check at all.
 *
 * Square corners, the reason always whole (no ellipsis — it wraps), and what was read kept in its own
 * script with `dir="auto"`, because a customer's name is almost always Arabic.
 */

import { CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { PLACE_CHECK_ADVICE_LABEL, type PlaceCheckAdvice, type PlaceCheckAdviceKind } from "@/lib/phoenix-crm/place-check-advice";
import { cn } from "@/lib/utils";

const PILL: Record<PlaceCheckAdviceKind, PillTone> = { approve: "good", reject: "bad", look: "warn" };
const BAR: Record<PlaceCheckAdviceKind, string> = {
  approve: "border-l-emerald-500",
  reject: "border-l-rose-500",
  look: "border-l-amber-500",
};

export function SystemAdvice({ advice, className }: { advice: PlaceCheckAdvice; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1 border border-l-[3px] border-slate-200 bg-white px-3 py-2", BAR[advice.kind], className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">System recommends</p>
        <CrmPill tone={PILL[advice.kind]}>{PLACE_CHECK_ADVICE_LABEL[advice.kind]}</CrmPill>
      </div>
      <p className="break-words text-xs font-semibold text-slate-800">{advice.reason}</p>
      {advice.quote ? (
        <p className="break-words text-xs text-slate-500">
          Read: <span className="font-semibold text-slate-700" dir="auto">{advice.quote}</span>
        </p>
      ) : null}
    </div>
  );
}
