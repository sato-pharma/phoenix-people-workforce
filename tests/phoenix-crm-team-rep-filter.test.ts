import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  filterByTeamRep,
  inTeamRepScope,
  teamRepLabel,
  teamRepManagerToOpen,
  teamRepsOf,
  teamRepScope,
} from "../src/lib/phoenix-crm/team-rep-filter.ts";

/**
 * Phoenix CRM — the Team tab's one Rep picker (owner, 2026-11-27: "i need 2 be able 2 filter by rep in
 * all tabs", answered "Team's sections"). One choice narrows every section, and stays when he moves.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmTeamRepFilterTests(): void {
  const territories = [
    { seatId: "minia-2", name: "Minia 2", repHrId: "R-2", repName: "Mohamed Mehrez", reviewerHrId: "DM-1" },
    { seatId: "minia-1", name: "Minia 1", repHrId: "R-1", repName: "Ahmed Samir", reviewerHrId: "DM-1" },
    { seatId: "vacant", name: "Assiut 3", repHrId: null, repName: null, reviewerHrId: "DM-2" },
    // A rep on two seats is ONE choice, with both places and both managers.
    { seatId: "beni-suef-1", name: "Beni Suef 1", repHrId: "R-2", repName: "Mohamed Mehrez", reviewerHrId: "DM-3" },
    // The same seat read twice (territories and the week's plans) is one seat.
    { seatId: "minia-2", name: "Minia 2", repHrId: "R-2", repName: "Mohamed Mehrez", reviewerHrId: "DM-1" },
  ];

  // ── The choices ────────────────────────────────────────────────────────────────────────────────
  {
    const reps = teamRepsOf(territories);
    assert.deepEqual(
      reps.map((rep) => rep.hrId),
      ["R-1", "R-2"],
      "one choice per rep, A to Z by name, and a vacant territory offers no rep",
    );
    const mehrez = reps.find((rep) => rep.hrId === "R-2");
    assert.deepEqual(mehrez?.seatIds, ["minia-2", "beni-suef-1"], "a rep on two seats is one choice holding both");
    assert.deepEqual(mehrez?.managerHrIds, ["DM-1", "DM-3"]);
    assert.equal(mehrez && teamRepLabel(mehrez), "Mohamed Mehrez · Minia 2 · Beni Suef 1", "the option names the rep, then his places");
  }

  // ── Whose an item is ───────────────────────────────────────────────────────────────────────────
  {
    const reps = teamRepsOf(territories);
    assert.equal(teamRepScope(reps, null), null, "no choice is every rep");
    assert.equal(teamRepScope(reps, "R-gone"), null, "a rep no longer on the team reads as every rep, never as an empty tab");
    const scope = teamRepScope(reps, "R-2");
    assert.ok(scope);

    assert.equal(inTeamRepScope(null, { seatId: "anything" }), true, "every rep keeps every item");
    assert.equal(inTeamRepScope(scope, { repHrId: "R-2", seatId: "elsewhere" }), true, "an item naming him is his, wherever it sits");
    assert.equal(inTeamRepScope(scope, { seatId: "beni-suef-1" }), true, "an item naming only a seat is his on any of his seats");
    assert.equal(inTeamRepScope(scope, { seatId: "minia-1" }), false, "another rep's seat is not his");
    assert.equal(
      inTeamRepScope(scope, { repHrId: "R-old", seatId: "minia-2" }),
      false,
      "an item naming ANOTHER rep stays that rep's, even on his seat — the rep who held it before keeps his own",
    );
    assert.equal(inTeamRepScope(scope, { repHrId: null, seatId: null }), false, "an item that names nobody is not his");

    const requests = [
      { id: "a", seatId: "minia-2" },
      { id: "b", seatId: "minia-1" },
      { id: "c", seatId: "beni-suef-1" },
    ];
    assert.deepEqual(
      filterByTeamRep(scope, requests, (request) => ({ seatId: request.seatId })).map((request) => request.id),
      ["a", "c"],
    );
    assert.equal(filterByTeamRep(null, requests, (request) => ({ seatId: request.seatId })).length, 3);
  }

  // ── The manager sections open on his manager, only one this viewer reads ────────────────────────
  {
    const choices = [{ hrId: "DM-3" }, { hrId: "DM-9" }];
    assert.equal(teamRepManagerToOpen(["DM-1", "DM-3"], choices, null), "DM-3", "the first of his managers the viewer reads");
    assert.equal(teamRepManagerToOpen(["DM-1"], choices, null), null, "a manager out of reach is never asked for");
    assert.equal(teamRepManagerToOpen(["DM-3"], choices, "DM-3"), null, "already showing him: nothing to change");
    assert.equal(teamRepManagerToOpen(["DM-3"], null, null), null, "a district manager reading his own has no choice to make");
  }

  // ── The screen: ONE picker above the sections, and every section fed the narrowed data ─────────
  {
    const tab = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(tab, /const \[repHrId, setRepHrId\] = useState<string \| null>\(null\);/, "the choice lives in the tab, so it survives a section change");
    assert.match(tab, /<CrmSelect\s+id=\{`\$\{idPrefix\}-team-rep`\}/, "the admin's picker is the module's combo box, never a bare select");
    assert.ok(tab.indexOf("-team-rep`") < tab.indexOf('title="Look at"'), "the Rep picker sits above the sections, not inside one");
    for (const fed of [
      "view={reviewsShown}",
      "view={monthsShown}",
      "team={teamShown}\n",
      "items={reversibleShown}",
      "repScope={repScope}",
      "repManagerHrIds={repScope?.managerHrIds}",
    ]) {
      assert.ok(tab.includes(fed.trim()), `a section is fed the rep's data: ${fed.trim()}`);
    }
    for (const raw of ["view={reviews.data}", "view={months.data}", "team={team.data}", "items={reversible}"]) {
      assert.ok(!tab.includes(raw), `no section reads the whole team past the picker: ${raw}`);
    }
    for (const kind of ["territories:", "requests:", "planEdits:", "unplannedVisits:"]) {
      assert.ok(tab.includes(`${kind} filterByTeamRep(repScope`), `the team payload's ${kind} is narrowed to the rep`);
    }

    const asks = source("src/components/phoenix-crm/visit-asks.tsx");
    assert.match(asks, /filterByTeamRep\(repScope, view\.waiting/, "the double-visit asks waiting are the rep's");
    assert.match(asks, /filterByTeamRep\(repScope, view\.others/, "and so are the rest");
  }
}
