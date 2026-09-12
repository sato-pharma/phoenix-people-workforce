import assert from "node:assert/strict";

import {
  buildWhatsAppIntakeInput,
  parseWhatsAppWebhookPayload,
} from "../src/lib/recruitment/inbound/whatsapp-payload-parser.ts";
import { decideTextOnlyAction } from "../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts";

// A video on this channel is never a job application. The Future Talents programme's closing videos
// were sent to the advertised HR handset, so once coexistence links it, Meta replays them through
// the recruitment webhook. What this suite pins is that they are KEPT and that they never become
// candidates — the two halves of the loss, which failed in opposite directions before this change.

const HANDSET_DISPLAY = "+20 11 59888247";
const HANDSET_ID = "999888777";
const INTERN = "201012345678";
// 12 Sep 2026 12:00:00 UTC — a fixed instant, so the ISO assertion below is not a moving target.
const SENT_UNIX = "1789214400";

function livePayload(messages: unknown[]) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ profile: { name: "Yasmeen Elsafory" }, wa_id: INTERN }],
              messages,
              messaging_product: "whatsapp",
              metadata: { display_phone_number: HANDSET_DISPLAY, phone_number_id: HANDSET_ID },
            },
          },
        ],
      },
    ],
  };
}

function historyPayload(messages: unknown[]) {
  return {
    entry: [
      {
        changes: [
          {
            field: "history",
            value: {
              contacts: [{ profile: { name: "Yasmeen Elsafory" }, wa_id: INTERN }],
              history: [{ metadata: { chunk_order: 1, phase: "0" }, threads: [{ id: INTERN, messages }] }],
              messaging_product: "whatsapp",
              metadata: { display_phone_number: HANDSET_DISPLAY, phone_number_id: HANDSET_ID },
            },
          },
        ],
      },
    ],
  };
}

/** The camera-icon shape: WhatsApp compresses it and sends no filename. */
const recordedVideo = {
  from: INTERN,
  id: "wamid.VIDEO1",
  timestamp: SENT_UNIX,
  type: "video",
  video: { caption: "My closing video - Pediatrics", id: "VMEDIA1", mime_type: "video/mp4", sha256: "abc" },
};

/** The attach-as-file shape: the same video, a `document` node, a filename, and no compression. */
const attachedVideo = {
  document: { filename: "closing-video.mp4", id: "VMEDIA2", mime_type: "video/mp4" },
  from: INTERN,
  id: "wamid.VIDEO2",
  timestamp: SENT_UNIX,
  type: "document",
};

const realCv = {
  document: { filename: "Yasmeen-CV.pdf", id: "CVMEDIA1", mime_type: "application/pdf" },
  from: INTERN,
  id: "wamid.CV1",
  timestamp: SENT_UNIX,
  type: "document",
};

