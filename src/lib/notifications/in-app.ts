import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isReadOnlyViewer } from "@/lib/auth/read-only-viewer";
import {
  mapInAppNotificationRows,
  type InAppNotificationDetail,
  type InAppNotificationMetricRow,
  type NotificationEnrichmentRecord,
} from "@/lib/communication/metrics";
import { canViewerSeeNotification, isPersonalBellCategory, PERSONAL_BELL_CATEGORIES } from "@/lib/notifications/recipients";
import { notificationHrefForViewerRole } from "@/lib/notifications/hrefs";
import {
  noticeFetchLimit,
  noticeHiddenFromSeat,
  seatNeedsOtherKindsRead,
  seatNoticeWindow,
  TALENT_ACQUISITION_FLOODING_EVENT_TYPE,
} from "@/lib/notifications/seat-notice-filter";
// A LEAF of the Phoenix CRM server tree, chosen deliberately: it imports only access, db and the
// pure rules, so the bell never ends up in a cycle with that module's own notifications file.
import { phoenixCrmPlanIdsAwaitingDecision, phoenixCrmVisitIdsAwaitingDecision } from "@/lib/phoenix-crm/server/awaiting-decisions";
import { logError } from "@/lib/observability/log";
import { fetchVacationNotificationEnrichments } from "@/lib/vacation/notification-enrichment";
import {
  getExcuseApprovalsForResponder,
  getPlanApprovalsForResponder,
  getVacationApprovalsForResponder,
} from "@/lib/approvals-hub/service";

export type InAppNotificationCategory = "coaching_report" | "general" | "internal_message";

export type InAppNotificationInput = {
  category: InAppNotificationCategory | string;
  dedupeKey: string;
  href?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  recipientHrId: string;
  title: string;
};

export type InAppNotificationResult =
  | { eventId?: string; skipped?: false }
  | { reason: string; skipped: true };

export type InAppNotificationView = {
  actionLabel?: string;
  category: string;
  details: InAppNotificationDetail[];
  href: string | null;
  id: string;
  isRead: boolean;
  message: string;
  module: string | null;
  primaryText?: string;
  priority: string;
  readAt: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  status: string;
  statusLabel?: string;
  title: string;
};

type InAppNotificationEventRow = {
  category?: string | null;
  created_at?: string | null;
  employee_hr_id?: string | null;
  event_type?: string | null;
  id?: string | number | null;
  metadata?: unknown;
  module?: string | null;
  priority?: string | null;
  action_url?: string | null;
  recipients?: unknown;
  scheduled_for?: string | null;
  sent_at?: string | null;
  status?: string | null;
  subject?: string | null;
  test_login_id?: string | null;
};

/**
 * The `TEST-` login a notification row is reserved for, or null when it is an ordinary one.
 *
 * Read from the column and from the metadata, because `createNotificationEvent` writes both and its
 * fallback path (an old schema, no column) can only carry the metadata copy. Either one marks the
 * row, so a marker that survives in only one carrier still hides it from the real person.
 */
export function testLoginMarkerOf(row: { metadata?: unknown; test_login_id?: string | null }): string | null {
  const column = typeof row.test_login_id === "string" ? row.test_login_id.trim().toUpperCase() : "";
  if (column) return column;
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as { testLoginId?: unknown }).testLoginId;
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text || null;
}

/**
 * Whether this viewer may see this row.
 *
 * An unmarked row is everybody's as before — that is why nothing about a real person's bell changes.
 * A marked row belongs to ONE test login and to no one else: not to the employee it is addressed to,
 * not to another test login, and not to a Super Admin reading his own bell.
 */
export function testNoticeVisibleToViewer(viewerTestLoginId: string | null, row: { metadata?: unknown; test_login_id?: string | null }): boolean {
  const marker = testLoginMarkerOf(row);
  if (!marker) return true;
  const viewer = typeof viewerTestLoginId === "string" ? viewerTestLoginId.trim().toUpperCase() : "";
  return viewer !== "" && viewer === marker;
}

// Notification (module, event_type) pairs where at least SOME copies are sent to exactly the
// one person whose turn it currently is — the rest of a fanned-out event's copies (a
// future-stage or awareness-only recipient) are filtered out in classifyActionableApprovalCandidates
// below using a field already present in that event's own metadata (never guessed/inferred).
const ACTIONABLE_APPROVAL_NOTIFICATIONS: Record<
  string,
  { domain: "excuse" | "phoenixCrm" | "phoenixCrmPlan" | "plan" | "vacation"; idField: "planId" | "requestId" | "visitId" }
