import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calendarCandidateNotice,
  resolveCalendarCandidate,
  type CalendarCandidateDeps,
  type CalendarCandidateResolution,
} from "../src/lib/recruitment/calendar-candidate-resolve.ts";
import { findMatchingCandidate, normalizePhone } from "../src/lib/recruitment/candidate-matching.ts";

// Every number here is INVENTED and belongs to nobody. This file is committed and pushed, so a live
// applicant's mobile sitting in a fixture would outlive their application — the same rule
// recruitment-candidate-matching.test.ts states about its own fixtures.
const LOCAL = "01234567890";
const INTERNATIONAL = "+201234567890";
const CANONICAL = "201234567890";
const DIALLING = "0020 123 456 7890";

type Call = { stage: string; args: unknown[] };

function harness(overrides: Partial<CalendarCandidateDeps> = {}): { deps: CalendarCandidateDeps; calls: Call[] } {
  const calls: Call[] = [];
  const record = (stage: string, ...args: unknown[]) => calls.push({ args, stage });
  const deps: CalendarCandidateDeps = {
    createCandidate: async (identity) => {
      record("createCandidate", identity);
      return { candidate: { fullName: identity.fullName, id: "new-candidate" }, created: true };
    },
    fingerprintCv: (bytes) => {
      record("fingerprintCv");
      return Buffer.isBuffer(bytes) ? bytes.toString("utf8") : "not-a-buffer";
    },
    findCvOwnerId: async (md5) => {
      record("findCvOwnerId", md5);
      return null;
    },
    findPhoneTwins: async (phoneNorm, excludeCandidateId) => {
      record("findPhoneTwins", phoneNorm, excludeCandidateId);
      return [];
    },
    getCandidateById: async (id) => {
      record("getCandidateById", id);
      return { fullName: "Existing Person", id };
    },
    ...overrides,
  };
  return { calls, deps };
}

const person = { email: null, fullName: "Booked Person", phone: null };

