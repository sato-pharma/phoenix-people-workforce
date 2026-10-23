import { writeAuditLog, type AuditLogInput } from "@/lib/admin/audit";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Who looked at whose screenshot — one audit row for every picture opened on the System Audit page.
 *
 * WHY. Both pictures are unmasked by the owner's decision of 23 Oct 2026 (a payslip that errors is
 * photographed with the pay on it), and the access registry declared the picture route an audited
 * read — yet neither route wrote a row, so nothing said who had looked at whose screen (review of
 * #6358 and #6359, 23 Oct 2026). The owner the same evening: "log every screenshot view on the
 * System Audit page".
 *
 * WHAT COUNTS AS A VIEW. A picture actually handed to the viewer: the block or error screen streamed
 * by /api/admin/system-audit/screens/[id], or the crash picture's five-minute signed URL minted by
 * /api/admin/system-audit/screenshot/[eventId]. A refused caller, a bad id, or a picture past its 90
 * days writes nothing — no picture was seen.
 *
 * WHEN. Awaited BEFORE the picture leaves, never deferred with `afterResponse`: that loses the task if
 * the process dies between the reply and the write, and this row must never be the one missing while
 * the picture was seen. `writeAuditLog` keeps a slow write in the outbox rather than losing it and
 * never throws, so a slow trail can delay a picture but never refuse one. The person's name is
 * best-effort: a lookup that fails keeps their HR ID in the sentence and still writes the row.
 */

type Client = ReturnType<typeof getSupabaseAdmin>;

export type ViewedScreenshot = {
  /** "screen" — a block or error screen (user_error_screens); "crash" — app_error_events' picture. */
  source: "screen" | "crash";
  /** The user_error_screens id, or the app_error_events id for a crash. */
  id: string;
  /** user_error_screens.kind for a screen; ignored for a crash. */
  screenKind?: string | null;
  /** Whose screen it was — the person photographed, never the viewer. */
  hrId: string | null;
  loginId: string | null;
  /** The page or route that person was on. */
  page: string | null;
  takenAt: string | null;
  isTest?: boolean;
};

export type ScreenshotViewer = { loginId: string | null; hrId: string | null };

/** The drawer's own words for each picture (incident-drawer.tsx, SCREEN_KIND_LABELS). */
const SCREEN_KIND_LABELS: Record<string, string> = {
  error_screen: "Error screen shown",
  refused_request: "Request refused",
  failed_request: "Request failed",
};

export function screenshotKindLabel(viewed: Pick<ViewedScreenshot, "source" | "screenKind">): string {
  if (viewed.source === "crash") return "Crash";
  return SCREEN_KIND_LABELS[viewed.screenKind ?? ""] ?? "Screen";
}

/** The person in words: their name, else their HR ID, else their login, else "an unknown person". */
export function screenshotSubject(viewed: Pick<ViewedScreenshot, "hrId" | "loginId" | "isTest">, name: string | null): string {
  const who = name?.trim() || viewed.hrId || (viewed.loginId ? `login ${viewed.loginId}` : "an unknown person");
  return viewed.isTest ? `${who} (test account)` : who;
}

/** One sentence for the audit log, e.g. "Viewed the screenshot of what Mona Adel saw — Request refused on /employee-portals/payslips, taken 23 Oct 2026 · 19:05 Cairo." */
export function screenshotViewSummary(viewed: ViewedScreenshot, name: string | null): string {
  const page = viewed.page ? ` on ${viewed.page}` : "";
  const taken = viewed.takenAt ? `, taken ${cairoDateTime(viewed.takenAt)} Cairo` : "";
  return `Viewed the screenshot of what ${screenshotSubject(viewed, name)} saw — ${screenshotKindLabel(viewed)}${page}${taken}.`;
}

/** The audit row a view writes. Pure, so the shape is pinned without a database. */
export function screenshotViewAuditRow(viewer: ScreenshotViewer, viewed: ViewedScreenshot, name: string | null): AuditLogInput {
  return {
    actorLoginId: viewer.loginId,
    entityId: viewed.id,
    entityType: "system_audit_screenshot_view",
    newValues: {
      viewerHrId: viewer.hrId,
      picture: viewed.source,
      kind: screenshotKindLabel(viewed),
      personHrId: viewed.hrId,
      personLoginId: viewed.loginId,
      page: viewed.page,
      takenAt: viewed.takenAt,
      isTest: viewed.isTest === true,
    },
    summary: screenshotViewSummary(viewed, name),
  };
}

async function personName(hrId: string | null, override?: Client): Promise<string | null> {
  const key = canonicalHrIdKey(hrId);
  if (!hrId || !key) return null;
  try {
    const supabase = override ?? getSupabaseAdmin();
    const { data, error } = await supabase.from("employees").select("hr_id, full_name").in("hr_id", hrIdLookupKeys(hrId));
    if (error) return null;
    const match = ((data ?? []) as Array<{ hr_id: string | null; full_name: string | null }>).find(
      (row) => canonicalHrIdKey(row.hr_id) === key && row.full_name?.trim(),
    );
    return match?.full_name?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Write the one audit row for a picture the viewer is about to receive. Never throws. */
export async function recordScreenshotView(
  viewer: ScreenshotViewer,
  viewed: ViewedScreenshot,
  deps: { client?: Client; write?: (input: AuditLogInput) => Promise<void> } = {},
): Promise<void> {
  const name = await personName(viewed.hrId, deps.client);
  const row = screenshotViewAuditRow(viewer, viewed, name);
  try {
    await (deps.write ?? writeAuditLog)(row);
  } catch (error) {
    // writeAuditLog reports its own failures and keeps the row in the outbox; this catches only a
    // throw from beneath it, so a broken trail is loud in the logs and never refuses the picture.
    logError("Screenshot view audit row could not be written", {
      labels: { event: "screenshot_view_audit_failed", entityId: viewed.id },
      context: { actorLoginId: viewer.loginId, summary: row.summary },
      error,
    });
  }
}
