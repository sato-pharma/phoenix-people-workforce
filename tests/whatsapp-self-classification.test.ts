import assert from "node:assert/strict";

import { candidateRegionCodes, candidateRegionLabels } from "../src/lib/recruitment/candidate-region.ts";
import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import {
  areaMenu,
  classifyRowId,
  classifySessionSteps,
  cleanTypedJobTitle,
  jobTitleMenu,
  jobTitleOtherPromptText,
  jobTitleOtherTooLongText,
  JOB_TITLE_OTHER_MAX,
  isOfferedRegion,
  menuViolations,
  offeredRoleMenuFamilies,
  parseClassifyRowId,
  regionMenu,
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
  const OFFERED = Object.keys(PRODUCTION_AREAS) as Array<(typeof candidateRegionCodes)[number]>;
  assert.deepEqual(menuViolations(regionMenu(OFFERED)), [], "the region menu must satisfy every Cloud API limit");

  for (const [regionCode, areas] of Object.entries(PRODUCTION_AREAS)) {
    const menu = areaMenu(regionCode as (typeof candidateRegionCodes)[number], areas);
    assert.deepEqual(menuViolations(menu), [], `the ${regionCode} area menu must satisfy every Cloud API limit`);
    assert.equal(menu.rows.length, areas.length, `every active ${regionCode} area must be offered — none silently dropped`);
  }

  // Every region really does fit the 10-row cap. Others is the largest at 9; if an org change ever
  // pushes one past 10 this fails here rather than truncating a territory out of existence.
  for (const [regionCode, areas] of Object.entries(PRODUCTION_AREAS)) {
    assert.ok(
      areas.length <= WHATSAPP_LIST_MAX_ROWS,
      `${regionCode} has ${areas.length} areas, which no longer fits WhatsApp's ${WHATSAPP_LIST_MAX_ROWS}-row list`,
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
  // The menu is built from the regions that actually HAVE areas, read live from au.canonical_areas.
  // au.regions also holds UE-1 and UE-2 with zero active areas, and the pool vocabulary now carries
  // "Delta (3)" whose areas have not moved yet — offering any of the three would walk an applicant
  // to question 3 and show an empty list.
  const regionIds = regionMenu(OFFERED).rows.map((row) => row.id);
  assert.ok(!regionIds.includes(classifyRowId("region", "UE-1")), "UE-1 has no areas and must never be offered");
  assert.ok(!regionIds.includes(classifyRowId("region", "UE-2")), "UE-2 has no areas and must never be offered");
  assert.equal(regionMenu(OFFERED).rows.length, OFFERED.length, "every offered region must have an area list");
  for (const code of OFFERED) {
    assert.ok(
      Array.isArray(PRODUCTION_AREAS[code]) && PRODUCTION_AREAS[code].length > 0,
      `region ${candidateRegionLabels[code]} is offered but has no areas to follow it with`,
    );
  }

  // Delta (3) is in the pool vocabulary but has no canonical areas yet (verified in production
  // 2026-08-28: au.canonical_areas has 0 rows with code_region_code = 'D3'). It must stay OUT of
  // the menu until they move — and it must appear by itself, with no code change, once they do.
  assert.ok(
    candidateRegionCodes.includes("D3"),
    "Delta (3) must be in the pool vocabulary — the Region filter is how her reps get recruited",
  );
  assert.ok(
    !regionIds.includes(classifyRowId("region", "D3")),
    "Delta (3) has no areas yet and must not be offered on WhatsApp",
  );
  const withDelta3 = regionMenu([...OFFERED, "D3"]).rows.map((row) => row.id);
  assert.ok(
    withDelta3.includes(classifyRowId("region", "D3")),
    "the day Delta (3) has areas, the menu must offer it with no further code change",
  );

  // The guard on the REPLY must use the same set as the menu, or a candidate holding an older
  // message could answer with a region that is no longer offered.
  assert.equal(isOfferedRegion("D3", OFFERED), false, "a region that was not offered is not accepted back");
  assert.equal(isOfferedRegion("D3", [...OFFERED, "D3"]), true, "a region that WAS offered is accepted back");
  assert.equal(isOfferedRegion("UE-1", OFFERED), false, "a region with no areas is never accepted");

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
    ["job_title", "job_title_other", "region", "area", "done"],
    "must match the CHECK constraint in 20260828071500_ats_whatsapp_classify_other_free_text.sql",
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
