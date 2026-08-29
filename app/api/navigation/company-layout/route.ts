import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  countLayoutHrefs,
  isPersonalNavigationLayout,
  MAX_LAYOUT_HREFS,
} from "@/lib/navigation/personal-layout";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  clearCompanyDefaultLayout,
  loadCompanyDefaultLayout,
  saveCompanyDefaultLayout,
} from "@/lib/navigation/personal-layout-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The COMPANY DEFAULT navigation layout — the arrangement everyone who has saved nothing sees.
 *
 * ── Why this is a separate route from personal-layout ────────────────────────────────────────
 * Not tidiness. The personal route derives its key from the session and is structurally incapable
 * of naming a different target; adding a "scope" flag to it would turn the one route every signed-in
 * account can call into a route that can write everybody's navigation, gated only by a branch. Two
 * routes means the wide write has its own URL, its own gate, and its own audit story, and the narrow
 * one keeps the property that made it safe.
 *
 * ── What this can and cannot do ─────────────────────────────────────────────────────────────
 * It CANNOT widen anyone's access. A layout only reorders links the viewer was already permitted to
 * see — applyPersonalLayout resolves against that viewer's own gated sections and drops every href
 * that is not in them, so an href published here that a Medical Rep may not open simply does not
 * render for them.
 *
 * It CANNOT overwrite anyone's saved arrangement. loadEffectiveLayout prefers a personal layout
 * whenever one exists; the default only fills the gap for accounts that have arranged nothing. So
 * publishing a bad default costs "the standard menu looks wrong until it is cleared" — never work.
 *
 * ── The gate ────────────────────────────────────────────────────────────────────────────────
 * Super Admin only, checked server-side here, because this is the one navigation write whose blast
 * radius is the whole company. The button is also hidden for everyone else, but that is UX: this
 * check is the security boundary, per the repo's standing rule that a hidden link is not a gate.
 */

function deny(status: number, error: string, message: string) {
  return NextResponse.json({ error, message, success: false }, { status });
}

/** Resolve the caller and refuse anyone who is not a Super Admin. Returns null when allowed. */
async function assertSuperAdmin(request: Request) {
  const access = await resolveAccessContext(request);
  // An unauthenticated caller resolves to role "Employee", not null — so `!access.role` is dead code
  // everywhere it appears in this repo. `source === "guest"` is the real test, and it must come
  // first so a signed-out caller gets 401 rather than a misleading 403.
  if (access.source === "guest") return deny(401, "unauthorized", "Sign in first.");
  if (access.role !== "Super Admin") {
    return deny(403, "forbidden", "Only a Super Admin can change the company default navigation.");
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const denied = await assertSuperAdmin(request);
    if (denied) return denied;
    const layout = await loadCompanyDefaultLayout();
    return NextResponse.json({ data: layout, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load the company default navigation.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function PUT(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const denied = await assertSuperAdmin(request);
    if (denied) return denied;

    const body: unknown = await request.json().catch(() => null);
    const layout = (body as { layout?: unknown } | null)?.layout;

    if (!isPersonalNavigationLayout(layout)) {
      return deny(400, "invalid_layout", "That navigation layout is not in a shape this version understands.");
    }
    if (countLayoutHrefs(layout) > MAX_LAYOUT_HREFS) {
      return deny(400, "layout_too_large", `A layout may reference at most ${MAX_LAYOUT_HREFS} pages.`);
    }

    await saveCompanyDefaultLayout(layout);
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to publish the company default navigation.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function DELETE(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const denied = await assertSuperAdmin(request);
    if (denied) return denied;
    await clearCompanyDefaultLayout();
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to withdraw the company default navigation.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
