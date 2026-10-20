import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { withDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { PLAN_REMINDER_JOB_SLUG } from "@/lib/phoenix-crm/plan-reminder-rules";
import { runManagerPlanEditExpiry } from "@/lib/phoenix-crm/server/manager-plans";
import { runSingleVisitDayExpiry } from "@/lib/phoenix-crm/server/manager-single-visit-days";
import { runPhoenixCrmPlanEditExpiry, type PlanEditExpiryRun } from "@/lib/phoenix-crm/server/plan-edit-expiry";
import { runPhoenixCrmPlanReminder } from "@/lib/phoenix-crm/server/plan-reminder";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phoenix CRM's "your coming week is not sent" reminder (owner, 2026-10-02), at 12:57 and 17:57 Cairo.
 * It goes to the rep and to his district manager, in the teams that have started. It speaks only from
 * the day the week is due until the day before it starts. On every other day it reads nothing and
 * sends nothing, which is the job working, not failing.
 *
 * The 17:57 tick tells whoever is STILL not sent, in its own words (owner, 2026-10-02). Safe to fire
 * twice: the keys are per person per week per Cairo day per tick, so a retry of one tick tells nobody
 * twice.
 *
 * 🔴 IT ALSO CLOSES EXPIRED EDIT REQUESTS, AND THAT HALF RUNS EVERY DAY — the reminder itself speaks
 * only on a reminder day, and `runPhoenixCrmPlanReminder` returns early on every other, so the expiry
 * cannot live inside it. It runs FIRST, outside that early return, and its own failure is logged and
 * swallowed: a request that could not be closed must never cost a team its reminder.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/phoenix-crm-plan-reminder");
  if (denied) return denied;
  // It closes a request to edit a week that has passed and tells its rep and managers — in-app and
  // Telegram, never email and never the phone (the owner's own answer, 2026-10-02; the module guard
  // owns those channels, not this call). See src/lib/phoenix-crm/server/plan-edit-expiry.ts.
  let planEdits: PlanEditExpiryRun | { error: string };
  try {
    planEdits = await runPhoenixCrmPlanEditExpiry();
  } catch (error) {
    logError("Phoenix CRM plan-edit expiry failed", {
      error,
      labels: { event: "cron_step_failed", job: PLAN_REMINDER_JOB_SLUG, step: "plan_edit_expiry" },
    });
    planEdits = { error: clientSafeErrorMessage(error, "Phoenix CRM plan-edit expiry failed.") };
  }
  // The same pass for a district manager's ask to edit his own week (owner, 2026-10-16) — its own step,
  // so one failing never costs the other or the reminder. In-app and Telegram, never email or the phone.
  let managerPlanEdits: { expired: number; told: number } | { error: string };
  try {
    managerPlanEdits = await runManagerPlanEditExpiry();
  } catch (error) {
    logError("Phoenix CRM district-manager plan-edit expiry failed", {
      error,
      labels: { event: "cron_step_failed", job: PLAN_REMINDER_JOB_SLUG, step: "manager_plan_edit_expiry" },
    });
    managerPlanEdits = { error: clientSafeErrorMessage(error, "Phoenix CRM district-manager plan-edit expiry failed.") };
  }
  // And his ask for another day of single visits whose day passed undecided (owner, 2026-10-20) — its own
  // step too. In-app and Telegram, never email or the phone.
  let singleVisitDays: { expired: number; told: number } | { error: string };
  try {
    singleVisitDays = await runSingleVisitDayExpiry();
  } catch (error) {
    logError("Phoenix CRM district-manager single-visit-day expiry failed", {
      error,
      labels: { event: "cron_step_failed", job: PLAN_REMINDER_JOB_SLUG, step: "manager_single_visit_day_expiry" },
    });
    singleVisitDays = { error: clientSafeErrorMessage(error, "Phoenix CRM district-manager single-visit-day expiry failed.") };
  }
  try {
    const result = await withDeadMansSwitch(PLAN_REMINDER_JOB_SLUG, () => runPhoenixCrmPlanReminder());
    return NextResponse.json({ success: true, ...result, planEdits, managerPlanEdits, singleVisitDays });
  } catch (error) {
    logError("Phoenix CRM plan reminder failed", {
      error,
      labels: { event: "cron_failed", job: PLAN_REMINDER_JOB_SLUG },
    });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Phoenix CRM plan reminder failed.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
