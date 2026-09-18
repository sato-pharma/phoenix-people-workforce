import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  seatQueueMatch,
  textNamesSeatArea,
} from "../src/lib/recruitment/vacancy-seat-queue.ts";
import { vacanciesForCandidate } from "../src/lib/recruitment/vacancy-applicants.ts";

// "Screen a vacant seat" — the Menoufia 1 medical representative post, screened by hand on
// 2026-09-11: seventeen CVs, over an hour, and the screening workstation showed none of them.
// Every case below is one of the three reasons it showed none, plus the two things that must NOT
// change: a decided CV never comes back, and the default queue (no seat picked) is untouched.

/** The real open seat. Anti Infective, Delta (1), area "Menoufia 1". */
const menoufia1 = {
  areaName: "Menoufia 1",
  id: 501,
  jobTitle: "Medical Representative",
  lineName: "Anti Infective",
  managerHrId: "A-21",
  managerName: "Ahmed Sami",
  regionName: "Delta (1)",
  standingInFor: null,
};

/** Its neighbour. Same governorate, same job, DIFFERENT territory — the one a misspelling must not steal. */
const menoufia2 = { ...menoufia1, areaName: "Menoufia 2", id: 502 };

/** A look-alike pair in another governorate, for the folder-key case. */
const kafr1 = { ...menoufia1, areaName: "Kafr El-Sheikh 1", id: 503 };
const kafr2 = { ...menoufia1, areaName: "Kafr El-Sheikh 2", id: 504 };

