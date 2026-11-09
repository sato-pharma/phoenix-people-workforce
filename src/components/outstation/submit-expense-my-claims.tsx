import { TriangleAlert } from "lucide-react";

import { MyExpenseSubmissions } from "@/components/outstation/my-expense-submissions";
import type { MyOutstationSubmission } from "@/lib/outstation/service";
import { MY_CLAIMS_ANCHOR } from "@/lib/outstation/submit-expense-steps";

/**
 * "My claims" under the Submit Expense form — the two screens are one page (owner, 2026-10-22:
 * "I want the submit expense and the expense submissions to be in one page … in the same form"),
 * laid out the way Report It puts "My Reports" under its form.
 *
 * `submissions: null` means the read failed. That is said in words, never drawn as an empty list:
 * "you have no claims" and "we could not read your claims" must not look the same on a money screen.
 */
export function SubmitExpenseMyClaims({
  employeeHrId,
  submissions,
}: {
  employeeHrId: string;
  submissions: MyOutstationSubmission[] | null;
}) {
  return (
    <section aria-label="My claims" className="scroll-mt-4 space-y-2" id={MY_CLAIMS_ANCHOR}>
      <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-500">My claims</h2>
      {submissions === null ? (
        <p className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-4 text-phx-md leading-relaxed text-rose-800">
          <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          Your claims could not be loaded just now. Nothing has been lost — reload the page to see them.
        </p>
      ) : (
        <MyExpenseSubmissions employeeHrId={employeeHrId} submissions={submissions} />
      )}
    </section>
  );
}
