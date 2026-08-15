import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES } from "@/lib/auth/session-lifecycle";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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

    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, job_title, employment_status")
      .ilike("full_name", `%${query}%`)
      // Only CURRENT staff. A person is chosen here to be DEDUCTED FROM, so a
      // resigned/terminated employee must never surface — this picker previously
      // filtered on name alone and offered them as selectable. Mirrors the
      // active-status constraint the other deduction rosters already apply.
      .in("employment_status", Array.from(ACTIVE_EMPLOYMENT_STATUSES))
      .order("full_name")
      .limit(20);
    if (error) throw new Error(`Employee search failed: ${error.message}`);

    const employees = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((row) => String(row.full_name ?? "").trim())
      .map((row) => ({
        hrId: String(row.hr_id ?? ""),
        name: String(row.full_name ?? ""),
        jobTitle: (row.job_title as string | null) ?? null,
        employmentStatus: (row.employment_status as string | null) ?? null,
      }));

    return NextResponse.json({ success: true, employees });
  } catch (error) {
    return jsonError(error, "Failed to look up employees.");
  }
}
