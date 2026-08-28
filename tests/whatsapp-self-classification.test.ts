import assert from "node:assert/strict";

import { candidateRegionCodes, candidateRegionLabels } from "../src/lib/recruitment/candidate-region.ts";
import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import {
  areaMenu,
  classifyRowId,
  jobTitleMenu,
  menuViolations,
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
  assert.deepEqual(menuViolations(regionMenu()), [], "the region menu must satisfy every Cloud API limit");

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
  // au.regions also holds UE-1 and UE-2, which have ZERO active areas. Offering either would walk
  // the applicant to question 3 and present an empty list.
  const regionIds = regionMenu().rows.map((row) => row.id);
  assert.ok(!regionIds.includes(classifyRowId("region", "UE-1")), "UE-1 has no areas and must never be offered");
  assert.ok(!regionIds.includes(classifyRowId("region", "UE-2")), "UE-2 has no areas and must never be offered");
  assert.equal(regionMenu().rows.length, candidateRegionCodes.length, "every offered region must have an area list");
  for (const code of candidateRegionCodes) {
    assert.ok(
      Array.isArray(PRODUCTION_AREAS[code]) && PRODUCTION_AREAS[code].length > 0,
      `region ${candidateRegionLabels[code]} is offered but has no areas to follow it with`,
    );
  }

  // ── The role menu offers every family, with "Other" last ──────────────────────────────────────

  const roleMenu = jobTitleMenu();
  assert.equal(roleMenu.rows.length, candidateRoleFamilies.length, "every role family must be offered");
  for (const family of candidateRoleFamilies) {
    assert.ok(
      roleMenu.rows.some((row) => row.id === classifyRowId("job_title", family)),
      `role family ${family} must be offered`,
    );
  }
  assert.equal(
    roleMenu.rows[roleMenu.rows.length - 1].id,
    classifyRowId("job_title", "other"),
    '"Other" must be last — offering it early invites it',
  );

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
}
