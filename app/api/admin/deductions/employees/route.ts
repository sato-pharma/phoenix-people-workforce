import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES, isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * First and last-plus-one day of a YYYY-MM month key, or null when absent or
 * malformed. Half-open so the last day of the month is included without any
 * month-length arithmetic.
 */
function finalSettlementBounds(monthKey: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Employee picker for the manual (Loan / Other) deduction entry.
 *
 * Name-first by design: the owner's standing rule is that a person is chosen
 * and shown by NAME, never by an HR code. The existing outstation lookup is
 * hr-id-first and gated on outstation access, so it cannot serve this screen.
 *
 * Two modes, deliberately separated so a broad search never carries
 * salary-derived data for many people at once:
 *   ?q=<name>                       -> matching names (no money)
 *   ?hrId=<id>&monthKey=YYYY-MM     -> that ONE employee's day rate, so the
 *                                      form can preview what N days costs
 *                                      before anything is written.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    // Same actor that may record a decision — this feeds a screen that writes
    // an auto-approved deduction, so it is not a general employee directory.
    assertDeductionsDecisionActor(access);

    const url = new URL(request.url);
    const hrId = url.searchParams.get("hrId")?.trim() ?? "";
    const supabase = getSupabaseAdmin();

    if (hrId) {
      const monthKey = url.searchParams.get("monthKey")?.trim() ?? "";
      const [yearStr, monthStr] = monthKey.split("-");
      const year = Number.parseInt(yearStr ?? "", 10);
      const month = Number.parseInt(monthStr ?? "", 10);
      if (!Number.isFinite(year) || !Number.isFinite(month)) {
        throw new Error("Validation: monthKey (YYYY-MM) is required alongside hrId.");
      }

      const { data, error } = await supabase
        .from("employees")
        .select("hr_id, full_name, base_salary, hire_date")
        .eq("hr_id", hrId)
        .maybeSingle();
      if (error) throw new Error(`Employee lookup failed: ${error.message}`);
      if (!data) throw new Error("Not found: no employee matches that record.");

      const row = data as { hr_id: string; full_name: string | null; base_salary: number | null; hire_date: string | null };
      // One day's cost, from the same helper every other category uses, so a
      // manual entry can never price a day differently from a detected one.
      const dayRate = calculateDeductionAmountFromBaseSalary({
        baseSalary: row.base_salary,
        deductionDays: 1,
        month,
        year,
      });

      return NextResponse.json({
        success: true,
        employee: {
          hrId: row.hr_id,
          name: row.full_name ?? null,
          hireDate: row.hire_date ?? null,
          // null means "no base salary on record" — the form must say so rather
          // than quietly offering a 0.00 EGP deduction.
          dayRate,
        },
      });
    }

    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length < 2) {
      return NextResponse.json({ success: true, employees: [] });
    }

    // Only CURRENT staff, PLUS whoever left during the month being worked on.
    //
    // A person is chosen here to be DEDUCTED FROM, so a resigned employee must
    // not surface in general — this picker once filtered on name alone and
    // offered them for any month. But excluding them outright made a leaver's
    // FINAL month unrecordable too: collection refuses an unfinished month, and
    // with nobody selectable here there was no second route. All 13 of August
    // 2026's leavers were stranded that way while their settlements were paid.
    //
    // So the roster widens by exactly one case: the month you are working on is
    // the month they left in. The write path re-checks this independently
    // (isFinalSettlementMonth in the manual route) — this only decides who is
    // offered, never who is allowed.
    const searchMonthKey = url.searchParams.get("monthKey")?.trim() ?? "";
    const monthBounds = finalSettlementBounds(searchMonthKey);

    let search = supabase
      .from("employees")
      .select("hr_id, full_name, job_title, employment_status, last_working_date")
      .ilike("full_name", `%${query}%`);
    search = monthBounds
      ? search.or(
          `employment_status.in.(${Array.from(ACTIVE_EMPLOYMENT_STATUSES).join(",")}),` +
            `and(last_working_date.gte.${monthBounds.start},last_working_date.lt.${monthBounds.end})`,
        )
      : search.in("employment_status", Array.from(ACTIVE_EMPLOYMENT_STATUSES));

    const { data, error } = await search.order("full_name").limit(20);
    if (error) throw new Error(`Employee search failed: ${error.message}`);

    const employees = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((row) => String(row.full_name ?? "").trim())
      .map((row) => {
        const status = (row.employment_status as string | null) ?? null;
        const lastWorkingDate = (row.last_working_date as string | null) ?? null;
        return {
          hrId: String(row.hr_id ?? ""),
          name: String(row.full_name ?? ""),
          jobTitle: (row.job_title as string | null) ?? null,
          employmentStatus: status,
          lastWorkingDate,
          // The form labels these differently — the entry is a final
          // settlement, not an ongoing deduction, and HR should see that
          // before they type a number.
          isFinalSettlement: isTerminalEmploymentStatus(status) && Boolean(lastWorkingDate),
        };
      });

    return NextResponse.json({ success: true, employees });
  } catch (error) {
    return jsonError(error, "Failed to look up employees.");
  }
}
