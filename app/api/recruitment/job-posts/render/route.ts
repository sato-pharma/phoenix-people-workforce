import {
  assertSameOriginMutation,
  readJsonObject,
  recruitmentApiError,
  recruitmentProblem,
  requireRecruitmentAccess,
} from "@/app/api/recruitment/_lib/http";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { canBuildJobPosts } from "@/lib/recruitment/access";
import { renderJobPostBundle, renderJobPostPdf, renderJobPostPng } from "@/lib/recruitment/job-posts/render";
import { JOB_POST_CAREERS, jobPostFileStem, jobPostForArea } from "@/lib/recruitment/job-posts/templates";
import { coerceAreas, coerceTitleDraft, contentFromDraft, postRequestViolations } from "@/lib/recruitment/job-posts/titles";
import { NEW_CHANNEL_APPLY_WHATSAPP_NUMBER } from "@/lib/recruitment/outreach/job-post-channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Draw a job post — a PNG, a PDF, or the whole set as a ZIP.
 *
 * THE POST ARRIVES WHOLE, NOT AS A TITLE ID: what downloads is exactly what the person sees in the
 * preview, unsaved edits included. Every field is re-checked here with the same rules the screen uses.
 *
 * THE APPLY DETAILS ARE THE SERVER'S. The WhatsApp number and the careers address are supplied here
 * and never read from the body, so a request cannot print somebody else's number on a company advert.
 *
 * `area` narrows a PNG or PDF to one area — the per-area picture, which names that area and no other.
 * `zip` returns the full set: the all-areas picture, one per area, and one PDF of every page.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "export");
    if (!canBuildJobPosts(access)) {
      return recruitmentProblem("Job Posts is open to the Super Admin and Talent Acquisition.", 403);
    }

    const body = await readJsonObject(request);
    const format = body.format === "pdf" ? "pdf" : body.format === "zip" ? "zip" : "png";
    const draft = coerceTitleDraft(body.title && typeof body.title === "object" ? (body.title as Record<string, unknown>) : {});
    const areas = coerceAreas(body.areas);
    const line = typeof body.line === "string" && body.line.trim() ? body.line.trim() : null;
    const problems = postRequestViolations({ areas, draft, line, template: body.template });
    if (problems.length) return recruitmentProblem(problems.join(" "), 400);
    const template = body.template as Parameters<typeof renderJobPostPng>[1];

    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: `export:job-post:${format}` });

    const content = contentFromDraft(draft, { areas, line }, { careers: JOB_POST_CAREERS, whatsapp: NEW_CHANNEL_APPLY_WHATSAPP_NUMBER });

    if (format === "zip") {
      const zip = await renderJobPostBundle(content, template);
      return file(zip, `${jobPostFileStem(content)}.zip`, "application/zip");
    }

    const area = typeof body.area === "string" ? body.area.trim() : "";
    if (area && !areas.some((name) => name.toLowerCase() === area.toLowerCase())) {
      return recruitmentProblem("That area is not one of this post's areas.", 400);
    }
    const one = area ? jobPostForArea(content, areas.find((name) => name.toLowerCase() === area.toLowerCase())!) : content;
    const stem = jobPostFileStem(one, area || null);
    if (format === "pdf") return file(await renderJobPostPdf(one, template), `${stem}.pdf`, "application/pdf");
    return file(await renderJobPostPng(one, template), `${stem}.png`, "image/png");
  } catch (error) {
    if (error instanceof ChromiumUnavailableError) {
      return recruitmentProblem("This server cannot draw the post right now. Try again in a minute.", 503);
    }
    return recruitmentApiError(error, "The job post could not be drawn.");
  }
}

function file(bytes: Uint8Array, filename: string, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": contentType,
    },
  });
}
