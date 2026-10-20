// Recruitment workspace — the two overdue rules the owner ticked on 20 Oct 2026 (#11): a CV
// shortlisted for 14 days with no action, and a CV sent to a manager 7 days ago with no reply.
//
// WHY A COPY OF THE SQL. `ats_workspace_filter` decides which rows the "Overdue" filter returns;
// this decides what the row's own flag says ("Overdue · 16 days"). The two MUST agree, or a row the
// filter returned would carry no flag — so this is the same arithmetic, line for line: the same
// thresholds (`OVERDUE_*`, which `workspaceDbParams` also hands the SQL), the same anchor
// (`status_changed_at`, else `created_at`; for a send, the NEWEST send first), and the same strict
// "older than N days" comparison. Pure, so `tests/` can pin it without a database.

import { OVERDUE_SENT_DAYS, OVERDUE_SHORTLIST_DAYS } from "@/lib/recruitment/workspace/vocabulary";

const DAY_MS = 86_400_000;

export type WorkspaceOverdue = { kind: "shortlisted" | "sent_to_manager"; days: number };

export type OverdueInput = {
  status: string | null;
  statusChangedAt: string | null;
  /** When the CV arrived — the anchor of last resort, exactly as the SQL coalesces it. */
  createdAt: string;
  /** The newest `ats_candidate_manager_sends.sent_at`, or null when there is none. */
  latestSentAt: string | null;
};

function overdueSince(kind: WorkspaceOverdue["kind"], since: string | null, thresholdDays: number, now: Date): WorkspaceOverdue | null {
  const at = Date.parse(String(since ?? ""));
  if (!Number.isFinite(at)) return null;
  // SQL: `since < now() - make_interval(days => N)` — strictly older, so day 14 itself is not yet late.
  if (!(at < now.getTime() - thresholdDays * DAY_MS)) return null;
  return { days: Math.floor((now.getTime() - at) / DAY_MS), kind };
}

/** The row's overdue flag, or null. Any other status is never overdue. */
export function workspaceOverdue(input: OverdueInput, now: Date = new Date()): WorkspaceOverdue | null {
  if (input.status === "shortlisted") {
    return overdueSince("shortlisted", input.statusChangedAt ?? input.createdAt, OVERDUE_SHORTLIST_DAYS, now);
  }
  if (input.status === "sent_to_manager") {
    return overdueSince(
      "sent_to_manager",
      input.latestSentAt ?? input.statusChangedAt ?? input.createdAt,
      OVERDUE_SENT_DAYS,
      now,
    );
  }
  return null;
}
