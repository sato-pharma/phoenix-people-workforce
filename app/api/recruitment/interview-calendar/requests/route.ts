import { NextResponse } from "next/server";

import { assertSameOriginMutation, readJsonObject, recruitmentApiError } from "@/app/api/recruitment/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { CV_UPLOAD_LIMIT_BYTES, interviewCalendarCaller } from "@/lib/recruitment/interview-calendar";
import {
  createInterviewRequest,
  type InterviewRequestItemInput,
  listInterviewRequestsInbox,
  listMyInterviewRequests,
} from "@/lib/recruitment/interview-requests";
import { assertCandidatesVisible, fenceInterviewRequests } from "@/lib/recruitment/workspace/fence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  ?mine=1                 the requests I asked for (a District Manager / above / HR)
//      (default)               the HR inbox — requests waiting for a time (book rights only)
//      ?includeCancelled=1     also the withdrawn ones
// POST                         make a request — JSON when every CV is picked from Recruitment, or
//                              multipart with a `payload` JSON field and one file per uploaded CV, each
//                              named by its item's `cvField`.
//
// Every branch passes the calendar's own gate inside src/lib/recruitment/interview-requests.ts.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const params = new URL(request.url).searchParams;
    const headers = { "Cache-Control": "no-store" };
    // The Talent Acquisition fence (owner, 2026-10-20): an HR applicant's CV leaves every request, and a
    // request that was only about HR applicants leaves the list. Someone from outside always stays.
    if (params.get("mine")) {
      const mine = await listMyInterviewRequests(caller);
      return NextResponse.json({ requests: await fenceInterviewRequests(access, mine), success: true }, { headers });
    }
    const includeCancelled = Boolean(params.get("includeCancelled"));
    const inbox = await listInterviewRequestsInbox(caller, { includeCancelled });
    return NextResponse.json({ requests: await fenceInterviewRequests(access, inbox), success: true }, { headers });
  } catch (error) {
    return recruitmentApiError(error, "Could not load the interview requests.");
  }
}

type ItemPayload = {
  candidateId?: unknown;
  external?: { name?: unknown; phone?: unknown; email?: unknown } | null;
  cvField?: unknown;
};

/** A request item as read off the wire, its uploaded CV (if any) still a File to be read. */
type PendingItem = { candidateId: string | null; external: { name: string; phone: string | null; email: string | null } | null; cvFile: File | null };

function pendingItemsFrom(raw: ItemPayload[], fileFor: (field: string) => File | null): PendingItem[] {
  return raw.map((item) => {
    const candidateId = typeof item.candidateId === "string" && item.candidateId.trim() ? item.candidateId.trim() : null;
    if (candidateId) return { candidateId, cvFile: null, external: null };
    const external = item.external
      ? {
          email: typeof item.external.email === "string" ? item.external.email : null,
          name: typeof item.external.name === "string" ? item.external.name : "",
          phone: typeof item.external.phone === "string" ? item.external.phone : null,
        }
      : null;
    const field = typeof item.cvField === "string" && item.cvField.trim() ? item.cvField.trim() : null;
    return { candidateId: null, cvFile: field ? fileFor(field) : null, external };
  });
}

/**
 * Read the body: JSON (every CV from Recruitment), or multipart where `payload` describes the items and
 * each uploaded CV is a file whose field name the item names in `cvField`.
 */
async function readRequest(request: Request): Promise<{ body: Record<string, unknown>; items: PendingItem[] }> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("multipart/form-data")) {
    const body = await readJsonObject(request);
    const raw = Array.isArray(body.items) ? (body.items as ItemPayload[]) : [];
    return { body, items: pendingItemsFrom(raw, () => null) };
  }
  const form = await request.formData();
  const payload = form.get("payload");
  let body: Record<string, unknown> = {};
  try {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    throw new Error("The request could not be read. Try again.");
  }
  const raw = Array.isArray(body.items) ? (body.items as ItemPayload[]) : [];
  const items = pendingItemsFrom(raw, (field) => {
    const file = form.get(field);
    if (!file || typeof file === "string") return null;
    if (file.size > CV_UPLOAD_LIMIT_BYTES) throw new Error("A CV is larger than 10 MB.");
    return file;
  });
  return { body, items };
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const caller = await interviewCalendarCaller(access, request);
    const { body, items } = await readRequest(request);
    // A request may not name a person this viewer may not see: the whole request answers as unknown.
    await assertCandidatesVisible(
      access,
      items.map((item) => item.candidateId).filter((id): id is string => Boolean(id)),
    );

    const serviceItems: InterviewRequestItemInput[] = [];
    for (const item of items) {
      if (item.candidateId) {
        serviceItems.push({ candidateId: item.candidateId });
        continue;
      }
      const cv = item.cvFile
        ? {
            bytes: Buffer.from(await item.cvFile.arrayBuffer()),
            fileName: item.cvFile.name || "cv",
            mimeType: item.cvFile.type || "",
            sizeBytes: item.cvFile.size,
          }
        : null;
      serviceItems.push({ cv, external: item.external });
    }

    const result = await createInterviewRequest(caller, {
      interviewerHrId: body.interviewerHrId,
      items: serviceItems,
      line: body.line,
      note: body.note,
      requestedDay: body.requestedDay,
    });
    return NextResponse.json({ request: result, success: true }, { status: 201 });
  } catch (error) {
    return recruitmentApiError(error, "Could not send the interview request.");
  }
}