export async function runVacancySeatQueueTests() {
  // ── SOURCE 1 · FILED TO THE SEAT'S FOLDER ─────────────────────────────────
  // 323 CVs sit in folders, and a filed CV is dropped from the pool and from the workstation. The
  // area folder is exactly where the CVs for an open seat are put, so the shelf was hiding the pile.
  const filed = seatQueueMatch(
    { appliedForJobTitle: "Medical Representative", folderKey: "Menoufia 1" },
    menoufia1,
  );
  assert.equal(filed?.source, "folder", "a CV filed to the seat's own area folder belongs to that seat");
  assert.equal(
    filed?.reason,
    "Filed to the Menoufia 1 folder",
    "the headline assertion: the row must say WHY in plain words, naming the place",
  );

  // A LOOK-ALIKE FOLDER KEY. Same canonical area, different spelling — case, spacing and the
  // company's own index written without a space. PR #3719's normaliser is the only one used.
  assert.equal(
    seatQueueMatch({ appliedForJobTitle: "Medical rep", folderKey: "  menoufia   1 " }, menoufia1)?.source,
    "folder",
    "a folder key differing only by case and spacing is the SAME area",
  );
  assert.equal(
    seatQueueMatch({ appliedForJobTitle: "Medical rep", folderKey: "menofia 1" }, menoufia1)?.source,
    "folder",
    "a misspelt folder key reaches the seat through the shared place vocabulary",
  );

  // …AND THE INDEX STILL HAS TO AGREE. Kafr El-Sheikh 1 and Kafr El-Sheikh 2 are two territories,
  // and a key naming neither index may claim neither. Refusing here is the correct answer.
  assert.equal(
    seatQueueMatch({ appliedForJobTitle: "Medical rep", folderKey: "kafrelsheikh" }, kafr1),
    null,
    "a key with no index cannot choose between Kafr El-Sheikh 1 and 2, so it claims neither",
  );
  assert.equal(
    seatQueueMatch({ appliedForJobTitle: "Medical rep", folderKey: "kafrelsheikh" }, kafr2),
    null,
    "and it must not claim the other one either",
  );
  assert.equal(
    seatQueueMatch({ appliedForJobTitle: "Medical rep", folderKey: "kafrelsheikh 2" }, kafr2)?.source,
    "folder",
    "with the index present, the squashed spelling does reach its own seat",
  );

  // A DISTRICT MANAGER NEVER REACHES A MEDICAL REP'S SEAT — the owner's standing rule, enforced by
  // the job gate rather than by a second title rule written here.
  assert.equal(
    seatQueueMatch(
      { currentJobTitle: "District Sales Manager", folderKey: "Menoufia 1" },
      menoufia1,
    ),
    null,
    "a district manager's CV in a rep's area folder is still not a rep's CV",
  );

  // ── SOURCE 2 · THE APPLICANT'S OWN WHATSAPP ANSWER ────────────────────────
  // The owner's rule: what the applicant chose by hand in the intake is the number-one source of
  // truth for what they applied to.
  const whatsapp = seatQueueMatch(
    { appliedForJobTitle: "Medical Representative", preferredAreaName: "Menoufia 1" },
    menoufia1,
  );
  assert.equal(whatsapp?.source, "whatsapp", "the area the applicant tapped puts them in that seat's pile");
  assert.equal(
    whatsapp?.reason,
    "Chose Menoufia 1 on WhatsApp",
    "and the row says so in the applicant's own terms",
  );

  // ── SOURCE 3 · THE EMAIL SUBJECT, MISSPELT ────────────────────────────────
  // The strongest of the seventeen. No WhatsApp answers at all: no applied-for title, no area, no
  // folder, no salary — just a subject line, spelling Menoufia the way people say it.
  const emailApplicant = {
    appliedForJobTitle: null,
    appliedForText: "Senior medical rep menofia 1",
    currentJobTitle: "Medical Representative",
    emailSubject: "Senior medical rep menofia 1",
  };
  const email = seatQueueMatch(emailApplicant, menoufia1);
  assert.equal(email?.source, "email", "a misspelt email subject still names the seat it names");
  assert.equal(
    email?.reason,
    "Email subject names Menoufia 1",
    "the headline assertion: the reason names the seat, never the raw subject or a code",
  );
  // AND IT DOES NOT LEAK NEXT DOOR. "menofia" alone reaches the governorate; the index is what
  // separates the two seats, and it says 1.
  assert.equal(
    seatQueueMatch(emailApplicant, menoufia2),
    null,
    "the misspelling must not also claim Menoufia 2 — territory is never inferred from free text",
  );

  // The place reader on its own, in both directions.
  assert.ok(textNamesSeatArea("menofia 1", "Menoufia 1"), "a governorate alias plus the index is a match");
  assert.ok(!textNamesSeatArea("menofia", "Menoufia 1"), "the alias alone is not");
  assert.ok(textNamesSeatArea("Tanta", "Gharbia 1 (Tanta)"), "a name inside the area's own name still matches");
  assert.ok(!textNamesSeatArea("Cairo, Egypt", "Menoufia 1"), "an unrelated address matches nothing");

  // ── WHAT WAS DECIDED IS SORTED BY THE DECISION TABS, NOT DROPPED HERE ─────
  // The seat once hid rejected, sent and hired CVs by a rule of its own. Since 2026-09-18 every pile
  // on the screening page opens on "Not decided yet" and the decided ones sit on their own tabs, so
  // the seat reads every CV and the tabs narrow it like any other pile.
  const workspace = readFileSync(path.join(process.cwd(), "src/lib/recruitment/screening-workspace.ts"), "utf8");
  assert.doesNotMatch(workspace, /isSeatQueueDecided/, "the seat keeps no decided rule of its own");
  assert.match(workspace, /for \(const candidate of whatsAppMatches \?\? outsideHandBuiltFolders\) \{/);

  // ── THE DEFAULT QUEUE IS UNCHANGED ────────────────────────────────────────
  // With no seat picked, nothing here runs: the rail and the list still answer through
  // `vacanciesForCandidate`, and this module must not have moved that answer.
  assert.deepEqual(
    vacanciesForCandidate(
      { address: "Shebin El Kom, Menoufia", appliedForJobTitle: "Medical Representative" },
      [menoufia1, menoufia2],
    ),
    [menoufia1.id],
    "the existing attribution still reads the address for itself, exactly as before",
  );
  // …and the seat queue is a SUPERSET of it, never a replacement: a CV the old rule already claimed
  // is still claimed, and says so as the read it is.
  assert.equal(
    seatQueueMatch(
      { address: "Shebin El Kom, Menoufia", appliedForJobTitle: "Medical Representative" },
      menoufia1,
    )?.source,
    "read",
    "a CV the existing place reader already attributed keeps that attribution",
  );

  // ── AN EXPLICIT SEND OUTRANKS EVERY READ ──────────────────────────────────
  assert.equal(
    seatQueueMatch({ folderKey: "Menoufia 1", sentForVacancyId: menoufia1.id }, menoufia1)?.source,
    "sent",
    "a recruiter who already picked this seat has settled the question",
  );
}