> = {
  "excuse:request_resubmitted": { domain: "excuse", idField: "requestId" },
  "excuse:request_submitted": { domain: "excuse", idField: "requestId" },
  "vacation:next_manager_review": { domain: "vacation", idField: "requestId" },
  // Fans out to every step's recipient at once (direct manager AND future manager-of-manager
  // AND HR) under one eventType. Each copy's own metadata.status already says which one is
  // actually actionable now vs. a future-stage FYI (see recipientCopy() in vacation/service.ts:
  // "Pending your approval" vs. "Available after the first management approval" / "Review /
  // reject only until management approves") — filtered on below, no new tagging needed.
  "vacation:request_submitted": { domain: "vacation", idField: "requestId" },
  // The action-needed copy only — notifyHr tags HR's copy audience: "hr_awareness" whenever the
  // automatic HR acknowledgement already ran, and leaves it untagged (genuinely actionable) only
  // when that failed and the plan is still sitting at final_approved awaiting a manual click.
  "weekly_plans:plan_ceo_approved": { domain: "plan", idField: "planId" },
  "weekly_plans:plan_manager_approved": { domain: "plan", idField: "planId" },
  // The manager copy only — notifyHrOnSubmit tags its own "awareness" copy of this same
  // eventType with metadata.audience: "hr_awareness" (see weekly-planning/service.ts), which
  // classifyActionableApprovalCandidates excludes below. Without that split, HR's awareness
  // copy would be wrongly archived the instant it's read (HR is never "awaiting" at the
  // manager stage), before the plan ever reaches HR's real stage.
  "weekly_plans:plan_submitted": { domain: "plan", idField: "planId" },
  // The reviewing manager's "Off-plan visit to approve" (owner, 2026-10-02: "clear the manager's
  // off-plan notice when he approves it too"). Raised once, at the manager stage, and no longer his
  // the moment he decides it, it moves on to SFE, or the visit is removed. There is no awareness
  // copy to tell apart: `unplanned_visit_waiting` goes to the one reviewer and nobody else.
  "phoenix_crm:unplanned_visit_waiting": { domain: "phoenixCrm", idField: "visitId" },
  // 🔴 THE REVIEWING MANAGER'S "Weekly plan to review from <rep>" (owner, 2026-10-07). It is the
  // notice this module sends most — thirteen in one evening — and until now nothing withdrew it, so
  // his bell kept every week he had already approved or returned, including TWO copies of one week
  // when the rep re-sent it after a return. Addressed to the territory's reviewer and to nobody
  // else, like the off-plan one above, so there is no awareness copy to tell apart.
  "phoenix_crm:plan_waiting": { domain: "phoenixCrmPlan", idField: "planId" },
  // 🔴 THE DISTRICT MANAGER'S OWN WEEK IN PHOENIX CRM (owner, 2026-10-16) is decided in the Approvals
  // Hub, so its three "please decide" notices sit in the PLAN domain — getPlanApprovalsForResponder
  // lists them — and NEVER in phoenixCrmPlan, whose check reads the reps' plans only and would archive
  // every one of these on its first read. Each id field is the id the Hub's awaiting item carries: the
  // week, the ask to edit it, and the own-list customer whose removal waits.
  "phoenix_crm:manager_plan_waiting": { domain: "plan", idField: "planId" },
  "phoenix_crm:manager_plan_edit_waiting": { domain: "plan", idField: "requestId" },
  "phoenix_crm:manager_list_removal_waiting": { domain: "plan", idField: "requestId" },
  // His ask for a second or third day of single visits (owner, 2026-10-20), decided in the same Hub.
  "phoenix_crm:manager_single_visit_day_waiting": { domain: "plan", idField: "requestId" },
};

const VACATION_REQUEST_SUBMITTED_ACTIONABLE_STATUS = "Pending your approval";

