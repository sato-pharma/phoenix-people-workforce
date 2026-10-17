import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import {
  WEEKLY_BATCH_HIDDEN_FIGURES,
  scopeWeeklyBatchesForViewer,
  weeklyScopeSeesEveryRow,
} from "../src/lib/sales/weekly/batch-list-scope.ts";
import type { WeeklyBatch } from "../src/lib/sales/weekly/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// 🔴 THE WEEKLY UPLOAD LIST HANDED THE SFE MANAGER EACH UPLOAD'S STORED TOTALS — found 2026-09-20.
//
// GET /api/sales/weekly/batches, and the Upload page's own props, returned every upload's stored units,
// stock and sales value. Those add every row the sheet holds, the restricted products (Lacto Basic 1 and 2,
// Satoslim) and the Head Office line included, and the route admits anyone holding the upload permission:
// the Super Admin AND the SFE Manager, whose weekly scope is "full, minus the restricted products". The
// screen prints only the row count and dashes for the units, so the figures were one network tab away
// rather than on the screen — which is exactly why nothing ever showed them.
//
// The scope cuts the list to null (never zero: a zero reads as "sold nothing") for any viewer who is not
// scoped to see every row. It is judged on what the route SERIALISES, since that is what reaches a browser.

type Sentinel = Record<(typeof WEEKLY_BATCH_HIDDEN_FIGURES)[number], number>;

// Distinct, unmistakable figures: a serialised list that still carries one of them has leaked it.
const SENTINEL: Sentinel = {
  totalSalesQty: 9_100_017,
  totalReturnQty: 4_400_029,
  totalNetQty: 8_600_041,
  totalBonusQty: 3_300_053,
  totalSalesValue: 7_654_321.25,
  totalStockQty: 5_500_067,
};

function batch(id: string, over: Partial<WeeklyBatch> = {}): WeeklyBatch {
  return {
    id,
    distributorCode: "D1",
    distributorName: "Distributor One",
    templateKey: "distributor-one",
    fileName: `${id}.xlsx`,
    sheetName: "Week 2",
    weekStart: "2026-09-06",
    cycleMonth: "2026-09-01",
    weekNumber: 2,
    status: "validated",
    totalRows: 1204,
    importableRows: 1200,
    failedRows: 2,
    warningRows: 2,
    ...SENTINEL,
    blockingReasons: [],
    uploadedBy: "B-10",
    columnContractSource: "code",
    createdAt: "2026-09-07T08:00:00.000Z",
    ...over,
  };
}

const SEES_EVERYTHING: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };
// The SFE Manager: the full tier, minus the restricted products, and never the Head Office line.
const SFE_MANAGER: WeeklyAccessScope = { tier: "full", canViewRestricted: false, canViewHeadOffice: false };
const BOUNDED: readonly { label: string; scope: WeeklyAccessScope }[] = [
  { label: "the SFE Manager (full tier, no restricted products, no Head Office)", scope: SFE_MANAGER },
  {
    label: "a full-tier viewer who reveals the restricted products but not the Head Office line",
    scope: { tier: "full", canViewRestricted: true, canViewHeadOffice: false },
  },
  {
    label: "a full-tier viewer who reveals the Head Office line but not the restricted products",
    scope: { tier: "full", canViewRestricted: false, canViewHeadOffice: true },
  },
  { label: "a product-list viewer", scope: { tier: "product", productCodes: new Set(["P1"]), canViewHeadOffice: false } },
  {
    label: "a territory viewer",
    scope: {
      tier: "territory",
      allowedLineNames: null,
      allowedRegionCodes: new Set(["CA"]),
      allowedAreaCodes: null,
      canViewHeadOffice: false,
    },
  },
  { label: "a viewer with no weekly access", scope: { tier: "none", canViewHeadOffice: false } },
];

/** Comments out, so an explanation that names a call cannot satisfy or trip a source check. */
function code(source: string): string {
  return stripComments(source);
}

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** Every .ts/.tsx source under app/ and src/ that calls the list function. */
function callersOfListWeeklyBatches(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && /\blistWeeklyBatches\(/.test(code(readFileSync(full, "utf8")))) {
        found.push(relative(process.cwd(), full).split(sep).join("/"));
      }
    }
  };
  walk(join(process.cwd(), "app"));
  walk(join(process.cwd(), "src"));
  return found.sort();
}

