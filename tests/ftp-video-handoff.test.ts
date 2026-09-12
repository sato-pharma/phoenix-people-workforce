import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_HANDOFF_BATCH,
  extractFtpSubmissionIds,
  parseHandoffWamids,
} from "../src/lib/whatsapp-videos/handoff-contract.ts";
import {
  FTP_VIDEO_THANKS_TEXT,
  cairoDay,
  shouldThankFtpSender,
} from "../src/lib/whatsapp-videos/thanks-contract.ts";

// The Future Talents Portal claims the WhatsApp videos through /api/integrations/ftp-videos. A claimed
// row is never listed again, so what this suite pins is that a claim is refused WHOLE when it is not
// exactly a list of message ids — trimming a bad claim down to its good part would hide the rest from
// the portal forever — and that the route answers only to its own token.
//
// It also pins the submission id: interns type theirs next to their videos, and the webhook must take
// that message before anything in the recruitment path can answer it with "send your CV".

export function runFtpVideoHandoffTests() {
  // --- a claim is a de-duplicated list of trimmed ids ----------------------------------------
  assert.deepEqual(parseHandoffWamids({ wamids: ["wamid.A", " wamid.B ", "wamid.A"] }), ["wamid.A", "wamid.B"]);

  // --- anything else is refused whole --------------------------------------------------------
  assert.equal(parseHandoffWamids(null), null, "no body is not a claim");
  assert.equal(parseHandoffWamids({}), null, "a body with no wamids is not a claim");
  assert.equal(parseHandoffWamids({ wamids: [] }), null, "an empty claim is refused, not answered 0");
  assert.equal(parseHandoffWamids({ wamids: ["wamid.A", 7] }), null, "one non-string refuses the lot");
  assert.equal(parseHandoffWamids({ wamids: ["wamid.A", "   "] }), null, "one blank id refuses the lot");
  assert.equal(parseHandoffWamids({ wamids: "wamid.A" }), null, "a bare string is not a list");

  const tooMany = Array.from({ length: MAX_HANDOFF_BATCH + 1 }, (_, index) => `wamid.${index}`);
  assert.equal(
    parseHandoffWamids({ wamids: tooMany }),
    null,
    "an oversized claim is refused rather than cut to its first fifty",
  );
  assert.equal(parseHandoffWamids({ wamids: tooMany.slice(0, MAX_HANDOFF_BATCH) })?.length, MAX_HANDOFF_BATCH);

  // --- the route is on its own token, and never falls back to CRON_SECRET -------------------
  const route = readFileSync(new URL("../app/api/integrations/ftp-videos/route.ts", import.meta.url), "utf8");
  const guards = route.match(/assertCronAuthorized\(request, JOB, \{ secret: process\.env\.FTP_VIDEO_HANDOFF_SECRET \}\)/g) ?? [];
  assert.equal(guards.length, 2, "both GET and POST guard on FTP_VIDEO_HANDOFF_SECRET");
  // Comments are stripped first: the route's header explains WHY it avoids the shared secret by name.
  const code = route.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bCRON_SECRET\b/, "the portal's door must not open to the shared cron secret");

  // --- a submission id is read in every way a phone types it --------------------------------
  assert.deepEqual(extractFtpSubmissionIds("FTP-12345678"), ["FTP-12345678"]);
  assert.deepEqual(extractFtpSubmissionIds("my id is ftp 12345678, thanks"), ["FTP-12345678"]);
  assert.deepEqual(extractFtpSubmissionIds("FTP12345678"), ["FTP-12345678"]);
  assert.deepEqual(extractFtpSubmissionIds("FTP – 12345678"), ["FTP-12345678"], "a dash a phone autocorrected");
  assert.deepEqual(extractFtpSubmissionIds("FTP-١٢٣٤٥٦٧٨"), ["FTP-12345678"], "Arabic-Indic digits");
  assert.deepEqual(
    extractFtpSubmissionIds("FTP-12345678\nFTP-12345678 FTP-87654321"),
    ["FTP-12345678", "FTP-87654321"],
    "every distinct id, once each — choosing between two is the portal's refusal to make",
  );

  // --- and ONLY that shape, because a match takes the message out of recruitment -------------
  assert.deepEqual(extractFtpSubmissionIds("FTP-123456789"), [], "nine digits is not an id");
  assert.deepEqual(extractFtpSubmissionIds("FTP-1234567"), [], "seven digits is not an id");
  assert.deepEqual(
    extractFtpSubmissionIds("12345678"),
    [],
    "bare digits are never taken: an applicant's message must not be swallowed on a guess",
  );
  assert.deepEqual(extractFtpSubmissionIds("XFTP-12345678"), [], "the prefix must stand on its own");
  assert.deepEqual(extractFtpSubmissionIds("السلام عليكم"), []);
  assert.deepEqual(extractFtpSubmissionIds(null), []);

  // --- the webhook takes the id before anything can answer it --------------------------------
  const webhook = readFileSync(new URL("../app/api/webhooks/whatsapp/route.ts", import.meta.url), "utf8");
  const capture = webhook.indexOf("captureInboundSubmissionId(");
  assert.ok(capture > 0, "the webhook must capture a submission id");
  for (const later of ["handleClassifyText({", "bufferWhatsAppMessage(message.from", "handleTextOnlyMessage({"]) {
    const at = webhook.indexOf(later);
    assert.ok(at > 0, `expected the webhook to still call ${later}`);
    assert.ok(
      capture < at,
      `the submission id must be captured before ${later} — otherwise the intern is asked for a CV`,
    );
  }

  // --- the thank-you: the owner's words, once per sender per Cairo day -----------------------
  assert.equal(FTP_VIDEO_THANKS_TEXT, "Thanks, well received. Good luck!");
  assert.equal(cairoDay(new Date("2026-09-12T20:59:00Z")), "2026-09-12", "23:59 Cairo is still the 12th");
  assert.equal(
    cairoDay(new Date("2026-09-12T21:30:00Z")),
    "2026-09-13",
    "00:30 Cairo is the 13th even though UTC still says the 12th",
  );

  assert.equal(shouldThankFtpSender({ historical: false, outcome: "captured" }), true);
  assert.equal(shouldThankFtpSender({ historical: false, outcome: "duplicate" }), false, "a redelivery is never thanked twice");
  assert.equal(shouldThankFtpSender({ historical: false, outcome: "failed" }), false, "a video that failed to save is not well received");
  assert.equal(shouldThankFtpSender({ historical: true, outcome: "captured" }), false, "a history replay is not answered days late");

  // The day is claimed by a primary key BEFORE the send, so six simultaneous videos thank once.
  const migration = readFileSync(
    new URL("../supabase/migrations/20260912230000_whatsapp_ftp_video_thanks.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /primary key \(wa_id, cairo_day\)/, "once-per-day is enforced by the table, not by a read");
  const thanks = readFileSync(new URL("../src/lib/whatsapp-videos/thanks.ts", import.meta.url), "utf8");
  const claimAt = thanks.indexOf(".insert(");
  const sendAt = thanks.indexOf("sendWhatsAppText({");
  assert.ok(claimAt > 0 && sendAt > 0 && claimAt < sendAt, "the day must be claimed before the message is sent");

  // The thank-you goes FROM the line the intern wrote to. With two lines on one webhook, replying
  // from the other one opens a conversation with the company's second number that they never started.
  assert.match(thanks, /phoneNumberId: input\.phoneNumberId,/, "the send must use the line the message arrived on");
  const thankArgs = webhook.match(/thankFtpVideoSender\(\{[^}]*\}\)/g) ?? [];
  assert.equal(thankArgs.length, 2);
  for (const call of thankArgs) {
    assert.match(call, /phoneNumberId: message\.deliveredToPhoneNumberId/, "the webhook must pass the receiving line");
  }

  // Both captures thank, each only through the gate.
  const thankCalls = webhook.match(/shouldThankFtpSender\(/g) ?? [];
  assert.equal(thankCalls.length, 2, "a new video and a new submission id both thank, through shouldThankFtpSender");
  const idThank = webhook.indexOf("shouldThankFtpSender(", capture);
  assert.ok(idThank < webhook.indexOf("handleClassifyText({"), "the id thank-you belongs to the id block");
  const videoCapture = webhook.indexOf("captureInboundVideo({");
  const videoThank = webhook.indexOf("shouldThankFtpSender(", videoCapture);
  assert.ok(
    videoCapture > 0 && videoThank > videoCapture && videoThank < webhook.indexOf("handleTextOnlyMessage({"),
    "the video thank-you belongs to the video block",
  );
}