export function runWhatsAppInboundVideoTests() {
  // --- the camera shape is a video, and is NOT a document -----------------------------------
  const [recorded] = parseWhatsAppWebhookPayload(livePayload([recordedVideo]));
  assert.ok(recorded.video, "a type:video message parses into the video field");
  assert.equal(recorded.video?.mediaId, "VMEDIA1");
  assert.equal(recorded.video?.mimeType, "video/mp4");
  assert.equal(recorded.video?.caption, "My closing video - Pediatrics");
  assert.equal(recorded.video?.filename, null, "a recorded video carries no filename");
  assert.equal(
    recorded.document,
    null,
    "document stays null for a video — it is what every consumer reads as 'this is a CV'",
  );

  // --- THE ONE THAT MATTERS: a video attached as a document is still a video ------------------
  // This is the shape a sender chooses deliberately, to stop WhatsApp compressing the file. Routing
  // on the node name instead of the MIME type sends it straight into the CV queue, where it is
  // downloaded, read by the extraction and filed as a candidate.
  const [attached] = parseWhatsAppWebhookPayload(livePayload([attachedVideo]));
  assert.ok(attached.video, "a document node with a video MIME type parses as a video");
  assert.equal(attached.video?.mediaId, "VMEDIA2");
  assert.equal(attached.video?.filename, "closing-video.mp4", "the attached shape keeps its filename");
  assert.equal(attached.document, null, "a video attached as a file must never reach the CV path");

  // --- a real CV is untouched by any of this -------------------------------------------------
  const [cv] = parseWhatsAppWebhookPayload(livePayload([realCv]));
  assert.equal(cv.video, null, "a PDF is not a video");
  assert.ok(cv.document, "a PDF document is still a CV");
  assert.equal(cv.document?.filename, "Yasmeen-CV.pdf");
  assert.equal(cv.document?.mimeType, "application/pdf");

  // A photographed CV — an image — also stays a document. It shares the video's node shape, so a
  // broad "any media that is not a PDF" split would have swallowed it.
  const [photo] = parseWhatsAppWebhookPayload(
    livePayload([{ from: INTERN, id: "wamid.IMG1", image: { id: "IMG1", mime_type: "image/jpeg" }, type: "image" }]),
  );
  assert.ok(photo.document, "a photographed CV is still a document");
  assert.equal(photo.video, null, "an image is not a video");

  // --- the send time is captured, because nothing else identifies these files ------------------
  assert.equal(recorded.sentAt, "2026-09-12T12:00:00.000Z", "Meta's unix seconds become an ISO instant");
  const [noTimestamp] = parseWhatsAppWebhookPayload(
    livePayload([{ ...recordedVideo, id: "wamid.VIDEO3", timestamp: undefined }]),
  );
  assert.equal(noTimestamp.sentAt, null, "a missing timestamp is null, never 1970");
  const [zeroTimestamp] = parseWhatsAppWebhookPayload(
    livePayload([{ ...recordedVideo, id: "wamid.VIDEO4", timestamp: "0" }]),
  );
  assert.equal(zeroTimestamp.sentAt, null, "a zero timestamp is null — it would sort first forever");
  const [junkTimestamp] = parseWhatsAppWebhookPayload(
    livePayload([{ ...recordedVideo, id: "wamid.VIDEO5", timestamp: "not-a-number" }]),
  );
  assert.equal(junkTimestamp.sentAt, null, "an unparseable timestamp is null, not NaN");

  // --- a replayed video survives the history envelope ------------------------------------------
  // The backlog is the whole reason this exists: it arrives two levels deeper, once, and is not
  // re-requestable.
  const [replayed] = parseWhatsAppWebhookPayload(historyPayload([recordedVideo]));
  assert.ok(replayed.video, "a video inside a coexistence history replay is still parsed");
  assert.equal(replayed.historical, true, "and is marked as a replay, not an arrival");
  assert.equal(replayed.video?.mediaId, "VMEDIA1");
  assert.equal(replayed.sentAt, "2026-09-12T12:00:00.000Z", "a replay keeps the ORIGINAL send time");

  // The business's own outgoing video in a replayed thread is still skipped — the existing rule,
  // which must not be lost by adding a second media kind to the same envelope.
  const ownVideo = { ...recordedVideo, from: "201159888247", id: "wamid.OURS" };
  assert.deepEqual(
    parseWhatsAppWebhookPayload(historyPayload([ownVideo])),
    [],
    "our own replayed video is not an inbound message",
  );

  // --- what the webhook would have done without the new branch ---------------------------------
  // Both halves of the old behaviour, asserted against the real decision table rather than
  // described in a comment. A LIVE video reaching this table is answered "send us your CV"; a
  // REPLAYED one is discarded with no record at all. The webhook's video branch runs before either
  // can happen, and these two assertions are what make that ordering load-bearing rather than
  // incidental.
  const liveAsTextOnly = decideTextOnlyAction({
    hasOpenClassifySession: false,
    hasRecentCv: false,
    historical: false,
    isImportSender: false,
    priorTextOnlyEventsInWindow: 0,
    replyEnabled: true,
  });
  assert.equal(liveAsTextOnly.ask, true, "a live video reaching the text-only table asks the intern for a CV");
  assert.equal(liveAsTextOnly.notify, true, "and notifies Talent Acquisition about an intern");

  const replayAsTextOnly = decideTextOnlyAction({
    hasOpenClassifySession: false,
    hasRecentCv: false,
    historical: true,
    isImportSender: false,
    priorTextOnlyEventsInWindow: 0,
    replyEnabled: true,
  });
  assert.equal(replayAsTextOnly.record, false, "a replayed video reaching that table is not even recorded");
  assert.equal(replayAsTextOnly.reason, "historical");

  // --- and if a video ever did reach the CV builder, it carries no CV --------------------------
  // buildWhatsAppIntakeInput is reached only from the queue, which a video never enters. Pinned
  // anyway: the failure mode is an intern filed as a job applicant, which is not recoverable by
  // deleting a row once a notification has gone out.
  const videoAsIntake = buildWhatsAppIntakeInput(recorded, null);
  assert.equal(videoAsIntake.attachment, null, "a video has no CV attachment to extract");
  assert.equal(
    (videoAsIntake.rawMetadata as { messageType?: string }).messageType,
    "video",
    "and the message type says plainly what it was",
  );
}