/**
 * The ONLY valid ON CONFLICT arbiter for notification_user_states.
 *
 * The table used to carry two independent unique indexes over the same person —
 * (notification_event_id, hr_id) and (notification_event_id, user_id) — and these upserts
 * picked one or the other depending on whether the viewer had a loginId. ON CONFLICT only
 * protects the index it arbitrates on, so any insert that missed the chosen index but
 * collided on the *other* one raised 23505 and was swallowed by the fail-soft handlers
 * below — meaning the write silently never persisted and was retried on every single bell
 * poll, forever (production logged this ~2x/minute continuously).
 *
 * hr_id is the canonical employee key in this codebase; user_id is the loginId, which is NOT
 * stable for one person (dev-auth writes "dev.preview" where a real login writes "A-16", and
 * production still holds 8 such rows). So hr_id is the sole uniqueness key, user_id is kept
 * as informational context only, and the redundant user_id unique index was dropped in
 * 20260730120000_notification_user_states_single_conflict_key.sql.
 *
 * Every caller must therefore have a resolved hr_id before writing — with no unique index on
 * user_id, a NULL hr_id would silently accumulate duplicate rows instead of upserting.
 */
export const NOTIFICATION_STATE_CONFLICT_TARGET = "notification_event_id,hr_id";

export type ApprovalCandidate = { id: string; requestId: string };
export type ApprovalCandidatesByDomain = Record<"excuse" | "phoenixCrm" | "phoenixCrmPlan" | "plan" | "vacation", ApprovalCandidate[]>;

/**
 * Pure classification: which raw notification rows are approver "please decide" candidates
 * eligible for auto-archive-on-decide, grouped by domain. Exported so this — the part most
 * likely to hide the wrong thing if wrong — can be unit-tested without a database.
 */
export function classifyActionableApprovalCandidates(rows: InAppNotificationEventRow[]): ApprovalCandidatesByDomain {
  const candidatesByDomain: ApprovalCandidatesByDomain = { excuse: [], phoenixCrm: [], phoenixCrmPlan: [], plan: [], vacation: [] };

  for (const row of rows) {
    const key = `${row.module ?? ""}:${row.event_type ?? ""}`;
    const rule = ACTIONABLE_APPROVAL_NOTIFICATIONS[key];
    if (!rule) continue;
    const id = String(row.id ?? "");
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
    // Two weekly-plan eventTypes fan out an action-needed copy AND a pure-awareness copy to HR
    // under the SAME eventType — the audience tag is the only way to tell them apart at read
    // time. plan_submitted: manager decides, HR is only told. plan_ceo_approved: HR's
    // acknowledgement is now automatic (autoAcknowledgeFinalApprovedPlan in
    // weekly-planning/service.ts), so their copy is tagged awareness UNLESS the automatic
    // acknowledgement failed and the plan really is still waiting on HR's manual click.
    if (metadata.audience === "hr_awareness") continue;
    // vacation:request_submitted fans out to every step's recipient at once — only the copy
    // whose own metadata.status says "Pending your approval" is genuinely actionable right now.
    if (key === "vacation:request_submitted" && metadata.status !== VACATION_REQUEST_SUBMITTED_ACTIONABLE_STATUS) continue;
    const requestId = typeof metadata[rule.idField] === "string" ? String(metadata[rule.idField]) : "";
    if (!id || !requestId) continue;
    candidatesByDomain[rule.domain].push({ id, requestId });
  }

  return candidatesByDomain;
}

/**
 * Auto-archive an approver "please decide" notification once the underlying request has
 * moved past the stage it was about, so it disappears from the bell without the approver
 * needing to clear it manually. Fail-open throughout: any lookup error just leaves the
 * notification visible rather than risk hiding something still genuinely pending.
 */
