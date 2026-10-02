import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the UI gaps the 2026-10-02 audit confirmed in source, pinned so they stay closed.
 *
 *   1. A raw brick code never becomes a heading. A brick the master holds no name for keeps its id as
 *      the group KEY and reads as words; the code had reached the List board heading, the Brick
 *      filter, the export and the Reports bricks table. (Behaviour is pinned in
 *      phoenix-crm-customer-list-board and phoenix-crm-brick-coverage-report; this holds the source.)
 *   2. Desktop table and phone card print the SAME facts (AGENTS.md §4: "desktop shows full tables,
 *      mobile gets cards" — the same rows, not fewer facts). Five places dropped one side's line.
 *   3. The square edge reaches the native audio player on the ADMIN shell, whose globals block has no
 *      audio rule, and every native date/time field carries `appearance-none`.
 *   4. `shrink-0` beside a `flex-wrap` makes the wrap inert — the exact pattern the fits-the-screen
 *      rule names — so no class list in the module carries both.
 *
 * Each check reads source, so each fails the moment its line is reverted.
 */

const read = (path: string) => stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
const count = (text: string, needle: string) => text.split(needle).length - 1;

const CRM_DIR = "src/components/phoenix-crm/";

export function runPhoenixCrmCardTableParityTests() {
  // ── 1. No raw brick code as a label ─────────────────────────────────────────────────────────────
  {
    const grouping = read("src/lib/phoenix-crm/customer-list-grouping.ts");
    assert.doesNotMatch(grouping, /brickName \?\? (place|reference)\.brickId/, "a group heading must never fall back to the brick id");
    assert.match(grouping, /heading: place\.brickName\?\.trim\(\) \|\| UNNAMED_BRICK/, "a placed customer's unnamed brick reads as the label");
    assert.match(grouping, /heading: reference\.brickName\?\.trim\(\) \|\| UNNAMED_BRICK/, "a pending customer's unnamed brick reads as the label");
    const report = read("src/lib/phoenix-crm/brick-report.ts");
    assert.doesNotMatch(report, /\|\| brickId\)/, "a bricks-report row must never be labelled by its id");
    assert.ok(report.includes("|| UNNAMED_BRICK_LABEL)"), "it ends in the name label instead");
  }

  // ── 2. Table and card carry the same facts ─────────────────────────────────────────────────────
  {
    const reports = read(`${CRM_DIR}reports-tab.tsx`);
    // Visits PM/AM, Plan PM/AM, Coverage PM/AM: the table's DeltaLine has a card twin in each.
    assert.ok(
      count(reports, "{deltaFact(changes.get(") >= 6,
      "every comparison line a Reports table prints under a cell, its phone card prints too (visits, plan and coverage, PM and AM)",
    );
    // Locations: the card's accuracy and place point are in the table as well.
    assert.equal(count(reports, "row.placeLat.toFixed(5)"), 2, "the place's point is printed by the Locations card AND its table");
    assert.equal(count(reports, "` (accuracy ${countText(Math.round(row.accuracyMeters))} m)`"), 2, "and so is the reading's accuracy");

    const integrity = read("app/(admin)/admin/phoenix-crm/integrity/page.tsx");
    assert.equal(count(integrity, "<Position entry={entry} />"), 2, "the integrity board's Position column is in its phone card too, from one component");

    const team = read(`${CRM_DIR}team-tab.tsx`);
    assert.ok(
      team.includes("meta={[row.territory.regionName, metaText(row.territory, team.viewerHrId, false)]"),
      "the Customer lists card names the territory's region, as its table does",
    );

    const visits = read(`${CRM_DIR}visits-tab.tsx`);
    assert.ok(count(visits, "visit.unplanned.note") >= 2, "the off-plan note the visit card prints is in the table's Standing cell too");
  }

  // ── 3. Square audio on the admin shell, and native date/time fields ────────────────────────────
  {
    for (const file of ["voice-playback.tsx", "speak.tsx"]) {
      const code = read(`${CRM_DIR}${file}`);
      const audio = code.slice(code.indexOf("<audio"), code.indexOf("/>", code.indexOf("<audio")));
      assert.ok(audio.length > 0, `${file} still renders an <audio> player`);
      for (const part of ["rounded-none", "[&::-webkit-media-controls-enclosure]:rounded-none", "[&::-webkit-media-controls-panel]:rounded-none"]) {
        assert.ok(audio.includes(part), `${file}'s <audio> carries ${part} — the admin shell has no audio rule to square it`);
      }
    }

    let fields = 0;
    for (const file of readdirSync(CRM_DIR).filter((name) => name.endsWith(".tsx"))) {
      const code = read(`${CRM_DIR}${file}`);
      for (const chunk of code.split("<input").slice(1)) {
        const element = chunk.slice(0, chunk.indexOf("/>"));
        if (!/type="(time|date|month|datetime-local)"/.test(element)) continue;
        fields += 1;
        assert.match(element, /appearance-none/, `${file}: a native date/time field must carry appearance-none like the module's others`);
      }
    }
    assert.ok(fields >= 15, `the date/time sweep found ${fields} fields — a sweep that reads nothing reads green`);
  }

  // ── 4. No shrink-0 on a wrapping row ───────────────────────────────────────────────────────────
  {
    const both = /className="[^"]*\bshrink-0\b[^"]*\bflex-wrap\b[^"]*"|className="[^"]*\bflex-wrap\b[^"]*\bshrink-0\b[^"]*"/;
    let files = 0;
    for (const file of readdirSync(CRM_DIR).filter((name) => name.endsWith(".tsx"))) {
      files += 1;
      assert.doesNotMatch(read(`${CRM_DIR}${file}`), both, `${file}: shrink-0 beside flex-wrap makes the wrap inert — use min-w-0`);
    }
    assert.ok(files >= 20, `the shrink-0 sweep read ${files} files`);
  }
}
