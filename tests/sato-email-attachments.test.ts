/**
 * Attaching a file, and putting a picture in the body.
 *
 * Owner 2026-09-12: "make an option to attach pic or file and to put pic in message body".
 *
 * The two halves have completely different exposure, and every assertion here is about keeping them
 * apart. An attachment travels inside the message and nobody outside the recipient list can reach
 * it; a body picture is fetched over plain HTTP by whoever holds its address, because that is the
 * only way an `<img>` in an email works at all.
 *
 * Four ways that can quietly go wrong, and what each would cost:
 *
 *   1. an over-budget attachment is DROPPED instead of refused — "the policy is attached" reaches
 *      the whole company with nothing attached, and nothing on screen ever said so;
 *   2. the token route serves something that is not a picture — an attached contract, or worse an
 *      SVG, handed out unauthenticated from the company's own origin;
 *   3. a filename talks its way to a different extension or out of its folder;
 *   4. the ceiling drifts above the smaller provider's, so the mail works until the day it fails
 *      over to Brevo and every message with a file on it is rejected.
 */

import assert from "node:assert/strict";

import {
  EDITOR_IMAGE_ACCEPT,
  attachablesFromTransfer,
  looksLikePicture,
  picturesFromTransfer,
} from "@/lib/email/transfer-files";
import { brevoProvider, resendProvider, type PreparedEmail } from "@/lib/email/email-providers";
import { parseSatoEmailDraft } from "@/lib/sato-email/draft";
import { loadSatoEmailAttachments, resolveSatoEmailAttachments } from "@/lib/sato-email/media";
import {
  SATO_EMAIL_INLINE_ACCEPT,
  SATO_EMAIL_MEDIA_MAX_FILE_BYTES,
  SATO_EMAIL_MEDIA_MAX_TOTAL_BYTES,
  isSatoEmailInlineContentType,
  safeAttachmentFileName,
  validateSatoEmailUpload,
} from "@/lib/sato-email/media-limits";

/**
 * The smallest stub that answers the two query shapes this module builds.
 *
 * `.select().in().eq()` is awaited directly, so the builder is a thenable that returns itself from
 * every filter. Each filter is recorded, because half of what is being asserted is not what came
 * back but WHICH filters were applied on the way.
 */
function stubSupabase(rows: Record<string, unknown>[], filters: string[][]) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.in = (column: string, values: unknown) => {
    filters.push(["in", column, JSON.stringify(values)]);
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    filters.push(["eq", column, String(value)]);
    return builder;
  };
  builder.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
  return {
    from(table: string) {
      filters.push(["from", table]);
      return builder;
    },
  } as never;
}

function attachmentRow(id: string, byteSize: number, filename: string) {
  return { byte_size: byteSize, id, original_file_name: filename };
}

