import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { validationError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { enterManagerMissedActivity, enterManagerMissedVisit, loadManagerMissedRecordForm } from "@/lib/phoenix-crm/server/manager-missed-records";
import { enterMissedActivity, enterMissedVisit, loadMissedRecordForm, removeMissedVisit } from "@/lib/phoenix-crm/server/missed-records";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A record a rep MISSED, entered for him by the Super Admin (owner, 2026-10-01: "the rep is responsible
// for all his records, but if he missed a visit or a record, admin can enter it for him").
//
// GET  = what can be entered for one territory on one day: its customers, the line's products and the
//        day's activity.
// POST = enter a missed visit (`record: "visit"`) or a missed day activity (`record: "activity"`), or
//        remove a visit he entered by mistake (`record: "remove-visit"`).
//
// A MANAGER's missed record (owner, 2026-10-24: "Visits and days") rides the same door: GET with `manager`
// (the calendar row's key) instead of `seatId`, and POST `record: "manager-visit"` / `"manager-activity"`.
//
// `update`, the Super Admin's own permission here (the same gate as Settings), and narrowed AGAIN in the
// service to the Super Admin alone — `territoryForMissedRecord` — so holding `update` is not enough.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    if (search.get("manager")) {
      const form = await loadManagerMissedRecordForm(viewer, { date: search.get("date"), list: search.get("list"), manager: search.get("manager") });
      return NextResponse.json({ form, success: true });
    }
    const form = await loadMissedRecordForm(viewer, {
      date: search.get("date"),
      seatId: search.get("seatId"),
      test: search.get("test"),
    });
    return NextResponse.json({ form, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load what can be entered for this day.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.record === "visit") {
      const saved = await enterMissedVisit(viewer, body);
      return NextResponse.json({ saved, success: true });
    }
    if (body.record === "activity") {
      const saved = await enterMissedActivity(viewer, body);
      return NextResponse.json({ saved, success: true });
    }
    if (body.record === "manager-visit") {
      const saved = await enterManagerMissedVisit(viewer, body);
      return NextResponse.json({ saved, success: true });
    }
    if (body.record === "manager-activity") {
      const saved = await enterManagerMissedActivity(viewer, body);
      return NextResponse.json({ saved, success: true });
    }
    // Taking back a visit he entered by mistake — his own entry only, decided by the database.
    if (body.record === "remove-visit") {
      const removed = await removeMissedVisit(viewer, body);
      return NextResponse.json({ removed, success: true });
    }
    throw validationError("Choose whether this is a visit or the day's activity.");
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save this record.");
  }
}