async function archiveStaleApprovalNotifications(access: AccessContext, rows: InAppNotificationEventRow[]): Promise<Set<string>> {
  const stale = new Set<string>();
  const candidatesByDomain = classifyActionableApprovalCandidates(rows);

  if (candidatesByDomain.vacation.length > 0) {
    try {
      const { awaiting } = await getVacationApprovalsForResponder(access);
      const awaitingIds = new Set(awaiting.map((item) => item.id));
      for (const candidate of candidatesByDomain.vacation) if (!awaitingIds.has(candidate.requestId)) stale.add(candidate.id);
    } catch {
      // fail-open — leave vacation candidates visible
    }
  }

  if (candidatesByDomain.excuse.length > 0) {
    try {
      const { awaiting } = await getExcuseApprovalsForResponder(access);
      const awaitingIds = new Set(awaiting.map((item) => item.id));
      for (const candidate of candidatesByDomain.excuse) if (!awaitingIds.has(candidate.requestId)) stale.add(candidate.id);
    } catch {
      // fail-open — leave excuse candidates visible
    }
  }

  if (candidatesByDomain.plan.length > 0) {
    try {
      const { awaiting, unavailable } = await getPlanApprovalsForResponder(access);
      // A source that could not be read is missing from `awaiting`, so every one of its notices
      // would read as decided and be archived for good — leave the whole domain visible instead,
      // as the catch below does.
      if (unavailable.length === 0) {
        const awaitingIds = new Set(awaiting.map((item) => item.id));
        for (const candidate of candidatesByDomain.plan) if (!awaitingIds.has(candidate.requestId)) stale.add(candidate.id);
      }
    } catch {
      // fail-open — leave plan candidates visible
    }
  }

  if (candidatesByDomain.phoenixCrm.length > 0) {
    try {
      // "Still HIS", not "still open" — at the SFE stage the visit is still waiting, but not on him.
      const awaitingIds = await phoenixCrmVisitIdsAwaitingDecision(access);
      for (const candidate of candidatesByDomain.phoenixCrm) if (!awaitingIds.has(candidate.requestId)) stale.add(candidate.id);
    } catch {
      // fail-open — leave the off-plan candidates visible. A viewer who is not a Phoenix CRM user
      // at all lands here too (resolvePhoenixCrmViewer throws), and keeping an unreadable notice is
      // the harmless half of that trade.
    }
  }

  if (candidatesByDomain.phoenixCrmPlan.length > 0) {
    try {
      // "Still his" again: a week he approved, a week he returned, and a week the rep took back are
      // all gone from this set, and the next send writes its own notice.
      const awaitingIds = await phoenixCrmPlanIdsAwaitingDecision(access);
      for (const candidate of candidatesByDomain.phoenixCrmPlan) if (!awaitingIds.has(candidate.requestId)) stale.add(candidate.id);
    } catch {
      // fail-open — leave the weekly-plan candidates visible, as the off-plan ones above are.
    }
  }

  // A test login (src/lib/auth/test-persona.ts) reads the real person's bell, so it keeps the filter
  // below for THIS response but never writes her archive state — that row is hers. The Super Admin's
  // View as Seat (src/lib/auth/seat-view.ts) reads a person's bell the same way and writes nothing.
  if (stale.size > 0 && !isReadOnlyViewer(access)) {
    const identity = viewerIdentity(access);
    const now = new Date().toISOString();
    try {
      await Promise.allSettled(
        Array.from(stale).map((eventId) =>
          getSupabaseAdmin()
            .from("notification_user_states")
            .upsert(
              { archived_at: now, hr_id: identity.hrId, notification_event_id: eventId, updated_at: now, user_id: identity.userId },
              { onConflict: NOTIFICATION_STATE_CONFLICT_TARGET },
            ),
        ),
      );
    } catch {
      // Best-effort persistence — even if the write fails, we still exclude these rows from
      // THIS response below; a future read will simply re-detect and retry the archive write.
    }
  }

  return stale;
}

type NotificationUserStateRow = {
  archived_at?: string | null;
  hr_id?: string | null;
  notification_event_id?: string | null;
  read_at?: string | null;
  user_id?: string | null;
};

type InAppNotificationListRow = Omit<InAppNotificationMetricRow, "id" | "metadata"> & {
  id: string;
  metadata: Record<string, unknown>;
  module: string | null;
  priority: string;
};

function cleanHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function isDuplicateNotificationError(error: unknown) {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return text.includes("23505") || text.toLowerCase().includes("duplicate key");
}

function notificationSchemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("notification_events") ||
    text.includes("could not find the table") ||
    text.includes("schema cache") ||
    (text.includes("relation") && text.includes("does not exist"))
  );
}

function stateSchemaMissing(error: unknown) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes("notification_user_states") ||
    text.includes("schema cache") ||
    text.includes("does not exist") ||
    text.includes("could not find the table")
  );
}

export function viewerIdentity(access: AccessContext) {
  return {
    hrId: normalizeHrId(resolveEmployeeIdentityId(access)),
    // A test account reads the mirrored person's bell, so this is the ONLY thing that tells the two
    // apart — and the only thing that lets a test-world notice be shown to one and not the other.
    testLoginId: access.testPersona?.loginId ?? null,
    userId: access.loginId ?? null,
  };
}

