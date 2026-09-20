import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chooseCvCopies, copyLabelsFor, shouldMirrorCopy, withCopyLabel } from "../src/lib/recruitment/cv-duplicate-copies.ts";
import {
  CABINET_ROOT_NAME,
  cabinetChannelFolder,
  cabinetImportSendersFromEnv,
  cabinetPathFor,
  cabinetRedFlagFor,
  DID_NOT_ANSWER_FOLDER,
  earliestIntakeEvent,
  EMAIL_CHANNEL_FOLDER,
  INTERVIEW_CALENDAR_CHANNEL_FOLDER,
  latestCvVerdict,
  OTHER_POSITIONS_FOLDER,
  POSITION_NOT_STATED,
  RED_FLAGS_FOLDER,
  TYPED_AREA_FOLDER,
  whatsappLineFolderName,
  type CabinetCandidateRow,
  type CabinetFileInput,
  type CabinetIntakeEvent,
} from "../src/lib/recruitment/drive-cabinet-folders.ts";

/**
 * The live area→region grouping, as `au.canonical_areas` reports it (production, 2026-09-07).
 *
 * Only the areas the assertions below actually name. The point of handing it in rather than reading
 * it is that the whole tree stays testable with no database.
 */
const AREA_REGIONS = {
  "Alex Center": "AB",
  "Behira 1": "AB",
  "Cairo East 1": "CA",
  "Gharbia 1 (Tanta)": "D1",
  "Kafr El-Sheikh 1": "D1",
  "Qena 1": "UE",
  // Sales files Sharkia under Delta (2). Recruitment files it under Delta (3). That disagreement is
  // the whole reason `regionFolderForArea` exists, and the test below pins which side wins.
  "Sharkia 1": "D2",
};

/** The chatbot line as Meta reports the number a message was delivered to — spaced display form. */
const CHATBOT_LINE = "+20 115 988 8247";
const CHATBOT_FOLDER = "WhatsApp 01159888247";

/** An applicant who answered every question, choosing Delta (1) and Tanta. */
function answered(overrides: Partial<CabinetCandidateRow> = {}): CabinetCandidateRow {
  return {
    applied_for_job_title: "Medical Representative",
    preferences_declared_at: "2026-09-10T10:05:00Z",
    preferred_area_name: "Gharbia 1 (Tanta)",
    preferred_region_code: "D1",
    ...overrides,
  };
}

function whatsappIntake(overrides: Partial<CabinetIntakeEvent> = {}): CabinetIntakeEvent {
  return {
    channel: "whatsapp",
    created_at: "2026-09-10T10:00:00Z",
    mailbox_label: null,
    raw_metadata: { deliveredToDisplayNumber: CHATBOT_LINE },
    sender_identifier: "201001234567",
    ...overrides,
  };
}

function emailIntake(overrides: Partial<CabinetIntakeEvent> = {}): CabinetIntakeEvent {
  return {
    channel: "email",
    created_at: "2026-09-10T10:00:00Z",
    mailbox_label: "careers",
    raw_metadata: {},
    sender_identifier: "applicant@gmail.com",
    ...overrides,
  };
}

/** One clean CV: judged a CV, the only file its candidate has, arrived on the chatbot line. */
function cv(overrides: Partial<CabinetFileInput> = {}): CabinetFileInput {
  return {
    candidate: answered(),
    fileId: "f1",
    importSenders: { email: [], whatsapp: ["01000000009"] },
    intake: whatsappIntake(),
    isCv: true,
    siblings: [{ content_md5: "x", created_at: "2026-09-10T10:00:00Z", id: "f1" }],
    ...overrides,
  };
}

const flagged = (label: string) => [RED_FLAGS_FOLDER, label];

