/**
 * The viewer's unread in-app notices of ONE module, and marking some of them read.
 *
 * Built for the pulsing badges of Phoenix CRM (owner, 2026-10-08) but module-agnostic: it reads the SAME
 * rows the bell does (`notification_events` with the viewer's own `notification_user_states`) under the
 * SAME fences — the row must be addressed to him, a test-world notice shows only to the test login it was
 * written for, and a read or archived one is not "unread". It lives here rather than in a module's own
 * folder because the notification tables are this folder's, not a module's.
 *
 * Both functions THROW on a database failure; the caller decides what a failure looks like on its screen
 * (the badges draw nothing — never "nothing new").
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { NOTIFICATION_STATE_CONFLICT_TARGET, testNoticeVisibleToViewer, viewerIdentity } from "@/lib/notifications/in-app";
import { canViewerSeeNotification } from "@/lib/notifications/recipients";
import { quotedOrClause } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type UnreadModuleNotice = {
  actionUrl: string | null;
  createdAt: string;
  eventType: string;
  id: string;
  /** The seat the notice was raised about (`metadata.seatId`), when its module records one. */
  seatId: string | null;
  title: string;
};

type EventRow = {
  action_url?: string | null;
  created_at?: string | null;
  employee_hr_id?: string | null;
  event_type?: string | null;
  id?: string | number | null;
  metadata?: unknown;
  recipients?: unknown;
  subject?: string | null;
  test_login_id?: string | null;
};

type StateRow = { archived_at?: string | null; notification_event_id?: string | null; read_at?: string | null };

/** Event ids per `notification_user_states` read — well inside a URL, however many unread there are. */
const STATE_ID_CHUNK = 150;

function seatIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const seatId = (metadata as { seatId?: unknown }).seatId;
  return typeof seatId === "string" && seatId.length > 0 ? seatId : null;
}

export async function listUnreadModuleNotices(
  access: AccessContext,
  input: { limit: number; module: string; sinceDays: number },
): Promise<UnreadModuleNotice[]> {
  const identity = viewerIdentity(access);
  if (!identity.hrId) return [];
  // Held in a const: the guard above narrows the property, but that narrowing is discarded inside the
  // chunk callback below, where the quoted arm needs a plain string.
  const viewerHrId = identity.hrId;
  const supabase = getSupabaseAdmin();
  const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000).toISOString();

  // Each event row is per-recipient (`employee_hr_id` is the person it was written for), so one filter
  // finds the viewer's own.
  const { data, error } = await supabase
    .from("notification_events")
    .select("id,subject,event_type,action_url,created_at,employee_hr_id,recipients,metadata,test_login_id")
    .eq("module", input.module)
    .eq("employee_hr_id", identity.hrId.toUpperCase())
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (error) throw error;

  const rows = ((data ?? []) as EventRow[])
    // Fail-closed, exactly as the bell does after its own query: never rely on the SQL filter alone.
    .filter((row) =>
      canViewerSeeNotification(identity.hrId ?? "", {
        employeeHrId: row.employee_hr_id,
        recipients: Array.isArray(row.recipients) ? row.recipients : [],
      }),
    )
    .filter((row) => testNoticeVisibleToViewer(identity.testLoginId, row));
  const ids = rows.map((row) => String(row.id ?? "")).filter(Boolean);
  if (ids.length === 0) return [];

  // Up to 300 ids: one `.in()` that long is a ~11 KB URL, so the states are asked in chunks of
  // STATE_ID_CHUNK, all at once — every chunk is the same viewer's, and none depends on another.
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += STATE_ID_CHUNK) chunks.push(ids.slice(index, index + STATE_ID_CHUNK));
  const stateReads = await Promise.all(
    chunks.map(async (chunk) => {
      let stateQuery = supabase.from("notification_user_states").select("notification_event_id,read_at,archived_at").in("notification_event_id", chunk);
      // Quoted values: the HR id is normalised, not validated, and a `,` in it would end its arm
      // and leave the badge counting someone else's read state (AGENTS.md MR-B04).
      stateQuery = identity.userId
        ? stateQuery.or(
            [
              quotedOrClause("user_id", "eq", identity.userId),
              quotedOrClause("hr_id", "eq", viewerHrId),
            ].join(","),
          )
        : stateQuery.eq("hr_id", identity.hrId);
      const { data: states, error: stateError } = await stateQuery;
      if (stateError) throw stateError;
      return (states ?? []) as StateRow[];
    }),
  );
  const settled = new Set(
    stateReads.flat().filter((state) => state.read_at || state.archived_at).map((state) => String(state.notification_event_id ?? "")),
  );

  return rows
    .filter((row) => !settled.has(String(row.id ?? "")))
    .map((row) => ({
      actionUrl: row.action_url ?? null,
      createdAt: String(row.created_at ?? ""),
      eventType: String(row.event_type ?? ""),
      id: String(row.id ?? ""),
      seatId: seatIdOf(row.metadata),
      title: String(row.subject ?? "").trim() || "New notice",
    }));
}

/**
 * Mark these notices read for the viewer only. The ids come from `listUnreadModuleNotices` for the same
 * viewer, so each is already proven to be his; the state row is keyed on (event, his HR id).
 */
export async function markNoticesReadForViewer(access: AccessContext, notificationIds: readonly string[]): Promise<number> {
  const identity = viewerIdentity(access);
  if (!identity.hrId || notificationIds.length === 0) return 0;
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("notification_user_states")
    .upsert(
      notificationIds.map((id) => ({
        hr_id: identity.hrId,
        notification_event_id: id,
        read_at: now,
        updated_at: now,
        user_id: identity.userId,
      })),
      { onConflict: NOTIFICATION_STATE_CONFLICT_TARGET },
    );
  if (error) throw error;
  return notificationIds.length;
}
