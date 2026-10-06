"use client";

import type { OutstationTerritoryValidationStatus } from "@/lib/outstation/types";
import { Card } from "@/components/ui/card";

// 🔴 THE COLOURS RUN THE OPPOSITE WAY TO WHAT THE NAMES SUGGEST, AND THAT IS CORRECT.
// An outstation trip is by definition outside the employee's assigned area, so
// `outside_expected_territory` is what a LEGITIMATE claim looks like — green. `matched` means the
// destination was INSIDE their own area, i.e. no out-of-station travel to pay for — amber.
// Until 2026-09-28 these were swapped, which put an amber badge on every request ever filed and
// so told the approver nothing.
function tone(status: OutstationTerritoryValidationStatus) {
  if (status === "outside_expected_territory") return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  if (status === "matched") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export function TerritoryValidationPanel({
  reason,
  status,
}: {
  reason: string;
  status: OutstationTerritoryValidationStatus;
}) {
  return (
    <Card className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-500">
        Territory Validation
      </p>
      <div className="mt-3">
        {/* `rounded-md` and not `rounded-full`, and the difference is not cosmetic: every
            `rounded-*` step resolves through the --phx-radius scale, which tokens.css sets to 0,
            but `rounded-full` is a Tailwind literal that no token reaches. It was square here only
            because globals.css RULE 1 zeroes `[class*="rounded"]` inside `.admin-shell` — so the
            pill was one mount outside the admin shell away from rendering, with nothing to catch
            it. On `rounded-md` the badge is square by token, like its sibling
            `ApprovalRecommendationBadge`. (The Card's `rounded-3xl` is deliberate and stays:
            globals.css pins --radius-3xl to 0 and keeps the name for its 33 call sites.) */}
        <span className={`inline-flex rounded-md px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] ring-1 ${tone(status)}`}>
          {status.replace(/_/g, " ")}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{reason || "No territory validation notes were recorded."}</p>
    </Card>
  );
}
