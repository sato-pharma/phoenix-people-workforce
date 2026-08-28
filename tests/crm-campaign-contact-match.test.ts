import assert from "node:assert/strict";

import {
  buildKnownContactIndex,
  isMatchableName,
  matchCampaignComment,
  matchCampaignNote,
  normalizeContactName,
  summarizeCampaignMatches,
  type KnownContactRow,
} from "../src/lib/crm/campaign-contact-match.ts";
import { readCampaignNote } from "../src/lib/crm/campaign-note.ts";
import {
  buildRepVisits,
  isProspectRow,
  type CrmRegionTerritoryIndex,
  type VisitForRepDrilldown,
} from "../src/lib/crm/rep-visits.ts";

const UNMAPPED: CrmRegionTerritoryIndex = new Map();

/** The rep whose campaign notes are under test. */
const HR = "hr-1";

function visit(overrides: Partial<VisitForRepDrilldown> = {}): VisitForRepDrilldown {
  return {
    agent_crm_id: 100,
    agent_hr_id: HR,
    agent_name: "Adel.Srour ( Down-town / C )",
    ampm: "AM",
    comment: null,
    contact_crm_id: 555,
    contact_name: "Dr Sherif Kamal",
    crm_contact_grade: "A",
    crm_region_id: 118,
    crm_region_name: "Mahalla",
    crm_save_date: "2026-08-01T11:00:00",
    crm_visit_id: 9001,
    customer_name: "El Nasr Clinic",
    double_hr_id: null,
    double_name: null,
    speciality: "Pediatrics",
    visit_date: "2026-08-01",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

/** A campaign row as production actually sends one: a comment, and nothing else. */
function campaignVisit(comment: string, overrides: Partial<VisitForRepDrilldown> = {}): VisitForRepDrilldown {
  return visit({
    comment,
    contact_crm_id: 0,
    contact_name: null,
    crm_visit_id: 51,
    customer_name: null,
    speciality: null,
    visit_type: -8,
    visit_type_description: "Campaign (Prospection)",
    ...overrides,
  });
}

function directory(rows: readonly Partial<KnownContactRow>[]) {
  return buildKnownContactIndex(
    rows.map((row) => ({
      agentHrId: row.agentHrId ?? HR,
      contactCrmId: row.contactCrmId ?? "555",
      contactName: row.contactName ?? null,
      speciality: row.speciality ?? null,
    })),
  );
}

export function runCrmCampaignContactMatchTests() {
  // ── The same name, typed four different ways ────────────────────────────────────
  {
    // Every one of these is a spelling difference an Egyptian keyboard produces on its own, and
    // every one of them was enough to hide a doctor from the match before this normaliser existed.
    const canonical = normalizeContactName("احمد سمير");
    assert.equal(normalizeContactName("أحمد سمير"), canonical, "the hamza on alif is a keyboard, not a different man");
    assert.equal(normalizeContactName("د/أحمد سمير"), canonical, "and the honorific is a title, not part of his name");
    assert.equal(normalizeContactName("د. أَحْمَد سمير"), canonical, "diacritics are decoration — the CRM rarely carries them");
    assert.equal(normalizeContactName("  أحمد   سمير  "), canonical, "spacing is typing, not identity");

    assert.equal(normalizeContactName("سمية يحيى"), normalizeContactName("سميه يحيي"), "final ة/ه and ى/ي are the same two letters");
    assert.equal(normalizeContactName("Dr Sherif Kamal"), "sherif kamal", "the English titles go too, and case is not identity");

    // A name that is ONLY a title normalises to nothing. It must come back empty rather than as a
    // key, because an empty key would collide every unnamed row onto one doctor.
    assert.equal(normalizeContactName("د."), "", "a bare honorific names nobody");
    assert.equal(normalizeContactName(null), "", "and neither does a null");
  }

  // ── One word is not a name ──────────────────────────────────────────────────────
  {
    // أحمد is among the commonest first names in Egypt. Matching a bare one against a CRM record
    // whose whole name is also أحمد would attach a real visit to a stranger, silently.
    assert.equal(isMatchableName("احمد"), false, "a lone first name is a coin toss, not evidence");
    assert.equal(isMatchableName("احمد سمير"), true, "two tokens is the floor — a first name and one more thing");

    // The same rule does the prose filtering for free, which is why there is no blocklist of English
    // filler in the module. The parser hands back sentence fragments on some notes; they simply are
    // not in the contact list, so the lookup rejects them with nobody having to enumerate them.
    const index = directory([{ contactName: "احمد سمير" }]);
    assert.equal(
      matchCampaignComment("need more visits to remember the roya by name", HR, index),
      null,
      "a fragment of the rep's own sentence is not a doctor and must never match one",
    );
  }

  // ── His own contact, his own coding mistake ─────────────────────────────────────
  {
    // THE DEFECT THIS WHOLE MODULE EXISTS FOR. Measured on production 2026-08-28: 3,126 campaign
    // visits name a doctor the rep already visits normally. Every one of them was labelled
    // "Prospect · not on his list" — a sentence that is simply false about that doctor.
    const index = directory([{ contactCrmId: "777", contactName: "د. عبدالكريم صبح", speciality: "Pediatrics" }]);
    const match = matchCampaignComment("د. عبدالكريم صبح Pedia العصافرة", HR, index)!;
    assert.ok(match, "the doctor he wrote is the doctor he visits — the note and the record are one man");
    assert.equal(match.scope, "own", "and it is HIS list, so this is a coding mistake he can be told to stop making");
    assert.equal(match.contactCrmId, "777", "carrying the CRM id, so a reader can reconcile without guessing");
    assert.equal(match.contactName, "د. عبدالكريم صبح", "shown in the CRM's spelling — that is what makes a WRONG match visible");
    assert.equal(match.writtenName, "عبدالكريم صبح", "beside the rep's own words, which are never rewritten");
    assert.deepEqual(match.alsoVisitedBy, [], "nobody else holds him, so there is no territory question to raise");
  }

  // ── A colleague's contact is a different question entirely ──────────────────────
  {
    // A further 2,716 production campaign visits name a doctor on SOMEBODY ELSE's list. Telling
    // this rep to "fix his coding" would be wrong — the doctor is not his to log normally. The two
    // cases are kept apart everywhere: different scope, different wording, different count.
    const index = directory([{ agentHrId: "hr-9", contactCrmId: "888", contactName: "احمد سمير" }]);
    const match = matchCampaignComment("د/أحمد سمير باطنة", HR, index)!;
    assert.equal(match.scope, "other", "on a colleague's list — a territory question, not a mistake");
    assert.deepEqual(match.alsoVisitedBy, ["hr-9"], "and it names whose, because 'somebody else' is not actionable");
  }

  // ── When a note names two doctors, the actionable one wins ──────────────────────
  {
    const index = directory([
      { agentHrId: "hr-9", contactCrmId: "888", contactName: "احمد سمير" },
      { agentHrId: HR, contactCrmId: "777", contactName: "عبدالكريم صبح" },
    ]);
    // The colleague's doctor is named FIRST in the note, so first-wins would report the territory
    // question and bury the rep's own mis-coded call behind it.
    const match = matchCampaignNote(readCampaignNote("د/أحمد سمير\r\nد. عبدالكريم صبح"), HR, index)!;
    assert.equal(match.scope, "own", "his own mis-coded call outranks a colleague's customer, whatever the note's order");
    assert.equal(match.contactCrmId, "777", "and it is the right doctor, not merely the right verdict");
  }

  // ── A stranger stays a prospect ─────────────────────────────────────────────────
  {
    const index = directory([{ contactName: "احمد سمير" }]);
    assert.equal(
      matchCampaignComment("د. عبدالكريم صبح Pedia", HR, index),
      null,
      "a doctor on nobody's list is genuine prospecting and must keep saying so",
    );
    assert.equal(matchCampaignComment("", HR, index), null, "an empty note names nobody");
    assert.equal(matchCampaignComment(null, HR, index), null, "and neither does a missing one");
  }

  // ── The index keeps every owner, and shows one name ─────────────────────────────
  {
    // A doctor two reps both call on is a shared customer — a "treasure", in the owner's word — and
    // collapsing him onto whichever rep happened to be read first would lose exactly that fact.
    const index = directory([
      { agentHrId: "hr-1", contactCrmId: "777", contactName: "أحمد سمير" },
      { agentHrId: "hr-9", contactCrmId: "778", contactName: "احمد سمير" },
    ]);
    assert.equal(index.size, 1, "two spellings of one man are one entry, which is the whole point of normalising");
    const match = matchCampaignComment("د/احمد سمير", "hr-9", index)!;
    assert.equal(match.scope, "own", "he is on hr-9's list too, so for hr-9 this is a coding mistake");
    assert.deepEqual(match.alsoVisitedBy, ["hr-1"], "and the colleague who shares him is named, never dropped");

    // A single-word CRM record cannot become a key, or every one-word note would match it.
    assert.equal(directory([{ contactName: "أحمد" }]).size, 0, "a one-word contact record is not a usable key");
    assert.equal(directory([{ contactName: null }]).size, 0, "and a nameless one is not a record at all");
  }

  // ── End to end: the row stops calling him a prospect ────────────────────────────
  {
    const comment = "د. عبدالكريم صبح Pedia العصافرة\r\nكتب اللاكتو ادفانسد";
    const contactDirectory = directory([{ contactCrmId: "777", contactName: "عبدالكريم صبح", speciality: "Pediatrics" }]);
    const built = buildRepVisits([campaignVisit(comment)], [], { contactDirectory, territoryIndex: UNMAPPED });
    const row = built.rows[0]!;

    assert.equal(row.knownContact?.scope, "own", "the drill-down row carries the match, not just the matcher's unit test");
    assert.equal(
      isProspectRow(row),
      false,
      "and the row STOPS claiming 'not on his list' — that sentence is false about this doctor",
    );
    assert.equal(built.summary.campaignAlreadyKnown, 1, "the strip counts it, so the size of the problem is on the screen");

    // NOTHING ELSE MOVES. The match is a reading, not an edit: the visit still has no contact
    // record, still counts as a campaign call, and the rate the board shows is untouched. A fix
    // that quietly re-bucketed these would change 3,126 reps' call rates overnight with no audit.
    assert.equal(row.contactCrmId, null, "the visit is NOT attached to the contact — a human decides that, not a matcher");
    assert.equal(row.standing, "campaign", "and it is still a campaign call, so no rate moves");
    assert.equal(built.summary.campaign, 1, "counted exactly once, in the bucket it was always in");
  }

  // ── With no directory, nothing changes at all ───────────────────────────────────
  {
    // The directory read is a display overlay and degrades to empty on any failure. That path has
    // to leave the screen exactly as it is today — a directory that cannot be read must never make
    // a visit look like something it is not.
    const built = buildRepVisits([campaignVisit("د. عبدالكريم صبح Pedia")], [], { territoryIndex: UNMAPPED });
    const row = built.rows[0]!;
    assert.equal(row.knownContact, null, "no directory means no claim about anybody");
    assert.ok(isProspectRow(row), "and the row reads exactly as it did before this feature existed");
    assert.equal(built.summary.campaignAlreadyKnown, 0, "with nothing to count");
  }

  // ── A regular visit is never re-derived from prose ──────────────────────────────
  {
    // A visit that HAS a contact record already knows who was seen. Running the parser beside it
    // would put a guess next to a fact, and the guess would sometimes disagree.
    const contactDirectory = directory([{ contactCrmId: "777", contactName: "عبدالكريم صبح" }]);
    const built = buildRepVisits(
      [visit({ comment: "د. عبدالكريم صبح Pedia", contact_crm_id: 555, contact_name: "Dr Sherif Kamal" })],
      [],
      { contactDirectory, territoryIndex: UNMAPPED },
    );
    assert.equal(built.rows[0]!.knownContact, null, "a real contact is never second-guessed by a reading of its comment");
    assert.equal(built.summary.campaignAlreadyKnown, 0, "and a regular visit can never be a mis-coded campaign call");
  }

  // ── Unnamed is not the same as prospecting ──────────────────────────────────────
  {
    // Folding them together would report a parsing gap as a prospecting achievement, and the two
    // want opposite follow-ups: one is a note to write more clearly, the other a doctor worth
    // adding to the list.
    const summary = summarizeCampaignMatches(
      [
        { alsoVisitedBy: [], contactCrmId: "1", contactName: "a b", scope: "own", speciality: null, writtenName: "a b" },
        { alsoVisitedBy: [], contactCrmId: "2", contactName: "c d", scope: "other", speciality: null, writtenName: "c d" },
        null,
        null,
      ],
      [true, true, true, false],
    );
    assert.deepEqual(
      summary,
      { onAnotherList: 1, onHisOwnList: 1, trueProspect: 1, unnamed: 1 },
      "four campaign calls, four different answers — and none of them borrows another's count",
    );
  }
}
