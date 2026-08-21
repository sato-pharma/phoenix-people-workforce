import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APPLIED_FOR_SOURCE_LABEL,
  APPLIED_FOR_SOURCE_SHORT,
  candidateAppliedFor,
  candidateRowAppliedFor,
  cleanJobTitle,
  freeAppliedForEvidence,
} from "../src/lib/recruitment/applied-for.ts";

/**
 * "Applying for" — the column that answered 2.7% of the time.
 *
 * Every string in this file is a VERBATIM production value, taken from the 555 candidates in
 * `ats_candidates` on 2026-08-21. That matters: the cleaner is a pile of regexes, and a regex tested
 * against invented input proves only that it matches what its author imagined. Each one below broke
 * something real.
 *
 * Measured waterfall over those 555 rows, each rung counting only what the ones above could not
 * answer — 15 → 211 → 229 → 234 → 432 → 437 → 438. After the cleaner rejects the values that name
 * no job at all (bare "cv", filenames, a maternity-leave request), 394 of 433 distinct-value rows
 * survive. The column was populated on 208 before this.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export async function runRecruitmentAppliedForTests() {
  // ── 1 · The ladder, in order ────────────────────────────────────────────────
  //
  // A human's typed value always wins. Then what the SENDER wrote — subject, then the messages they
  // typed with the CV — because the job someone wants is a statement of intent. The AI's reading
  // sits below those because it is DERIVED from them (see formatCoveringMessage), so preferring it
  // would be preferring a paraphrase to the original. The requisition is last: one row has one.
  assert.deepEqual(
    candidateAppliedFor({
      cvExtractionJobTitle: "Something Else Entirely",
      fullName: "X From(A B (a@b com)) Subject(District Manager)",
      sourceSubject: "Application for National Sales Manager",
      statedJobTitle: "Medical Representative",
    }),
    { evidence: "Medical Representative", source: "stated", text: "Medical Representative" },
    "a stored title always wins — a person entered it",
  );
  assert.deepEqual(
    candidateAppliedFor({
      cvExtractionJobTitle: "Something Else Entirely",
      sourceSubject: "Application for National Sales Manager",
    }),
    { evidence: "Application for National Sales Manager", source: "subject", text: "National Sales Manager" },
    "the subject line outranks the model's reading of that same subject line",
  );
  assert.deepEqual(
    candidateAppliedFor({ requisitionJobTitle: "Medical Representative" }),
    { evidence: "Medical Representative", source: "requisition", text: "Medical Representative" },
    "the vacancy answers when nothing the applicant wrote does",
  );

  // A WhatsApp caption is REGULARLY just the filename, with the role in the message above it. The
  // list is walked in order, so "Cv.pdf" is skipped and the next line answers — not the reverse.
  assert.deepEqual(
    candidateAppliedFor({ sourceMessages: ["Cv.pdf", "applying for medical rep"] }),
    { evidence: "applying for medical rep", source: "message", text: "medical rep" },
    "a filename caption must not block the message that names the role",
  );

  // A chat message must PROVE it names a job; a subject line need not. Caught on the live page:
  // of the seven rows the message rung answered on its first production run, four were "صباح الخير"
  // (good morning) and a home address — in the column that decides which manager gets the CV.
  for (const chatter of ["صباح الخير", "sheraton resisdent", "hello sir", "please find attached"]) {
    assert.equal(
      candidateAppliedFor({ sourceMessages: [chatter] }).text,
      null,
      `"${chatter}" is small talk, not a role`,
    );
  }
  assert.equal(
    candidateAppliedFor({ sourceMessages: ["مطلوب للتعيين: منسقة مكتب"] }).text,
    "مطلوب للتعيين: منسقة مكتب",
    "and an Arabic message that DOES name a role still answers",
  );
  // The same words in a SUBJECT line are kept, because a subject is written to say what the mail is
  // about. These five shorthand production subjects would all be lost to a job-word requirement.
  for (const shorthand of ["Cairo 2 DM", "M.r - Gharbia", "Mohamed Hassan D.M"]) {
    assert.equal(
      candidateAppliedFor({ sourceSubject: shorthand }).text,
      shorthand,
      `"${shorthand}" is a real answer in shorthand — a subject line is not held to the job-word test`,
    );
  }

  // ── 2 · Never invent a role ─────────────────────────────────────────────────
  //
  // A wrong job title routes a CV to the wrong hiring manager, which is worse than an empty cell.
  // These are the values that must stay empty, and every one is a real row.
  for (const nothing of [
    "cv",
    "Cv",
    "...",
    "Job applications",
    "Afroz cv",
    "Amr cv",
    "Hassan Alabd Hassan C.V.",
    "Cv for Siyabulela Knockpaal",
    "Fwd: Job Inquiry - Syed Mohamed Faizal",
    "Michael CV PDFF.pdf",
    "Default Resume.pdf",
    "blue professional modern CV resume (1).pdf",
    "Khaled_Gamal_Basuoniy_ATS_CV (1).pdf",
    "DOC-20260725-WA0080..pdf",
    "Re: Job offer from Sato Pharma",
    "Inquiry for Salesforce opportunities",
  ]) {
    assert.equal(cleanJobTitle(nothing), null, `"${nothing}" names no job — the cell must stay empty`);
  }

  // Not every message in the recruitment mailbox is somebody applying for work. Reading a role out
  // of one of these would put a fabricated job on a real person's record.
  for (const notAnApplication of [
    "طلب إجازة وضع - ساره سمير يعقوب حنا - إدارة الدعايا والمبيعات",
    "Re: طلب عرض سعر وتوضيح آلية التعاقد",
    "قيد موردين موازين",
    "Re: Interview Confirmation – Sato Pharma",
    "Certificate of Attendance - Pharmacy Promotion & OTC Campaign",
    "Medical Insurane & Life Protection Benefits 2025/2026",
  ]) {
    assert.equal(cleanJobTitle(notAnApplication), null, `"${notAnApplication}" is not an application`);
  }

  // The Arabic rejections are the reason \b is absent from those patterns. JS defines \b by
  // [A-Za-z0-9_], so an Arabic letter never sits on a word boundary and /\bطلب/ matches NOTHING —
  // which silently let the maternity-leave request through as a job title until it was measured.
  const appliedForSource = read("src/lib/recruitment/applied-for.ts");
  assert.doesNotMatch(
    appliedForSource,
    /\\b[؀-ۿ]/,
    "a \\b in front of an Arabic letter can never match — the pattern would be dead",
  );

  // ── 3 · Cleaning, on the strings that actually arrive ───────────────────────
  for (const [raw, expected] of [
    // The single most common subject in production — 22 rows — must survive verbatim.
    ["Personnel & Recruitment Specialist", "Personnel & Recruitment Specialist"],
    ["Application for Personnel & Recruitment Specialist", "Personnel & Recruitment Specialist"],
    ["APPLICATION FOR EMPLOYMENT AS NATIONAL SALES MANAGER", "NATIONAL SALES MANAGER"],
    ["Apply for the Post of National Sales Manager", "National Sales Manager"],
    ["Job vacancy : National Sales Manager", "National Sales Manager"],
    ["Fw: Job Offer from Sato Pharma – Regional Sales Manager", "Regional Sales Manager"],
    ["Fw: Job Offer – Office Coordinator at Sato Pharma", "Office Coordinator"],
    ["Accounts Payable Accountant – Sato Pharma", "Accounts Payable Accountant"],
    // Mathematical-bold letters, used for emphasis by ten senders. Without NFKC this is a DIFFERENT
    // string from "National Sales Manager" in every filter, export and count on the page.
    ["𝐍𝐚𝐭𝐢𝐨𝐧𝐚𝐥 𝐒𝐚𝐥𝐞𝐬 𝐌𝐚𝐧𝐚𝐠𝐞𝐫", "National Sales Manager"],
    ["𝐒𝐮𝐛𝐣𝐞𝐜𝐭: 𝐍𝐚𝐭𝐢𝐨𝐧𝐚𝐥 𝐒𝐚𝐥𝐞𝐬 𝐌𝐚𝐧𝐚𝐠𝐞𝐫", "National Sales Manager"],
    // A trailing "cv" comes off only when a job is still standing afterwards.
    ["Sales cv", "Sales"],
    ["Cv Accountant", "Accountant"],
    ["Cv for district manager job for upper Egypt", "district manager for upper Egypt"],
    // 25 rows state the role in Arabic and must come through untouched.
    ["محاسب مالي", "محاسب مالي"],
    // "HR" is the whole subject on 18 rows. A three-character floor would silently drop all of them.
    ["HR", "HR"],
    ["Apply to HR", "HR"],
    // Too long to be a title, but that shape is "<the role> – <the person>": take the first segment,
    // and only when it actually names a job.
    ["Application for Veterinary Product Manager – Dr. Alaa Hamdy Ibrahim | DVM | KSA Licensed", "Veterinary Product Manager"],
    // The trailing strip must stop at the role. It once ate its way to "…Seeking". The biography
    // around the role is now cut by the tightening pass in section 9 — but the ROLE is what has to
    // survive, and that is what this line has always been checking.
    ["Experienced Health Information Specialist Seeking Opportunities", "Health Information Specialist"],
  ] as const) {
    assert.equal(cleanJobTitle(raw), expected, `"${raw}" must clean to "${expected}"`);
  }

  // ── 4 · The salvage pass, and the line it must not cross ────────────────────
  //
  // A filename is rejected outright by the ordinary path — and yet three production rows have the
  // answer written across the middle of one. The salvage runs ONLY after the normal read returned
  // null, and only on a closed vocabulary, so it cannot promote somebody's name into the column.
  assert.equal(cleanJobTitle("Ramy_Asaad_District_Sales_Manager_CV.pdf"), "District Sales Manager");
  assert.equal(cleanJobTitle("Sameh_Hamdy_Senior_Accountant.pdf"), "Senior Accountant");
  assert.equal(
    cleanJobTitle(":: Bahaa Abd El Azim - CV :: HR-Recruitment Consultant / Talent Acquisition Consultant ::"),
    "Talent Acquisition Consultant",
  );
  // "Hamdy" is not in the qualifier vocabulary, which is the whole reason the row above reads
  // "Senior Accountant" and not "Hamdy Senior Accountant".
  assert.doesNotMatch(cleanJobTitle("Sameh_Hamdy_Senior_Accountant.pdf") ?? "", /Hamdy/);
  // And the salvage never overrides a clean read.
  assert.equal(cleanJobTitle("National Sales Manager"), "National Sales Manager");

  // ── 5 · The row-level resolver the UI calls ─────────────────────────────────
  //
  // listCandidates resolves the full ladder and stores the answer on the row; every other surface
  // (getCandidate, the manager's push list) has only the free evidence. Both must answer.
  const envelopeRow = {
    appliedForJobTitle: null,
    fullName: "file 754C From(Islam Mostafa (a@b com)) Subject(Apply for Hr)",
  };
  assert.deepEqual(
    candidateRowAppliedFor(envelopeRow),
    { evidence: "Apply for Hr", source: "subject", text: "Hr" },
    "a row the fuller loader never saw still reads the envelope rather than falling back to Not stated",
  );
  assert.equal(
    candidateRowAppliedFor({ ...envelopeRow, appliedFor: { evidence: "x", source: "cv", text: "Product Manager" } }).text,
    "Product Manager",
    "an answer the list already resolved wins — it is the only one that saw the CV extraction",
  );

  // The email subject and the WhatsApp messages come off the SAME sourceContext field and must not
  // be crossed: an email's shortLabel is its subject, a WhatsApp row's detailLines are messages.
  assert.deepEqual(
    freeAppliedForEvidence({
      fullName: "A B",
      sourceContext: { channel: "whatsapp", detailLines: ["Cv.pdf", "for the DSM vacancy"], shortLabel: "Cv.pdf" },
    }).sourceMessages,
    ["Cv.pdf", "for the DSM vacancy"],
    "a WhatsApp row contributes its messages, not a subject",
  );
  assert.equal(
    freeAppliedForEvidence({
      fullName: "A B",
      sourceContext: { channel: "whatsapp", detailLines: ["x"], shortLabel: "x" },
    }).sourceSubject,
    null,
    "and never a subject, because it has none",
  );

  // ── 6 · Every source can be named on screen ─────────────────────────────────
  //
  // A derived role must never read as a stated one. That guarantee is only as good as the labels:
  // a source with no entry renders `undefined` in the tooltip, which is how "shown as inferred"
  // quietly becomes "shown as nothing".
  for (const source of ["stated", "subject", "message", "cv", "requisition", "current"] as const) {
    assert.ok(APPLIED_FOR_SOURCE_LABEL[source], `${source} needs a tooltip label`);
    if (source !== "stated") {
      assert.ok(APPLIED_FOR_SOURCE_SHORT[source], `${source} needs a short label for the mobile card`);
      // The owner's rule: never truncate, never wrap. A mobile card label has no room to be a
      // sentence, so the short form is capped at something a phone can hold on one line.
      assert.ok(
        APPLIED_FOR_SOURCE_SHORT[source].length <= 28,
        `"${APPLIED_FOR_SOURCE_SHORT[source]}" is too long for a card label — it would wrap`,
      );
    }
  }

  // ── 7 · Nothing here writes ─────────────────────────────────────────────────
  //
  // This is a reading of evidence already on the record. The moment it starts writing derived job
  // titles back onto candidates, a cleaner bug stops being a display defect and becomes bad data.
  assert.doesNotMatch(
    appliedForSource,
    /\b(?:insert|update|upsert|delete)\b/i,
    "applied-for.ts must stay pure — it derives, it never persists",
  );

  // ── 8 · The data layer only pays for what it needs ──────────────────────────
  //
  // extracted_fields is a fat jsonb blob (1.1 MB across 370 production rows) and every round trip
  // from here crosses the Atlantic. Resolving the free evidence FIRST is what keeps the two extra
  // queries small — they run against the ~120 rows still unanswered, not all 555.
  const candidatesSource = read("src/lib/recruitment/candidates.ts");
  assert.match(
    candidatesSource,
    /const unresolved = candidates\.filter\(\(candidate\) => !candidate\.appliedFor\?\.text\);/,
    "the CV-extraction and requisition loaders must run only for candidates the free evidence could not answer",
  );
  assert.match(
    candidatesSource,
    /loadCvJobTitlesByCandidate\(unresolvedIds\)/,
    "and be given that narrowed id list, not the whole pool",
  );
  // Both CV fields come off the same jsonb blob, so they must cost ONE query, not two.
  assert.equal(
    candidatesSource.match(/\.from\("ats_candidate_cv_extractions"\)/g)?.length,
    1,
    "appliedForJobTitle and currentJobTitle must be read in a single pass over extracted_fields",
  );

  // ── 9 · The tightening pass, and the line it must not cross ─────────────────
  //
  // With the ladder live, production answered 396 of 555 — and 24 of those answers still read as a
  // sentence rather than a job, because the sender's name, their CV filename and their years of
  // experience were sitting in the middle of the subject line.
  //
  // Every pair below is a verbatim production subject from 2026-08-21 and the answer it must now
  // give. These 23 are the COMPLETE impact: the same corpus of 226 distinct live subjects was run
  // through the cleaner before and after the pass, and nothing outside this list moved.
  const tightened: Array<[string, string]> = [
    ["Application NSM sales", "NSM sales"],
    ["Application for Accounting Position – Mostafa El Hogoraty", "Accounting"],
    ["Application for Office Coordinator Position – Sabreen Mahmoud", "Office Coordinator"],
    ["Application for Office Coordinator – Hana Essam Abdelbary", "Office Coordinator"],
    ["District Manager for Upper Egypt 2", "District Manager for Upper Egypt"],
    // An underscore is a word character, so there is no \b between "Resume" and "_National" and the
    // marker rule missed this row entirely on the first production run — the sender's name stayed in
    // the column. The marker now ends on (?![A-Za-z]).
    ["Fwd: Shashi Gupta _ Resume_National Sales Manager", "National Sales Manager"],
    ["District manager application Alex & Beheira", "District manager Alex & Beheira"],
    ["District manger upper Egypt resident Assuit", "District manger upper Egypt"],
    ["Experienced Health Information Specialist Seeking Opportunities", "Health Information Specialist"],
    ["M Aamir khan Resume for the post of National sales Manager", "National sales Manager"],
    ["Medical Representative - Mahalla - fresh graduate", "Medical Representative - Mahalla"],
    ["Medical representative vacancy.( Beni suef)", "Medical representative (Beni suef)"],
    ["Michael'Cv National sales manager", "National sales manager"],
    ["My c.v / District manager upperegypt", "District manager upperegypt"],
    ["National Sales Manager (Shokry Ammar)", "National Sales Manager"],
    ["National sales Manager -  Tamer Abdallah CV", "National sales Manager"],
    ["National sales Manager- 15 yrs of exp in UAE in all the channels.", "National sales Manager"],
    ["Osama mohammed cv District manager upper Egypt", "District manager upper Egypt"],
    ["Product manager vacancy ,Heba Magdy", "Product manager"],
    ["RWAN-SAFAA-Application for medical representative position-Minya", "medical representative Minya"],
    ["Re: R&D Internship Request (August–October 2026) – Sato Pharma", "R&D Internship"],
    ["Senior medical rep menofia 1", "Senior medical rep menofia"],
    ["Shaimaa mostafa cv as district manager upper Egypt 2", "district manager upper Egypt"],
    ["Summer internship application - Lydia Magdy Fahmy", "Summer internship"],
  ];
  for (const [raw, expected] of tightened) {
    assert.equal(cleanJobTitle(raw), expected, `"${raw}" should tighten to "${expected}"`);
  }

  // The other half of the same rule, and the more important half: a place, a line name, a country,
  // a qualification and a second role are NOT noise, and 10 of the 24 long answers are made only of
  // those. Each of these broke a draft of the pass — an earlier trailing-name rule read "Qena
  // Luxor", "Upper Egypt" and "Kafr Elsheikh" as people and deleted three governorates, and ate
  // "Infective Line" out of the middle of "Anti-Infective". A kept name is a blemish; a deleted
  // territory is a wrong answer, so where the two conflict the pass does nothing.
  const mustKeepEveryWord: Array<[string, string]> = [
    ["Application for National Sales Manager – Anti-Infective Line", "National Sales Manager – Anti-Infective Line"],
    ["Application – National Sales Manager | Anti-Infective Line", "National Sales Manager | Anti-Infective Line"],
    ["Medical Representative-Kafr Elsheikh", "Medical Representative-Kafr Elsheikh"],
    ["District sales manager sohage Qena Luxor", "District sales manager sohage Qena Luxor"],
    ["District manager for Upper Egypt", "District manager for Upper Egypt"],
    ["Senior Medical Sales Representative (Nigeria)", "Senior Medical Sales Representative (Nigeria)"],
    ["Application for Personnel & Recruitment Specialist", "Personnel & Recruitment Specialist"],
    ["Personnel & Recruitment Specialist HR Generalist", "Personnel & Recruitment Specialist HR Generalist"],
    ["Recruitment&Personnel Specialist", "Recruitment&Personnel Specialist"],
    ["Business Development & Sales Manager", "Business Development & Sales Manager"],
    ["Interest in Medical Coding Specialist Opportunities", "Medical Coding Specialist Opportunities"],
    ["Finance Manager Mohamed Hamed", "Finance Manager Mohamed Hamed"],
    [
      "Request for the post of Procurement executive/Store logistic supervisor Supply chain executive,",
      "Procurement executive/Store logistic supervisor Supply chain executive",
    ],
  ];
  for (const [raw, expected] of mustKeepEveryWord) {
    assert.equal(cleanJobTitle(raw), expected, `"${raw}" must keep every real word — it has no noise in it`);
  }

  // The two invariants that make the pass safe to run last: it may shorten an answer, but it can
  // never delete one and never lengthen one. Measured across all 226 live subjects: 23 changed,
  // 0 newly empty.
  for (const [raw] of [...tightened, ...mustKeepEveryWord]) {
    const text = cleanJobTitle(raw);
    assert.ok(text, `tightening must never blank an answer — "${raw}" resolved before it ran`);
    assert.ok(text.length <= raw.length, `tightening must never lengthen an answer — "${raw}"`);
  }

  // ── 10 · The role they hold now, when they never said what they want ────────
  //
  // 117 of the 555 attached a CV and wrote no covering text of ANY kind — no subject worth reading,
  // no caption, nothing the model could find a wanted-role in. For those the choice is not "their
  // goal or their current role", it is "their current role or an empty cell", and 71 have one.
  //
  // It goes LAST, below even the requisition, and it is a different KIND of fact from every rung
  // above it. That is the whole risk: a recruiter must never read "the job he has" as "the job he
  // asked for". The guarantee is the label, so the label is what gets tested.
  assert.deepEqual(
    candidateAppliedFor({ cvCurrentJobTitle: "Medical Representative" }),
    { evidence: "Medical Representative", source: "current", text: "Medical Representative" },
    "the role they hold now fills a cell that would otherwise be empty",
  );
  assert.equal(
    candidateAppliedFor({ cvCurrentJobTitle: "Community Pharmacist", requisitionJobTitle: "Medical Representative" })
      .source,
    "requisition",
    "but it never outranks a real application — every other rung says what they WANT",
  );
  assert.match(
    APPLIED_FOR_SOURCE_LABEL.current,
    /did not say/i,
    "the tooltip must say outright that they never stated a role, or the column tells a lie",
  );
  assert.notEqual(
    APPLIED_FOR_SOURCE_SHORT.current,
    APPLIED_FOR_SOURCE_SHORT.cv,
    "and it must not read the same as the CV rung, which IS a wanted-role the model found",
  );

  // Structured extractions are not envelopes and must not be tightened. "District Manager -
  // Commercial Unit" is a business unit, not a person; the pass read it as a name and deleted it.
  for (const value of [
    "District Manager - Commercial Unit",
    "HR | Administration | Operations Manager",
    "Accounting Manager & Financial Review - Temporary Assignment",
  ]) {
    assert.equal(
      candidateAppliedFor({ cvCurrentJobTitle: value }).text,
      value,
      `a structured CV field is already clean — "${value}" must come through whole`,
    );
  }
  // The same protection on the envelope path, where tightening DOES run: a tail that names a job is
  // not a person, however much it looks like two capitalised words after a separator.
  assert.equal(
    cleanJobTitle("HR | Administration | Operations Manager"),
    "HR | Administration | Operations Manager",
    "the trailing-name rule must never eat a tail that names a job — this once became \"HR | Administration\"",
  );
  // And the prefix that "CV for …" leaves stranded, which read as a sentence on production.
  assert.equal(
    cleanJobTitle("CV for the position of National Sales Manager- Sato Pharma"),
    "National Sales Manager",
    "\"CV for \" comes off as a prefix, which used to leave \"the position of\" standing in the cell",
  );
}
