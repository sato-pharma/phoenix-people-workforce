import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { checkDisputeImage, DISPUTE_ATTACHMENT_MAX_FILES, type CheckedDisputeImage } from "@/lib/deductions/comment-attachment-rules.ts";
import { addDeductionsReply } from "@/lib/deductions/comments.ts";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsDecisionActor, assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { listPublishedDeductionCommentThreads } from "@/lib/deductions/portal.ts";
import { parseFormBody, parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Disputes tab's text-only reply: `{ body, candidateId }`. */
const ReplyJsonBodySchema = z.object({
  body: z.string().nullish(),
  candidateId: z.string().nullish(),
});

/** One `images` entry as a form carries it — a file, or (from an odd client) a plain string, which is skipped. */
const ReplyFormEntry = z.union([z.string(), z.instanceof(File)]);

/**
 * The Disputes tab's reply WITH pictures: multipart `candidateId`, `body` and one `images` entry per
 * picture (a single picture arrives as one value, several as a list). Every picture is still checked by
 * its own bytes below, before anything is written.
 */
const ReplyFormBodySchema = z.object({
  body: z.string().optional(),
  candidateId: z.string().optional(),
  images: z.union([ReplyFormEntry, z.array(ReplyFormEntry)]).optional(),
});

// The admin Disputes inbox: every employee comment on a published deduction, company-wide and
// month-independent. A deduction comment mails HR a link that lands here, so this is the read
// behind that destination. Company-wide data, admin audience only — the same gate as every other
// /api/admin/deductions read, asserted on top of the RBAC action (see permissions.ts).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    assertDeductionsReadActor(access);

    const threads = await listPublishedDeductionCommentThreads();
    return NextResponse.json({ success: true, threads });
  } catch (error) {
    return jsonError(error, "Failed to load deduction comments.");
  }
}

// An HR reply on a dispute — the other side of the conversation the GET above lists. Super Admin
// only (assertDeductionsDecisionActor, inside addDeductionsReply — the owner's call, 2026-10-06);
// CSRF-protected because it writes. The reply is delivered to the employee's portal, opening a
// two-way thread.
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    // Turned away before a single picture is read: only a Super Admin replies (addDeductionsReply
    // asserts it again, but that is after the bytes were already parsed).
    assertDeductionsDecisionActor(access);

    // Two shapes: JSON (text only) or multipart/form-data when the reply carries pictures (owner,
    // 2026-10-08). Every picture is checked by its own bytes HERE, before anything is written, so a
    // bad file is refused cleanly and never leaves half a reply.
    let candidateId = "";
    let replyText = "";
    const images: CheckedDisputeImage[] = [];
    if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      // The pictures are read here, through the schema, only after the Super Admin check above.
      const parsed = await parseFormBody(request, ReplyFormBodySchema);
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
      }
      const form = parsed.data;
      candidateId = String(form.candidateId ?? "").trim();
      replyText = String(form.body ?? "");
      const entries: Array<string | File> =
        form.images === undefined ? [] : Array.isArray(form.images) ? form.images : [form.images];
      const files = entries.filter((entry): entry is File => typeof entry !== "string" && entry.size > 0);
      if (files.length > DISPUTE_ATTACHMENT_MAX_FILES) {
        throw new Error(`Validation: A reply can carry at most ${DISPUTE_ATTACHMENT_MAX_FILES} pictures.`);
      }
      for (const file of files) {
        images.push(checkDisputeImage({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }));
      }
    } else {
      const parsed = await parseJsonBody(request, ReplyJsonBodySchema);
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
      }
      const body = parsed.data;
      candidateId = String(body.candidateId ?? "").trim();
      replyText = String(body.body ?? "");
    }
    if (!candidateId) {
      return NextResponse.json({ success: false, error: "candidateId is required." }, { status: 400 });
    }

    // `delivery` says who the reply was addressed to and whether Telegram can reach them, so the
    // Disputes inbox shows the sender what the reply did (owner, 2026-10-08).
    const { comment, delivery } = await addDeductionsReply({ access, body: replyText, candidateId, images });
    return NextResponse.json({ success: true, comment, delivery });
  } catch (error) {
    return jsonError(error, "Failed to save the reply.");
  }
}
