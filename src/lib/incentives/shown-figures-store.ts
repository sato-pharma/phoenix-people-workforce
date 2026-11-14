import type { AccessContext } from "@/lib/auth/permissions";
import { isPreviewSession } from "@/lib/auth/preview-session-guard";
import { isReadOnlyViewer } from "@/lib/auth/read-only-viewer";
import type { MedicalRepPortalData } from "@/lib/employee-portal/service";
import { hrIdsMatch } from "@/lib/hr-id";
import {
  shownIncentiveFigure,
  shownIncentiveFingerprint,
  type ShownIncentiveFigure,
} from "@/lib/incentives/shown-figures";
import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// STORING AND READING BACK THE INCENTIVE FIGURE A PERSON WAS SHOWN (enterprise audit REC-066).
//
// Written ONLY from the person's own Incentive tab (`/employee-portals/incentive` and the admin
// shell's `/workspace/incentive`), never from Employee 360, where a manager is looking at someone
// else's figure. Never from a test account, a seat view or a preview session: those look and leave no
// trace. One row per distinct figure; the figure columns are never rewritten, only `last_shown_at`.
// A failed write is logged and the page carries on: storing the figure must never cost the person
// their tab. Read back by the Super Admin alone, on Employee 360.
// ─────────────────────────────────────────────────────────────────────────────

const TABLE = "incentive_shown_figures";

/** Whether this viewer's tab view is stored at all — their OWN figure, seen by a real session. */
export function shouldRecordShownIncentive(
  access: Pick<AccessContext, "hrId" | "source" | "seatView" | "testPersona">,
  data: MedicalRepPortalData,
): boolean {
  if (isReadOnlyViewer(access) || isPreviewSession(access)) return false;
  return Boolean(access.hrId) && hrIdsMatch(access.hrId, data.employee.hrId);
}

/** Store the figure the person's own tab just showed them. Best-effort: never throws. */
export async function recordShownIncentive(access: AccessContext, data: MedicalRepPortalData | null): Promise<void> {
  if (!data || !shouldRecordShownIncentive(access, data)) return;
  const figure = shownIncentiveFigure(data);
  if (!figure) return;
  try {
    const now = new Date().toISOString();
    const { error } = await getSupabaseAdmin()
      .from(TABLE)
      .upsert(
        {
          hr_id: figure.hrId,
          semester_label: figure.semesterLabel,
          periods: figure.periods,
          line: figure.line,
          sales_scope: figure.salesScope,
          achievement_percent: figure.achievementPercent,
          semester_sales: figure.semesterSales,
          semester_target: figure.semesterTarget,
          basic_salary: figure.basicSalary,
          payout_egp: figure.payoutEgp,
          payout_percentage: figure.payoutPercentage,
          pedia_split: figure.pediaSplit,
          window_notice: figure.windowNotice,
          fingerprint: shownIncentiveFingerprint(figure),
          app_revision: getDeployRevision(),
          last_shown_at: now,
        },
        // Same person, same figure: only last_shown_at moves (first_shown_at is not sent, so it stays).
        { onConflict: "hr_id,fingerprint" },
      );
    if (error) throw error;
  } catch (error) {
    logPortalFailure({ route: "incentive-tab", module: "incentive-shown-figures", role: access.role, hrId: access.hrId }, error);
  }
}

/** One stored figure as the Super Admin reads it back. */
export type ShownIncentiveHistoryRow = Omit<ShownIncentiveFigure, "hrId"> & {
  firstShownAt: string;
  lastShownAt: string;
  appRevision: string | null;
};

type StoredRow = {
  semester_label: string;
  periods: string[] | null;
  line: string | null;
  sales_scope: string | null;
  achievement_percent: number | string;
  semester_sales: number | string;
  semester_target: number | string;
  basic_salary: number | string;
  payout_egp: number | string;
  payout_percentage: number | string | null;
  pedia_split: ShownIncentiveFigure["pediaSplit"];
  window_notice: string | null;
  app_revision: string | null;
  first_shown_at: string;
  last_shown_at: string;
};

const num = (value: number | string | null) => (value == null ? null : Number(value));

/** Every figure this person was shown, newest first. The Super Admin's read; the caller checks the role. */
export async function loadShownIncentiveHistory(hrId: string, limit = 24): Promise<ShownIncentiveHistoryRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(
      "semester_label, periods, line, sales_scope, achievement_percent, semester_sales, semester_target, basic_salary, payout_egp, payout_percentage, pedia_split, window_notice, app_revision, first_shown_at, last_shown_at",
    )
    .eq("hr_id", hrId)
    .order("first_shown_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as StoredRow[]).map((row) => ({
    semesterLabel: row.semester_label,
    periods: row.periods ?? [],
    line: row.line,
    salesScope: row.sales_scope,
    achievementPercent: Number(row.achievement_percent),
    semesterSales: Number(row.semester_sales),
    semesterTarget: Number(row.semester_target),
    basicSalary: Number(row.basic_salary),
    payoutEgp: Number(row.payout_egp),
    payoutPercentage: num(row.payout_percentage),
    pediaSplit: row.pedia_split,
    windowNotice: row.window_notice,
    appRevision: row.app_revision,
    firstShownAt: row.first_shown_at,
    lastShownAt: row.last_shown_at,
  }));
}
