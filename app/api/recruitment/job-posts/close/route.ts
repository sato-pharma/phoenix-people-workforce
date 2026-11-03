import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";
import { writeAuditLog } from "@/lib/admin/audit";
import { canPublishJobPosts } from "@/lib/recruitment/access";
import { closeJobCardOnWebsite, WebsiteCareersError } from "@/lib/recruitment/job-posts/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Close one card on the careers page. A person's press, Super Admin only. Nothing closes a card by itself. */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    if (!canPublishJobPosts(access)) {
      return recruitmentProblem("Closing a careers card is open to the Super Admin.", 403);
    }

    const body = await readJsonObject(request);
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    if (!CARD_ID.test(cardId)) return recruitmentProblem("That card could not be identified.", 400);
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";

    await closeJobCardOnWebsite(cardId);

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: cardId,
      entityType: "job_post_publish",
      newValues: { action: "close", title },
      summary: `Closed “${title}” on the careers page`,
    });

    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof WebsiteCareersError) return recruitmentProblem(error.message, error.status);
    return recruitmentApiError(error, "The card could not be closed.");
  }
}
