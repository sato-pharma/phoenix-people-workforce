"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/**
 * The month picker over a Medical Rep's landing keycards.
 *
 * WHY IT EXISTS (owner, 2026-10-01, his own words): *"in medical rep emp portal I want to be able in
 * overview landing page to choose the month of the KPIs showing data — example now I /10 no any KPIs,
 * I chose Sep I got full view in keycards of Sep KPIs."* On the 1st of a month every one of his four
 * keycards is empty by construction and every one of them is empty for a different, correct reason:
 * no closing is published for a month still running (the closing golden rule), no plan has been
 * scored, and no visit has been logged. Four honest blanks still read as a broken page, and the one
 * thing that fixes it is letting him name the month he wants to look at.
 *
 * ## It drives ALL FOUR keycards, not three
 *
 * Achievement follows the picked month too. Coverage, frequency and the call rate came off the CRM
 * KPI board for one month while achievement came off Monthly Closing for another (it falls back to
 * the newest PUBLISHED month), so before this the four cards could legitimately describe two
 * different windows with nothing on screen saying so. One month, one label, four cards.
 *
 * ## Why the options arrive as plain data
 *
 * Exactly the reason `KpisPeriodPicker` gives for the same decision: the list is built on the server
 * by `kpiMonthOptions`, and importing that module here would pull its dependency chain — which
 * reaches the Supabase admin client — into the browser bundle. That 500s at runtime while `tsc`
 * stays perfectly happy, which is how it shipped once before (2026-09-01, the Reps Weekly Plans
 * filter).
 *
 * ## The control
 *
 * A native `<select>` at `text-base`, square, full width on a phone. The owner's fits-the-screen rule
 * names a native select as the one control that cannot be shrunk — iOS zooms the whole page when a
 * select's text is under 16px — so it keeps its size and the row wraps around it instead. Square
 * corners are written out, never inherited: `tokens.css` still defaults `--phx-radius` to 4px.
 *
 * The month rides in the URL, so picking one re-runs the page's access gates server-side and the back
 * button works. The param is always written, including for the running month: a picker that silently
 * dropped it for one value would make "October" and "no choice at all" two different URLs that look
 * the same to read.
 */
export function RepKpiMonthPicker({
  month,
  options,
}: {
  /** The month in force — always one of `options`, validated server-side in the home snapshot. */
  month: string;
  /** Newest first, stopping at the CRM data floor. Never empty in practice; renders nothing if it is. */
  options: ReadonlyArray<{ label: string; value: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (options.length === 0) return null;

  return (
    <label className={`flex flex-wrap items-center gap-2 border border-slate-200 bg-white px-3 py-2 ${adminSoftDepthClassName}`}>
      <span className="text-phx-sm font-bold uppercase tracking-[0.1em] text-slate-500">KPI month</span>
      <select
        // `text-base` and `font-semibold` are this screen's own, kept through `cn()` so
        // tailwind-merge drops the token's `text-sm`: a native select under 16px makes iOS
        // zoom the whole page on focus, which the fits-the-screen rule forbids.
        className={cn(phxSelectClassName, "ml-auto min-w-0 text-base font-semibold sm:w-56")}
        disabled={pending}
        onChange={(event) =>
          startTransition(() =>
            router.push(`/employee-portals?kpiMonth=${encodeURIComponent(event.target.value)}`),
          )
        }
        value={month}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