export async function runSatoEmailAttachmentTests() {
  // ── 1. The ceiling never drifts above the SMALLER provider's ───────────────────────────────
  //
  // Resend takes 40MB and Brevo rejects anything over 10MB. Mail moves to Brevo on a quota or auth
  // error — the bad day — so a ceiling raised to Resend's would work in every test and fail the one
  // time it mattered, on every message carrying a file.
  const BREVO_MESSAGE_LIMIT_BYTES = 10 * 1024 * 1024;
  assert.ok(
    SATO_EMAIL_MEDIA_MAX_TOTAL_BYTES <= BREVO_MESSAGE_LIMIT_BYTES,
    "the total attachment budget rose above Brevo's 10MB message limit — mail would fail the moment it failed over",
  );
  assert.ok(SATO_EMAIL_MEDIA_MAX_FILE_BYTES <= BREVO_MESSAGE_LIMIT_BYTES);

  // ── 2. The refusal is a refusal, not a drop ────────────────────────────────────────────────
  //
  // 🔴 THE HEADLINE. `guardAttachments` in send-phoenix-email.ts omits an over-budget file and
  // sends anyway. On a system notification that is a reasonable default. On the one screen that
  // mails an entire distribution list under the company's name it is the worst possible behaviour,
  // because the sender is never told and the email cannot be recalled.
  const filters: string[][] = [];
  const overBudget = await resolveSatoEmailAttachments(
    ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    stubSupabase(
      [
        attachmentRow("11111111-1111-4111-8111-111111111111", 6 * 1024 * 1024, "policy.pdf"),
        attachmentRow("22222222-2222-4222-8222-222222222222", 6 * 1024 * 1024, "annex.pdf"),
      ],
      filters,
    ),
  );
  assert.ok(
    overBudget.problem,
    "12MB of attachments came back with no problem — the send would have gone out with a file silently dropped",
  );
  assert.match(overBudget.problem ?? "", /12 MB/, "the refusal must name the actual total, not just say 'too big'");
  assert.equal(
    overBudget.files.length,
    2,
    "both files must still be listed with the refusal — the sender has to see WHICH files, not just that something is wrong",
  );

  // And the send stops there rather than mailing a partial email.
  const loaded = await loadSatoEmailAttachments(
    ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    stubSupabase(
      [
        attachmentRow("11111111-1111-4111-8111-111111111111", 6 * 1024 * 1024, "policy.pdf"),
        attachmentRow("22222222-2222-4222-8222-222222222222", 6 * 1024 * 1024, "annex.pdf"),
      ],
      [],
    ),
  );
  assert.ok("problem" in loaded, "the send path must refuse the over-budget draft, not send it with one file missing");

  // A file that has gone is a refusal too, never a quiet skip.
  const missing = await resolveSatoEmailAttachments(
    ["33333333-3333-4333-8333-333333333333"],
    stubSupabase([], []),
  );
  assert.match(
    missing.problem ?? "",
    /no longer available/i,
    "a chip on screen for a row that no longer exists must refuse the send, not drop the file",
  );

  // Under budget, nothing is in the way.
  const fine = await resolveSatoEmailAttachments(
    ["11111111-1111-4111-8111-111111111111"],
    stubSupabase([attachmentRow("11111111-1111-4111-8111-111111111111", 2 * 1024 * 1024, "poster.png")], []),
  );
  assert.equal(fine.problem, null, "a 2MB attachment must send");
  assert.equal(fine.files[0]?.filename, "poster.png");

  // ── 3. An ATTACHMENT is never reachable as a body picture, and vice versa ──────────────────
  //
  // The lookup states the kind. An attached contract has no public token at all, so it cannot be
  // named at the token route — but the kind is in the query as well, so a future bug that minted
  // one still could not open it to the world.
  assert.ok(
    filters.some((entry) => entry[0] === "eq" && entry[1] === "kind" && entry[2] === "attachment"),
    "resolving what to clip on an email must filter on kind=attachment, or a body picture could be pulled in as a file",
  );

  // ── 4. What may be uploaded at all ─────────────────────────────────────────────────────────
  //
  // 🔴 SVG AND HTML ARE THE WHOLE POINT OF THIS ALLOWLIST. Both carry script, and the token route
  // serves from this application's own origin — an SVG accepted here is stored XSS handed out by
  // the one screen whose job is mailing links to the entire company.
  for (const forbidden of ["image/svg+xml", "text/html", "application/x-msdownload", "application/zip"]) {
    for (const kind of ["inline", "attachment"] as const) {
      const verdict = validateSatoEmailUpload({ byteSize: 1024, contentType: forbidden, kind });
      assert.ok("message" in verdict, `${forbidden} was accepted as an ${kind} upload`);
    }
  }

  // A picture is a picture in both places; a document is an attachment only. A PDF in the BODY is
  // not a thing an email can render, and admitting it would mean serving documents from this origin.
  assert.ok("extension" in validateSatoEmailUpload({ byteSize: 1024, contentType: "image/png", kind: "inline" }));
  assert.ok("extension" in validateSatoEmailUpload({ byteSize: 1024, contentType: "application/pdf", kind: "attachment" }));
  assert.ok("message" in validateSatoEmailUpload({ byteSize: 1024, contentType: "application/pdf", kind: "inline" }));
  assert.ok(
    "message" in validateSatoEmailUpload({ byteSize: SATO_EMAIL_MEDIA_MAX_FILE_BYTES + 1, contentType: "image/png", kind: "inline" }),
    "a file over the per-file ceiling must be refused before it is stored",
  );
  assert.ok("message" in validateSatoEmailUpload({ byteSize: 0, contentType: "image/png", kind: "inline" }));

  // What the public route is allowed to echo back as a content type.
  assert.equal(isSatoEmailInlineContentType("image/png"), true);
  assert.equal(isSatoEmailInlineContentType("image/svg+xml"), false, "an SVG must never be served as an SVG from this origin");
  assert.equal(isSatoEmailInlineContentType("application/pdf"), false);
  assert.equal(isSatoEmailInlineContentType("text/html"), false);

  // ── 5. A filename cannot smuggle a path or a different extension ───────────────────────────
  const traversal = safeAttachmentFileName("../../etc/passwd.pdf", "pdf");
  assert.ok(!traversal.includes("/") && !traversal.includes("\\"), `a path separator survived: ${traversal}`);
  const doubled = safeAttachmentFileName("salary.pdf.exe", "pdf");
  assert.ok(doubled.endsWith(".pdf"), `the extension was not forced to the one the MIME type maps to: ${doubled}`);
  assert.ok(!doubled.endsWith(".exe"), `an executable extension survived: ${doubled}`);
  assert.equal(safeAttachmentFileName("", "png"), "attachment.png", "a nameless file still needs a name");

  // ── 6. Preview and send read the same attachment list ──────────────────────────────────────
  //
  // Same reason preview and send already share `parseSatoEmailDraft`: the count and the files on
  // screen have to describe the email that actually goes out.
  const base = {
    bodyHtml: "<p>Hello</p>",
    clientRequestId: "sato-1",
    listKeys: ["all_staff"],
    subject: "Notice",
  };
  const good = parseSatoEmailDraft({ ...base, attachmentIds: ["11111111-1111-4111-8111-111111111111"] });
  assert.ok("draft" in good, "a valid draft with an attachment must parse");
  assert.deepEqual(good.draft.attachmentIds, ["11111111-1111-4111-8111-111111111111"]);

  const noAttachments = parseSatoEmailDraft(base);
  assert.ok("draft" in noAttachments && noAttachments.draft.attachmentIds.length === 0, "attachments stay optional");

  const forged = parseSatoEmailDraft({ ...base, attachmentIds: ["../../secret"] });
  assert.ok("message" in forged, "an attachment id that is not a uuid must be refused at the parser");

  // ── 7. A pasted or dragged picture reaches the upload at all ───────────────────────────────
  //
  // Owner 2026-09-23: "i want to be able to insert attachment and upload photo either in message
  // body or as attachment". Both buttons already existed; what did nothing was the gesture — the
  // editor's paste handler read `text/plain` only, so Ctrl+V on a screenshot was swallowed in
  // silence. These assertions pin the one rule that makes the gesture honest.
  //
  // 🔴 THE FILTER IS WIDER THAN THE STORE'S ALLOWLIST, ON PURPOSE. A phone photo is HEIC, which
  // `validateSatoEmailUpload` refuses and should. Refusing it in the browser instead would put the
  // gesture back where it started: nothing happens, and nothing says why.
  assert.equal(looksLikePicture({ name: "screenshot.png", type: "image/png" }), true);
  assert.equal(
    looksLikePicture({ name: "IMG_4821.HEIC", type: "image/heic" }),
    true,
    "a phone photo must reach the upload, so the server's refusal is what the sender reads",
  );
  assert.ok(
    "message" in validateSatoEmailUpload({ byteSize: 2048, contentType: "image/heic", kind: "inline" }),
    "and the store must still be the one that refuses it",
  );
  assert.equal(
    looksLikePicture({ name: "photo.jpg", type: "" }),
    true,
    "a drag from some file managers carries no MIME type — the extension has to answer",
  );
  assert.equal(looksLikePicture({ name: "policy.pdf", type: "application/pdf" }), false);
  assert.equal(
    looksLikePicture({ name: "diagram.svg", type: "image/svg+xml" }),
    true,
    "an SVG may be handed to the upload — the store refuses it, and that refusal is the message",
  );
  assert.ok(
    "message" in validateSatoEmailUpload({ byteSize: 2048, contentType: "image/svg+xml", kind: "inline" }),
    "🔴 an SVG must never be storable as a body picture — it would be served as script from this origin",
  );

  const dropped = [
    { name: "photo.png", type: "image/png" },
    { name: "policy.pdf", type: "application/pdf" },
    // A folder dragged in: no type, no extension. It is not a file and must not be uploaded.
    { name: "Board pack", type: "" },
  ];
  assert.deepEqual(
    picturesFromTransfer(dropped).map((file) => file.name),
    ["photo.png"],
    "only the pictures go into the message body",
  );
  assert.deepEqual(
    attachablesFromTransfer(dropped).map((file) => file.name),
    ["photo.png", "policy.pdf"],
    "a dropped folder must not be uploaded as an attachment",
  );
  assert.equal(
    EDITOR_IMAGE_ACCEPT.split(",").every((type) => SATO_EMAIL_INLINE_ACCEPT.includes(type)),
    true,
    "the editor's fallback picker must not offer a type the body-picture store would refuse",
  );

  // ── 8. An attached PDF reaches the provider's request, byte for byte ───────────────────────
  //
  // Owner 2026-10-24: "make sure if i attached a pdf it will be send attched in the email". Every
  // check above stops at the loader; this one follows the file to the HTTP body each provider is
  // actually sent, because a field name the provider does not know (`attachment` vs `attachments`,
  // `type` vs `content_type`) is not an error at either end — the mail goes out, 200, with nothing
  // on it. Both providers are checked: Brevo is the one that sends on the bad day.
  await assertPdfReachesProviderRequests();
}