export function runWeeklyBatchListScopeTests() {
  const batches = [batch("b1"), batch("b2", { distributorName: "Distributor Two", totalRows: 88 })];

  // ── The one viewer who sees every row keeps every figure ─────────────────────────────────────────
  {
    assert.equal(weeklyScopeSeesEveryRow(SEES_EVERYTHING), true, "the Super Admin / CEO scope sees every row");
    const listed = scopeWeeklyBatchesForViewer(batches, SEES_EVERYTHING);
    assert.deepEqual(listed, batches, "the Super Admin's list is untouched");
    const wire = JSON.stringify(listed);
    for (const figure of WEEKLY_BATCH_HIDDEN_FIGURES) {
      assert.ok(wire.includes(String(SENTINEL[figure])), `the Super Admin still reads ${figure}`);
    }
  }

  // ── Every bounded viewer gets the figures withheld — null, never zero, never a smaller number ────
  for (const { label, scope } of BOUNDED) {
    assert.equal(weeklyScopeSeesEveryRow(scope), false, `${label} does not see every row`);
    const listed = scopeWeeklyBatchesForViewer(batches, scope);
    assert.equal(listed.length, batches.length, `${label}: every upload is still listed`);

    listed.forEach((item, index) => {
      for (const figure of WEEKLY_BATCH_HIDDEN_FIGURES) {
        assert.equal(item[figure], null, `${label}: ${figure} of ${item.id} is withheld as null (not 0)`);
      }
      // Everything else about the upload is what the screen prints and acts on, and it is unchanged.
      const rest = (row: WeeklyBatch) => {
        const copy: Partial<WeeklyBatch> = { ...row };
        for (const figure of WEEKLY_BATCH_HIDDEN_FIGURES) delete copy[figure];
        return copy;
      };
      assert.deepEqual(rest(item), rest(batches[index]), `${label}: nothing but the stored totals changed on ${item.id}`);
      assert.equal(item.totalRows, batches[index].totalRows, `${label}: the row count is the file's length and stays`);
    });

    // The emitted artifact: what the route puts on the wire carries none of the figures.
    const wire = JSON.stringify({ success: true, data: listed });
    for (const figure of WEEKLY_BATCH_HIDDEN_FIGURES) {
      assert.ok(!wire.includes(String(SENTINEL[figure])), `${label}: the serialised list carries no trace of ${figure}`);
    }
  }

  // ── The input is not mutated (the page reuses what it loaded) ────────────────────────────────────
  {
    const before = JSON.stringify(batches);
    scopeWeeklyBatchesForViewer(batches, SFE_MANAGER);
    assert.equal(JSON.stringify(batches), before, "scoping returns copies and leaves the loaded list alone");
  }

  // ── A new stored total on WeeklyBatch cannot slip past the list of withheld figures ──────────────
  {
    const totalsOnTheType = Object.keys(batches[0])
      .filter((key) => /^total/.test(key) && key !== "totalRows")
      .sort();
    assert.deepEqual(
      [...WEEKLY_BATCH_HIDDEN_FIGURES].sort(),
      totalsOnTheType,
      "every total* field of an upload other than its row count is withheld from a bounded viewer",
    );
  }

  // ── Both doors that hand the list to a browser cut it ────────────────────────────────────────────
  {
    const route = code(read("app/api/sales/weekly/batches/route.ts"));
    const get = route.slice(route.indexOf("export async function GET("), route.indexOf("export async function DELETE("));
    assert.match(get, /const scope = await resolveWeeklyAccessScope\(access\);/, "the GET route resolves the viewer's weekly scope");
    assert.match(
      get,
      /scopeWeeklyBatchesForViewer\(await listWeeklyBatches\(\), scope\)/,
      "the GET route sends the list through the scope, never listWeeklyBatches() alone",
    );
    assert.doesNotMatch(get, /data = await listWeeklyBatches\(\)/, "the GET route no longer returns the uncut list");

    const page = code(read("app/(admin)/sales/weekly/page.tsx"));
    assert.match(page, /const scope = await resolveWeeklyAccessScope\(access\);/, "the Upload page resolves the viewer's weekly scope");
    assert.match(
      page,
      /initialBatches = scopeWeeklyBatchesForViewer\(loadedBatches, scope\);/,
      "the Upload page's own props carry the cut list",
    );
    assert.doesNotMatch(
      page,
      /initialBatches\s*\]?\s*=\s*await\s+Promise\.all|\[distributors, initialBatches\]/,
      "the Upload page no longer assigns the uncut list to its props",
    );

    const listSource = code(read("src/lib/sales/weekly/batch-list-scope.ts"));
    assert.match(
      listSource,
      /export function scopeWeeklyBatchesForViewer\(\s*batches: readonly WeeklyBatch\[\],\s*scope: WeeklyAccessScope,\s*\)/,
      "the scope is a required argument with no default: a caller that forgets it does not compile",
    );
  }

  // ── No third caller can send the uncut list anywhere ─────────────────────────────────────────────
  // The three exports only read the newest upload's period tags to pick a default; they print no total.
  {
    const callers = callersOfListWeeklyBatches();
    assert.deepEqual(
      callers,
      [
        "app/(admin)/sales/weekly/page.tsx",
        "app/api/sales/weekly/batches/route.ts",
        "app/api/sales/weekly/nsm-dsm-export/route.ts",
        "app/api/sales/weekly/summary-export/route.ts",
        "src/lib/sales/weekly/portal-nsm-dsm-export.ts",
        "src/lib/sales/weekly/service.ts",
      ],
      "a new caller of listWeeklyBatches must cut its list with scopeWeeklyBatchesForViewer, or read only period tags",
    );
    for (const periodOnly of [
      "app/api/sales/weekly/nsm-dsm-export/route.ts",
      "app/api/sales/weekly/summary-export/route.ts",
      // The portal NSM/DSM download: it reads the list for ONE thing, the latest validated upload's
      // cycle MONTH, when the manager named no month. Nothing from an upload's header reaches him.
      "src/lib/sales/weekly/portal-nsm-dsm-export.ts",
    ]) {
      const source = code(read(periodOnly));
      for (const figure of WEEKLY_BATCH_HIDDEN_FIGURES) {
        assert.ok(!source.includes(figure), `${periodOnly} reads the upload list for its period tags only, never ${figure}`);
      }
    }
  }
}