export function runDriveCabinetFolderTests() {
  // ── The cabinet is a SECOND tree, never the first one ──────────────────────────────────────────
  // The owner asked for a new folder and for the old one to be left alone. A session that renamed
  // this constant back would silently start writing into the frozen tree.
  assert.equal(CABINET_ROOT_NAME, "Phoenix CV Cabinet");
  assert.notEqual(CABINET_ROOT_NAME, "Phoenix CVs");

  // ── Level one: the CHANNEL the CV arrived on ──────────────────────────────────────────────────
  // Owner, 2026-09-12: "every folder with every channel we receive CVs from … any CV received on this
  // WhatsApp, folder it in this WhatsApp folder." Named by the number, so a new line files itself.
  assert.equal(whatsappLineFolderName("201159888247"), "WhatsApp 01159888247");
  assert.equal(whatsappLineFolderName("+20 109 850 0699"), "WhatsApp 01098500699");
  // A foreign line keeps its international form rather than being forced into Egypt's.
  assert.equal(whatsappLineFolderName("971501234567"), "WhatsApp +971501234567");
  assert.equal(whatsappLineFolderName("1234"), null);
  assert.equal(whatsappLineFolderName(null), null);

  assert.equal(cabinetChannelFolder(whatsappIntake()), CHATBOT_FOLDER);
  assert.equal(cabinetChannelFolder(emailIntake()), EMAIL_CHANNEL_FOLDER);
  // careers@ and hr@ are two inboxes of ONE channel.
  assert.equal(cabinetChannelFolder(emailIntake({ channel: "EMAIL", mailbox_label: "hr" })), EMAIL_CHANNEL_FOLDER);
  assert.equal(cabinetChannelFolder(whatsappIntake({ raw_metadata: {} })), null);
  assert.equal(cabinetChannelFolder(whatsappIntake({ channel: "telegram" })), null);
  assert.equal(cabinetChannelFolder(null), null);

  // ── An applicant who answered: Channel / Position / Region / Area ─────────────────────────────
  assert.deepEqual(cabinetPathFor(cv(), AREA_REGIONS), [CHATBOT_FOLDER, "Medical Representative", "Delta (1)", "Gharbia 1 (Tanta)"]);
  assert.deepEqual(
    cabinetPathFor(cv({ intake: emailIntake() }), AREA_REGIONS),
    [EMAIL_CHANNEL_FOLDER, "Medical Representative", "Delta (1)", "Gharbia 1 (Tanta)"],
    "the same answers on an email land under Email — the channel is where THIS file arrived",
  );

  // ── NOTHING IS READ FROM THE CV ───────────────────────────────────────────────────────────────
  // The defect this tree replaces: 698 of 783 CVs whose sender never answered sat in a position
  // folder the CV had been guessed into. Extra CV-derived fields on the row must change nothing.
  const withCvData = {
    ...answered(),
    current_job_title: "District Manager",
    faculty: "Faculty of Pharmacy",
    governorate: "Cairo",
    sent_for_job_title: "Accountant",
  };
  assert.deepEqual(
    cabinetPathFor(cv({ candidate: withCvData }), AREA_REGIONS),
    cabinetPathFor(cv(), AREA_REGIONS),
    "a title, degree or governorate read from the CV must never move a CV — the owner: follow what they choose",
  );

  // ── Did not answer is filed as exactly that ───────────────────────────────────────────────────
  // Even when the record carries a job title and an area: without a declaration those came from the
  // CV extractor, not from the applicant.
  assert.deepEqual(
    cabinetPathFor(
      cv({
        candidate: answered({ applied_for_job_title: "District Manager", preferences_declared_at: null, preferred_region_code: null }),
      }),
      AREA_REGIONS,
    ),
    [CHATBOT_FOLDER, DID_NOT_ANSWER_FOLDER],
  );
  assert.deepEqual(
    cabinetPathFor(cv({ candidate: answered({ preferences_declared_at: "   " }), intake: emailIntake() }), AREA_REGIONS),
    [EMAIL_CHANNEL_FOLDER, DID_NOT_ANSWER_FOLDER],
  );

  // ── The position is the row they TAPPED, never reclassified ───────────────────────────────────
  const positionOf = (title: string | null) =>
    cabinetPathFor(cv({ candidate: answered({ applied_for_job_title: title }) }), AREA_REGIONS)[1];
  // One live record says "Office coordinator" — the menu label matches whatever its case.
  assert.equal(positionOf("office coordinator"), "Office Coordinator");
  assert.equal(positionOf("Pharmacist"), "Pharmacist");
  assert.equal(positionOf("Sales & Business Development"), "Sales & Business Development");
  // A typed "Other" answer is the applicant's own words: one shelf, not one folder per spelling, and
  // not run through the title classifier that used to turn it into a menu row they never picked.
  assert.equal(positionOf("Medical Representative - Damietta and Port Said"), OTHER_POSITIONS_FOLDER);
  assert.equal(positionOf("Primary Lawyer"), OTHER_POSITIONS_FOLDER);
  assert.equal(positionOf("Other"), OTHER_POSITIONS_FOLDER);
  assert.equal(OTHER_POSITIONS_FOLDER, "Other positions");
  assert.equal(positionOf(null), POSITION_NOT_STATED);
  assert.equal(positionOf("   "), POSITION_NOT_STATED);

  // ── Region, then area — both from their answers ───────────────────────────────────────────────
  const placeOf = (overrides: Partial<CabinetCandidateRow>) =>
    cabinetPathFor(cv({ candidate: answered(overrides) }), AREA_REGIONS).slice(2);

  // THE DELTA (3) OVERRIDE. With no region chosen, a company area names its region — through the
  // recruitment override, never the raw sales region, which would say Delta (2).
  assert.deepEqual(placeOf({ preferred_area_name: "Sharkia 1", preferred_region_code: null }), ["Delta (3)", "Sharkia 1"]);
  // A company area matches whatever its case, and is filed under its real name.
  assert.deepEqual(placeOf({ preferred_area_name: "gharbia 1 (tanta)" }), ["Delta (1)", "Gharbia 1 (Tanta)"]);
  // A region chosen with no area stops at the region rather than inventing an area.
  assert.deepEqual(placeOf({ preferred_area_name: null, preferred_region_code: "ue" }), ["Upper Egypt"]);
  // A typed area that is not a company area gets ONE shelf per region — "Qena north" must never sit
  // beside the real Qena 1 wearing an official-looking name.
  assert.deepEqual(placeOf({ preferred_area_name: "Qena north", preferred_region_code: "UE" }), ["Upper Egypt", TYPED_AREA_FOLDER]);
  // No region at all stops at the POSITION. A region folder they never chose is the exact guess this
  // tree exists to stop making — and an area with no region above it would be a guess too.
  assert.deepEqual(placeOf({ preferred_area_name: null, preferred_region_code: null }), []);
  assert.deepEqual(placeOf({ preferred_area_name: "Qena north", preferred_region_code: null }), []);
  // An unlisted code is shown verbatim — never an invented label — and still a single folder.
  assert.deepEqual(placeOf({ preferred_area_name: null, preferred_region_code: "a/b" }), ["A-B"]);

  // ── RED FLAGS ─────────────────────────────────────────────────────────────────────────────────
  // Owner: "Anything that may disturb our work, that's a red flag and that's separate."

  // 1. Not a CV — an explicit verdict only. An extraction that never judged is not a verdict.
  assert.deepEqual(cabinetPathFor(cv({ isCv: false }), AREA_REGIONS), flagged("Not a CV"));
  assert.equal(cabinetRedFlagFor(cv({ isCv: null })), null, "a null verdict must never park a real CV");

  // 2. Duplicate copies — the ORIGINAL keeps its real folder; only the later copy is parked.
  const copies = [
    { content_md5: "same", created_at: "2026-09-01T10:00:00Z", id: "original" },
    { content_md5: "same", created_at: "2026-09-05T10:00:00Z", id: "resend" },
  ];
  assert.deepEqual(cabinetPathFor(cv({ fileId: "resend", siblings: copies }), AREA_REGIONS), flagged("Duplicate copies"));
  assert.deepEqual(
    cabinetPathFor(cv({ fileId: "original", siblings: copies }), AREA_REGIONS),
    [CHATBOT_FOLDER, "Medical Representative", "Delta (1)", "Gharbia 1 (Tanta)"],
  );
  // A sibling list that does not contain the file cannot call it a copy — `shouldMirrorCopy` would
  // answer "not kept" for a file it never saw, and park an original.
  assert.equal(cabinetRedFlagFor(cv({ fileId: "unseen", siblings: copies })), null);
  assert.equal(cabinetRedFlagFor(cv({ siblings: [] })), null);

  // 3. Auto-forwarded — the company forwarding CVs to itself.
  assert.deepEqual(cabinetPathFor(cv({ intake: whatsappIntake({ raw_metadata: { bulkImport: true, deliveredToDisplayNumber: CHATBOT_LINE } }) }), AREA_REGIONS), flagged("Auto-forwarded"));
  assert.equal(cabinetRedFlagFor(cv({ intake: whatsappIntake({ raw_metadata: { bulkImport: "true", deliveredToDisplayNumber: CHATBOT_LINE } }) })), "auto_forward");
  // A sender on the import list, configured in local form and reported by Meta in international form.
  assert.equal(cabinetRedFlagFor(cv({ intake: whatsappIntake({ sender_identifier: "201000000009" }) })), "auto_forward");
  // The sender id missing from the column but present in the payload.
  assert.equal(cabinetRedFlagFor(cv({ intake: whatsappIntake({ raw_metadata: { deliveredToDisplayNumber: CHATBOT_LINE, wa_id: "201000000009" }, sender_identifier: null }) })), "auto_forward");
  // One of the company's OWN lines as the sender is a forward even with NO import list configured —
  // a missing environment variable must not quietly turn our own forwards into applicants.
  assert.equal(cabinetRedFlagFor(cv({ importSenders: null, intake: whatsappIntake({ sender_identifier: "201098500699" }) })), "auto_forward");
  assert.equal(cabinetRedFlagFor(cv({ intake: emailIntake({ sender_identifier: "Old.Inbox@Example.com" }), importSenders: { email: ["old.inbox@example.com"], whatsapp: [] } })), "auto_forward");
  // An answer on the record does not rescue it: that answer came from somebody else's conversation.
  assert.deepEqual(cabinetPathFor(cv({ intake: whatsappIntake({ sender_identifier: "201000000009" }) }), AREA_REGIONS), flagged("Auto-forwarded"));
  // An applicant forwarding THEIR OWN CV from another chat is an applicant, not an auto-forward.
  assert.equal(
    cabinetRedFlagFor(cv({ intake: whatsappIntake({ raw_metadata: { deliveredToDisplayNumber: CHATBOT_LINE, forwarded: true } }) })),
    null,
    "a self-forward is not a red flag",
  );

  // 4. Sent by a colleague — an email from a company address.
  assert.deepEqual(cabinetPathFor(cv({ intake: emailIntake({ sender_identifier: "Someone@SatoPharma.com" }) }), AREA_REGIONS), flagged("Sent by a colleague"));
  assert.equal(cabinetRedFlagFor(cv({ intake: emailIntake({ sender_identifier: "a@hr.satopharma.com" }) })), "colleague");
  assert.equal(cabinetRedFlagFor(cv({ intake: emailIntake({ sender_identifier: "a@notsatopharma.com" }) })), null);

  // 5. Source unknown — no record, or a WhatsApp record that never said which line.
  assert.deepEqual(cabinetPathFor(cv({ intake: null }), AREA_REGIONS), flagged("Source unknown"));
  assert.equal(cabinetRedFlagFor(cv({ intake: whatsappIntake({ raw_metadata: {} }) })), "source_unknown");

  // ── THE INTERVIEW CALENDAR IS A CHANNEL, NOT A RED FLAG ───────────────────────────────────────
  // Measured on production 2026-09-21: every CV ever uploaded by a person — 5 of them, 4 attached by
  // the owner himself while booking an interview — sat under `Red flags/Source unknown`, because the
  // cabinet reads the channel off `ats_cv_intake_events` and an in-app upload writes no such record.
  // `ats_files.upload_origin` is what now says where it came from. Owner's decision the same day:
  // the interview calendar gets its own folder; the other two in-app paths keep today's behaviour.
  const booked = cv({ intake: null, uploadOrigin: "interview_calendar" });
  assert.equal(cabinetRedFlagFor(booked), null, "a CV attached while booking an interview is not a red flag");
  assert.deepEqual(
    cabinetPathFor(booked, AREA_REGIONS),
    [INTERVIEW_CALENDAR_CHANNEL_FOLDER, "Medical Representative", "Delta (1)", "Gharbia 1 (Tanta)"],
    "it files as a channel, so the applicant's own answers still drive the rest of the path",
  );
  assert.deepEqual(
    cabinetPathFor(
      cv({ candidate: answered({ preferences_declared_at: null }), intake: null, uploadOrigin: "interview_calendar" }),
      AREA_REGIONS,
    ),
    [INTERVIEW_CALENDAR_CHANNEL_FOLDER, DID_NOT_ANSWER_FOLDER],
    "and a booking for somebody who never answered the questions is filed as exactly that",
  );
  assert.equal(cabinetChannelFolder(null, "interview_calendar"), INTERVIEW_CALENDAR_CHANNEL_FOLDER);

  // The other two origins are RECORDED but open no folder — the owner asked for one folder, and a
  // file dropped onto a candidate has no channel the cabinet can stand behind.
  for (const origin of ["ats_upload", "whatsapp_inbox"]) {
    assert.equal(
      cabinetRedFlagFor(cv({ intake: null, uploadOrigin: origin })),
      "source_unknown",
      `${origin} keeps today's behaviour until the owner asks for a folder of its own`,
    );
  }

  // An ORIGIN NEVER OVERRULES A REAL ARRIVAL. If a row ever carried both, the line the CV came in on
  // is the channel the owner asked us to file by — the origin only names the screen that wrote the row.
  assert.equal(cabinetChannelFolder(whatsappIntake(), "interview_calendar"), CHATBOT_FOLDER);
  assert.equal(cabinetChannelFolder(emailIntake(), "interview_calendar"), EMAIL_CHANNEL_FOLDER);

  // An UNKNOWN or absent origin must read exactly as the cabinet read before the column existed —
  // every row on production was null the day it was added.
  assert.equal(cabinetChannelFolder(null, "some_future_screen"), null);
  assert.equal(cabinetChannelFolder(null, null), null);
  assert.equal(cabinetChannelFolder(null, undefined), null);
  assert.equal(cabinetRedFlagFor(cv({ intake: null, uploadOrigin: null })), "source_unknown");

  // A red flag still WINS over the new channel: an interview booking is not a licence to file a
  // certificate as an applicant, nor to put a duplicate copy back beside its original.
  assert.equal(
    cabinetRedFlagFor(cv({ intake: null, isCv: false, uploadOrigin: "interview_calendar" })),
    "not_a_cv",
  );

  // THE ORDER IS DELIBERATE — one flag per CV, strongest first.
  const everything = cv({
    fileId: "resend",
    intake: whatsappIntake({ raw_metadata: { bulkImport: true } }),
    isCv: false,
    siblings: copies,
  });
  assert.equal(cabinetRedFlagFor(everything), "not_a_cv");
  assert.equal(cabinetRedFlagFor({ ...everything, isCv: true }), "duplicate_copy");
  assert.equal(cabinetRedFlagFor({ ...everything, fileId: "original", isCv: true }), "auto_forward");
  // With the company domain on the email import list (production), a colleague's email is an
  // auto-forward: the import list outranks the domain check.
  assert.equal(
    cabinetRedFlagFor(cv({ importSenders: { email: ["@satopharma.com"], whatsapp: [] }, intake: emailIntake({ sender_identifier: "a@satopharma.com" }) })),
    "auto_forward",
  );

  // ── Every path is a list of real folder names ─────────────────────────────────────────────────
  for (const input of [cv(), cv({ intake: null }), cv({ candidate: answered({ preferences_declared_at: null }) }), cv({ candidate: answered({ applied_for_job_title: "HR / Payroll", preferred_area_name: "Qena / north", preferred_region_code: "UE" }) })]) {
    const segments = cabinetPathFor(input, AREA_REGIONS);
    assert.ok(segments.length >= 2 && segments.length <= 4, `cabinet paths are 2 to 4 deep: ${segments.join("/")}`);
    assert.ok(segments.every((segment) => segment && !segment.includes("/")), `no empty segment and no separator: ${segments.join(" | ")}`);
  }

  // ── The pickers the mirror and both scripts share ─────────────────────────────────────────────
  // The FIRST intake record is where a file arrived.
  assert.equal(
    earliestIntakeEvent([
      whatsappIntake({ created_at: "2026-09-10T12:00:00Z", sender_identifier: "later" }),
      whatsappIntake({ created_at: "2026-09-10T08:00:00Z", sender_identifier: "first" }),
    ])?.sender_identifier,
    "first",
  );
  assert.equal(earliestIntakeEvent([]), null);
  // The LATEST verdict wins, and only an explicit false is "not a CV".
  assert.equal(latestCvVerdict([{ created_at: "2026-09-01", is_cv: true }, { created_at: "2026-09-02", is_cv: false }]), false);
  assert.equal(latestCvVerdict([{ created_at: "2026-09-02", is_cv: true }, { created_at: "2026-09-01", is_cv: false }]), true);
  assert.equal(latestCvVerdict([{ created_at: "2026-09-01", is_cv: false }, { created_at: "2026-09-02", is_cv: null }]), null);
  assert.equal(latestCvVerdict([]), null);
  // Read from the same variables the intake reads.
  const senders = cabinetImportSendersFromEnv({
    RECRUITMENT_EMAIL_IMPORT_SENDERS: "@satopharma.com",
    RECRUITMENT_WHATSAPP_IMPORT_SENDERS: "01000000009, 201111111111",
  });
  assert.equal(senders.whatsapp.length, 2);
  assert.equal(senders.email.length, 1);
  assert.deepEqual(cabinetImportSendersFromEnv({}), { email: [], whatsapp: [] });

  // ── The dedupe ────────────────────────────────────────────────────────────────────────────────
  // 264 of the 1,156 mirrored files were byte-identical re-sends by one person, and one candidate
  // had thirteen copies of the same file in one folder.
  const rows = [
    { content_md5: "aaa", created_at: "2026-09-02T10:00:00Z", id: "second" },
    { content_md5: "aaa", created_at: "2026-09-01T10:00:00Z", id: "first" },
    { content_md5: "aaa", created_at: "2026-09-03T10:00:00Z", id: "third" },
    { content_md5: "bbb", created_at: "2026-09-04T10:00:00Z", id: "different" },
  ];
  const chosen = chooseCvCopies(rows);
  assert.deepEqual(
    chosen.keep.map((row) => row.id).sort(),
    ["different", "first"],
    "one copy per distinct file, and the ORIGINAL wins",
  );
  assert.equal(chosen.suppress.length, 2);

  // The oldest wins because `findCandidateIdByContentFingerprint` already resolves a fingerprint
  // clash oldest-first. Disagreeing would let the row that owns the candidate and the row that owns
  // the Drive copy be two different rows.
  assert.equal(chosen.keep.find((row) => row.content_md5 === "aaa")?.id, "first");

  // A row with NO fingerprint is always kept: absence means "never computed", not "unique", and
  // suppressing on a value we do not have would silently drop a CV nobody sees again.
  const unfingerprinted = chooseCvCopies([
    { content_md5: null, created_at: "2026-09-01T10:00:00Z", id: "a" },
    { content_md5: null, created_at: "2026-09-02T10:00:00Z", id: "b" },
  ]);
  assert.equal(unfingerprinted.keep.length, 2);
  assert.equal(unfingerprinted.suppress.length, 0);

  // Ties are broken on id, so a re-run of the fill script cannot pick a different winner and upload
  // a second copy of the file it is meant to be de-duplicating.
  const sameInstant = [
    { content_md5: "ccc", created_at: "2026-09-01T10:00:00Z", id: "zzz" },
    { content_md5: "ccc", created_at: "2026-09-01T10:00:00Z", id: "aaa" },
  ];
  assert.equal(chooseCvCopies(sameInstant).keep[0].id, "aaa");
  assert.equal(chooseCvCopies([...sameInstant].reverse()).keep[0].id, "aaa");

  // The live mirror's yes/no shape agrees with the chooser it wraps.
  assert.equal(shouldMirrorCopy("first", rows), true);
  assert.equal(shouldMirrorCopy("second", rows), false);
  assert.equal(shouldMirrorCopy("different", rows), true);

  // ── Telling one candidate's two DIFFERENT CVs apart ───────────────────────────────────────────
  // Owner, 2026-09-07: "add the date to the duplicate names". These are not duplicates in the
  // dedupe sense — every byte-identical re-send is already gone — they are genuinely different CVs
  // from one person, and both belong in the cabinet wearing distinguishable names.

  // A candidate with ONE CV keeps the plain name.
  const solo = copyLabelsFor([{ content_md5: "a", created_at: "2026-08-15T09:00:00Z", id: "only" }]);
  assert.equal(solo.get("only"), "");
  assert.equal(withCopyLabel("Samy Kassab - 966577581850.pdf", ""), "Samy Kassab - 966577581850.pdf");

  // Two CVs on DIFFERENT days: the date alone separates them, so no counter.
  const twoDays = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-15T09:00:00Z", id: "aug" },
    { content_md5: "b", created_at: "2026-09-06T15:14:00Z", id: "sep" },
  ]);
  assert.equal(twoDays.get("aug"), "2026-08-15");
  assert.equal(twoDays.get("sep"), "2026-09-06");

  // THE CASE THE DATE ALONE CANNOT SOLVE: three CVs within a minute of each other.
  const sameDay = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-14T06:15:04Z", id: "first" },
    { content_md5: "b", created_at: "2026-08-14T06:15:15Z", id: "second" },
    { content_md5: "c", created_at: "2026-08-14T06:15:26Z", id: "third" },
  ]);
  assert.equal(sameDay.get("first"), "2026-08-14 #1");
  assert.equal(sameDay.get("second"), "2026-08-14 #2");
  assert.equal(sameDay.get("third"), "2026-08-14 #3");
  assert.equal(new Set([...sameDay.values()]).size, 3, "same-day CVs must still get distinct labels");

  // Mixed: the lone day stays clean, only the crowded one is numbered.
  const mixed = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-14T06:00:00Z", id: "x1" },
    { content_md5: "b", created_at: "2026-08-14T07:00:00Z", id: "x2" },
    { content_md5: "c", created_at: "2026-09-01T07:00:00Z", id: "y" },
  ]);
  assert.equal(mixed.get("x1"), "2026-08-14 #1");
  assert.equal(mixed.get("x2"), "2026-08-14 #2");
  assert.equal(mixed.get("y"), "2026-09-01");

  // A suppressed identical re-send never gets a label.
  const withResend = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-15T09:00:00Z", id: "kept" },
    { content_md5: "a", created_at: "2026-08-16T09:00:00Z", id: "resent" },
    { content_md5: "b", created_at: "2026-09-06T09:00:00Z", id: "different" },
  ]);
  assert.equal(withResend.has("resent"), false);
  assert.equal(withResend.get("kept"), "2026-08-15");
  assert.equal(withResend.get("different"), "2026-09-06");

  // The label goes BEFORE the extension.
  assert.equal(
    withCopyLabel("Amr Mohamed Rozza - 01004316664.docx", "2026-08-14"),
    "Amr Mohamed Rozza - 01004316664 (2026-08-14).docx",
  );
  assert.equal(withCopyLabel("Acheampong Augustine.jpg", "2026-08-14 #2"), "Acheampong Augustine (2026-08-14 #2).jpg");
  assert.equal(withCopyLabel("Unnamed CV", "2026-08-14"), "Unnamed CV (2026-08-14)");

  // Cairo, not UTC. 22:30 UTC on the 14th is already the 15th in Cairo.
  const cairoEdge = copyLabelsFor([
    { content_md5: "a", created_at: "2026-08-14T22:30:00Z", id: "late" },
    { content_md5: "b", created_at: "2026-09-01T09:00:00Z", id: "other" },
  ]);
  assert.equal(cairoEdge.get("late"), "2026-08-15", "the day key must be Africa/Cairo, not UTC");

  // ── The mirror, pinned in its own source ──────────────────────────────────────────────────────
  //
  // THE CUTOVER GUARD PROTECTS THE FROZEN TREE. Every `ats_files` row written before 2026-09-07
  // records a path in the old "Phoenix CVs" tree, so the stored path must be ROOTED and the move
  // branch gated on it, or a mismatch read as "the folder changed" empties the old tree silently.
  //
  // Pinned as source because `mirrorCvToDrive` needs a live Supabase client and a live Drive token.
  const mirrorSource = fs.readFileSync(
    path.join(process.cwd(), "src/lib/recruitment/drive-cv-mirror.ts"),
    "utf8",
  );

  assert.match(
    mirrorSource,
    /const pathKey = \[CABINET_ROOT_NAME, \.\.\.path\]\.join\("\/"\)/,
    "the stored mirror path must be ROOTED at the cabinet, or a legacy row is indistinguishable from a cabinet one",
  );
  assert.match(
    mirrorSource,
    /const recordedInCabinet = String\(row\.drive_mirror_path \?\? ""\)\.startsWith\(`\$\{CABINET_ROOT_NAME\}\/`\)/,
    "the mirror must decide move-vs-upload on whether the RECORDED path is a cabinet path",
  );
  assert.match(
    mirrorSource,
    /if \(row\.drive_mirror_file_id && recordedInCabinet\) \{/,
    "the MOVE branch must be gated on recordedInCabinet — ungated, it drags files out of the frozen tree",
  );

  // A NEW re-send is still never uploaded; one ALREADY in the cabinet goes on to be moved to
  // Red flags / Duplicate copies. Anything wider uploads copies; anything narrower leaves the 264
  // existing copies sitting beside their originals.
  assert.match(
    mirrorSource,
    /const duplicate = !shouldMirrorCopy\(fileId, siblings\);\s*if \(duplicate && !\(row\.drive_mirror_file_id && recordedInCabinet\)\) return "skipped";/,
    "a re-send must be skipped unless it is already filed in the cabinet",
  );
  const guardAt = mirrorSource.indexOf("shouldMirrorCopy(fileId, siblings)");
  const uploadAt = mirrorSource.indexOf("uploadCvToDrivePath({");
  assert.ok(guardAt > 0, "the mirror must consult shouldMirrorCopy");
  assert.ok(uploadAt > 0, "the mirror must still upload");
  assert.ok(guardAt < uploadAt, "the dedupe guard must run before the upload, not after it");

  // The channel and the verdict are per-FILE facts, read before the path is decided. Without them
  // every CV reads "Source unknown" — and a missing verdict files a certificate as an applicant.
  const pathKeyAt = mirrorSource.indexOf("const pathKey =");
  for (const landmark of [
    '.from("ats_cv_intake_events")',
    '.from("ats_candidate_cv_extractions")',
    "earliestIntakeEvent(",
    "latestCvVerdict(",
    "cabinetImportSendersFromEnv(process.env)",
  ]) {
    const at = mirrorSource.indexOf(landmark);
    assert.ok(at > 0 && at < pathKeyAt, `the mirror must read ${landmark} before deciding the path`);
  }

  // The cabinet is what the tree roots at.
  const treeSource = fs.readFileSync(path.join(process.cwd(), "src/lib/recruitment/drive-tree.ts"), "utf8");
  const rootStart = treeSource.indexOf("export async function ensureRootFolder(");
  assert.ok(rootStart > 0, "drive-tree must still export ensureRootFolder");
  const rootBody = treeSource.slice(rootStart, rootStart + 600);
  assert.match(rootBody, /CABINET_ROOT_NAME/, "the mirror's root must be the cabinet");
  assert.doesNotMatch(
    rootBody,
    /rootFolderId\(\)/,
    "ensureRootFolder must NOT read GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID — that pins the frozen tree",
  );
}