export async function enqueueInAppNotification(input: InAppNotificationInput): Promise<InAppNotificationResult> {
  const recipientHrId = cleanHrId(input.recipientHrId);
  const eventKey = cleanText(input.dedupeKey);
  const title = cleanText(input.title);
  const message = cleanText(input.message);

  if (!recipientHrId) return { reason: "In-app notification skipped: recipient HR_ID is missing.", skipped: true };
  if (!eventKey) return { reason: "In-app notification skipped: dedupe key is missing.", skipped: true };
  if (!title) return { reason: "In-app notification skipped: title is missing.", skipped: true };

  const now = new Date();
  const metadata = {
    ...(input.metadata ?? {}),
    href: input.href ?? null,
    message,
    title,
  };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .insert({
        category: input.category,
        employee_hr_id: recipientHrId,
        event_key: eventKey,
        metadata,
        recipients: [recipientHrId],
        scheduled_for: now.toISOString().slice(0, 10),
        sent_at: now.toISOString(),
        status: "sent",
        subject: title,
        updated_at: now.toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      if (isDuplicateNotificationError(error)) {
        return { reason: "In-app notification already exists.", skipped: true };
      }
      throw error;
    }

    return { eventId: String(data?.id ?? ""), skipped: false };
  } catch (error) {
    if (notificationSchemaMissing(error)) {
      return { reason: "In-app notification skipped: notification_events table is unavailable.", skipped: true };
    }
    throw error;
  }
}

