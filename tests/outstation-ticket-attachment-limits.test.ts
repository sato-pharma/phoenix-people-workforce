import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkSubmitBodySize,
  checkTicketAttachmentFile,
  jpegFileName,
  SUBMIT_BODY_MAX_CHARS,
  TICKET_PDF_MAX_BYTES,
} from "../src/lib/outstation/ticket-attachment-limits.ts";

const MB = 1024 * 1024;

export function runOutstationTicketAttachmentLimitsTests() {
  // A phone camera photo is far over the server's 5 MB cap, and it must be ACCEPTED at the picker
  // (the wizard shrinks it) rather than refused: that refusal is the bug this pins.
  const bigPhoto = checkTicketAttachmentFile({ name: "IMG_2041.jpg", size: 8 * MB, type: "image/jpeg" });
  assert.deepEqual(bigPhoto, { kind: "image", ok: true }, "a large photo is shrunk, never refused");

  // HEIC / WebP are offered by `image/*` and are not types the server takes; they too go through
  // the canvas re-encode, so the picker lets them in.
  assert.equal(checkTicketAttachmentFile({ name: "a.heic", size: 2 * MB, type: "image/heic" }).ok, true);
  assert.equal(checkTicketAttachmentFile({ name: "a.webp", size: 2 * MB, type: "image/webp" }).ok, true);

  // Some Android pickers report no MIME type at all; the extension decides.
  assert.deepEqual(checkTicketAttachmentFile({ name: "Invoice.PDF", size: MB, type: "" }), {
    kind: "pdf",
    ok: true,
  });
  assert.deepEqual(checkTicketAttachmentFile({ name: "photo.jpeg", size: MB, type: "" }), {
    kind: "image",
    ok: true,
  });

  // A PDF cannot be shrunk, so an oversize one is refused up front with words the employee can act on.
  const bigPdf = checkTicketAttachmentFile({ name: "dinner.pdf", size: 6 * MB, type: "application/pdf" });
  assert.equal(bigPdf.ok, false);
  if (!bigPdf.ok) {
    assert.match(bigPdf.message, /dinner\.pdf/);
    assert.match(bigPdf.message, /PDF can be at most 4\.5 MB/);
  }
  assert.equal(
    checkTicketAttachmentFile({ name: "ok.pdf", size: TICKET_PDF_MAX_BYTES, type: "application/pdf" }).ok,
    true,
    "exactly at the cap is allowed",
  );

  // Not a ticket at all.
  assert.equal(checkTicketAttachmentFile({ name: "sheet.xlsx", size: MB, type: "application/vnd.ms-excel" }).ok, false);
  assert.equal(checkTicketAttachmentFile({ name: "empty.jpg", size: 0, type: "image/jpeg" }).ok, false);

  // The whole request travels as one JSON body that proxy.ts buffers only up to 10 MB.
  assert.deepEqual(checkSubmitBodySize(SUBMIT_BODY_MAX_CHARS), { ok: true });
  const tooBig = checkSubmitBodySize(SUBMIT_BODY_MAX_CHARS + 1);
  assert.equal(tooBig.ok, false);

  assert.equal(jpegFileName("Dinner Receipt.HEIC"), "Dinner Receipt.jpg");
  assert.equal(jpegFileName("scan"), "scan.jpg");
  assert.equal(jpegFileName(""), "attachment.jpg");

  // The wizard must actually call the guards — a pure module nobody imports pins nothing. Read the
  // component: it is a client file the node test runner cannot execute.
  const wizard = readFileSync(
    new URL("../src/components/outstation/mobile-outstation-wizard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(wizard, /ticketFiles\.map\(prepareTicketAttachment\)/, "submit shrinks each attachment");
  assert.match(wizard, /checkSubmitBodySize\(/, "submit checks the body size before posting");
  assert.match(wizard, /checkTicketAttachmentFile\(file\)/, "the picker judges each file when chosen");

  // The submit route must log its failures; without it a refused submit leaves no trace anywhere.
  const route = readFileSync(new URL("../app/api/outstation/submit/route.ts", import.meta.url), "utf8");
  assert.match(route, /event: "outstation_submit_failed"/, "the submit route logs each failure");
}
