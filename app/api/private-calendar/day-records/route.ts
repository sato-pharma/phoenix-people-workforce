import { NextResponse } from "next/server";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { answerDayRecordQuestion, findDayRecordQuestions } from "@/lib/private-calendar/day-record-questions";
import {
  assertDayRecordActor,
  listDayRecords,
  loadDayRecordPicker,
  recordDayForPeople,
  voidDayRecord,
} from "@/lib/private-calendar/day-records-admin";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRIVATE CALENDAR DAY RECORDS (owner, 2026-11-28) — Super Admin only, end to end: the domain helper's
// assertDayRecordActor is the gate, asked before the body is read.
//   GET  ?year=&month=  → the people picker, the month's standing records, and the open questions.
//   POST { action: "record" | "answer" | "void", … }

function monthOf(url: URL) {
  const now = new Date();
  const year = Number(url.searchParams.get("year") ?? now.getUTCFullYear());
  const month = Number(url.searchParams.get("month") ?? now.getUTCMonth() + 1);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw validationError("Pick a month.");
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { end: `${key}-${String(last).padStart(2, "0")}`, month, start: `${key}-01`, year };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    assertDayRecordActor(access);
    const window = monthOf(new URL(request.url));
    const [groups, records, questions] = await Promise.all([
      loadDayRecordPicker(access),
      listDayRecords(access, window),
      findDayRecordQuestions(access, window),
    ]);
    return NextResponse.json({ data: { groups, questions, records }, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load the day records.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    assertDayRecordActor(access);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "record") return NextResponse.json({ data: await recordDayForPeople(access, body), success: true });
    if (body.action === "answer") return NextResponse.json({ data: await answerDayRecordQuestion(access, body), success: true });
    if (body.action === "void") {
      await voidDayRecord(access, String(body.id ?? ""));
      return NextResponse.json({ data: { voided: true }, success: true });
    }
    throw validationError("action must be 'record', 'answer' or 'void'.");
  } catch (error) {
    const apiError = toApiError(error, "Unable to save the day record.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