export async function runCalendarCandidateDedupeTests() {
  // ---- 1. THE HEADLINE. A byte-identical CV belongs to whoever already holds it --------------
  // The production case: a candidate arrived on 26/09 through WhatsApp intake, and booking an
  // interview on 27/09 with the SAME 198,144-byte Word file created a second record. Inbound intake
  // asks this question; booking did not. Break the fingerprint branch in
  // calendar-candidate-resolve.ts and this block is what goes red.
  {
    const { calls, deps } = harness({ findCvOwnerId: async () => "already-on-file" });
    const resolution = await resolveCalendarCandidate(person, Buffer.from("cv-bytes"), deps);
    assert.equal(
      resolution.candidateId,
      "already-on-file",
      "the booking must land on the record that already owns this exact CV",
    );
    assert.equal(resolution.created, false);
    assert.equal(resolution.matchReason, "cv_content");
    assert.equal(
      resolution.fullName,
      "Existing Person",
      "the resolved record's own name wins over the name typed on the booking form",
    );
    assert.equal(
      calls.some((call) => call.stage === "createCandidate"),
      false,
      "createCandidate cannot be taken back — the fingerprint must be asked BEFORE it, never after",
    );
  }

  // ---- 2. No CV, or a CV nobody holds, still creates the candidate ---------------------------
  {
    const { calls, deps } = harness();
    const resolution = await resolveCalendarCandidate(person, null, deps);
    assert.equal(resolution.created, true);
    assert.equal(resolution.candidateId, "new-candidate");
    assert.equal(resolution.matchReason, null);
    assert.equal(calls.some((call) => call.stage === "fingerprintCv"), false, "no CV, nothing to fingerprint");
  }
  {
    const { deps } = harness();
    const resolution = await resolveCalendarCandidate(person, Buffer.from("unseen"), deps);
    assert.equal(resolution.created, true);
  }

  // ---- 3. A failed lookup must never cost the booking ---------------------------------------
  // An interview that would not save is worse than a duplicate a human can merge, so both lookups
  // fall through to today's behaviour and report themselves.
  {
    const failures: string[] = [];
    const { deps } = harness({
      findCvOwnerId: async () => {
        throw new Error("fingerprint query down");
      },
      findPhoneTwins: async () => {
        throw new Error("phone query down");
      },
      onLookupFailure: (stage) => failures.push(stage),
    });
    const resolution = await resolveCalendarCandidate({ ...person, phone: LOCAL }, Buffer.from("cv-bytes"), deps);
    assert.equal(resolution.created, true, "a broken fingerprint lookup must still book the interview");
    assert.deepEqual(resolution.phoneTwinNames, []);
    assert.deepEqual(failures, ["cv_fingerprint", "phone_twins"]);
  }

  // ---- 4. THE PHONE FORMATS. One handset, four spellings, ONE question asked -----------------
  // 01234567890, +201234567890, 201234567890 and 00201234567890 are the same number, and the lookup
  // is asked in the canonical form every time — the same form candidatePayload and updateCandidate
  // write into phone_norm, so exact equality on that column IS the format-proof comparison.
  for (const typed of [LOCAL, INTERNATIONAL, CANONICAL, DIALLING]) {
    const { calls, deps } = harness();
    await resolveCalendarCandidate({ ...person, phone: typed }, null, deps);
    const lookup = calls.find((call) => call.stage === "findPhoneTwins");
    assert.ok(lookup, `a phone of ${typed} must be checked for twins`);
    assert.equal(
      lookup.args[0],
      CANONICAL,
      `${typed} must ask the pool about ${CANONICAL} — the fold lives in normalizePhone, not in this caller`,
    );
    assert.equal(
      lookup.args[1],
      "new-candidate",
      "the record just resolved must be excluded, or it reports itself as its own twin",
    );
  }
  // The premise this module rests on, asserted rather than assumed.
  assert.equal(normalizePhone(LOCAL), normalizePhone(INTERNATIONAL));
  assert.equal(normalizePhone(DIALLING), CANONICAL);

  // ---- 5. THE OWNER'S RULING. A shared number NEVER merges anything --------------------------
  // Phone stopped deciding a match on 2026-08-30, after it merged three different applicants into
  // one record: a hiring manager forwarding CVs from her own handset stamps her number onto each
  // one. Five of the twelve candidate pairs sharing a number on production are unrelated people.
  // So a twin is a sentence for a human, and the decision above is untouched by it.
  {
    const { deps } = harness({
      findPhoneTwins: async () => [{ fullName: "Somebody Else Entirely", id: "other-person" }],
    });
    const resolution = await resolveCalendarCandidate({ ...person, phone: LOCAL }, null, deps);
    assert.equal(resolution.created, true, "a shared mobile must NOT attach the booking to the other record");
    assert.equal(resolution.candidateId, "new-candidate");
    assert.equal(resolution.matchReason, null, "a phone twin is never a match reason");
    assert.deepEqual(resolution.phoneTwinNames, ["Somebody Else Entirely"]);
  }
  // And the identity rule itself still refuses phone, which is what makes the advisory necessary.
  assert.equal(
    findMatchingCandidate(
      [{ emailNorm: null, id: "existing", nationalIdNorm: null, phoneNorm: CANONICAL }],
      { emailNorm: null, nationalIdNorm: null, phoneNorm: CANONICAL },
    ),
    null,
    "findMatchingCandidate must stay blind to phone — restoring it re-creates the 2026-08-30 false merges",
  );

  // ---- 6. What the person who booked is told -------------------------------------------------
  const base: CalendarCandidateResolution = {
    candidateId: "x",
    created: true,
    fullName: "Booked Person",
    matchReason: null,
    phoneTwinNames: [],
  };
  assert.equal(
    calendarCandidateNotice(base, { cvAttached: false }),
    null,
    "nothing to report when the person is genuinely new",
  );

  const sameCv = calendarCandidateNotice({ ...base, created: false, matchReason: "cv_content" }, { cvAttached: true });
  assert.ok(sameCv?.includes("Booked Person"), "the notice names the person, never an id");
  assert.ok(
    sameCv?.includes("identical document"),
    "the booker must be told WHY the interview moved onto another record",
  );

  const matchedByEmail = calendarCandidateNotice({ ...base, created: false }, { cvAttached: true });
  assert.ok(
    matchedByEmail?.includes("was already in Recruitment"),
    "the wording that existed before this change must survive it — an e-mail match reads exactly as it did",
  );

  const twoTwins = calendarCandidateNotice(
    { ...base, phoneTwinNames: ["Aya Mohamed Mahmoud", "Raneen Awad Aboelghet"] },
    { cvAttached: false },
  );
  assert.ok(
    twoTwins?.includes("Aya Mohamed Mahmoud and Raneen Awad Aboelghet"),
    "two holders read as a list of names, not a count",
  );
  assert.ok(twoTwins?.includes("already hold the same mobile number"));
  assert.ok(
    twoTwins?.includes("check whether this is the same person"),
    "the sentence asks; it must never assert the two are the same person",
  );
  assert.ok(!twoTwins?.includes("…") && !twoTwins?.includes("..."), "no ellipsis anywhere in owner-facing text");

  const oneTwin = calendarCandidateNotice({ ...base, phoneTwinNames: ["Aya Mohamed Mahmoud"] }, { cvAttached: false });
  assert.ok(oneTwin?.includes("already holds the same mobile number"), "one holder reads in the singular");

  // ---- 7. The wiring. A resolver nothing calls is inert -------------------------------------
  // The defect was never a missing comparison — normalizePhone has folded these formats since
  // August, and production carries zero phone_norm values that disagree with it. It was that the
  // interview-calendar path never ASKED. Pin the call site.
  const calendarSource = readFileSync("src/lib/recruitment/interview-calendar.ts", "utf8");
  assert.ok(
    /await resolveCalendarCandidate\(/.test(calendarSource),
    "createInterviewBooking must resolve the candidate through resolveCalendarCandidate, or this module is dead code",
  );
  assert.ok(
    /findCvOwnerId: \(contentMd5\) => findCandidateIdByContentFingerprint\(/.test(calendarSource),
    "the fingerprint dependency must be wired to the real lookup, not left stubbed",
  );
  assert.ok(
    /findPhoneTwins: \(phoneNorm, excludeCandidateId\) => findCandidatesByPhoneNorm\(/.test(calendarSource),
    "the advisory phone check must be wired to findCandidatesByPhoneNorm",
  );
  assert.ok(
    /notice = calendarCandidateNotice\(/.test(calendarSource),
    "the booker sees this only through the booking notice — unwire it and the signal is silent",
  );

  // findCandidatesByPhoneNorm compares the COLUMN by equality. A LIKE or a tail match there would
  // widen it into the false-positive territory the owner's 2026-08-30 ruling exists to avoid.
  const candidatesSource = readFileSync("src/lib/recruitment/candidates.ts", "utf8");
  const phoneNormQuery = /export async function findCandidatesByPhoneNorm[\s\S]*?\n}/.exec(candidatesSource)?.[0] ?? "";
  assert.ok(phoneNormQuery.length > 0, "findCandidatesByPhoneNorm must exist in candidates.ts");
  assert.ok(phoneNormQuery.includes('.eq("phone_norm", key)'), "the twin lookup must be exact equality on phone_norm");
  assert.ok(!/ilike|\blike\b/i.test(phoneNormQuery), "no LIKE in the twin lookup — the fold belongs in normalizePhone");
}
