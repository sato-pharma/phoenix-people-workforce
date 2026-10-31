import assert from "node:assert/strict";

import { candidateRegionCodes, candidateRegionLabels } from "../src/lib/recruitment/candidate-region.ts";
import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import { builtInQuestionAppliesToRole } from "../src/lib/recruitment/inbound/whatsapp-question-audience.ts";
import {
  AREA_OTHER_MAX,
  areaMenu,
  areaOtherPromptText,
  BACKGROUND_OTHER_MAX,
  backgroundMenu,
  backgroundOtherPromptText,
  backgroundOtherTooLongText,
  candidateBackgroundCodes,
  candidateBackgroundLabels,
  candidateExperienceCodes,
  candidateExperienceLabels,
  classifyRowId,
  classifyThankYouText,
  classifySessionSteps,
  cleanTypedAnswer,
  cleanTypedJobTitle,
  EXPECTED_SALARY_MAX,
  experienceMenu,
  isOfferedBackground,
  isOfferedExperience,
  jobTitleMenu,
  jobTitleMenuAllFamilies,
  jobTitleOtherPromptText,
  jobTitleOtherTooLongText,
  JOB_TITLE_OTHER_MAX,
  menuViolations,
  parseDeclaredSalaryFigure,
  offeredRoleMenuFamilies,
  OTHER_ROW_VALUE,
  parseClassifyRowId,
  REGION_OTHER_MAX,
  regionMenu,
  regionOtherPromptText,
  salaryPromptText,
  salaryTooLongText,
  typedAnswerTooLongText,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_TITLE_MAX,
} from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import {
  areaPlaceHint,
  areaPlaceHints,
  regionPlaceHint,
  regionPlaceHints,
} from "../src/lib/recruitment/inbound/whatsapp-classify-place-hints.ts";
import { parseWhatsAppWebhookPayload } from "../src/lib/recruitment/inbound/whatsapp-payload-parser.ts";

// The active area names, verbatim from au.canonical_areas in production on 2026-08-28. Held here as
// a fixture so the limit assertions below run without a database: they are checking that the MENU
// BUILDER copes with the real names, which is where the 24-character trap actually bites.
const PRODUCTION_AREAS: Record<string, string[]> = {
  AB: ["Alex East", "Alex Center", "Alex West", "Behira 1", "Behira 2"],
  CA: ["Heliopolis", "Nasr City", "Cairo East 1", "Cairo East 2", "Down town", "Cairo West"],
  D1: ["Qalubeya", "Menoufia 1", "Menoufia 2", "Gharbia 1 (Tanta)", "Gharbia 2 (Mahalla)", "Kafr El-Sheikh 1", "Kafr El-Sheikh 2"],
  D2: ["Dakahlia 1", "Dakahlia 2", "Dakahlia 3", "Sharkia 1", "Sharkia 2", "Port said - Domiat"],
  GZ: [
    "Giza - Giza Centers",
    "Dokki - Mohandseen - Bolak",
    "Imbaba - Imbaba Centers",
    "Haram - Faisal",
    "Helwan-Maadi",
    "Fayoum",
    "October -Zayed",
    "Beni Suef",
  ],
  OT: ["North Sinai", "Suez", "New Valley", "Hurgada", "Luxor", "Aswan", "Red Sea", "Ismailia", "South Sinai"],
  UE: ["Minia 1", "Minia 2", "Assuit 1", "Assuit 2", "Sohag1", "Sohag2", "Qena 1", "Qena 2"],
};

function interactivePayload(interactive: Record<string, unknown>) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [{ from: "201001234567", id: "wamid.REPLY1", interactive, type: "interactive" }],
              metadata: { display_phone_number: "201098500699", phone_number_id: "PNID1" },
            },
          },
        ],
      },
    ],
  };
}

