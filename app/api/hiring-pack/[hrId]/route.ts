import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertMayUseHrForms, packForViewer } from "@/lib/hiring-pack/paper-access";
import {
  getHiringPack,
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  saveHiringPackProfile,
} from "@/lib/hiring-pack/service";
import type { HiringPackProfileInput } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The hiring pack is an employee document, so it is gated by the SAME permission as the hiring
// documents tracker it feeds — `employee_documents`. That is deliberate: the two are one workflow
// seen from two ends, and giving the pack its own resource would let the two drift apart, so that
// somebody could print a contract for an employee whose document checklist they cannot open.

function apiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: hiringPackErrorMessage(error), status: 403 };
  }
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  if (isHiringPackSchemaMissing(error)) {
    return {
      message:
        "HR forms schema is not ready. Run the Supabase migrations for employee_hiring_profile and employee_offboarding_profile.",
      status: 409,
    };
  }
  return { message: hiringPackErrorMessage(error), status: 500 };
}

export async function GET(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    // employee_documents as before, or a seat in SEAT_PRINTABLE_DOCUMENTS on its own papers' grants.
    await assertMayUseHrForms(access, "read");
    const { hrId } = await params;

    return NextResponse.json(packForViewer(access, await getHiringPack(hrId)));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_load_failed", message }, { status });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // STILL employee_documents. The hiring profile is the contract's own terms (duration, dates, the
    // underperformance and training-bond clauses) and Form 1's registration codes. The HR Operations
    // Specialist comes in here too since the owner opened the whole module to her on 2026-11-02; this
    // saves what the papers print, in employee_hiring_profile, and does not touch the contracts table.
    await assertPermission(access, "employee_documents", "update");
    const { hrId } = await params;
    const payload = (await request.json()) as HiringPackProfileInput;

    // The saved pack is returned rather than an acknowledgement, so the screen redraws from what
    // the database actually holds — including the recalculated gap list — instead of from what the
    // form believed it sent.
    return NextResponse.json(await saveHiringPackProfile(hrId, payload, access.hrId ?? null));
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_save_failed", message }, { status });
  }
}
