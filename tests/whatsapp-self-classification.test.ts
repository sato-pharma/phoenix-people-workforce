import assert from "node:assert/strict";

import { candidateRegionCodes, candidateRegionLabels } from "../src/lib/recruitment/candidate-region.ts";
import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import {
  AREA_OTHER_MAX,
  areaMenu,
  areaOtherPromptText,
  classifyRowId,
  classifySessionSteps,
  cleanTypedAnswer,
  cleanTypedJobTitle,
  jobTitleMenu,
  jobTitleOtherPromptText,
  jobTitleOtherTooLongText,
  JOB_TITLE_OTHER_MAX,
  menuViolations,
  offeredRoleMenuFamilies,
  OTHER_ROW_VALUE,
  parseClassifyRowId,
  REGION_OTHER_MAX,
  regionMenu,
  regionOtherPromptText,
  typedAnswerTooLongText,
  WHATSAPP_LIST_MAX_ROWS,
  WHATSAPP_ROW_TITLE_MAX,
} from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
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
  // ── The menus must satisfy Meta's limits, or the message is a 400 and the flow dies silently ──

  assert.deepEqual(menuViolations(jobTitleMenu()), [], "the role menu must satisfy every Cloud API limit");
  assert.deepEqual(menuViolations(regionMenu()), [], "the region menu must satisfy every Cloud API limit");

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
  assert.equal(dokki.description, "Dokki - Mohandseen - Bolak", "the full area name must survive on the description line");

  // A name that already fits carries no duplicate description — the same words twice reads as a bug.
  const fayoum = gizaMenu.rows.find((row) => row.id === classifyRowId("area", "Fayoum"));
  assert.ok(fayoum, "Fayoum must be offered");
  assert.equal(fayoum.description, undefined, "a title that already fits must not repeat itself as a description");

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

  const roleMenu = jobTitleMenu();
  assert.deepEqual(
    roleMenu.rows.map((row) => row.id),
    [
      "medical_rep",
      "district_manager",
      "area_regional_manager",
      "product_manager",
      "national_sales_manager",
      "human_resources",
      "finance",
      "other",
    ].map((family) => classifyRowId("job_title", family)),
    "the role menu must offer exactly the owner's eight roles, in his order (stated 2026-08-28)",
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
  assert.equal(roleTitleById.get(classifyRowId("job_title", "finance")), "Finance");
  assert.equal(roleTitleById.get(classifyRowId("job_title", "national_sales_manager")), "National Sales Manager");

  // ── Row ids round-trip, and a foreign id is never mistaken for ours ───────────────────────────

  assert.deepEqual(parseClassifyRowId(classifyRowId("job_title", "medical_rep")), {
    step: "job_title",
    value: "medical_rep",
  });
  assert.deepEqual(parseClassifyRowId(classifyRowId("area", "Beni Suef")), { step: "area", value: "Beni Suef" });
  assert.equal(parseClassifyRowId("someone_elses_button"), null, "an unnamespaced id is not ours");
  assert.equal(parseClassifyRowId("other:job_title:medical_rep"), null, "a foreign prefix is not ours");
  assert.equal(parseClassifyRowId("phx:salary:1000"), null, "an unknown step is not ours");
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
    ["job_title", "job_title_other", "region", "region_other", "area", "area_other", "done"],
    "must match the CHECK constraint in 20260828075500_ats_whatsapp_classify_typed_region_and_area.sql",
  );
  assert.equal(
    parseClassifyRowId("phx:job_title_other:anything"),
    null,
    "job_title_other has no menu and no rows — an id claiming that step is not ours",
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
