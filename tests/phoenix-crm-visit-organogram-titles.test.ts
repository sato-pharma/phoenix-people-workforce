import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { highestSeatTitle, ORG_SEAT_TITLE, orgSeatTitle } from "../src/lib/org/seat-titles.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { personSeatTitle, seatTierTitle } from "../src/lib/phoenix-crm/server/territory.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * WHO WAS ON THE VISIT IS NAMED WITH HIS REAL JOB TITLE, AS THE ORGANOGRAM STATES IT.
 *
 * Owner, 2026-10-01, looking at a chain visit on his own Phoenix CRM Visits tab: *"put actual titles
 * from the organogram"*. The card read
 *
 *     Aya Ibrahim · Rep
 *     Dina Hamdy · Manager
 *     Magdy El Senosey · Senior manager
 *
 * and those three words are the SLOTS a visit has — the rep, a manager on a double visit, a senior
 * manager on a chain visit. They are the shape of the visit, not anybody's job, and the organogram
 * calls the same three people Medical Representative, District Sales Manager and National Sales
 * Manager. A national sales manager reading "Senior manager" on his own call is the system demoting
 * him on screen.
 *
 * Three things have to hold together, and the second is the one that rots quietly:
 *
 *  1. THE WORDING IS THE ORGANOGRAM'S. Not a fourth vocabulary invented here, and not the shorter set
 *     Phoenix CRM used to carry ("Medical Rep", "District Manager", "Regional Manager").
 *  2. THERE IS ONE COPY OF IT. `organogram-au-source.ts` must IMPORT the map rather than hold its own
 *     — two hand-typed copies is how the organogram and the visit card drift apart with nothing
 *     failing, because each is internally consistent.
 *  3. A PERSON WITH NO SEAT STILL READS. The tree is SALES-ONLY, so the Super Admin and anyone at head
 *     office genuinely have no title in it. The server answers null and the card falls back to the
 *     slot it always showed, which is still a true sentence — never a blank, never a raw `ACTING_DM`.
 *
 * Comments are stripped before every source read: this file's prose spells the strings it pins, and a
 * test that matched its own explanation would pin nothing (AGENTS.md §2.1).
 */

const ORGANOGRAM = "src/lib/reports/organogram-au-source.ts";
const VISITS = "src/lib/phoenix-crm/server/visits.ts";
const TAB = "src/components/phoenix-crm/visits-tab.tsx";
const TERRITORY = "src/lib/phoenix-crm/server/territory.ts";

/** Source with comments removed and whitespace flattened — these files are hard-wrapped at ~100 cols. */
const flat = (path: string) => stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");

const seat = (over: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier">): OrgSeat => ({
  parentSeatId: null,
  path: [over.seatId],
  occupantHrId: null,
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: null,
  ...over,
});