export async function listInAppNotificationsForViewer(
  access: AccessContext,
  limit = 8,
): Promise<InAppNotificationView[]> {
  const identity = viewerIdentity(access);
  const employeeHrId = identity.hrId;
  if (!employeeHrId) return [];

  try {
    const supabase = getSupabaseAdmin();
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    // A seat that hides some notices reads past them (see seat-notice-filter.ts); the slice below
    // still returns at most boundedLimit.
    const readLimit = noticeFetchLimit(access.role, boundedLimit);
    const selectColumns =
      "id,category,subject,scheduled_for,sent_at,status,metadata,recipients,employee_hr_id,created_at,module,priority,action_url,event_type,test_login_id";

    const allowedCategories = Array.from(PERSONAL_BELL_CATEGORIES);

    // The two reads are independent, so they run together: the bell is polled by every open page and each
    // round trip to the database costs 300-600 ms (Sentry, 2026-10-16), which the second one used to add on top.
    const [employeeResult, recipientResult, otherKindsResult] = await Promise.all([
      supabase
        .from("notification_events")
        .select(selectColumns)
        .eq("employee_hr_id", employeeHrId.toUpperCase())
        .in("category", allowedCategories)
        .order("created_at", { ascending: false })
        .limit(readLimit),
      supabase
        .from("notification_events")
        .select(selectColumns)
        .overlaps("recipients", [employeeHrId])
        .in("category", allowedCategories)
        .order("created_at", { ascending: false })
        .limit(readLimit),
      // The Talent Acquisition seat gets a new-CV notice every twenty minutes, so the two reads above
      // fill with them and reach back only a day or two. Her other notices are read on their own, so an
      // interview request that has waited three days is still on the page (seat-notice-filter.ts).
      seatNeedsOtherKindsRead(access.role)
        ? supabase
            .from("notification_events")
            .select(selectColumns)
            .eq("employee_hr_id", employeeHrId.toUpperCase())
            .in("category", allowedCategories)
            .or(`event_type.is.null,event_type.neq.${TALENT_ACQUISITION_FLOODING_EVENT_TYPE}`)
            .order("created_at", { ascending: false })
            .limit(readLimit)
        : null,
    ]);

    if (employeeResult.error) throw employeeResult.error;

    const rowsById = new Map<string, InAppNotificationEventRow>();
    for (const row of (employeeResult.data ?? []) as InAppNotificationEventRow[]) {
      const id = String(row.id ?? "");
      if (id) rowsById.set(id, row);
    }

    if (!recipientResult.error) {
      for (const row of (recipientResult.data ?? []) as InAppNotificationEventRow[]) {
        const id = String(row.id ?? "");
        if (id) rowsById.set(id, row);
      }
    }

    // A failed side read costs her the older interview requests, never the bell itself.
    if (otherKindsResult && !otherKindsResult.error) {
      for (const row of (otherKindsResult.data ?? []) as InAppNotificationEventRow[]) {
        const id = String(row.id ?? "");
        if (id) rowsById.set(id, row);
      }
    }

    const newestFirst = Array.from(rowsById.values())
      // Personal-bell category allowlist: hide legacy/orphaned categories (e.g.
      // "leave") that may carry mis-assigned recipients. Defense-in-depth on top
      // of the SQL .in("category", ...) filter. See src/lib/notifications/recipients.ts.
      .filter((row) => isPersonalBellCategory(row.category))
      // The Talent Acquisition seat's centre holds three notices; the older recruitment alerts
      // already written for her are dropped here (seat-notice-filter.ts).
      .filter((row) => !noticeHiddenFromSeat(access.role, row.event_type))
      // Fail-closed recipient isolation applied AFTER the DB query — never rely on
      // the SQL employee/overlap filters alone. See src/lib/notifications/recipients.ts.
      .filter((row) =>
        canViewerSeeNotification(employeeHrId, {
          employeeHrId: row.employee_hr_id,
          recipients: Array.isArray(row.recipients) ? row.recipients : [],
        }),
      )
      // A Phoenix CRM test-world notice is addressed to the real person, so every filter above
      // passes it. This is the one that keeps it off her bell and on her test login's.
      .filter((row) => testNoticeVisibleToViewer(identity.testLoginId, row))
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
    // The newest `boundedLimit` rows; for the Talent Acquisition seat, with room held for the notices
    // that are not a new CV (seat-notice-filter.ts).
    const rows = seatNoticeWindow(access.role, newestFirst, boundedLimit);

    const rowIds = rows.map((row) => String(row.id ?? "")).filter(Boolean);
    const stateByEventId = new Map<string, NotificationUserStateRow>();
    if (rowIds.length > 0) {
      try {
        let stateQuery = supabase
          .from("notification_user_states")
          .select("notification_event_id,user_id,hr_id,read_at,archived_at")
          .in("notification_event_id", rowIds);
        stateQuery = identity.userId
          ? stateQuery.or(`user_id.eq.${identity.userId},hr_id.eq.${employeeHrId}`)
          : stateQuery.eq("hr_id", employeeHrId);
        const { data: stateRows, error: stateError } = await stateQuery;
        if (stateError) throw stateError;
        for (const state of (stateRows ?? []) as NotificationUserStateRow[]) {
          const id = String(state.notification_event_id ?? "");
          if (id) stateByEventId.set(id, state);
        }
      } catch (error) {
        if (!stateSchemaMissing(error)) throw error;
      }
    }

    const mappedRows: InAppNotificationListRow[] = rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};

      return {
        category: String(row.category ?? "general"),
        employeeHrId: row.employee_hr_id ?? null,
        id: String(row.id ?? ""),
        metadata: {
          ...metadata,
          href: notificationHrefForViewerRole({
            fallbackHref: typeof metadata.href === "string" ? metadata.href : row.action_url ?? null,
            metadata,
            role: access.role,
          }),
        },
        module: row.module ?? null,
        priority: row.priority ?? "normal",
        recipients: Array.isArray(row.recipients) ? row.recipients : [],
        scheduledFor: row.scheduled_for ? new Date(String(row.scheduled_for)).toISOString() : null,
        sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
        status: String(row.status ?? "pending"),
        subject: String(row.subject ?? "Notification"),
      };
    });

    const staleApprovalIds = await archiveStaleApprovalNotifications(access, rows).catch(() => new Set<string>());
    const archivedEventIds = new Set([
      ...mappedRows.filter((row) => stateByEventId.get(row.id)?.archived_at).map((row) => row.id),
      ...staleApprovalIds,
    ]);

    // Read-time enrichment: resolve the (non-sensitive) subject/type/period for
    // vacation notifications so OLD rows display subject-first like new ones.
    // Best-effort and fail-soft — never blocks the bell.
    const vacationRequestIds = mappedRows
      .filter((row) => row.category === "vacation_request")
      .map((row) => (typeof row.metadata.requestId === "string" ? row.metadata.requestId : ""))
      .filter((value) => value.length > 0);

    let enrichmentByRequestId: ReadonlyMap<string, NotificationEnrichmentRecord> = new Map();
    if (vacationRequestIds.length > 0) {
      try {
        enrichmentByRequestId = await fetchVacationNotificationEnrichments(vacationRequestIds);
      } catch {
        enrichmentByRequestId = new Map();
      }
    }

    const views = mapInAppNotificationRows(mappedRows, employeeHrId, enrichmentByRequestId);
    return views.filter((view) => !archivedEventIds.has(view.id)).map((view) => {
      const state = stateByEventId.get(view.id);
      const source = mappedRows.find((row) => row.id === view.id);
      return {
        ...view,
        isRead: Boolean(state?.read_at),
        module: source?.module ?? null,
        priority: source?.priority ?? "normal",
        readAt: state?.read_at ?? null,
      };
    });
  } catch (error) {
    if (notificationSchemaMissing(error)) return [];
    throw error;
  }
}

