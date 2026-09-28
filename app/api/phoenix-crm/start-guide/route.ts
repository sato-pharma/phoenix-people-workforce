import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { buildPhoenixCrmStartGuide, isStartGuideLanguage } from "@/lib/phoenix-crm/start-guide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET = the one-page start guide a District Manager sends a rep, in English or Arabic.
 *
 * 🔴 HTML, NOT A SERVER-RENDERED PDF, and for the reason the hiring pack's print route already
 * states in its own header: the BROWSER is what shapes and orders Arabic correctly, and "Print →
 * Save as PDF" from this page produces a real PDF with selectable text. Half this document is
 * Arabic, so that argument is stronger here than where it was first written. The `?format=pdf`
 * Chromium path exists in this repo for one narrow reason — a flowing instrument that has to print
 * "صفحة N من M" — and this guide is deliberately one page, so it needs none of that machinery and
 * does not put a headless browser in the request path of a help document.
 *
 * 🔴 NO VIEWER IS RESOLVED, DELIBERATELY. Every other route in this module calls
 * `resolvePhoenixCrmViewer` because it is about to read somebody's territory; this one holds no
 * data about anybody — no rep, no customer, no figure, nothing an organogram scope could narrow.
 * Resolving a viewer here would be a gate that reads as meaningful and decides nothing, and the next
 * person would reasonably assume the page is scoped when it is not. `phoenix_crm:read` is the whole
 * of the gate, which is right for a page whose content is the same for every person who can open the
 * module at all.
 *
 * An unknown `lang` is a 400 rather than a silent fall back to English: a manager who sends the link
 * with a typo should be told, not handed the wrong language to forward to his team.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");

    const search = searchOf(request);
    const language = search.get("lang") ?? "en";
    if (!isStartGuideLanguage(language)) {
      throw validationError("The start guide is available in English (en) and Arabic (ar).");
    }

    return new Response(buildPhoenixCrmStartGuide(language), {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not open the start guide.");
  }
}