export function runPhoenixCrmVisitOrganogramTitlesTests() {
  // ── 1. The wording ───────────────────────────────────────────────────────────────────────────
  // The six strings the organogram prints on a node. Spelt out rather than compared to the module's
  // own export, which would pass whatever the module said.
  assert.equal(ORG_SEAT_TITLE.CEO, "CEO");
  assert.equal(ORG_SEAT_TITLE.NSM, "National Sales Manager");
  assert.equal(ORG_SEAT_TITLE.RSM, "Regional Sales Manager");
  assert.equal(ORG_SEAT_TITLE.DM, "District Sales Manager");
  assert.equal(ORG_SEAT_TITLE.REP, "Medical Representative");
  // An acting district manager is drawn as the district manager he is acting as: the organogram
  // collapses his own REP seat into that node. A SEAT title, not a statement about HR's job-title
  // column, where he stays a medical rep (owner, settled).
  assert.equal(ORG_SEAT_TITLE.ACTING_DM, "District Sales Manager");

  assert.equal(orgSeatTitle("rep"), "Medical Representative", "the tier is read case-insensitively");
  assert.equal(orgSeatTitle(" DM "), "District Sales Manager", "a padded tier still resolves");
  assert.equal(orgSeatTitle("SFE"), null, "a tier the view grows later resolves to null, never to its own code");
  assert.equal(orgSeatTitle(null), null);

  // ── 2. Phoenix CRM speaks it too ─────────────────────────────────────────────────────────────
  // The visit form's companion picker and the manager-visits report read seatTierTitle. It carried a
  // shorter set of its own until this change, so the same person read one way on the organogram and
  // another on his own visit.
  assert.equal(seatTierTitle("REP"), "Medical Representative");
  assert.equal(seatTierTitle("DM"), "District Sales Manager");
  assert.equal(seatTierTitle("ACTING_DM"), "District Sales Manager");
  assert.equal(seatTierTitle("RSM"), "Regional Sales Manager");
  assert.equal(seatTierTitle("NSM"), "National Sales Manager");
  // The fallback is a word, never the raw tier: printing `SFE` on a card is the owner's
  // names-never-codes rule broken in the one place a person reads it.
  assert.equal(seatTierTitle("SFE"), "Manager");

  // ── 3. A person's title comes off his HIGHEST seat ───────────────────────────────────────────
  const org = buildOrgIndex([
    seat({ seatId: "SEAT-NSM", tier: "NSM", occupantHrId: "AI-0008" }),
    seat({ seatId: "SEAT-DM", tier: "DM", occupantHrId: "B-12", parentSeatId: "SEAT-NSM", path: ["SEAT-NSM", "SEAT-DM"] }),
    seat({ seatId: "SEAT-REP", tier: "REP", occupantHrId: "B-7", parentSeatId: "SEAT-DM", path: ["SEAT-NSM", "SEAT-DM", "SEAT-REP"] }),
    // The acting district manager: two seats, one person. The organogram draws him once, at the
    // higher one, so a title resolved from his seats must do the same.
    seat({ seatId: "SEAT-ADM", tier: "ACTING_DM", occupantHrId: "B-1", parentSeatId: "SEAT-NSM", path: ["SEAT-NSM", "SEAT-ADM"] }),
    seat({ seatId: "SEAT-ADM-REP", tier: "REP", occupantHrId: "B-1", parentSeatId: "SEAT-ADM", path: ["SEAT-NSM", "SEAT-ADM", "SEAT-ADM-REP"] }),
  ]);

  assert.equal(personSeatTitle(org, "B-7"), "Medical Representative");
  assert.equal(personSeatTitle(org, "B-12"), "District Sales Manager");
  assert.equal(personSeatTitle(org, "AI-0008"), "National Sales Manager");
  assert.equal(personSeatTitle(org, "b-12"), "District Sales Manager", "an HR id is matched however it is cased");
  assert.equal(
    personSeatTitle(org, "B-1"),
    "District Sales Manager",
    "an acting district manager reads at his ACTING_DM seat, not the REP seat beneath it",
  );
  // The SALES-ONLY tree: the Super Admin has no seat in it and must not be given one.
  assert.equal(personSeatTitle(org, "B-10"), null, "somebody with no seat has no organogram title — null, never a guess");
  assert.equal(personSeatTitle(org, null), null);
  assert.equal(personSeatTitle(org, "   "), null);

  // Order must not decide the answer: the same two seats the other way round still read at the higher.
  assert.equal(highestSeatTitle(["REP", "ACTING_DM"]), "District Sales Manager");
  assert.equal(highestSeatTitle(["ACTING_DM", "REP"]), "District Sales Manager");
  assert.equal(highestSeatTitle(["REP", "NSM", "DM"]), "National Sales Manager");
  assert.equal(highestSeatTitle(["SFE", "nope"]), null, "no recognised tier at all is null, not the first one seen");
  assert.equal(highestSeatTitle([]), null);

  // ── 4. ONE copy of the map ───────────────────────────────────────────────────────────────────
  const organogram = flat(ORGANOGRAM);
  assert.ok(
    organogram.includes('from "@/lib/org/seat-titles"'),
    `${ORGANOGRAM}: the organogram must take its titles from the shared map, not hold a second copy`,
  );
  assert.ok(
    !/CEO:\s*"CEO",\s*NSM:\s*"National Sales Manager"/.test(organogram),
    `${ORGANOGRAM}: a hand-typed tier→title literal here is the drift this change removed — import ORG_SEAT_TITLE`,
  );

  const territory = flat(TERRITORY);
  assert.ok(
    territory.includes("orgSeatTitle(tier) ?? "),
    `${TERRITORY}: seatTierTitle must defer to the organogram's map rather than carrying Phoenix CRM's own shorter set`,
  );

  // ── 5. The title travels to the card ─────────────────────────────────────────────────────────
  const visits = flat(VISITS);
  for (const field of ["repTitle", "managerTitle", "seniorTitle"]) {
    assert.ok(visits.includes(`${field}: string | null`), `${VISITS}: VisitRow must carry ${field}`);
  }
  assert.ok(
    /const title = \(value: unknown\) => personSeatTitle\(options\.org, textOrNull\(value\)\)/.test(visits),
    `${VISITS}: the title must be resolved from the organogram the viewer already loaded, never from a second read`,
  );
  assert.ok(
    /repTitle: title\(row\.rep_hr_id\),\s*managerTitle: title\(row\.manager_hr_id\),\s*seniorTitle: title\(row\.senior_hr_id\)/.test(
      visits,
    ),
    `${VISITS}: each of the three people on a visit is titled from his OWN hr id`,
  );

  // ── 6. The slot survives only as the fallback ────────────────────────────────────────────────
  // The card must never print an empty role, and it must never print the slot where a real title
  // exists. Both directions are the point: `?? "Rep"` is right, `"Rep"` alone is the bug, and so is
  // dropping the fallback altogether for a person the tree has no seat for.
  const tab = flat(TAB);
  assert.ok(
    /role: visit\.repTitle \?\? "Rep"/.test(tab),
    `${TAB}: the rep reads his organogram title, falling back to the slot only when he has no seat`,
  );
  assert.ok(
    /role: visit\.managerTitle \?\? "Manager"/.test(tab),
    `${TAB}: the manager reads his organogram title, falling back to the slot`,
  );
  assert.ok(
    /role: visit\.seniorTitle \?\? "Manager above"/.test(tab),
    `${TAB}: the manager above reads his organogram title, falling back to "Manager above" — there is no "senior manager" title (owner, 2026-10-27)`,
  );
  assert.ok(
    !/role: "Rep"/.test(tab) && !/role: "Manager"/.test(tab) && !/role: "Senior manager"/.test(tab),
    `${TAB}: no person may be labelled by the visit's slot alone — that is what the owner asked be replaced`,
  );
}