export async function markInAppNotificationRead(access: AccessContext, notificationId: string) {
  const identity = viewerIdentity(access);
  // hr_id — not loginId — is what uniquely identifies the state row (see
  // NOTIFICATION_STATE_CONFLICT_TARGET). Without one there is nothing to upsert against.
  if (!identity.hrId) return { skipped: true };

  const cleanedId = cleanText(notificationId);
  if (!cleanedId) return { skipped: true };

  try {
    const { data: eventRow, error: eventError } = await getSupabaseAdmin()
      .from("notification_events")
      .select("employee_hr_id,recipients")
      .eq("id", cleanedId)
      .maybeSingle();
    if (eventError) throw eventError;
    // Fail-closed: only let a viewer mark an event "read" for themselves if the
    // event was actually addressed to them (subject or explicit recipient) —
    // otherwise any authenticated user could stamp read-state on arbitrary ids.
    if (
      !eventRow ||
      !canViewerSeeNotification(identity.hrId, {
        employeeHrId: eventRow.employee_hr_id,
        recipients: eventRow.recipients,
      })
    ) {
      return { reason: "Notification is not addressed to this viewer.", skipped: true };
    }
  } catch (error) {
    if (notificationSchemaMissing(error)) return { reason: "notification_events unavailable", skipped: true };
    throw error;
  }

  const now = new Date().toISOString();
  try {
    const payload = {
      hr_id: identity.hrId,
      notification_event_id: cleanedId,
      read_at: now,
      updated_at: now,
      user_id: identity.userId,
    };
    const { error } = await getSupabaseAdmin()
      .from("notification_user_states")
      .upsert(payload, { onConflict: NOTIFICATION_STATE_CONFLICT_TARGET });
    if (error) throw error;
    return { skipped: false };
  } catch (error) {
    if (stateSchemaMissing(error)) return { reason: "notification_user_states unavailable", skipped: true };
    throw error;
  }
}

export async function markAllInAppNotificationsRead(access: AccessContext) {
  const notifications = await listInAppNotificationsForViewer(access, 20);
  const unread = notifications.filter((notification) => !notification.isRead);
  // allSettled so a single failing row can't sink the whole "mark all read" batch
  // (one bad upsert previously failed the entire request with a 500).
  const results = await Promise.allSettled(
    unread.map((notification) => markInAppNotificationRead(access, notification.id)),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    logError(
      `markAllInAppNotificationsRead: ${failures.length}/${unread.length} notification(s) failed to mark read`,
      {
        labels: { event: "in_app_mark_all_read_partial_failure", failed: failures.length, total: unread.length },
        error: failures[0].reason,
      },
    );
  }
  return { marked: unread.length - failures.length };
}

export async function archiveInAppNotification(access: AccessContext, notificationId: string) {
  const identity = viewerIdentity(access);
  // hr_id — not loginId — is what uniquely identifies the state row (see
  // NOTIFICATION_STATE_CONFLICT_TARGET). Without one there is nothing to upsert against.
  if (!identity.hrId) return { skipped: true };

  const cleanedId = cleanText(notificationId);
  if (!cleanedId) return { skipped: true };

  try {
    const { data: eventRow, error: eventError } = await getSupabaseAdmin()
      .from("notification_events")
      .select("employee_hr_id,recipients")
      .eq("id", cleanedId)
      .maybeSingle();
    if (eventError) throw eventError;
    if (
      !eventRow ||
      !canViewerSeeNotification(identity.hrId, {
        employeeHrId: eventRow.employee_hr_id,
        recipients: eventRow.recipients,
      })
    ) {
      return { reason: "Notification is not addressed to this viewer.", skipped: true };
    }
  } catch (error) {
    if (notificationSchemaMissing(error)) return { reason: "notification_events unavailable", skipped: true };
    throw error;
  }

  const now = new Date().toISOString();
  try {
    const payload = {
      archived_at: now,
      hr_id: identity.hrId,
      notification_event_id: cleanedId,
      updated_at: now,
      user_id: identity.userId,
    };
    const { error } = await getSupabaseAdmin()
      .from("notification_user_states")
      .upsert(payload, { onConflict: NOTIFICATION_STATE_CONFLICT_TARGET });
    if (error) throw error;
    return { skipped: false };
  } catch (error) {
    if (stateSchemaMissing(error)) return { reason: "notification_user_states unavailable", skipped: true };
    throw error;
  }
}