/**
 * Drive's bin is not a 404, and the mirror must not put back what the owner threw away.
 *
 * FOUND ON THE CABINET'S FIRST NIGHT, 2026-09-07. The owner binned a job posting that had been
 * treated as somebody's CV. A trashed file answers `files/{id}` with a 200 and `trashed: true` in a
 * field nobody had asked for, so the check that catches deletion everywhere else never fires.
 *
 * TRASHED AND MISSING WANT OPPOSITE RESPONSES, which is why this is a three-way result and not a
 * boolean. Missing should be re-filed. Trashed must never be.
 */
export function runDriveTrashedFileTests() {
  const treeSource = fs.readFileSync(path.join(process.cwd(), "src/lib/recruitment/drive-tree.ts"), "utf8");
  const mirrorSource = fs.readFileSync(path.join(process.cwd(), "src/lib/recruitment/drive-cv-mirror.ts"), "utf8");

  assert.match(
    treeSource,
    /files\/\$\{id\}\?fields=parents,name,trashed/,
    "the lookup must request `trashed` — Drive omits it by default, which is exactly how this was missed",
  );
  assert.match(treeSource, /if \(current\.trashed\) return "trashed";/, "a trashed file must answer 'trashed'");

  // Asked BEFORE the folder walk: `ensureFolderPath` CREATES folders.
  const trashedAt = treeSource.indexOf('if (current.trashed) return "trashed";');
  const ensureAt = treeSource.indexOf("const targetId = await ensureFolderPath(input.path);");
  assert.ok(trashedAt > 0 && ensureAt > 0, "both landmarks must exist");
  assert.ok(trashedAt < ensureAt, "the trashed check must run BEFORE any folder is created");

  assert.match(treeSource, /Promise<DriveMoveResult>/, "moveDriveFile must return the three-way result");
  const moveStart = treeSource.indexOf("export async function moveDriveFile(");
  const moveBody = treeSource.slice(moveStart);
  assert.doesNotMatch(
    moveBody.slice(0, moveBody.indexOf("\n}\n")),
    /return (true|false);/,
    "no boolean return may survive in moveDriveFile — that is what merged 'binned' with 'gone'",
  );

  // A trashed file's id is KEPT — clearing it routes the row to the upload branch, the resurrection.
  const trashedBranch = mirrorSource.slice(
    mirrorSource.indexOf('if (moved === "trashed")'),
    mirrorSource.indexOf('if (moved === "ok" && folderUnchanged)'),
  );
  assert.ok(trashedBranch.length > 0, "the mirror must handle the trashed answer on its own");
  assert.doesNotMatch(
    trashedBranch,
    /drive_mirror_file_id: null/,
    "a binned file must KEEP its id — clearing it is what makes the next pass re-upload the file the owner deleted",
  );
  assert.match(trashedBranch, /return "removed"/, "a deliberate deletion is its own outcome, not a failure");

  const missingBranch = mirrorSource.slice(
    mirrorSource.indexOf('if (moved === "missing")'),
    mirrorSource.indexOf('return "failed";') + 20,
  );
  assert.match(
    missingBranch,
    /drive_mirror_file_id: null/,
    "a genuinely missing file must still clear its id so it can be re-filed",
  );
}