async function assertPdfReachesProviderRequests() {
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
  const pdfId = "44444444-4444-4444-8444-444444444444";
  const row = {
    byte_size: pdfBytes.length,
    content_type: "application/pdf",
    id: pdfId,
    original_file_name: "HR Policy 2026.pdf",
    storage_bucket: "sato-email-media",
    storage_path: "attachment/2026-10/abc.pdf",
  };
  const downloads: string[] = [];
  const supabase = stubSupabase([row], []) as unknown as Record<string, unknown>;
  supabase.storage = {
    from: (bucket: string) => ({
      download: async (path: string) => {
        downloads.push(`${bucket}/${path}`);
        return { data: new Blob([pdfBytes], { type: "application/pdf" }), error: null };
      },
    }),
  };

  const loaded = await loadSatoEmailAttachments([pdfId], supabase as never);
  assert.ok(!("problem" in loaded), "a stored PDF must load for the send");
  assert.deepEqual(downloads, ["sato-email-media/attachment/2026-10/abc.pdf"], "the bytes must be read from the file's own storage path");

  const email: PreparedEmail = {
    attachments: loaded.attachments,
    from: "Sato Pharma HR <hr@people.satopharma.com>",
    html: "<p>The policy is attached.</p>",
    idempotencyKey: "sato-pdf-1",
    replyTo: "hr@people.satopharma.com",
    subject: "HR Policy",
    text: "The policy is attached.",
    to: ["someone@example.com"],
  };

  const realFetch = globalThis.fetch;
  const saved = {
    brevo: process.env.BREVO_API_KEY,
    brevoFrom: process.env.BREVO_EMAIL_FROM,
    resend: process.env.RESEND_API_KEY,
  };
  const bodies: Record<string, Record<string, unknown>> = {};
  try {
    process.env.RESEND_API_KEY = "re_test";
    process.env.BREVO_API_KEY = "brevo_test";
    delete process.env.BREVO_EMAIL_FROM;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const provider = String(input).includes("resend") ? "resend" : "brevo";
      bodies[provider] = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(provider === "resend" ? { id: "R1" } : { messageId: "<B1>" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }) as typeof fetch;
    await resendProvider.send(email);
    await brevoProvider.send(email);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.brevo === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = saved.brevo;
    if (saved.brevoFrom === undefined) delete process.env.BREVO_EMAIL_FROM;
    else process.env.BREVO_EMAIL_FROM = saved.brevoFrom;
    if (saved.resend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.resend;
  }

  const resendFiles = bodies.resend?.attachments as Array<Record<string, string>> | undefined;
  assert.equal(resendFiles?.length, 1, "the PDF must be on Resend's request as attachments[] — the mail would go out with nothing attached");
  assert.equal(resendFiles?.[0].filename, "HR Policy 2026.pdf", "the recipient must see the PDF under its own name");
  assert.equal(resendFiles?.[0].content_type, "application/pdf", "Resend must be told it is a PDF");
  assert.equal("content_id" in (resendFiles?.[0] ?? {}), false, "an attached PDF must not be marked as an inline picture");
  assert.ok(
    Buffer.from(resendFiles?.[0].content ?? "", "base64").equals(pdfBytes),
    "the PDF on Resend's request must be the uploaded file byte for byte",
  );

  const brevoFiles = bodies.brevo?.attachment as Array<Record<string, string>> | undefined;
  assert.equal(brevoFiles?.length, 1, "the PDF must be on Brevo's request as attachment[] — the backup would send it without the file");
  assert.equal(brevoFiles?.[0].name, "HR Policy 2026.pdf");
  assert.ok(
    Buffer.from(brevoFiles?.[0].content ?? "", "base64").equals(pdfBytes),
    "the PDF on Brevo's request must be the uploaded file byte for byte",
  );
}
