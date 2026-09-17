import assert from "node:assert/strict";

import { SATO_LOGO_CID_SRC, SATO_LOGO_CONTENT_ID, satoLogoAttachment } from "../src/lib/offers/brand.ts";
import { brevoInlineFallback, brevoProvider, resendProvider, type PreparedEmail } from "../src/lib/email/email-providers.ts";
import { renderOfferBlock } from "../src/lib/offers/render.ts";
import { renderOfferEmail } from "../src/lib/offers/render-email.ts";
import { defaultOfferBlocks } from "../src/lib/offers/default-template.ts";

/**
 * The Sato mark on a sent offer letter.
 *
 * ── What went wrong, 2026-09-17 ──
 * The offer email's letterhead carried an absolute https link to the PNG the site serves. The
 * asset was fine — 200, a valid 401x158 PNG — but a REMOTE image is drawn only if the reader's
 * mail client agrees to fetch it, and Outlook, Yahoo/Turbify webmail and Gmail all withhold that
 * by default. The owner's BCC copy of a real offer showed the torn-page placeholder and the alt
 * text where the mark belongs, on a legally binding document.
 *
 * These assertions pin the shape of the repair, end to end: the body points at a `cid:` part, the
 * part is really attached with that Content-ID, Resend is told the field name that makes it inline
 * (`content_id`, NOT `contentId`), and Brevo — which has no such field — degrades back to the
 * public URL instead of shipping a stray file beside a broken letterhead.
 */

const FIELDS = {
  candidateEmail: "candidate@example.com",
  candidateName: "Candidate Name",
  contractTerm: "One year",
  costOfLiving: 0,
  dateOfIssue: "17 September 2026",
  reference: "SP-HR-MR-2026-999",
  reportsTo: "District Manager",
  salutationName: "Candidate",
  startDate: "1 October 2026",
  territory: "Cairo",
  title: "Medical Representative",
  totalMonthly: 10000,
  validUntil: "24 September 2026",
};

function preparedWithMark(): PreparedEmail {
  const mark = satoLogoAttachment("https://phoenix-hr.satopharma.com");
  assert.ok(mark, "the Sato mark must be readable off disk for this test to mean anything");
  return {
    attachments: [mark, { content: "cGRm", contentType: "application/pdf", filename: "offer.pdf" }],
    from: "Sato Pharma HR <hr@send.satopharma.com>",
    html: `<img src="${SATO_LOGO_CID_SRC}" alt="SATO PHARMACEUTICALS">`,
    idempotencyKey: "offer-letter:test",
    replyTo: "hr@satopharma.com",
    subject: "Offer of Employment",
    text: "Offer",
    to: ["candidate@example.com"],
  };
}

/** Run `fn` with `fetch` replaced, capturing the one request body the provider sends. */
async function captureRequest(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch;
  let captured: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "test-id", messageId: "test-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(captured, "the provider must have issued exactly one request");
  return captured as unknown as Record<string, unknown>;
}

/** Run `fn` with an env var forced, restoring whatever was there (real credentials included). */
async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const before = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

