import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { resolveAccessContext } from "@/lib/auth/server";
import { addDeductionsComment, addDeductionsReply } from "@/lib/deductions/comments.ts";
import { addDailyDisputeMessage } from "@/lib/dispute-center/daily.ts";
import { addDigestDisputeMessage } from "@/lib/dispute-center/digest.ts";
import { checkDisputeMessageImages, disputeCenterError } from "@/lib/dispute-center/http.ts";
import { resolveCaseParticipant } from "@/lib/dispute-center/participants.ts";
import { isDisputeCaseKind } from "@/lib/dispute-center/types.ts";
import { validationError } from "@/lib/http/api-errors";
import { parseFormBody, parseJsonBody } from "@/lib/http/request-body";
import { addPrivateCalendarDisputeMessage } from "@/lib/private-calendar/dispute-messages";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The reply as the two thread screens send it (REC-060): JSON `{ body }` for text, or a form with `body` and up to
 * four `images` when it carries pictures. The text has always been read as `String(body ?? "")`, so a number or a
 * yes/no still reads as before; an empty file input arrives as an empty File or a string and is dropped.
 */
const MessageJsonSchema = z.looseObject({ body: z.union([z.string(), z.number(), z.boolean()]).nullish() });
const ImageEntry = z.union([z.instanceof(File), z.string()]);
const MessageFormSchema = z.looseObject({
  body: z.string().optional(),
  images: z.union([ImageEntry, z.array(ImageEntry)]).optional(),
});

async function readMessage(request: Request) {
  if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    const parsed = await parseFormBody(request, MessageFormSchema);
    if (!parsed.ok) throw validationError(parsed.message);
    const entries = parsed.data.images === undefined ? [] : Array.isArray(parsed.data.images) ? parsed.data.images : [parsed.data.images];
    const files = entries.filter((entry): entry is File => typeof entry !== "string");
    return { body: String(parsed.data.body ?? ""), images: await checkDisputeMessageImages(files) };
  }
  const parsed = await parseJsonBody(request, MessageJsonSchema, { fallback: {} });
  if (!parsed.ok) throw validationError(parsed.message);
  return { body: String(parsed.data.body ?? ""), images: [] };
}

// A reply from either side, with up to four pictures (owner, 2026-10-09: "upload a picture in both").
// JSON for text, multipart when it carries pictures; every picture is checked by its own bytes before
// anything is written. Each module keeps its own thread table and its own notification rule — this
// route only decides which one the case belongs to.
export async function POST(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // REC-080: a signed-out caller is refused before the path's kind is judged.
    assertSignedIn(access);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const caseRef = decodeURIComponent(ref);
    const { body, images } = await readMessage(request);

    if (kind === "calendar") {
      const message = await addPrivateCalendarDisputeMessage(access, { body, disputeId: caseRef, images });
      return NextResponse.json({ message, success: true });
    }
    if (kind === "daily") {
      const message = await addDailyDisputeMessage(access, { body, disputeId: caseRef, images });
      return NextResponse.json({ message, success: true });
    }
    if (kind === "digest") {
      const message = await addDigestDisputeMessage(access, { body, images, lineId: Number(caseRef) });
      return NextResponse.json({ message, success: true });
    }

    // A deduction thread has two write paths with different gates and different notifications — the
    // employee's comment goes to HR, the reviewer's reply goes to the employee and their managers.
    // Which one this is follows from who is asking, not from anything the caller sends.
    const participant = await resolveCaseParticipant(access, "deduction", caseRef);
    const message =
      participant.isReviewer && !participant.isOwner
        ? (await addDeductionsReply({ access, body, candidateId: caseRef, images })).comment
        : await addDeductionsComment({ access, body, candidateId: caseRef, images });
    return NextResponse.json({ message, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to send this reply.");
  }
}
