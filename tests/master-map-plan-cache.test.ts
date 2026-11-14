import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { buildMasterMapTree } from "../src/lib/sales/master-map/tree.ts";
import {
  FORMAT_VERSION,
  createMasterMapPayload,
  fingerprintMasterMapSource,
  hashValues,
  type MasterMapPayloadDeps,
} from "../src/lib/sales/master-map/payload.ts";
import { stripComments } from "./support/comment-strip.ts";

// The sheet's script asks Phoenix for the whole plan once an hour whatever the cheap stamp says, and that
// used to reload and rebuild ~74,000 shops on the one thread that serves every page: a five-second freeze
// of the whole site, once an hour, at the same second as that request (24 Oct 2026, nine of nine freezes
// read in Railway's request logs). An hour with nothing changed must now cost no tree, no render, no hash —
// and a change MUST still show, because the hourly comparison is how a hand-edited row self-heals.

type Source = Awaited<ReturnType<MasterMapPayloadDeps["loadSource"]>>;

function makeSource(overrides: { customerName?: string; distributorOrder?: "ab" | "ba"; manager?: string } = {}): Source {
  const distributorNames = new Map<string, string>(
    overrides.distributorOrder === "ba"
      ? [["B", "Bravo Pharma"], ["A", "Alpha Pharma"]]
      : [["A", "Alpha Pharma"], ["B", "Bravo Pharma"]],
  );
  return {
    areaManagers: [{ areaCode: "UE1", lineName: "CNS", manager: overrides.manager ?? "Amgad" }],
    areas: [{ areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" }],
    bricks: [{ areaCode: "UE1", brickId: "B-MINIA", brickName: "Minia Centre" }],
    customers: [
      {
        address: "12 Corniche",
        brickId: "B-MINIA",
        customerCode: "1001",
        customerName: overrides.customerName ?? "Al Nour Pharmacy",
        distributorCode: "A",
        source: "admin-import",
      },
      {
        address: "",
        brickId: "B-MINIA",
        customerCode: "2002",
        customerName: "Bravo Corner",
        distributorCode: "B",
        source: "admin-import",
      },
    ],
    distributorNames,
    organogramAreas: [{ areaCode: "UE1", lineName: "CNS", regionCode: "UE" }],
    regions: [{ regionCode: "UE", regionName: "Upper Egypt" }],
  };
}

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export async function runMasterMapPlanCacheTests() {
  // --- the fingerprint: stable for the same content, moved by any real change ---------------------------
  const noPause = async () => {};
  const base = await fingerprintMasterMapSource(makeSource(), noPause);
  assert.equal(await fingerprintMasterMapSource(makeSource(), noPause), base, "the same content must fingerprint the same");
  assert.equal(
    await fingerprintMasterMapSource(makeSource({ distributorOrder: "ba" }), noPause),
    base,
    "the distributor Map's insertion order is the order PostgREST answered in and means nothing — it must not move the key",
  );
  assert.notEqual(
    await fingerprintMasterMapSource(makeSource({ customerName: "Al Nour Pharmacie" }), noPause),
    base,
    "a hand-edited customer name — the very edit the cheap stamp cannot see — must move the key",
  );
  assert.notEqual(
    await fingerprintMasterMapSource(makeSource({ manager: "Vacant" }), noPause),
    base,
    "a new manager in a seat must move the key",
  );

  // Slices: a source of 5,000 customers is hashed in 3 slices of 2,000, with a yield after each.
  const big = makeSource();
  big.customers = Array.from({ length: 5_000 }, (_, index) => ({
    address: null,
    brickId: "B-MINIA",
    customerCode: String(index),
    customerName: `Shop ${index}`,
    distributorCode: "A",
    source: null,
  }));
  let pauses = 0;
  await fingerprintMasterMapSource(big, async () => {
    pauses += 1;
  });
  assert.ok(pauses >= 3, `the customer rows must be hashed in slices with a yield between them — got ${pauses} yields`);

  // The tab hash must be BYTE-IDENTICAL to one unbroken pass over the rows: slicing it with yields must not move a
  // single tab's hash, or every tab would repaint once on the deploy and the sheet's 4.45 million cells with it.
  const rows = Array.from({ length: 6_500 }, (_, index) => [`Shop ${index}`, "أ", index % 7 === 0 ? "" : "x"]);
  const reference = createHash("sha1");
  reference.update(FORMAT_VERSION);
  for (const row of rows) reference.update(JSON.stringify(row));
  let hashPauses = 0;
  assert.equal(
    await hashValues(rows, async () => {
      hashPauses += 1;
    }),
    reference.digest("hex").slice(0, 16),
    "the sliced tab hash must equal the one-pass hash byte for byte",
  );
  assert.ok(hashPauses >= 3, `the tab hash must yield between slices — got ${hashPauses} yields for 6,500 rows`);
  assert.equal(await hashValues([], noPause), createHash("sha1").update(FORMAT_VERSION).digest("hex").slice(0, 16), "an empty tab still hashes (the format version alone)");

  // --- the payload: an unchanged hour rebuilds nothing; a change rebuilds and shows -----------------------
  let builds = 0;
  let loads = 0;
  let nowMs = Date.parse("2026-10-24T00:00:00Z");
  let stamp = "stamp-1";
  let source = makeSource();
  const payload = createMasterMapPayload({
    buildTree: (input) => {
      builds += 1;
      return buildMasterMapTree(input);
    },
    loadSource: async () => {
      loads += 1;
      return source;
    },
    now: () => nowMs,
    pause: noPause,
    readStamp: async () => stamp,
  });

  const first = await payload.getMasterMapPlan();
  assert.equal(builds, 1, "the first plan builds the tree once");
  assert.ok(first.tabs.length >= 3, "the plan names the tabs");

  // Within the cache window and the stamp unchanged: not even a reload.
  nowMs += 5 * 60_000;
  const quick = await payload.getMasterMapPlan();
  assert.equal(loads, 1, "inside the 15-minute window with the stamp unchanged nothing is reloaded");
  assert.deepEqual(quick.tabs, first.tabs);

  // THE HOURLY CHECK: the window has expired, so the source is read in full again — and nothing changed.
  nowMs += 60 * 60_000;
  const hourly = await payload.getMasterMapPlan();
  assert.equal(loads, 2, "the hourly check still reads the whole source — that read IS the content comparison");
  assert.equal(builds, 1, "an hour with nothing changed must NOT rebuild the tree");
  assert.deepEqual(hourly.tabs, first.tabs, "the tabs, hashes and chunk counts are the snapshot's, unchanged");
  assert.equal(hourly.generatedAt, new Date(nowMs).toISOString(), "the answer carries the time it was given, not the snapshot's");

  // The stamp moves but the content does not (an updated_at bump): still no rebuild, and the new stamp is reported.
  stamp = "stamp-2";
  nowMs += 60 * 60_000;
  const restamped = await payload.getMasterMapPlan();
  assert.equal(builds, 1, "a moved stamp over identical content must not rebuild the tree");
  assert.equal(restamped.stamp, "stamp-2", "the plan reports the stamp it was answered under");
  assert.deepEqual(restamped.tabs, first.tabs);
  const staleSlice = await payload.getMasterMapSlice({ chunk: 0, part: "values", sheetId: 7, stamp: "stamp-1", title: first.tabs[1]?.title ?? "" });
  assert.equal(staleSlice?.restart, true, "a slice cut under the OLD stamp is still told to restart");
  assert.equal(staleSlice?.stamp, "stamp-2");

  // Slices: a repaint asks for one tab in many pieces, and the tab is rendered once for them, not once a piece.
  // ONE tab at a time, as the script asks: walking every tab would evict the data tab from the two kept
  // renders before the heal below, and the stale-render case would never be exercised.
  const sliceOf = async (title: string, sheetId = 7) => {
    const slice = await payload.getMasterMapSlice({ chunk: 0, part: "values", sheetId, stamp: "stamp-2", title });
    return slice?.part === "values" ? JSON.stringify(slice.values) : "";
  };
  const shopTabs: string[] = [];
  for (const tab of restamped.tabs) if (/Al Nour Pharmacy/.test(await sliceOf(tab.title))) shopTabs.push(tab.title);
  assert.ok(shopTabs.length >= 1, "the slices show the shop as the snapshot holds it");
  const shopTab = shopTabs[0];
  const beforeHeal = await sliceOf(shopTab);
  assert.equal(await sliceOf(shopTab), beforeHeal, "a kept render answers exactly what a fresh render would");

  // A hand-edited row: the stamp does NOT move (that is the whole case), the hourly read finds it.
  source = makeSource({ customerName: "Al Nour Pharmacie" });
  nowMs += 60 * 60_000;
  const healed = await payload.getMasterMapPlan();
  assert.equal(builds, 2, "a changed input must rebuild the tree");
  const changedTabs = healed.tabs.filter((tab, index) => tab.hash !== first.tabs[index]?.hash).map((tab) => tab.title);
  assert.ok(changedTabs.length >= 1, "and the tab that shows that shop must carry a NEW hash, so the sheet repaints it");
  const afterHeal = await sliceOf(shopTab);
  assert.match(afterHeal, /Al Nour Pharmacie/, "after a rebuild the slices must show the NEW data — a render kept from the old tree must never answer");
  assert.doesNotMatch(afterHeal, /Al Nour Pharmacy"/, "and the old spelling must be gone from every slice");
  const clearFor7 = await payload.getMasterMapSlice({ chunk: 0, part: "clear", sheetId: 7, stamp: "stamp-2", title: shopTab });
  const clearFor8 = await payload.getMasterMapSlice({ chunk: 0, part: "clear", sheetId: 8, stamp: "stamp-2", title: shopTab });
  assert.notDeepEqual(clearFor7, clearFor8, "a render is kept per tab id — the formatting requests carry the sheet id, so one tab's must never answer another's");

  // And the next unchanged hour after that is cheap again.
  nowMs += 60 * 60_000;
  const after = await payload.getMasterMapPlan();
  assert.equal(builds, 2, "the hour after a heal rebuilds nothing");
  assert.deepEqual(after.tabs, healed.tabs);

  // A plan that fails to cut is not remembered: the next call tries again.
  let failOnce = true;
  const flaky = createMasterMapPayload({
    buildTree: (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("tree failed");
      }
      return buildMasterMapTree(input);
    },
    loadSource: async () => makeSource(),
    now: () => nowMs,
    pause: noPause,
    readStamp: async () => "s",
  });
  await assert.rejects(() => flaky.getMasterMapPlan(), /tree failed/);
  const recovered = await flaky.getMasterMapPlan();
  assert.ok(recovered.tabs.length >= 3, "a failed build must not poison the next call");

  // --- source pins ------------------------------------------------------------------------------------------
  const payload2 = read("src/lib/sales/master-map/payload.ts");
  assert.match(
    payload2,
    /const FINGERPRINTED_FIELDS: Record<keyof LoadedSource, true> = \{/,
    "the fingerprint must be typed against EVERY field the loader returns, so a new input can never be left out of it",
  );
  assert.match(
    payload2,
    /previous\.sourceKey === sourceKey[\s\S]*?const reused: CachedWorkbook = \{ \.\.\.previous, loadedAt: deps\.now\(\), stamp \};/,
    "an unchanged fingerprint must reuse the cached tree and plan",
  );
  assert.match(
    payload2,
    /await deps\.pause\(\);\s*const tree = await deps\.buildTree\(source, deps\.pause\);\s*const workbook: CachedWorkbook = \{[\s\S]*?\btree,/,
    "a real rebuild still yields to the loop before it builds the tree",
  );
  assert.match(
    payload2,
    /const rendered = renderedForSlices\(workbook, options\.title, options\.sheetId\);/,
    "a slice cuts its piece from the kept render, never from a whole new render of the tab",
  );
  assert.match(payload2, /plan: null,\s*renders: new Map\(\),/, "a rebuilt snapshot starts with no kept renders");
  assert.match(payload2, /await deps\.pause\(\);\s*\/\/ sheetId 0 is a placeholder|for \(const title of tabTitles\(\)\) \{\s*await deps\.pause\(\);/, "the plan yields between tabs");
  assert.doesNotMatch(
    payload2,
    /for \(const row of values\) \{\s*digest\.update\(JSON\.stringify\(row\)\);/,
    "the tab hash must not be one unbroken pass over ~74,000 rows",
  );
}