export function runWhatsAppSelfClassificationTests() {
  // --- THE SALARY COLUMN REGRESSION. `ats_candidates.expected_salary` is NUMERIC and the WhatsApp
  // --- flow writes what the applicant typed. Until 2026-09-02 it aimed the verbatim text straight
  // --- at that column, so every answer that was not a bare number failed the cast — 31 of the 42
  // --- answered in production — and because all six answers ride in ONE update, the rejected cast
  // --- threw away that applicant's experience band, region, background and area with it.
  // ---
  // --- These are real production answers. Every one of them must resolve to null here, because a
  // --- null is what keeps the verbatim column the only place the answer is kept and stops the
  // --- numeric column from ever seeing a string again.
  for (const notAFigure of [
    "Negotiable",
    "negotiable",
    "15k",
    "30 K",
    "25 k to 30 k",
    "15000-20000",
    "20000:27000",
    "28 to 35",
    "30,000 EGP",
    "10,000EGP",
    "28000-35000 L.E",
    "13,000 start up مع العمولات",
    "13000:17000 negotiable",
    "",
    "   ",
  ]) {
    assert.equal(
      parseDeclaredSalaryFigure(notAFigure),
      null,
      `"${notAFigure}" is not a bare figure and must never reach the numeric column`,
    );
  }
  assert.equal(parseDeclaredSalaryFigure(null), null);
  assert.equal(parseDeclaredSalaryFigure(undefined), null);

  // --- A bare figure still fills the numeric column, so the workspace's salary cell and the merge
  // --- borrow list keep working exactly as they did. Commas are the one tolerated flourish: they
  // --- are the same number written another way, and Postgres would have rejected "25,000" too.
  assert.equal(parseDeclaredSalaryFigure("12000"), 12000);
  assert.equal(parseDeclaredSalaryFigure(" 12000 "), 12000);
  assert.equal(parseDeclaredSalaryFigure("25,000"), 25000);
  assert.equal(parseDeclaredSalaryFigure("12500.5"), 12500.5);

  // ── The menus must satisfy Meta's limits, or the message is a 400 and the flow dies silently ──

  assert.deepEqual(menuViolations(jobTitleMenu()), [], "the role menu must satisfy every Cloud API limit");
  assert.deepEqual(menuViolations(backgroundMenu()), [], "the background menu must satisfy every Cloud API limit");
  assert.deepEqual(menuViolations(regionMenu()), [], "the region menu must satisfy every Cloud API limit");
  assert.deepEqual(menuViolations(experienceMenu()), [], "the experience menu must satisfy every Cloud API limit");

  for (const [regionCode, areas] of Object.entries(PRODUCTION_AREAS)) {
    const menu = areaMenu(regionCode as (typeof candidateRegionCodes)[number], areas);
    assert.deepEqual(menuViolations(menu), [], `the ${regionCode} area menu must satisfy every Cloud API limit`);
    assert.equal(
      menu.rows.length,
      areas.length + 1,
      `every active ${regionCode} area must be offered, plus the not-listed escape — none silently dropped`,
    );
  }

  // Every region fits the cap WITH the escape row taking one of the ten. Others is the largest at
  // 9, which is now exactly full. This is the assertion that catches an org change adding a tenth
  // area: without it `areaMenu` would slice that area away silently and no candidate could ever
  // choose the territory. It reads MAX - 1 on purpose — the escape is not optional.
  for (const [regionCode, areas] of Object.entries(PRODUCTION_AREAS)) {
    assert.ok(
      areas.length <= WHATSAPP_LIST_MAX_ROWS - 1,
      `${regionCode} has ${areas.length} areas, which no longer fits WhatsApp's ${WHATSAPP_LIST_MAX_ROWS}-row list beside the not-listed row`,
    );
  }

  // ── The one name that does not fit is shortened, not truncated ────────────────────────────────

  const gizaMenu = areaMenu("GZ", PRODUCTION_AREAS.GZ);
  const dokki = gizaMenu.rows.find((row) => row.id === classifyRowId("area", "Dokki - Mohandseen - Bolak"));
  assert.ok(dokki, "the Dokki area must still be offered");
  assert.ok(dokki.title.length <= WHATSAPP_ROW_TITLE_MAX, "the shortened Dokki title must fit the row limit");
  assert.ok(!dokki.title.includes("…") && !dokki.title.includes("..."), "a title must never be cut with an ellipsis");
  // UPDATED 2026-08-28 with the place hints. This pin used to read `=== "Dokki - Mohandseen - Bolak"`,
  // i.e. the full name ALONE. The hint now shares the line, and the assertion is deliberately still
  // an exact string: what has to be protected is that adding the hint did not evict the full name,
  // which is the only place the shortened title's real words survive.
  assert.ok(
    dokki.description?.startsWith("Dokki - Mohandseen - Bolak"),
    "the full area name must still LEAD the description line, ahead of any hint",
  );
  assert.equal(
    dokki.description,
    "Dokki - Mohandseen - Bolak (Bolak El Dakrour · Nahia · Ard El Lewa)",
    "the shortened row must carry the full name and its hint together",
  );

  // A name that already fits does not repeat itself — the same words twice reads as a bug — so its
  // description line is the HINT alone. (Before the hints existed this asserted `undefined`.)
  const fayoum = gizaMenu.rows.find((row) => row.id === classifyRowId("area", "Fayoum"));
  assert.ok(fayoum, "Fayoum must be offered");
  assert.equal(
    fayoum.description,
    "(Fayoum City · Ibshaway · Etsa)",
    "a title that already fits gives its whole description line to the bracketed place hint",
  );
  // A hint must EARN its line: it has to name at least one place the row’s own title does not
  // already say. Two of the 49 are genuinely one-brick areas whose single brick IS the city the
  // area is named after, so for those the measured truth is a line that repeats the name; they are
  // listed by name below so the next reader can see that is a measurement and not an oversight.
  //
  // This replaced a narrower pin, `!fayoum.description.includes("Fayoum")`, which held only while
  // the hints were ARABIC and therefore could never echo a Latin title. With the hints in English
  // (owner, 2026-10-04) Fayoum’s biggest brick really is "Fayoum City", and the old assertion
  // fired on correct data. The exact-string check above still pins Fayoum’s whole line.
  const ONE_BRICK_AREAS = new Set(["Suez", "Hurgada"]);
  for (const [name, hint] of Object.entries(areaPlaceHints)) {
    const places = hint.split("·").map((place) => place.trim()).filter(Boolean);
    assert.ok(places.length > 0, `area "${name}" has an empty place hint`);
    if (ONE_BRICK_AREAS.has(name)) continue;
    assert.ok(
      places.some((place) => !place.toLowerCase().includes(name.toLowerCase())),
      `area "${name}" must name at least one place its own title does not — its hint is "${hint}"`,
    );
  }

  // ── The region menu must not offer a dead end ─────────────────────────────────────────────────
  // au.regions also holds UE-1 and UE-2, which have ZERO active areas. Offering either would walk
  // the applicant to question 3 and present an empty list.
  const regionIds = regionMenu().rows.map((row) => row.id);
  assert.ok(!regionIds.includes(classifyRowId("region", "UE-1")), "UE-1 has no areas and must never be offered");
  assert.ok(!regionIds.includes(classifyRowId("region", "UE-2")), "UE-2 has no areas and must never be offered");
  assert.equal(
    regionMenu().rows.length,
    candidateRegionCodes.length + 1,
    "every region, plus the not-listed escape",
  );

  // THIS ASSERTION WAS INVERTED ON 2026-08-28, deliberately. It used to require that every offered
  // region already had areas — "region X is offered but has no areas to follow it with" — which was
  // the right rule while question 3 could only be answered by tapping. It is the wrong rule now,
  // and keeping it would have blocked the very fix the owner asked for.
  //
  // Delta (3) is the case. It went live in au.regions carrying target, with ZERO rows in
  // au.canonical_areas, on the same day the owner opened a District Manager seat in it — so the old
  // rule said do not offer D3, and the applicant for that seat could not name their own region at
  // all. What makes offering it safe is the typed escape: a region with no areas now asks the
  // applicant to type the area instead of dead-ending them.
  //
  // So the invariant is no longer "every region has areas". It is "every region has SOMETHING to
  // follow it with" — either a real area list, or the escape. The escape is what is pinned here,
  // because it is now the thing load-bearing for D3.
  const regionRows = regionMenu().rows;
  const escapeRow = regionRows[regionRows.length - 1];
  assert.equal(escapeRow.id, classifyRowId("region", OTHER_ROW_VALUE), "the escape must be the LAST region row");

  // ── The place hints — the second line that makes a region row answerable ──────────────────────
  // Owner's instruction 2026-08-28: "Delta (1)" means nothing to an applicant, so each region and
  // area row names the biggest places inside it. These assertions exist because a WRONG hint is
  // worse than none: it actively routes someone to a district that will never call them.

  // Every region we offer must explain itself. A new region appearing with no hint is exactly the
  // bug the owner reported — an unlabelled "Delta (N)" that an applicant has to guess at. If a
  // future region genuinely cannot be described yet, that is a deliberate decision and belongs
  // here as an exception, not as a silent omission.
  for (const code of candidateRegionCodes) {
    const hint = regionPlaceHint(code);
    assert.ok(hint, `region ${code} ("${candidateRegionLabels[code]}") has no place hint — an applicant cannot answer it`);
    assert.ok(!hint.includes("…") && !hint.includes("..."), `the ${code} hint must never be cut with an ellipsis`);
  }

  // The hint reaches the row, and the escape row carries none — there is no place inside "not listed".
  for (const row of regionRows) {
    const parsed = parseClassifyRowId(row.id);
    if (parsed?.value === OTHER_ROW_VALUE) {
      assert.equal(row.description, undefined, "the not-listed escape has no places to name");
      continue;
    }
    assert.equal(
      row.description,
      `(${regionPlaceHint(parsed?.value ?? "")})`,
      `the ${parsed?.value} row must carry its hint, in brackets`,
    );
  }

  // ── The hints follow the RECRUITMENT map, and #2509 moved four governorates ───────────────────
  // Qalyubia, Sharqia, Suez and Ismailia became Delta (3) in `governorateRegions`. If a hint still
  // named them under their old region, an applicant from Qalyubia would tap Delta (1) and be filed
  // where the Delta (3) recruiter is not looking — which is the precise failure #2509 set out to
  // fix. This is the pin that catches the next such move being made in only one of the two files.
  assert.ok(regionPlaceHints.D3?.includes("Qalyubia"), "Delta (3) must name Qalyubia — it is its biggest governorate");
  assert.ok(regionPlaceHints.D3?.includes("Sharqia"), "Delta (3) must name Sharqia");
  assert.ok(regionPlaceHints.D3?.includes("Ismailia"), "Delta (3) must name Ismailia");
  assert.ok(regionPlaceHints.D3?.includes("Suez"), "Delta (3) must name Suez — all four fit, so none is dropped");
  assert.ok(!regionPlaceHints.D1?.includes("Qalyubia"), "Qalyubia left Delta (1) in #2509 — its hint must not still claim it");
  assert.ok(!regionPlaceHints.D2?.includes("Sharqia"), "Sharqia left Delta (2) in #2509 — its hint must not still claim it");
  assert.ok(!regionPlaceHints.OT?.includes("Ismailia"), "Ismailia left Others in #2509");
  assert.ok(!regionPlaceHints.OT?.includes("Suez"), "Suez left Others in #2509");

  // Every active area explains itself too, and the hint reaches the row.
  for (const [regionCode, areas] of Object.entries(PRODUCTION_AREAS)) {
    const menu = areaMenu(regionCode as (typeof candidateRegionCodes)[number], areas);
    for (const name of areas) {
      const hint = areaPlaceHint(name);
      assert.ok(hint, `area "${name}" (${regionCode}) has no place hint`);
      assert.ok(!hint.includes("…") && !hint.includes("..."), `the "${name}" hint must never be cut with an ellipsis`);
      const row = menu.rows.find((candidate) => candidate.id === classifyRowId("area", name));
      assert.ok(row?.description?.includes(`(${hint})`), `the "${name}" row must carry its hint, in brackets`);
      assert.ok(!row?.description?.includes("…"), `the "${name}" description must never be cut with an ellipsis`);
    }
  }

  // An unknown name is null, never a throw and never a wrong neighbour's hint. A renamed area
  // silently showing some other area's towns is the one failure mode worse than showing nothing.
  assert.equal(areaPlaceHint("An Area That Does Not Exist"), null, "an unknown area must return null");
  assert.equal(regionPlaceHint("ZZ"), null, "an unknown region must return null");
  assert.equal(Object.keys(areaPlaceHints).length, 49, "all 49 active areas carry a hint");
  assert.ok(
    (candidateRegionCodes as readonly string[]).includes("D3"),
    "Delta (3) is live and carries target in au.regions — an applicant must be able to choose it",
  );
  assert.equal(
    PRODUCTION_AREAS.D3,
    undefined,
    "D3 genuinely has no areas — this records WHY the old every-region-has-areas rule had to go",
  );
  for (const code of candidateRegionCodes) {
    const areas = PRODUCTION_AREAS[code];
    const hasAreas = Array.isArray(areas) && areas.length > 0;
    assert.ok(
      hasAreas || escapeRow !== undefined,
      `region ${candidateRegionLabels[code]} has no areas and no escape to follow it with`,
    );
  }

  // ── The exhaustive-Record backstop ──────────────────────────────────────────────
  // `candidateRegionLabels` is a Record over the region union, and next.config sets
  // ignoreBuildErrors, so a region added to the union without a label COMPILES, BUILDS and DEPLOYS
  // and renders as undefined. That is exactly the 2026-08-24 failure that put NaN sort keys into
  // the screening queue. Adding D3 is precisely such an edit, so it gets the runtime assertion the
  // rule calls for: walk the union, prove every key resolves to real text.
  for (const code of candidateRegionCodes) {
    const label = candidateRegionLabels[code];
    assert.equal(typeof label, "string", `region ${code} has no label — an exhaustive Record lost a key`);
    assert.ok(label.length > 0 && !label.includes("undefined"), `region ${code} label is not human-readable: ${label}`);
  }
  assert.equal(
    Object.keys(candidateRegionLabels).length,
    candidateRegionCodes.length,
    "the label Record must hold exactly the offered regions — no orphan key, no missing one",
  );

  // ── The typed escape on questions 2 and 3 ───────────────────────────────────

  for (const [regionCode, areas] of Object.entries(PRODUCTION_AREAS)) {
    const rows = areaMenu(regionCode as (typeof candidateRegionCodes)[number], areas).rows;
    assert.equal(
      rows[rows.length - 1].id,
      classifyRowId("area", OTHER_ROW_VALUE),
      `the ${regionCode} area menu must end with the not-listed escape`,
    );
  }

  // The escape is NOT a region code and must keep failing the vocabulary guard — every branch has
  // to handle it explicitly before validating, or a tap on it reads as an unknown value and the
  // applicant's answer is dropped in silence.
  assert.ok(
    !(candidateRegionCodes as readonly string[]).includes(OTHER_ROW_VALUE),
    "the escape value must never become a real region code",
  );

  // Wording: Others is already a real selling region (OT). Two rows reading Other and Others would
  // be a coin flip for the applicant, so the escape says not listed instead.
  assert.ok(escapeRow.title.includes("not listed"), "the region escape must not be worded as a second Others");
  assert.notEqual(escapeRow.title, candidateRegionLabels.OT, "the escape must not duplicate the Others label");

  // Both new prompts obey the owner's no-ellipsis rule.
  for (const prompt of [regionOtherPromptText(), areaOtherPromptText()]) {
    assert.ok(!prompt.includes("…") && !prompt.includes("..."), "a prompt must never trail off with an ellipsis");
    assert.ok(prompt.length > 0);
  }
  assert.ok(typedAnswerTooLongText("region", REGION_OTHER_MAX).includes(String(REGION_OTHER_MAX)), "the nudge names its limit");
  assert.ok(typedAnswerTooLongText("area", AREA_OTHER_MAX).includes(String(AREA_OTHER_MAX)), "the nudge names its limit");

  // The shared cleaner: same contract as the job-title one, at whatever limit it is handed.
  assert.equal(cleanTypedAnswer("  Delta   (3)  ", REGION_OTHER_MAX), "Delta (3)", "whitespace is collapsed and trimmed");
  assert.equal(cleanTypedAnswer("", REGION_OTHER_MAX), null, "an empty answer is unusable, not an empty string");
  assert.equal(cleanTypedAnswer("   ", REGION_OTHER_MAX), null);
  assert.equal(cleanTypedAnswer(null, REGION_OTHER_MAX), null);
  assert.equal(cleanTypedAnswer("x".repeat(REGION_OTHER_MAX), REGION_OTHER_MAX)?.length, REGION_OTHER_MAX, "exactly at the limit is fine");
  assert.equal(cleanTypedAnswer("x".repeat(REGION_OTHER_MAX + 1), REGION_OTHER_MAX), null, "one over the limit is refused");
  assert.equal(
    cleanTypedJobTitle("Regulatory Affairs Specialist"),
    "Regulatory Affairs Specialist",
    "the job-title cleaner still delegates correctly",
  );


  // ── The role menu offers the OWNER'S list, not every family ───────────────────────────────────
  // This assertion used to read `roleMenu.rows.length === candidateRoleFamilies.length` — "every
  // role family must be offered". That was correct until 2026-08-28, when the owner named the exact
  // eight roles an applicant should see. Keeping it would have pinned the behaviour the change
  // exists to replace, so it is inverted deliberately: the menu is a QUESTION PUT TO A PERSON, and
  // the family list is an internal vocabulary that is allowed to be larger.
  //
  // Office Coordinator was added 2026-09-02 for the Sheraton opening, taking the list to nine. It is
  // ON the menu — unlike sales and pharmacist below — because the extra screening questions are now
  // scoped BY family: a role nobody can tap is a role no scoped question can ever reach, and a title
  // typed under "Other" is spelled a different way by every applicant, which is what puts the same
  // seat on several CV shelves. Adding a row here is what makes both work.

  const roleMenu = jobTitleMenu();
  assert.deepEqual(
    roleMenu.rows.map((row) => row.id),
    [
      "medical_rep",
      "district_manager",
      "area_regional_manager",
      "product_manager",
      "national_sales_manager",
      "hr_section_head",
      "talent_acquisition",
      "office_coordinator",
      "personnel",
      "other",
    ].map((family) => classifyRowId("job_title", family)),
    "the role menu must offer exactly the owner's ten roles, in his order (eight stated 2026-08-28, Office Coordinator added 2026-09-02, Talent Acquisition added 2026-09-22, HR Section Head added 2026-10-06 in the slot Finance held, the Human Resources row removed 2026-10-06 at his instruction, and Personnel Specialist added 2026-10-31 in the last free slot)",
  );
  assert.ok(
    !roleMenu.rows.some((row) => row.id === classifyRowId("job_title", "human_resources")),
    'the "Human Resources" choice was removed from the bot on 2026-10-06 at the owner\'s instruction — do not restore it',
  );
  assert.ok(
    jobTitleMenuAllFamilies().rows.some((row) => row.id === classifyRowId("job_title", "human_resources")),
    "human_resources stays in the pool, so the Screening Questions screen can switch the answer back on and an old tapped row still resolves",
  );
  assert.ok(
    !roleMenu.rows.some((row) => row.id === classifyRowId("job_title", "finance")),
    "finance was displaced from the menu by hr_section_head on 2026-10-06 — an applicant types it under Other",
  );
  assert.ok(
    jobTitleMenuAllFamilies().rows.some((row) => row.id === classifyRowId("job_title", "finance")),
    "finance stays in the pool, so the Screening Questions screen can switch the Finance answer back on",
  );
  for (const family of offeredRoleMenuFamilies) {
    assert.ok(
      (candidateRoleFamilies as readonly string[]).includes(family),
      `offered role ${family} must be a real family, or a tapped answer lands outside the pool filter`,
    );
  }
  // Not offered, and that is the point — someone applying for either types it under "Other".
  for (const absent of ["sales", "pharmacist"] as const) {
    assert.ok(
      !roleMenu.rows.some((row) => row.id === classifyRowId("job_title", absent)),
      `${absent} is deliberately not on the menu — do not "restore" it`,
    );
  }
  assert.equal(
    roleMenu.rows[roleMenu.rows.length - 1].id,
    classifyRowId("job_title", "other"),
    '"Other" must be last — offering it early invites it',
  );

  // The applicant-facing wording the owner asked for, which differs from the pool's own labels.
  const roleTitleById = new Map(roleMenu.rows.map((row) => [row.id, row.title]));
  assert.equal(
    roleTitleById.get(classifyRowId("job_title", "area_regional_manager")),
    "Regional Manager",
    "the applicant is asked for Regional Manager, not the pool's longer label",
  );
  assert.equal(roleTitleById.get(classifyRowId("job_title", "hr_section_head")), "HR Section Head");
  assert.equal(
    jobTitleMenuAllFamilies().rows.find((row) => row.id === classifyRowId("job_title", "finance"))?.title,
    "Finance",
    "the applicant-facing word for Finance is kept for the day it is switched back on",
  );
  assert.equal(roleTitleById.get(classifyRowId("job_title", "national_sales_manager")), "National Sales Manager");

  // ── Question 2 — graduation background (owner's instruction 2026-08-30) ────────────────────────
  // Asked to everyone, right after the role. Four rows: the three degrees a field applicant holds,
  // then "Other" last, which opens a typed follow-up exactly like the role question's "Other".
  const bgMenu = backgroundMenu();
  assert.equal(bgMenu.step, "background", "the background menu must carry its own step");
  assert.deepEqual(
    bgMenu.rows.map((row) => row.id),
    ["pharmacy", "science", "vet", "medicine", "dentistry", OTHER_ROW_VALUE].map((value) =>
      classifyRowId("background", value),
    ),
    "the background menu offers Pharmacy, Science, Veterinary, Medicine, Dentistry, then Other last",
  );
  const bgTitleById = new Map(bgMenu.rows.map((row) => [row.id, row.title]));
  assert.equal(bgTitleById.get(classifyRowId("background", "vet")), "Veterinary", "the applicant reads Veterinary, not the shorthand");
  assert.equal(
    bgMenu.rows[bgMenu.rows.length - 1].id,
    classifyRowId("background", OTHER_ROW_VALUE),
    '"Other" must be last on the background menu too — offering it early invites it',
  );

  // The guard rejects the "Other" escape (its branch is handled explicitly) and any stale value, and
  // accepts exactly the real codes.
  //
  // The rejected example was "dentistry" until 2026-08-31, when the owner made medicine and dentistry
  // offered answers. That assertion PINNED THE ANTI-PATTERN: it passed only for as long as a fully
  // eligible graduate had no row to tap, so widening the menu turned it red — which is the check
  // working, not a regression. "Commerce" replaces it because it is genuinely off-menu and is the
  // real typed answer production holds, so this keeps proving a stale value is refused.
  assert.ok(!isOfferedBackground(OTHER_ROW_VALUE), "the background escape must never pass the vocabulary guard");
  assert.ok(!isOfferedBackground("commerce"), "a value we do not offer is rejected");
  for (const code of candidateBackgroundCodes) {
    assert.ok(isOfferedBackground(code), `${code} is an offered background`);
  }
  // The two the owner added by name, asserted individually: a loop over the union would pass even if
  // both were dropped from it again, and this is the pair he asked for in words.
  for (const added of ["medicine", "dentistry"]) {
    assert.ok(isOfferedBackground(added), `${added} is an offered background — owner's instruction 2026-08-31`);
  }

  // The row ids round-trip through the parser, and the background step is a first-class tappable step.
  assert.deepEqual(parseClassifyRowId(classifyRowId("background", "science")), { step: "background", value: "science" });

  // The exhaustive-Record backstop, same reasoning as the region labels: a code added to the union
  // without a label would compile and render as undefined. Walk the union, prove every key resolves.
  for (const code of candidateBackgroundCodes) {
    const label = candidateBackgroundLabels[code];
    assert.equal(typeof label, "string", `background ${code} has no label`);
    assert.ok(label.length > 0 && !label.includes("undefined"), `background ${code} label is not human-readable: ${label}`);
  }
  assert.equal(
    Object.keys(candidateBackgroundLabels).length,
    candidateBackgroundCodes.length,
    "the background label Record must hold exactly the offered codes — no orphan, no missing one",
  );

  // The background "Other" prompts obey the owner's no-ellipsis rule and the too-long nudge names its
  // limit, so an applicant who overshoots knows what to do.
  for (const prompt of [backgroundOtherPromptText(), backgroundOtherTooLongText()]) {
    assert.ok(prompt.trim().length > 0, "the prompt must say something");
    assert.ok(!prompt.includes("…") && !prompt.includes("..."), "text is never cut with an ellipsis");
  }
  assert.ok(backgroundOtherTooLongText().includes(String(BACKGROUND_OTHER_MAX)), "the nudge names its limit");

  // ── Question 5 — years of experience (owner's instruction 2026-08-30, bucket 1) ────────────────
  // Asked to everyone, after geography. Five exhaustive bands and — deliberately — NO "Other" row:
  // the ranges leave nothing uncovered, so a closed tappable band beats a free-typed "about 4 years".
  const expMenu = experienceMenu();
  assert.equal(expMenu.step, "experience", "the experience menu must carry its own step");
  assert.deepEqual(
    expMenu.rows.map((row) => row.id),
    ["fresh", "lt_1", "1_3", "3_5", "gt_5"].map((code) => classifyRowId("experience", code)),
    "the experience menu offers the five bands least-to-most, with no Other row",
  );
  assert.ok(
    !expMenu.rows.some((row) => row.id === classifyRowId("experience", OTHER_ROW_VALUE)),
    "experience has no Other escape — the bands are exhaustive",
  );
  const expTitleById = new Map(expMenu.rows.map((row) => [row.id, row.title]));
  assert.equal(expTitleById.get(classifyRowId("experience", "fresh")), "Fresh graduate");
  assert.equal(expTitleById.get(classifyRowId("experience", "gt_5")), "More than 5 years");

  // The guard accepts exactly the five codes and rejects everything else, including the escape value
  // (which experience never offers) — a stale value must never read as a real band.
  for (const code of candidateExperienceCodes) {
    assert.ok(isOfferedExperience(code), `${code} is an offered experience band`);
  }
  assert.ok(!isOfferedExperience(OTHER_ROW_VALUE), "the escape value is not an experience band");
  assert.ok(!isOfferedExperience("10_years"), "a value we do not offer is rejected");

  // The exhaustive-Record backstop, same reasoning as the region and background labels: a code added
  // to the union without a label would compile under ignoreBuildErrors and render as undefined.
  for (const code of candidateExperienceCodes) {
    const label = candidateExperienceLabels[code];
    assert.equal(typeof label, "string", `experience ${code} has no label`);
    assert.ok(label.length > 0 && !label.includes("undefined"), `experience ${code} label is not human-readable: ${label}`);
  }
  assert.equal(
    Object.keys(candidateExperienceLabels).length,
    candidateExperienceCodes.length,
    "the experience label Record must hold exactly the offered codes — no orphan, no missing one",
  );

  // ── Question 6 — expected salary (typed, stored verbatim) ──────────────────────────────────────
  // The last question and the only free-typed one. The prompt obeys the no-ellipsis rule; the
  // too-long nudge names its limit; and the shared cleaner keeps a real answer verbatim while
  // refusing a pasted paragraph — including answers we must never coerce to a number.
  for (const prompt of [salaryPromptText(), salaryTooLongText()]) {
    assert.ok(prompt.trim().length > 0, "the prompt must say something");
    assert.ok(!prompt.includes("…") && !prompt.includes("..."), "text is never cut with an ellipsis");
  }
  assert.ok(salaryTooLongText().includes(String(EXPECTED_SALARY_MAX)), "the salary nudge names its limit");
  assert.equal(cleanTypedAnswer("  12000 - 15000  ", EXPECTED_SALARY_MAX), "12000 - 15000", "a salary range is kept, whitespace collapsed");
  assert.equal(cleanTypedAnswer("negotiable", EXPECTED_SALARY_MAX), "negotiable", "a non-numeric salary answer is a truthful answer, kept verbatim");
  assert.equal(cleanTypedAnswer("", EXPECTED_SALARY_MAX), null, "an empty salary is unusable");
  assert.equal(
    cleanTypedAnswer("x".repeat(EXPECTED_SALARY_MAX + 1), EXPECTED_SALARY_MAX),
    null,
    "a pasted sentence is refused rather than truncated",
  );

  // ── The area cascade — owner's rule 2026-08-30, now the area question's DEFAULT audience ─────
  // ONLY a Medical Rep is asked the area; every other role — the sales managers, the head-office
  // roles, and a typed "Other" — is asked region only. The rule used to be `askAreaForRole`, a
  // hardcoded line; since 2026-09-05 it is what the area question does with NOTHING CONFIGURED, one
  // of six audiences the owner can change on /admin/screening-questions. These assertions are the
  // same ones, ported onto the function that now answers it — the behaviour did not move, only the
  // place it is written. `undefined` is the argument that means "nothing configured".
  const asksArea = (family: string | null) => builtInQuestionAppliesToRole("area", undefined, family);
  assert.equal(asksArea("medical_rep"), true, "a Medical Rep is asked the area");
  for (const family of offeredRoleMenuFamilies) {
    if (family === "medical_rep") continue;
    assert.equal(asksArea(family), false, `${family} is asked region only — the area question defaults to Medical-Rep-only`);
  }
  // A typed "Other" job keeps family "other", and null is a session that never answered the role —
  // neither is a medical rep, so neither is asked an area.
  assert.equal(asksArea("other"), false, "a typed Other job is not a Medical Rep — region only");
  assert.equal(asksArea(null), false, "an unanswered role is never asked an area");
  // Every offered role except the rep is a region-only role, so at least the seven managers/HO roles
  // skip the area — a sanity check that the menu did not quietly become all reps.
  assert.ok(
    offeredRoleMenuFamilies.filter((family) => !asksArea(family)).length >= 6,
    "the cascade must actually skip the non-rep roles, not wave everyone through to the area",
  );

  // ── The thank-you survives a question the applicant was never asked ──────────────────────────
  //
  // THE ONE THAT WOULD HAVE SHIPPED SILENCE. The confirmation used to be gated on role AND region,
  // which was safe only while the region question was asked to everybody. Narrowing it to particular
  // job titles — which the owner can do since 2026-09-05 — meant an Office Coordinator could answer
  // every question put to them and receive nothing at all at the end. The WhatsApp bot is live, so
  // that is a real applicant getting real silence, and nothing would have logged it.
  const thanksWithoutRegion = classifyThankYouText({
    areaName: null,
    backgroundLabel: "Science",
    expectedSalary: "9000",
    experienceLabel: "1 - 3 years",
    regionLabel: null,
    roleLabel: "Office Coordinator",
  });
  assert.ok(thanksWithoutRegion.includes("Office Coordinator"), "the confirmation still names their role");
  assert.ok(thanksWithoutRegion.includes("Expected salary: 9000"), "and everything they did answer");
  assert.ok(!thanksWithoutRegion.includes("Region:"), "the region line is omitted, not printed empty");
  assert.ok(
    !/null|undefined/.test(thanksWithoutRegion),
    "an absent answer must never reach the applicant as the word null",
  );
  assert.ok(
    thanksWithoutRegion.includes("Our HR team will review your CV"),
    "the closing line is what makes this a confirmation rather than a fragment",
  );

  // Still printed for everyone who WAS asked it — the omission is about the question not being put,
  // never about tidying a summary.
  const thanksWithRegion = classifyThankYouText({
    areaName: "Haram - Faisal",
    backgroundLabel: "Pharmacy",
    expectedSalary: "15000",
    experienceLabel: "3 - 5 years",
    regionLabel: "Giza",
    roleLabel: "Medical Representative",
  });
  assert.ok(thanksWithRegion.includes("Region: Giza"), "a region that was asked and answered is shown");

  // ── Row ids round-trip, and a foreign id is never mistaken for ours ───────────────────────────

  assert.deepEqual(parseClassifyRowId(classifyRowId("job_title", "medical_rep")), {
    step: "job_title",
    value: "medical_rep",
  });
  assert.deepEqual(parseClassifyRowId(classifyRowId("area", "Beni Suef")), { step: "area", value: "Beni Suef" });
  // Experience is the fifth TAPPABLE step, so its row ids round-trip. The value "1_3" carries a
  // colon-free code, so the three-part split is unambiguous.
  assert.deepEqual(parseClassifyRowId(classifyRowId("experience", "1_3")), { step: "experience", value: "1_3" });
  assert.equal(parseClassifyRowId("someone_elses_button"), null, "an unnamespaced id is not ours");
  assert.equal(parseClassifyRowId("other:job_title:medical_rep"), null, "a foreign prefix is not ours");
  // "salary" is a real session step but a TYPED one — no menu, no row ids — so an id claiming it is
  // not ours, exactly like job_title_other. This is what keeps a typed step out of the tap handler.
  assert.equal(parseClassifyRowId("phx:salary:1000"), null, "the typed salary step has no row ids");
  assert.equal(parseClassifyRowId(null), null, "a missing id is not ours");

  // ── The webhook parser reads a tapped answer ──────────────────────────────────────────────────

  const listReply = parseWhatsAppWebhookPayload(
    interactivePayload({ list_reply: { id: "phx:job_title:medical_rep", title: "Medical Representative" }, type: "list_reply" }),
  );
  assert.equal(listReply.length, 1, "an interactive reply must be parsed, not dropped");
  assert.equal(
    listReply[0].interactiveReplyId,
    "phx:job_title:medical_rep",
    "the tapped row id must reach the handler — without it the applicant's answer is lost",
  );
  assert.equal(listReply[0].document, null, "an interactive reply carries no CV");
  assert.equal(listReply[0].text, null, "an interactive reply is not buffered as text");

  const buttonReply = parseWhatsAppWebhookPayload(
    interactivePayload({ button_reply: { id: "phx:region:GZ", title: "Giza" }, type: "button_reply" }),
  );
  assert.equal(buttonReply[0].interactiveReplyId, "phx:region:GZ", "a button reply must be read too");

  // A CV document is unchanged by all of this — it must never look like a tapped answer.
  const documentMessage = parseWhatsAppWebhookPayload({
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  document: { filename: "cv.pdf", id: "MEDIA1", mime_type: "application/pdf" },
                  from: "201001234567",
                  id: "wamid.DOC1",
                  type: "document",
                },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.equal(documentMessage[0].interactiveReplyId, null, "a CV document is not an interactive reply");
  assert.ok(documentMessage[0].document, "a CV document must still parse as a document");

  // ── "Other" opens a typed question ────────────────────────────────────────────────────────────
  // Owner's instruction 2026-08-28. The step vocabulary is pinned against the migration's CHECK
  // constraint: the two are written in different languages and nothing else would catch a drift,
  // and a step the database rejects dead-ends the applicant on question 1 with no error anyone sees.

  assert.deepEqual(
    [...classifySessionSteps],
    [
      "job_title",
      "job_title_other",
      "background",
      "background_other",
      "region",
      "region_other",
      "area",
      "area_other",
      "experience",
      "salary",
      "done",
    ],
    "must match the CHECK constraint in 20260831103000_ats_whatsapp_classify_screening.sql",
  );
  assert.equal(
    parseClassifyRowId("phx:job_title_other:anything"),
    null,
    "job_title_other has no menu and no rows — an id claiming that step is not ours",
  );
  assert.equal(
    parseClassifyRowId("phx:background_other:anything"),
    null,
    "background_other has no menu and no rows either — an id claiming that step is not ours",
  );

  // The prompt says what to do and never cuts text with an ellipsis (the owner's standing rule).
  for (const prompt of [jobTitleOtherPromptText(), jobTitleOtherTooLongText()]) {
    assert.ok(prompt.trim().length > 0, "the prompt must say something");
    assert.ok(!prompt.includes("…") && !prompt.includes("..."), "text is never cut with an ellipsis");
  }
  assert.ok(
    jobTitleOtherTooLongText().includes(String(JOB_TITLE_OTHER_MAX)),
    "the too-long nudge must name the limit, or the applicant cannot act on it",
  );

  // What a typed answer is worth keeping.
  assert.equal(cleanTypedJobTitle("  Regulatory   Affairs  Specialist "), "Regulatory Affairs Specialist");
  assert.equal(cleanTypedJobTitle(""), null, "an empty answer is not a job title");
  assert.equal(cleanTypedJobTitle("   "), null, "whitespace is not a job title");
  assert.equal(cleanTypedJobTitle(null), null);
  assert.equal(
    cleanTypedJobTitle("x".repeat(JOB_TITLE_OTHER_MAX + 1)),
    null,
    "a pasted paragraph is rejected rather than truncated — never cut text, and never store junk",
  );
  assert.equal(
    cleanTypedJobTitle("x".repeat(JOB_TITLE_OTHER_MAX)),
    "x".repeat(JOB_TITLE_OTHER_MAX),
    "exactly at the limit is still a job title",
  );
}
