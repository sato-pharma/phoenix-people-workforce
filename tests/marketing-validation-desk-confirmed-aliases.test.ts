import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { uniqueAliasNames } from "../src/lib/marketing-requests/service.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * "Also known as" on the marketing validation desk (owner, 2026-10-02).
 *
 * This is the most dangerous screen in the system to put a cross-system note on: a licence verdict
 * recorded here is PERMANENT and has no correction path (§4.1). So every rule below is about the
 * line staying a note — never evidence, never a gate, and never visible to someone who may not see
 * the customer behind it.
 */
export function runMarketingValidationDeskAliasTests() {
  const service = stripComments(readFileSync("src/lib/marketing-requests/service.ts", "utf8"));
  const screen = stripComments(readFileSync("src/components/employee-portal/marketing-validation-workspace.tsx", "utf8"));

  // ── Confirmed links only ─────────────────────────────────────────────────────────────────────
  assert.match(service, /loadAlsoKnownAsBatch\("marketing"/, "the desk reads confirmed links through the batch reader");
  assert.doesNotMatch(
    service,
    /suggestIdentityPairs|judgePair/,
    "the marketing service must never reach the suggestion engine — a maybe beside an uncorrectable verdict is the worst place in the system to show one",
  );

  const workspace = service.slice(service.indexOf("export async function getMarketingValidationWorkspace"));
  const body = workspace.slice(0, workspace.indexOf("\n}\n") + 1);
  assert.ok(body.length > 0 && body.length < service.length / 4, "the workspace slice must find its markers");

  // ── Never wider than the viewer ──────────────────────────────────────────────────────────────
  // 🔴 READ AFTER THE VISIBILITY FILTER. A viewer who may not see a customer must not learn one of
  //    its venues exists because an alias mentions it — the same rule the rows themselves obey.
  assert.ok(
    body.indexOf("visibleLinks") < body.indexOf("loadAlsoKnownAsBatch"),
    "the aliases are read from the VISIBLE links only, never from every link on the workspace",
  );
  assert.match(
    body,
    /visibleLinks\.map\(\(row\) => row\.pharmacy_id\)/,
    "and keyed on the pharmacies those visible links point at",
  );

  // ── It never fails the desk ──────────────────────────────────────────────────────────────────
  // The verdict is the desk's job; an annotation from another module is not a reason to lose it.
  assert.match(body, /\.catch\(\(\) => new Map<string, string\[\]>\(\)\)/, "a failure costs the annotation, never the screen");

  // ── It is not a verdict and cannot become one ────────────────────────────────────────────────
  const mapper = service.slice(service.indexOf("function mapValidationReportRows"));
  const mapperBody = mapper.slice(0, mapper.indexOf("\n}\n") + 1);
  assert.match(
    mapperBody,
    /alsoKnownAs: uniqueAliasNames\(params\.aliasesByPharmacyId\?\.get\(pharmacy\.id\) \?\? \[\], pharmacy\.displayName\)/,
    "each row carries its venue's confirmed names, deduped and without its own",
  );

  // 🔴 BOTH HALVES WERE FOUND ON A REAL SCREEN, NOT IN REVIEW. `othersOnMaster` drops the row
  //    ASKED ABOUT by source and id; it cannot know a DIFFERENT row on the same master carries
  //    the identical spelling. On production, Victoria hospital's master listed
  //    "صيدلية مستشفي فيكتوريا" twice and "السيد ابو الفتوح" read as an alias of itself.
  assert.deepEqual(
    uniqueAliasNames(["صيدلية مستشفي فيكتوريا", "صيدلية مستشفي فيكتوريا", "مستشفي فيكتوريا"], "صيدلية مستشفى فيكتوريا"),
    ["صيدلية مستشفي فيكتوريا", "مستشفي فيكتوريا"],
    "a spelling confirmed on two rows of one master is printed once",
  );
  assert.deepEqual(
    uniqueAliasNames(["السيد ابو الفتوح"], "السيد ابو الفتوح"),
    [],
    "a venue is never an alias of itself, however many rows the master holds",
  );
  assert.deepEqual(uniqueAliasNames([" ", ""], "x"), [], "blank names are not aliases");
  // 🔴 THE ONE THING THAT MUST NEVER HAPPEN: a confirmed link changing what the desk reports as
  //    validated. `validationStatus` comes from the LINK and from nothing else.
  assert.match(mapperBody, /validationStatus: link\.validationStatus/, "the status still comes from the link alone");
  const statusLine = mapperBody.slice(mapperBody.indexOf("validationStatus:"));
  assert.doesNotMatch(
    statusLine.slice(0, 120),
    /alsoKnownAs|aliases/,
    "an alias must never participate in deciding the validation status",
  );

  // ── The screen shows it without instructing anyone ───────────────────────────────────────────
  assert.match(screen, /pharmacy\.alsoKnownAs\.length > 0 \?/, "the line renders only when there is a confirmed link");
  assert.match(screen, /also known as/, "and says what it is in plain words");
  // 🔴 NEUTRAL INK. The wholesaler note beside it is amber because it asks the human to doubt
  //    something; this asks him to doubt nothing, and a line that LOOKS like a warning on a screen
  //    recording permanent verdicts will be read as one.
  // Both layouts, because this screen renders phone cards and a desktop table separately and a
  // line added to one of them is invisible to half the people who use it.
  assert.equal(
    screen.split("also known as ").length - 1,
    2,
    "the line is rendered in BOTH the phone card and the desktop table",
  );
  // Scoped to the alias element itself — the amber wholesaler note sits directly beneath it in
  // both layouts, so a window that runs past `) : null}` reads that note's colour as this one's.
  for (const layout of ["phone card", "desktop table"]) {
    const at = layout === "phone card"
      ? screen.indexOf("alsoKnownAs.length > 0")
      : screen.indexOf("alsoKnownAs.length > 0", screen.indexOf("alsoKnownAs.length > 0") + 1);
    assert.ok(at > 0, `${layout}: the alias block must exist`);
    const block = screen.slice(at, screen.indexOf(") : null}", at));
    assert.doesNotMatch(block, /amber|rose|red-|warning/, `${layout}: the alias line must not borrow a warning's colour`);
    assert.match(block, /text-slate-500/, `${layout}: it is neutral ink, like the other facts on the row`);
  }
  assert.match(screen, /alsoKnownAs: row\.alsoKnownAs/, "it is carried per pharmacy, like the wholesaler note");
}
