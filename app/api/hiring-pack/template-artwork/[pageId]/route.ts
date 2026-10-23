import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  downloadCustomTemplatePage,
  isCustomTemplateLayerMissing,
  loadCustomTemplatePage,
} from "@/lib/hiring-pack/custom-template-store";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The artwork behind a company template — one printed side, streamed from the private bucket.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NOT A DATA URI, and that is a measured decision rather than a preference. `renderSheet` puts the
// artwork in an `<img src>`, and inlining it would mean a page of a scanned form — several megabytes
// at print resolution — travelling inside the rendered HTML. This repository has already learnt what
// that costs: an `unstable_cache` entry over 2MB kills the dev server outright, throwing only in dev
// and uncatchably. A URL keeps the HTML small, lets the browser cache the image, and keeps the bytes
// behind a permission check.
//
// THE ROUTE TAKES A PAGE ID, NEVER A STORAGE PATH. The path is resolved server-side from the row, so
// no caller ever names an object and a request cannot reach anything in this bucket that is not a
// page of a real template. That is the same rule the hiring-documents file route runs on.
//
// GATED ON `employee_documents` READ — the same permission as printing the document this artwork is
// part of. A narrower gate here would mean an operator who can print the form cannot see the form.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (isCustomTemplateLayerMissing(error)) {
    return { message: "Company templates are not set up yet.", status: 409 };
  }
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

export async function GET(request: Request, { params }: { params: Promise<{ pageId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const { pageId } = await params;
    const found = await loadCustomTemplatePage(pageId);
    if (!found) {
      return NextResponse.json(
        { error: "not_found", message: "That template page is no longer on record." },
        { status: 404 },
      );
    }

    const bytes = await downloadCustomTemplatePage(found.page.storagePath);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        // A YEAR, and safely so: a page's storage path carries a random segment and is never
        // overwritten — replacing a template's artwork writes new objects under a new version. So
        // this URL's bytes cannot change, and `immutable` says exactly that. `private` keeps it out
        // of any shared cache, because a company template can be an internal form.
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(bytes.length),
        "Content-Type": found.page.contentType,
        // Inline, always. This is read by an `<img>`, never offered as a download.
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_template_artwork_failed", message }, { status });
  }
}
