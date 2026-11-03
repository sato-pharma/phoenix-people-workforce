// ─────────────────────────────────────────────────────────────────────────────────────────────
// The people who have left, and what is still owed on each (owner, 2026-11-03: "build 1"). Their papers
// come through the same read as the checklist's; the mailbox and device reads are status and count only.
//
// `DEPARTED_EMPLOYMENT_STATUSES` decides who, inside `getDepartedEmployeesWithPapers`: a declined offer
// has no last working day and owes no exit paper, and a ledger row or placeholder is nobody.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { leaverMailboxStanding, leaversNewestFirst } from "@/lib/hiring-documents/leavers-logic";
import { canSeeHiringDocumentRow, getDepartedEmployeesWithPapers } from "@/lib/hiring-documents/service";
import type { HiringLeaversData } from "@/lib/hiring-documents/types";
import type { ExitRoute } from "@/lib/hiring-pack/types";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** One side read, which may fail alone. It says "Not read" on its own line and costs nothing else. */
async function sideRead<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[hiring-leavers] the ${what} read failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

function keyOf(hrId: string | null | undefined): string {
  return canonicalHrIdKey(hrId) ?? "";
}

/** Scoped here rather than in the route, as the checklist's own board is, so no caller can skip it. */
export async function getHiringLeavers(access: AccessContext): Promise<HiringLeaversData> {
  const supabase = getSupabaseAdmin();
  const [rows, mailboxes, devices, exitRoutes] = await Promise.all([
    getDepartedEmployeesWithPapers(),
    sideRead("mailbox offboarding", async () => {
      const { data, error } = await supabase.from("mailbox_offboarding_tasks").select("employee_hr_id,status");
      if (error) throw new Error(error.message);
      const statuses = new Map<string, Array<string | null>>();
      for (const row of (data ?? []) as Array<{ employee_hr_id: string | null; status: string | null }>) {
        const key = keyOf(row.employee_hr_id);
        statuses.set(key, [...(statuses.get(key) ?? []), row.status]);
      }
      return statuses;
    }),
    sideRead("device", async () => {
      const { data, error } = await supabase
        .from("device_assignments")
        .select("employee_hr_id")
        .eq("status", "outstanding")
        .eq("is_placeholder", false);
      if (error) throw new Error(error.message);
      const counts = new Map<string, number>();
      for (const row of (data ?? []) as Array<{ employee_hr_id: string | null }>) {
        const key = keyOf(row.employee_hr_id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    }),
    // A failed read leaves both labour papers open, and the rest of the row does not depend on it.
    sideRead("exit route", async () => {
      const { data, error } = await supabase
        .from("employee_offboarding_profile")
        .select("hr_id,exit_route")
        .not("exit_route", "is", null);
      if (error) throw new Error(error.message);
      const routes = new Map<string, ExitRoute>();
      for (const row of (data ?? []) as Array<{ exit_route: ExitRoute; hr_id: string | null }>) {
        routes.set(keyOf(row.hr_id), row.exit_route);
      }
      return routes;
    }),
  ]);

  return {
    leavers: leaversNewestFirst(
      rows.filter((row) => canSeeHiringDocumentRow(access, row)).map((row) => ({
        ...row,
        devicesOutstanding: devices ? (devices.get(keyOf(row.hrId)) ?? 0) : null,
        exitRoute: exitRoutes?.get(keyOf(row.hrId)) ?? null,
        mailbox: mailboxes ? leaverMailboxStanding(mailboxes.get(keyOf(row.hrId)) ?? []) : null,
      })),
    ),
    todayKey: todayInCairo(),
  };
}
