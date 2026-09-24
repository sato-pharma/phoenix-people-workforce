import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { markMilestonesSeen } from "@/lib/milestones/ledger";
import { listMilestoneNoticeOccasions, milestoneNoticeWindow, occasionOccurrence } from "@/lib/milestones/notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "I have seen who is coming up." The acknowledgement that stops the daily reminder.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `milestones:read` — Super Admin alone, the same gate as the due list. Opening the
 * milestones page fires this once, and the workspace posts it fire-and-forget on mount.
 *
 * 🔴 IT TAKES NO OCCURRENCE LIST FROM THE CLIENT, DELIBERATELY. The window it marks is RE-DERIVED
 * here, server-side, from the one canonical `milestoneNoticeWindow()` the pump also reads — the
 * exact same occasions the reminder is about. A client that could name its own occurrences could
 * silence a reminder about somebody it was never shown, and widening the on-screen look-ahead to
 * peek further is not the same act as being told. So the body is ignored; the server decides what
 * "seen" covers, and it covers precisely what the pump would otherwise remind about.
 *
 * Marking is idempotent (`on conflict do nothing`), so firing on every mount is safe and cheap.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "milestones", "read");

    const viewerHrId = access.hrId?.trim() ?? "";
    if (!viewerHrId) {
      // No HR identity to latch against. Nothing to mark, and the reminder simply fires again —
      // the safe direction. Not an error: a Super Admin service account can legitimately hold the
      // grant without an employee row.
      return Response.json({ marked: 0 }, { headers: { "Cache-Control": "no-store" } });
    }

    const { from, to } = milestoneNoticeWindow();
    const occasions = await listMilestoneNoticeOccasions(from, to);
    const marked = await markMilestonesSeen(viewerHrId, occasions.map(occasionOccurrence));

    return Response.json({ marked }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "Milestones are available to the system administrator only." },
        { status: 403 },
      );
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The milestone acknowledgement could not be recorded.") },
      { status: 500 },
    );
  }
}