/**
 * The Drive scripts and the app must answer the SAME question about where a CV belongs.
 *
 * They did not, for a day: the cabinet shipped in #3454 while `backfill-cvs-to-drive.mjs` went on
 * computing the old tree, and `--verify` called 913 of 1,171 mirrored CVs misfiled, then advised a
 * `--refile` that would have moved every one of them back out. Neither half was wrong on its own,
 * so this pins the one thing that keeps them together — the scripts import the app's rule, and read
 * every fact the rule needs.
 */
export function runDriveScriptAgreesWithAppTests() {
  const source = fs.readFileSync(path.join(process.cwd(), "scripts", "backfill-cvs-to-drive.mjs"), "utf8");
  const buildSource = fs.readFileSync(path.join(process.cwd(), "scripts", "build-cv-cabinet.mjs"), "utf8");
  const contextSource = fs.readFileSync(path.join(process.cwd(), "scripts", "cv-cabinet-context.mjs"), "utf8");

  assert.match(
    source,
    /import \{[^}]*cabinetPathFor[^}]*\} from "@\/lib\/recruitment\/drive-cabinet-folders"/,
    "the backfill script must take its folder rule from the cabinet module the app itself runs",
  );
  assert.ok(
    source.includes(CABINET_ROOT_NAME) || source.includes("CABINET_ROOT_NAME"),
    "the expected path must be rooted — drive_mirror_path is recorded rooted",
  );

  // ── THE ROOT IS THE CABINET, AND THE SCRIPT MUST NOT OWN A SECOND ANSWER ──────────────────────
  // A local copy of the folder walker rooted at the FROZEN tree filed 32 CVs there on 2026-09-09
  // while every count read clean.
  const codeLines = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));

  assert.ok(
    codeLines.some(
      (line) => line.includes("ensureFolderPath") && line.includes('from "@/lib/recruitment/drive-tree"'),
    ),
    "the backfill script must walk folders with the app's ensureFolderPath, which roots at the cabinet",
  );
  assert.ok(
    !codeLines.some((line) => line.includes("function ensureFolderPath")),
    "the script must not define its own ensureFolderPath — a second walker is a second root",
  );
  for (const rooted of ["DRIVE_ROOT_NAME", "GOOGLE_DRIVE_RECRUITMENT_ROOT_NAME"]) {
    assert.ok(
      !codeLines.some((line) => line.includes(rooted)),
      `${rooted} names the OLD tree's root — the cabinet's root comes from ensureRootFolder()`,
    );
  }
  for (const dead of ["driveFolderPathFor", "driveInferredFolderPath"]) {
    assert.ok(
      !source.includes(dead),
      `${dead} builds the OLD tree's path — the backfill script must not compute a folder of its own`,
    );
  }

  // ── THE MOVE IS THE APP'S TOO ─────────────────────────────────────────────────────────────────
  // The script's own `moveInDrive` never asked Drive about the bin, so a `--refile` would have moved
  // the CV the owner deleted by hand back into a live folder.
  assert.ok(
    codeLines.some((line) => line.includes("moveDriveFile") && line.includes('from "@/lib/recruitment/drive-tree"')),
    "the refile must move files with the app's moveDriveFile, which checks the bin first",
  );
  assert.ok(!source.includes("function moveInDrive"), "the script must not keep its own Drive move");

  // ── EVERY FACT THE RULE READS ─────────────────────────────────────────────────────────────────
  // The rule reads four answers off the candidate. A SELECT missing one files an answered applicant
  // shallower than the app did — and the verifier then reports a correctly filed CV as misfiled.
  const uploadRun = source.slice(source.indexOf("async function main"), source.indexOf("async function verifyMirror"));
  const verify = source.slice(source.indexOf("async function verifyMirror"));
  assert.ok(uploadRun.length > 0 && verify.length > 0, "main() and verifyMirror() must both exist");
  for (const column of ["preferences_declared_at", "applied_for_job_title", "preferred_area_name", "preferred_region_code"]) {
    assert.ok(uploadRun.includes(column), `the run's candidate SELECT must fetch ${column}`);
    assert.ok(verify.includes(column), `--verify's candidate SELECT must fetch ${column}`);
    assert.ok(buildSource.includes(column), `build-cv-cabinet's candidate SELECT must fetch ${column}`);
  }

  // The per-FILE facts — where it arrived and whether it is a CV — come from ONE shared loader that
  // picks with the app's own functions, so a script can never choose a different record than the site.
  for (const [name, text] of [["backfill-cvs-to-drive", source], ["build-cv-cabinet", buildSource]] as const) {
    assert.match(
      text,
      /import \{[^}]*cabinetInputFor[^}]*loadCabinetFacts[^}]*\} from "\.\/cv-cabinet-context\.mjs"/,
      `${name} must load the intake record and verdict through cv-cabinet-context.mjs`,
    );
    // Without the production import lists the owner's own forwards read as applicants, while the live
    // mirror parks them under Red flags. The run must refuse rather than disagree.
    assert.ok(text.includes("requireImportSenders()"), `${name} must refuse to run without the import-sender lists`);
  }
  assert.ok(uploadRun.includes("loadCabinetFacts(") && verify.includes("loadCabinetFacts("), "both halves of the backfill must load the per-file facts");
  assert.match(buildSource, /cabinetPathFor\(\s*cabinetInputFor\(/, "build-cv-cabinet must hand the rule the whole per-file input");
  assert.match(
    contextSource,
    /import \{[^}]*earliestIntakeEvent[^}]*latestCvVerdict[^}]*\} from "@\/lib\/recruitment\/drive-cabinet-folders"/,
    "the shared loader must pick the record and verdict with the app's own pickers",
  );
  assert.ok(
    !contextSource.includes("function earliestIntakeEvent") && !contextSource.includes("function latestCvVerdict"),
    "the loader must not keep its own copy of the pickers",
  );
  assert.match(contextSource, /ats_cv_intake_events\?select=/, "the loader must read the intake records");
  assert.match(contextSource, /ats_candidate_cv_extractions\?select=/, "the loader must read the extraction verdicts");

  // A CV binned in Drive by a person is a STATE, not a failed attempt — matched by the app's
  // constant, never by re-spelling the sentence.
  assert.ok(
    source.includes("REMOVED_FROM_DRIVE_BY_HAND"),
    "the script must import the hand-deleted marker from the mirror, not re-spell it",
  );
  assert.ok(
    !source.includes("Removed from Drive by hand"),
    "the hand-deleted marker must not be written out a second time — import the constant",
  );
  assert.match(
    uploadRun,
    /select=[^`]*drive_mirror_error[^`]*/,
    "the refile's SELECT must fetch drive_mirror_error, or a CV binned by hand is moved back out of the bin",
  );

  // ── A RE-SENT COPY IS SUPPRESSED, AND THE SCRIPT MUST ASK THE APP WHICH ONE ───────────────────
  // Four suppressed rows uploaded by a plain backfill put four duplicates into the cabinet on
  // 2026-09-11, one of them a SIXTEENTH copy.
  assert.match(
    source,
    /import \{[^}]*shouldMirrorCopy[^}]*\} from "@\/lib\/recruitment\/cv-duplicate-copies"/,
    "the backfill must take the duplicate rule from the module the app itself runs",
  );
  assert.ok(
    uploadRun.includes("shouldMirrorCopy"),
    "the backfill must ask the app's duplicate rule before uploading",
  );
  // The refile needs the siblings too: a copy ALREADY in Drive now moves to Red flags / Duplicate
  // copies, and an empty sibling map would leave every one of them beside its original.
  assert.ok(!source.includes("REFILE ? new Map()"), "--refile must load the candidates' sibling CVs, not an empty map");
  assert.ok(
    !source.includes("function shouldMirrorCopy") && !source.includes("function chooseCvCopies"),
    "the script must not keep its own copy of the duplicate rule",
  );
  assert.ok(
    verify.includes("shouldMirrorCopy"),
    "--verify must count a suppressed re-send apart from a real backlog",
  );
  assert.ok(verify.includes("content_md5"), "--verify's SELECT must fetch content_md5");
  assert.ok(
    source.slice(0, source.indexOf("async function verifyMirror")).includes("content_md5"),
    "the sibling SELECT the upload run reads must fetch content_md5",
  );

  // ── THE ROOTED PATH AND THE DRIVE PATH ARE NOT THE SAME ARRAY ─────────────────────────────────
  // Conflating them on 2026-09-08 created a SECOND folder named "Phoenix CV Cabinet" and moved 264
  // CVs into it while every check reported zero misfiled.
  {
    const driveFn = source.slice(
      source.indexOf("function cabinetDriveSegments"),
      source.indexOf("function cabinetStoredPathKey"),
    );
    assert.ok(driveFn.length > 0, "cabinetDriveSegments must exist — it is the unrooted half");
    assert.ok(
      !driveFn.includes("CABINET_ROOT_NAME"),
      "the DRIVE path must NOT carry the cabinet name: ensureFolderPath already roots there",
    );
    assert.match(
      source,
      /function cabinetStoredPathKey[\s\S]{0,200}CABINET_ROOT_NAME/,
      "the STORED path key must be rooted",
    );
    assert.match(
      source,
      /const segments = cabinetDriveSegments\(/,
      "the array handed to moveDriveFile must come from cabinetDriveSegments",
    );
    assert.match(
      source,
      /const key = cabinetStoredPathKey\(/,
      "the value written to drive_mirror_path must come from cabinetStoredPathKey",
    );
  }
}

/**
 * EVERY PATH THAT UPLOADS A CV MUST ALSO MIRROR IT.
 *
 * `uploadCandidateFile` stores the bytes and writes the `ats_files` row. It does NOT mirror — the
 * cabinet is reached through `mirrorCandidateCvsToDrive`, a separate call. For a year only the two
 * inbound workers made it, so a CV uploaded inside Phoenix reached storage and stopped there.
 *
 * Measured on production 2026-09-21: 5 CVs, every one ever uploaded by a person, none mirrored by
 * the running site. Four were attached by the owner while booking interviews on 19-20 September and
 * sat unmirrored across two mornings of the health check until a backfill was run by hand; the fifth,
 * saved from the WhatsApp inbox on 18 August, reached Drive only because a backfill happened to run
 * weeks later. Nothing errored and nothing was logged — the rows simply had no `drive_mirror_file_id`,
 * which is indistinguishable from a suppressed duplicate copy.
 *
 * Asserted on the SOURCE rather than by running the paths, because each needs Supabase, Drive and an
 * access context; what actually went wrong was a missing call, and a missing call is visible here.
 * Structural matches, never byte offsets — a pinning test that slices a fixed window false-fails the
 * first time somebody adds a line above it.
 */
export function runCvUploadPathsMirrorTests() {
  const read = (...parts: string[]) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

  // The origin the cabinet reads has to actually be WRITTEN, or every in-app upload keeps filing
  // itself "Source unknown" while this suite's folder assertions still pass on their fixtures.
  const files = read("src", "lib", "recruitment", "files.ts");
  assert.match(
    files,
    /upload_origin: input\.origin \?\? null/,
    "uploadCandidateFile must persist the origin — the cabinet has no other way to know the channel",
  );

  const paths = [
    {
      origin: "interview_calendar",
      what: "a CV attached while booking an interview",
      where: ["src", "lib", "recruitment", "interview-calendar.ts"],
    },
    {
      origin: "ats_upload",
      what: "a file uploaded onto a candidate in the ATS",
      where: ["app", "api", "recruitment", "candidates", "[id]", "files", "route.ts"],
    },
    {
      origin: "whatsapp_inbox",
      what: "an attachment saved out of the WhatsApp inbox",
      where: ["src", "lib", "whatsapp-inbox", "store.ts"],
    },
  ];

  for (const { origin, what, where } of paths) {
    const source = read(...where);
    const name = where.join("/");
    assert.match(
      source,
      /import \{[^}]*mirrorCandidateCvsToDrive[^}]*\} from "@\/lib\/recruitment\/drive-cv-mirror"/,
      `${name} uploads a CV, so it must import the mirror — ${what} reaches no inbound worker`,
    );
    assert.match(
      source,
      /await mirrorCandidateCvsToDrive\(/,
      `${name} must actually CALL the mirror, not merely import it`,
    );
    assert.ok(
      source.includes(`origin: "${origin}"`),
      `${name} must stamp origin "${origin}", or the cabinet files ${what} under Red flags`,
    );
    // Best-effort, both of them: a CV that cannot reach Drive must never fail the booking, the
    // upload response or the inbox save that already succeeded.
    assert.match(
      source,
      /await mirrorCandidateCvsToDrive\([^)]*\)\.catch\(\(\) => \{\}\)/,
      `${name} must swallow a mirror failure — the upload has already committed by then`,
    );
  }

  // The scripts read the same column, so a re-file can never disagree with the running site about
  // where an interview-calendar CV belongs. `cabinetInputFor` reads it off the FILE row it is handed,
  // so a script whose SELECT omits it hands in undefined and quietly files the CV "Source unknown".
  assert.match(
    read("scripts", "cv-cabinet-context.mjs"),
    /uploadOrigin: file\.upload_origin \?\? null/,
    "the shared cabinet loader must pass the file's upload origin through",
  );
  for (const script of ["backfill-cvs-to-drive.mjs", "build-cv-cabinet.mjs"]) {
    const source = read("scripts", script);
    for (const select of source.match(/ats_files\?select=[^`&]+/g) ?? []) {
      // The sibling/dedupe selects carry only the fingerprint columns and never reach the cabinet
      // rule; the ones that also fetch a Drive column are the ones that do.
      if (!select.includes("drive_mirror")) continue;
      assert.ok(
        select.includes("upload_origin"),
        `${script}: a SELECT feeding the cabinet rule must fetch upload_origin — ${select}`,
      );
    }
  }
}