export async function runOfferLetterheadInlineMarkTests() {
  // 1) THE HEADLINE. The rendered email points the letterhead at the part inside the message,
  //    not at anything the reader's client has to go and fetch.
  {
    const { html } = renderOfferEmail(
      { blocks: defaultOfferBlocks() },
      FIELDS,
      { logoUrl: SATO_LOGO_CID_SRC },
    );
    assert.ok(
      html.includes(`<img src="cid:${SATO_LOGO_CONTENT_ID}"`),
      "the offer email letterhead must draw the mark from the message's own cid: part",
    );
    assert.ok(
      !html.includes("https://phoenix-hr.satopharma.com/brand/"),
      "a remote copy of the mark must not survive beside the inline one",
    );
  }

  // 2) A `cid:` source must not fall through to the typeset wordmark — the fallback that would
  //    make this whole repair silently do nothing.
  {
    const { html } = renderOfferEmail({ blocks: defaultOfferBlocks() }, FIELDS, { logoUrl: SATO_LOGO_CID_SRC });
    assert.ok(html.includes("<img src=\"cid:"), "cid: must be accepted as an image source");
  }

  // 3) The part itself: real PNG bytes, the Content-ID the body quotes, and a public URL to fall
  //    back to.
  {
    const mark = satoLogoAttachment("https://phoenix-hr.satopharma.com/");
    assert.ok(mark, "the mark must be readable from public/brand");
    assert.equal(mark.contentId, SATO_LOGO_CONTENT_ID);
    assert.equal(mark.contentType, "image/png");
    assert.equal(mark.remoteUrl, "https://phoenix-hr.satopharma.com/brand/sato-pharma-logo-on-light.png");
    const bytes = Buffer.from(mark.content, "base64");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the attached bytes must be a PNG");
    assert.ok(bytes.length > 1000, "the attached mark must not be a stub");
    assert.ok(!mark.content.startsWith("data:"), "the attachment carries bare base64, never a data: URI");
  }

  // 4) Resend is told `content_id` — the snake_case field is what makes the part inline. The
  //    camelCase name we use internally would be ignored, and the letterhead would break again
  //    with nothing failing anywhere.
  {
    await withEnv("RESEND_API_KEY", "test-key", async () => {
      const body = await captureRequest(() => resendProvider.send(preparedWithMark()));
      const attachments = body.attachments as { content_id?: string; content_type?: string; filename: string }[];
      assert.equal(attachments.length, 2, "the mark and the PDF both travel");
      assert.equal(attachments[0].content_id, SATO_LOGO_CONTENT_ID);
      assert.equal(attachments[0].content_type, "image/png");
      assert.equal(attachments[1].content_id, undefined, "the PDF is an attachment, not an inline part");
      assert.equal(attachments[1].filename, "offer.pdf");
    });
  }

  // 5) Brevo has no Content-ID field, so it must point the same <img> back at the public URL and
  //    drop the inline bytes — today's behaviour, not a stray file beside a broken letterhead.
  {
    const { attachments, html } = brevoInlineFallback(preparedWithMark());
    assert.ok(
      html.includes("https://phoenix-hr.satopharma.com/brand/sato-pharma-logo-on-light.png"),
      "Brevo's copy must point the letterhead at the public asset",
    );
    assert.ok(!html.includes("cid:"), "no cid: reference may survive into a Brevo send");
    assert.equal(attachments?.length, 1, "only the PDF is left to attach");
    assert.equal(attachments?.[0].filename, "offer.pdf");

    await withEnv("BREVO_API_KEY", "test-key", async () => {
      const body = await captureRequest(() => brevoProvider.send(preparedWithMark()));
      assert.ok(!String(body.htmlContent).includes("cid:"), "the Brevo request body must carry no cid:");
      assert.equal((body.attachment as unknown[]).length, 1);
    });
  }

  // 6) An email with no inline part is untouched — the fallback must not rewrite ordinary mail.
  {
    const plain: PreparedEmail = {
      attachments: [{ content: "cGRm", filename: "payslip.pdf" }],
      from: "a@b.c",
      html: "<p>hello</p>",
      idempotencyKey: "k",
      replyTo: "r@b.c",
      subject: "s",
      text: "hello",
      to: ["x@y.z"],
    };
    const result = brevoInlineFallback(plain);
    assert.equal(result.html, plain.html);
    assert.equal(result.attachments, plain.attachments);
  }

  // 7) The DOCUMENT letterhead — the PDF a candidate signs. A second, independent defect, found
  //    while fixing the email and repaired on the owner's instruction the same day.
  //
  //    `letterheadLogo` reads an EMPTY STRING as "the designer cleared this field on purpose" and
  //    prints the reserved gap instead of the mark. The classic built-in shipped `logo: ""`, so
  //    every classic offer PDF went out with 40px of white space where the Sato mark belongs.
  //    Only an ABSENT prop lets the renderer supply the mark — which is how the executive design
  //    has always done it. The gap and the mark are the same 40px, so filling it moves nothing.
  {
    const letterhead = defaultOfferBlocks().find((block) => block.type === "letterhead");
    if (!letterhead) throw new Error("the classic default template must carry a letterhead block");

    assert.ok(
      !Object.prototype.hasOwnProperty.call(letterhead.props ?? {}, "logo"),
      "the classic letterhead must carry NO `logo` prop — an empty string suppresses the mark",
    );

    const html = renderOfferBlock(letterhead, {}, { logoUrl: "data:image/png;base64,AAAA" });
    assert.ok(
      html.includes('<img src="data:image/png;base64,AAAA"'),
      "the classic document letterhead must draw the mark the renderer supplies",
    );
    assert.ok(!html.includes("logo-gap"), "the reserved gap must not survive beside the mark");
  }
}
