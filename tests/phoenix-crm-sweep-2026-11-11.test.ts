import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hasLeftBy, SEAT_REP_LEFT } from "../src/lib/phoenix-crm/departure-rules.ts";
import { sameNameOnSeatText } from "../src/lib/phoenix-crm/list-request-rules.ts";
import { customerNameKey } from "../src/lib/phoenix-crm/name-fold.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { managerOwnVisitScreenId, managerOwnVisitUuid } from "../src/lib/phoenix-crm/server/manager-visit-details.ts";
import { validateAgainRecipients } from "../src/lib/phoenix-crm/server/notifications.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Phoenix CRM sweep of 11 Nov 2026 — the defects found across the module, each pinned where it was fixed.
 *
 *   1. A visit to a customer still waiting to be validated counted in the KPIs (owner, 1 Oct: "not counted in
 *      kpis till validated") — 1,358 visits. Pinned in tests/crm-counts-in-kpi-readers.test.ts.
 *   2. A customer met outside the list filed no approval request (159 customers). The form asks the grade and
 *      the database files the request (20261111030456).
 *   3. "Visits — Yesterday and Today" crashed for a manager above a district manager who logged his own visit:
 *      the screen's row id ("own:" + uuid) was used as a database key.
 *   5. Three rows merged away as duplicates came back through ordinary bring-back requests (20261111030456's
 *      trigger, and the filing refuses it first).
 *   6. "Same name already on the list" only saw an exact spelling; it now folds the name as the database does,
 *      and the approver is told.
 *   7. A manager's double visit credited a seat's rep who had left (14 visits).
 *   8. Notices reached people who had left.
 *   9. "Validate again" went to whoever captured the customer, not to who holds the seat now.
 *  10. The owner's own validations with a photo already on file read as exact duplicates. Pinned in
 *      tests/phoenix-crm-duplicate-photos.test.ts.
 */

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

function seat(patch: Partial<OrgSeat>): OrgSeat {
  return { seatId: "SEAT-T", occupantHrId: null, ...patch } as OrgSeat;
}

export function runPhoenixCrmSweepTests(): void {
  // ── 3. The manager's own visit: the screen's id and the database's id are two different things ────────────
  {
    const uuid = "13cf8f2f-ddce-4044-82b1-a26fa797438a";
    const screenId = managerOwnVisitScreenId(uuid);
    assert.equal(screenId, `own:${uuid}`, "the row on the screen keeps its own: prefix, so it never collides with a rep's visit");
    assert.equal(managerOwnVisitUuid(screenId), uuid, "🔴 and the database is asked by the uuid alone — `own:…` is not a uuid and crashed the page");
    assert.equal(managerOwnVisitUuid(uuid), uuid, "a bare uuid passes through");

    const teamVisits = source("src/lib/phoenix-crm/server/team-visits.ts");
    assert.match(teamVisits, /managerOwnVisitUuid\(/, "the fix read maps each screen id back to its uuid before it asks the database");
    const details = source("src/lib/phoenix-crm/server/manager-visit-details.ts");
    assert.match(details, /managerOwnVisitScreenId\(/, "and the row id is built by the one function that undoes it");
  }

  // ── 6. The same name, folded exactly as phoenix_crm_fold_name folds it ─────────────────────────────────────
  //
  // Each expected key was read from production's phoenix_crm_fold_name on 11 Nov 2026. A drift between the two
  // folds shows a rep "new customer" for someone the database will refuse as the same name, or the reverse.
  {
    const PARITY: ReadonlyArray<[string, string]> = [
      ["د.محمود سعد", "محمود سعد"],
      ["محمود سعد", "محمود سعد"],
      ["أشرف إدوارد", "اشرف ادوارد"],
      ["اشرف ادوارد", "اشرف ادوارد"],
      ["مستشفي مصطفى محمود", "مستشفي مصطفي محمود"],
      ["مستشفى مصطفي محمود", "مستشفي مصطفي محمود"],
      ["Dr. Ahmed  Ali", "ahmed ali"],
      ["محمد الحسينى", "محمد الحسيني"],
      ["محمد الحسيني", "محمد الحسيني"],
      ["أميره السيد", "اميره السيد"],
      ["أميرة السيد", "اميره السيد"],
      ["دكتور هشام مدين", "هشام مدين"],
      ["  ", ""],
    ];
    for (const [name, key] of PARITY) assert.equal(customerNameKey(name), key, `${name} folds to the database's key`);
    assert.equal(customerNameKey(null), "");

    const listScreens = source("src/components/phoenix-crm/list-screens.tsx");
    assert.match(listScreens, /customerNameKey\(/, "the rep's same-name check uses the database's fold, not a lower-cased compare");
    assert.match(listScreens, /waiting to be validated/, "and a match still waiting says so");

    assert.equal(
      sameNameOnSeatText(["احمد علي"]),
      "احمد علي is on this territory already, under the same name. Approve only if this is a different person; if it is the same one, refuse and say so.",
    );
    assert.match(sameNameOnSeatText(["أ", "ب", "ج"]), /^أ, ب and ج are on this territory already/);
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /export async function withSameNameMatches</, "the approver's queue is told which requests share a name on the seat");
    assert.match(source("src/lib/phoenix-crm/server/team.ts"), /withSameNameMatches\(/, "and the manager's team queue carries it");
    assert.match(source("src/components/phoenix-crm/request-card.tsx"), /sameNameOnSeat/, "and the request card shows it");
  }

  // ── 2. A customer met outside the list is filed for approval ──────────────────────────────────────────────
  {
    const entry = source("src/components/phoenix-crm/out-of-list-entry.tsx");
    assert.match(entry, /proposedGrade/, "the outside entry sends the grade the request needs");
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /proposed_grade/, "and the server passes it on");
    const migration = readFileSync("supabase/migrations/20261111030456_phoenix_crm_sweep_fixes.sql", "utf8");
    assert.match(migration, /if v_mode = 'new' or v_grade is not null then/, "🔴 the database files the add request for an outside customer with a grade");
  }

  // ── 5. A merged duplicate never comes back by a request ───────────────────────────────────────────────────
  {
    const migration = readFileSync("supabase/migrations/20261111030456_phoenix_crm_sweep_fixes.sql", "utf8");
    assert.match(migration, /create or replace trigger phoenix_crm_customers_no_merged_return/);
    assert.match(migration, /raise exception 'phoenix_crm:merged_duplicate'/);
    assert.match(migration, /details ->> 'why' = 'merge_reversed'/, "the owner's own reversal (two doctors sharing one name) passes");
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.equal(
      (list.match(/await refuseAMergedDuplicate\(/g) ?? []).length,
      2,
      "both doors that file a bring-back ask first: the rep's request and the SFE Manager's own bring-back",
    );
    assert.match(source("src/lib/phoenix-crm/server/db.ts"), /merged_duplicate:\s*\{/, "and the refusal reaches the screen in words");
  }

  // ── 7, 8. Who has left, and by when ───────────────────────────────────────────────────────────────────────
  {
    assert.equal(hasLeftBy({ statusEnded: true, lastWorkingDate: "2026-11-02" }, "2026-11-03"), true, "a day after the last working day, the person has left");
    assert.equal(
      hasLeftBy({ statusEnded: true, lastWorkingDate: "2026-11-03" }, "2026-11-03"),
      false,
      "🔴 the last day is worked THROUGH: on it the person is still credited and still told",
    );
    assert.equal(hasLeftBy({ statusEnded: false, lastWorkingDate: "2026-11-20" }, "2026-11-11"), false, "serving notice, the person has not left");
    assert.equal(hasLeftBy({ statusEnded: false, lastWorkingDate: "2026-11-01T00:00:00Z" }, "2026-11-11"), true, "a timestamp is read by its date");
    assert.equal(hasLeftBy({ statusEnded: true, lastWorkingDate: null }, "2026-11-11"), true, "no date: an ended status says the person has gone");
    assert.equal(hasLeftBy({ statusEnded: false, lastWorkingDate: null }, "2026-11-11"), false);
    assert.equal(hasLeftBy({ statusEnded: false, lastWorkingDate: "" }, "2026-11-11"), false, "nothing known is never 'left'");
    assert.equal(hasLeftBy(null, "2026-11-11"), false, "an unread record fails open");

    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.match(visits, /departedBy\(\[seat\.occupantHrId\], viewer\.visitDay\)/, "the visit save asks whether the seat's rep had left by the visit day");
    assert.match(visits, /occupantLeft,\s*\}\);/, "and hands the answer to the participant check");
    assert.match(visits, /isVacantTerritory\(seat\) \|\| occupantLeft/, "a leaver's seat files the manager's own visit exactly as a vacant one does");
    assert.match(source("src/lib/phoenix-crm/scope.ts"), /if \(rep && input\.occupantLeft\) return \{ ok: false, error: SEAT_REP_LEFT \}/);
    assert.match(SEAT_REP_LEFT, /left/);

    const missed = source("src/lib/phoenix-crm/server/missed-records.ts");
    assert.equal(
      (missed.match(/await refuseADayAfterTheRepLeft\(repHrId, entry\.visitDate, isTest\)/g) ?? []).length,
      1,
      "a missed visit is refused on a day after the rep left",
    );
    assert.match(
      missed,
      /if \(!entry\.clear\) await refuseADayAfterTheRepLeft\(repHrId, entry\.activityDate, isTest\)/,
      "🔴 and a missed day is asked by its activityDate — a day activity has no visitDate, and asking by it refused nothing",
    );

    const notifications = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notifications, /isTest \? deliveries : await withoutLeavers\(deliveries\)/, "every notice drops anyone who has left before it is delivered");
    assert.match(notifications, /told\.map\(\(delivery\) => deliver\(notice, delivery, isTest\)\)/, "and only what is left is delivered");
  }

  // ── 9. "Validate again" goes to whoever holds the seat now ────────────────────────────────────────────────
  {
    assert.deepEqual(validateAgainRecipients(seat({ occupantHrId: "pd-0039" }), "AI-0009"), ["PD-0039"], "🔴 the seat's rep today, not the one who captured him");
    assert.deepEqual(
      validateAgainRecipients(seat({ occupantHrId: "PD-0039", occupants: ["PD-0039", "pd-0040", "PD-0039"] } as Partial<OrgSeat>), "AI-0009"),
      ["PD-0039", "PD-0040"],
      "both people on a seat in a handover, each once",
    );
    assert.deepEqual(validateAgainRecipients(seat({ occupantHrId: null }), "AI-0009"), ["AI-0009"], "a vacant seat falls back to the one who captured him");
  }
}
