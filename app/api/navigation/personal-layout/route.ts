import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { isPersonalNavigationLayout, type PersonalNavigationLayout } from "@/lib/navigation/personal-layout";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  clearPersonalLayout,
  loadPersonalLayout,
  savePersonalLayout,
} from "@/lib/navigation/personal-layout-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A person's own sidebar arrangement. GET reads it, PUT replaces it, DELETE resets to the
 * code-defined default.
 *
 * ── The identity rule ───────────────────────────────────────────────────────────────────────
 * The hr_id is ALWAYS taken from the resolved session and NEVER from the request. There is no
 * ?hrId= and no body field for it, deliberately: the moment a caller can name whose layout to read
 * or write, this stops being "my own account" and becomes the targeting matrix that Modules Control
 * was retired for being. Every function below keys on `access.hrId` and nothing else.
 *
 * ── Why the guest check is on `source`, not `role` ──────────────────────────────────────────
 * An unauthenticated caller resolves to role "Employee", not null — so the familiar `if
 * (!access.role) return 401` is dead code everywhere it appears in this repo. `source === "guest"`
 * is the real test.
 *
 * Nothing here grants access to anything. A layout only reorders links the viewer was already
 * permitted to see (see applyPersonalLayout), so the worst a bad write can do is give that one
 * person an inconvenient menu.
 */

/** A generous ceiling that still stops the jsonb column being used as free storage. */
const MAX_HREFS = 2000;

// Takes the whole layout type rather than a structural subset on purpose: a new zone added to
// PersonalNavigationLayout that this function forgets is a hole in the cap, and a structural
// parameter would keep compiling happily while the count silently ran low.
function countHrefs(layout: PersonalNavigationLayout): number {
  // Every per-module override carries its own pair of rows, so this is the one part of the document
  // that grows with the number of modules rather than being bounded by the number of pages. It is
  // exactly why the cap counts it: 40 modules × two full rows is what the ceiling is protecting.
  const moduleRowHrefs = Object.values(layout.moduleRows ?? {}).reduce(
    (total, rows) => total + rows.upperRow.length + rows.lowerRow.length,
    0,
  );
  return (
    layout.strip.length +
    (layout.upperRow?.length ?? 0) +
    (layout.lowerRow?.length ?? 0) +
    moduleRowHrefs +
    layout.hidden.length +
    layout.sections.reduce((total, section) => total + section.items.length, 0)
  );
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.source === "guest") {
      return NextResponse.json({ error: "unauthorized", message: "Sign in first.", success: false }, { status: 401 });
    }
    const layout = await loadPersonalLayout(access.hrId);
    return NextResponse.json({ data: layout, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load your navigation layout.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function PUT(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    if (access.source === "guest") {
      return NextResponse.json({ error: "unauthorized", message: "Sign in first.", success: false }, { status: 401 });
    }

    const body: unknown = await request.json().catch(() => null);
    const layout = (body as { layout?: unknown } | null)?.layout;

    if (!isPersonalNavigationLayout(layout)) {
      return NextResponse.json(
        { error: "invalid_layout", message: "That navigation layout is not in a shape this version understands.", success: false },
        { status: 400 },
      );
    }
    if (countHrefs(layout) > MAX_HREFS) {
      return NextResponse.json(
        { error: "layout_too_large", message: `A layout may reference at most ${MAX_HREFS} pages.`, success: false },
        { status: 400 },
      );
    }

    await savePersonalLayout(access.hrId, layout);
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to save your navigation layout.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function DELETE(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    if (access.source === "guest") {
      return NextResponse.json({ error: "unauthorized", message: "Sign in first.", success: false }, { status: 401 });
    }
    await clearPersonalLayout(access.hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to reset your navigation layout.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
