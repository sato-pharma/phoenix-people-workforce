import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ARRANGED_PACKAGES, cleanPackageSteps, type ArrangedPackage } from "@/lib/hiring-pack/forms-layout";
import {
  FormsLayoutTableMissingError,
  loadFormsLayout,
  saveFormsLayoutPackage,
  type StoredFormsLayout,
} from "@/lib/hiring-pack/forms-layout-store";
import type { LeaverStep } from "@/lib/hiring-pack/hr-forms-wizard";
import { assertMayUseHrForms } from "@/lib/hiring-pack/paper-access";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE HR FORMS CONTROL TAB (owner, 2026-11-27): which papers the new-hire and leaver packages walk
// through, and in what order. "Another paper" is everything in neither.
//
// READ is whoever may use HR Forms — the wizard itself walks this order. WRITE is the Super Admin
// only, the same seat as "Edit any form" and the company templates: the arrangement changes what
// every HR desk is walked through for every person, not one person's file.

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (error instanceof FormsLayoutTableMissingError) return { message: error.message, status: 409 };
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertMayUseHrForms(access, "read");
    return NextResponse.json(await loadFormsLayout());
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_forms_layout_read_failed", message }, { status });
  }
}

/**
 * Store the arrangement. Body: `{ layout: { newHire?: string[] | null, leaver?: string[] | null } }`.
 * A package left out is not touched; `null` puts it back to the standard order. Every list is cleaned
 * by `cleanPackageSteps` before it is stored — an unknown paper, a repeat or the exit form on the
 * new-hire list never reaches the table.
 */
export async function PUT(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "Only a Super Admin can arrange HR Forms — the order is what every HR desk walks through.",
        },
        { status: 403 },
      );
    }

    const payload = (await request.json().catch(() => null)) as { layout?: unknown } | null;
    const layout = payload?.layout;
    if (!layout || typeof layout !== "object") {
      return NextResponse.json(
        { error: "invalid_request", message: "Send the arrangement as { layout: { newHire, leaver } }." },
        { status: 400 },
      );
    }

    const changes: Array<{ pack: ArrangedPackage; steps: LeaverStep[] | null }> = [];
    for (const pack of ARRANGED_PACKAGES) {
      if (!(pack in layout)) continue;
      const raw = (layout as Record<string, unknown>)[pack];
      if (raw === null) {
        changes.push({ pack, steps: null });
        continue;
      }
      const steps = cleanPackageSteps(raw, pack);
      if (!steps) {
        return NextResponse.json(
          { error: "invalid_request", message: `The ${pack} list must be a list of papers, or null.` },
          { status: 400 },
        );
      }
      changes.push({ pack, steps });
    }

    let stored: StoredFormsLayout | null = null;
    for (const change of changes) {
      stored = await saveFormsLayoutPackage(change.pack, change.steps, access.hrId ?? null);
    }
    return NextResponse.json(stored ?? (await loadFormsLayout()));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_forms_layout_save_failed", message }, { status });
  }
}
