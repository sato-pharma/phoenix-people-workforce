import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_HANDOFF_BATCH,
  extractFtpSubmissionIds,
  parseHandoffWamids,
} from "../src/lib/whatsapp-videos/handoff-contract.ts";
import {
  FTP_VIDEO_THANKS_QUIET_MS,
  FTP_VIDEO_THANKS_TEXT,
  FTP_VIDEO_THANKS_WINDOW_MS,
  type FtpVideoThanksMessage,
  cairoDay,
  dueFtpVideoThanks,
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

  // --- the thank-you: the owner's words, once per batch, after the videos --------------------
  assert.equal(FTP_VIDEO_THANKS_TEXT, "Thanks, well received. Good luck!");
  assert.equal(cairoDay(new Date("2026-09-12T20:59:00Z")), "2026-09-12", "23:59 Cairo is still the 12th");
  assert.equal(
    cairoDay(new Date("2026-09-12T21:30:00Z")),
    "2026-09-13",
    "00:30 Cairo is the 13th even though UTC still says the 12th",
  );

  // Who is due. Owner 2026-09-13: thank an intern AFTER their videos — most type their id first, and
  // the old first-message reply thanked them before a single video had arrived.
  const now = new Date("2026-09-13T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const minute = 60_000;
  const msg = (waId: string, wamid: string, kind: FtpVideoThanksMessage["kind"], msAgo: number, line = "LINE-A") => ({
    kind,
    phoneNumberId: line,
    receivedAt: ago(msAgo),
    waId,
    wamid,
  });
  const due = (messages: FtpVideoThanksMessage[], thanked: Record<string, string> = {}) =>
    dueFtpVideoThanks({ lastThankedAt: new Map(Object.entries(thanked)), messages, now });

  assert.equal(FTP_VIDEO_THANKS_QUIET_MS, 3 * minute);
  assert.deepEqual(
    due([msg("201", "id-1", "submission_id", 10 * minute), msg("201", "v-1", "video", 5 * minute), msg("201", "v-2", "video", 4 * minute)]),
    [{ lastWamid: "v-2", phoneNumberId: "LINE-A", waId: "201" }],
    "an id then two videos, quiet for four minutes: one thank-you, keyed on the last message",
  );
  assert.deepEqual(
    due([msg("201", "id-1", "submission_id", 10 * minute), msg("201", "v-1", "video", 2 * minute)]),
    [],
    "still sending two minutes ago: wait",
  );
  assert.deepEqual(
    due([msg("201", "id-1", "submission_id", 10 * minute)]),
    [],
    "an id with no video yet is not 'well received' — it waits for the videos",
  );
  assert.deepEqual(
    due([msg("201", "v-1", "video", 20 * minute), msg("201", "id-1", "submission_id", 5 * minute)], { "201": ago(15 * minute) }),
    [],
    "an id typed after the thank-you is not a new batch of videos",
  );
  assert.deepEqual(
    due([msg("201", "v-1", "video", 30 * minute), msg("201", "v-2", "video", 5 * minute)], { "201": ago(20 * minute) }),
    [{ lastWamid: "v-2", phoneNumberId: "LINE-A", waId: "201" }],
    "a video after the last thank-you is a new batch",
  );
  assert.deepEqual(
    due([msg("201", "v-1", "video", 30 * minute)], { "201": ago(20 * minute) }),
    [],
    "a batch already thanked is never thanked again",
  );
  assert.deepEqual(
    due([msg("201", "v-1", "video", FTP_VIDEO_THANKS_WINDOW_MS + minute)]),
    [],
    "outside WhatsApp's reply window: no send",
  );
  assert.deepEqual(
    due([msg("201", "v-1", "video", 9 * minute, "LINE-A"), msg("201", "v-2", "video", 8 * minute, "LINE-B")]),
    [{ lastWamid: "v-2", phoneNumberId: "LINE-B", waId: "201" }],
    "the reply goes from the line the last message arrived on",
  );
  assert.deepEqual(
    due([msg("202", "v-9", "video", 6 * minute), msg("201", "v-1", "video", 6 * minute)]).map((item) => item.waId),
    ["201", "202"],
    "each sender is answered on their own",
  );

  // The batch is claimed by a primary key BEFORE the send, so two overlapping ticks thank once.
  const migration = readFileSync(
    new URL("../supabase/migrations/20260913000000_whatsapp_ftp_video_thanks_batch.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /primary key \(wa_id, triggered_by_wamid\)/, "once-per-batch is enforced by the table, not by a read");
  assert.match(migration, /revoke all on table public\.whatsapp_ftp_video_thanks_batch from anon, authenticated;/);
  const thanks = readFileSync(new URL("../src/lib/whatsapp-videos/thanks.ts", import.meta.url), "utf8");
  const claimAt = thanks.indexOf(".insert(");
  const sendAt = thanks.indexOf("sendWhatsAppText({");
  assert.ok(claimAt > 0 && sendAt > 0 && claimAt < sendAt, "the batch must be claimed before the message is sent");
  assert.match(thanks, /phoneNumberId: item\.phoneNumberId,/, "the send must use the line the message arrived on");
  assert.equal(
    (thanks.match(/\.eq\("historical", false\)/g) ?? []).length,
    2,
    "a history replay is never answered — neither a replayed video nor a replayed id",
  );
  assert.match(
    thanks,
    /\.from\("ats_whatsapp_outbound_messages"\)[\s\S]*?\.eq\("event", FTP_VIDEO_THANKS_EVENT\)/,
    "every thank-you already sent counts as 'last thanked', the one-off manual send included",
  );

  // The webhook no longer answers: a reply there is exactly the before-the-videos thank-you this replaced.
  const webhookCode = webhook.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(webhookCode, /thankFtpVideoSender|thankDueFtpVideoSenders|FTP_VIDEO_THANKS/, "the webhook must not send the thank-you");
  const cron = readFileSync(new URL("../app/api/cron/inbound-intake/route.ts", import.meta.url), "utf8");
  const cronFetch = cron.indexOf("await fetchPendingInboundVideos()");
  const cronThanks = cron.indexOf("await thankDueFtpVideoSenders()");
  assert.ok(cronFetch > 0 && cronThanks > cronFetch, "the cron thanks after it has fetched the videos");
  assert.ok(
    cronThanks > cron.indexOf("withDeadMansSwitch("),
    "the thank-you runs outside the CV queue's dead man's switch, so it can never mark that job unhealthy",
  );
}