export async function archiveAllInAppNotifications(access: AccessContext) {
  const notifications = await listInAppNotificationsForViewer(access, 20);
  // allSettled so a single failing row can't sink the whole "clear all" batch — mirrors
  // markAllInAppNotificationsRead's failure isolation.
  const results = await Promise.allSettled(
    notifications.map((notification) => archiveInAppNotification(access, notification.id)),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    logError(
      `archiveAllInAppNotifications: ${failures.length}/${notifications.length} notification(s) failed to archive`,
      {
        labels: { event: "in_app_archive_all_partial_failure", failed: failures.length, total: notifications.length },
        error: failures[0].reason,
      },
    );
  }
  return { archived: notifications.length - failures.length };
}

/** LIKE reads `%` and `_` as wildcards, and every event key here contains `phoenix_crm`. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Withdraw every in-app notice whose event key starts with `prefix`, for the people it went to.
 *
 * 🔴 THIS IS THE SYSTEM RETRACTING ITS OWN NOTICE, AND IT IS THE ONE PLACE THAT WRITES ANOTHER
 * PERSON'S ARCHIVE STATE. Everywhere else that row is the viewer's own: `archiveInAppNotification`
 * refuses an id not addressed to him, and `archiveStaleApprovalNotifications` deliberately does not
 * write a test login's host's row. The exception earns itself only because the RECORD behind the
 * notice is gone — a to-do that can never be done is worse than no notice at all. So it must be
 * called with a prefix naming ONE record, never a whole category, which would clear notices that
 * still have work behind them.
 *
 * Each `notification_events` row is already per-recipient (`createNotificationEvent` writes
 * `employee_hr_id` and a one-element `recipients`), so the row itself names whose state to write —
 * nothing is inferred, and a test-world copy carries its own key and is withdrawn with the rest.
 *
 * ARCHIVED, never deleted: the event row stays for the audit and only the bell's filter changes.
 */
export async function withdrawInAppNotificationsByEventKeyPrefix(
  prefix: string,
  client: Pick<ReturnType<typeof getSupabaseAdmin>, "from"> = getSupabaseAdmin(),
): Promise<{ withdrawn: number }> {
  const cleanedPrefix = cleanText(prefix);
  if (!cleanedPrefix) return { withdrawn: 0 };

  let events: Array<{ employee_hr_id?: unknown; id?: unknown; recipient_user_id?: unknown }> = [];
  try {
    const { data, error } = await client
      .from("notification_events")
      .select("id,employee_hr_id,recipient_user_id")
      .like("event_key", likePrefix(cleanedPrefix));
    if (error) throw error;
    events = (data ?? []) as typeof events;
  } catch (error) {
    if (notificationSchemaMissing(error)) return { withdrawn: 0 };
    throw error;
  }

  const rows = events
    .map((event) => ({
      hr_id: normalizeHrId(cleanText(event.employee_hr_id as string | null | undefined)),
      notification_event_id: cleanText(event.id as string | null | undefined),
      user_id: cleanText(event.recipient_user_id as string | null | undefined) || null,
    }))
    .filter((row) => row.notification_event_id && row.hr_id);
  if (rows.length === 0) return { withdrawn: 0 };

  const now = new Date().toISOString();
  try {
    const { error } = await client
      .from("notification_user_states")
      .upsert(
        rows.map((row) => ({ ...row, archived_at: now, updated_at: now })),
        { onConflict: NOTIFICATION_STATE_CONFLICT_TARGET },
      );
    if (error) throw error;
    return { withdrawn: rows.length };
  } catch (error) {
    if (stateSchemaMissing(error)) return { withdrawn: 0 };
    throw error;
  }
}
