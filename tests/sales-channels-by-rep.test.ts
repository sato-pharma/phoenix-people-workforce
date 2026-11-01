import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertChannelsByRepReadAllowed,
  ChannelsByRepRefused,
  channelStems,
  excludedProductCodes,
  labelFor,
  mapChannelsByRepRow,
  resolveChannelsByRepPeriod,
  totalsFor,
} from "../src/lib/sales/channels-by-rep.ts";
import { CHANNELS_BY_REP_WHOLE_HISTORY } from "../src/lib/sales/periods.ts";
import {
  HOSPITAL_NAME_KEYWORDS,
  normalizeCustomerName,
  STORE_NAME_KEYWORDS,
} from "../src/lib/sales/customer-channel.ts";
import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/access-scope.ts";

export async function runSalesChannelsByRepTests() {
  // ── the stems must be DERIVED, never a second copy ──────────────────────────────────────────
  // customer-channel.ts declares itself THE single edit point: "adding an entry re-classifies all
  // history". A hardcoded copy in the service or in SQL breaks that silently the first time one is
  // edited and the other is not. This is not hypothetical — a hand-transcribed copy of these six
  // words mis-stated the store channel by 8.7M EGP and 94 customers before it was caught.
  const stems = channelStems();
  assert.deepEqual(
    stems.store,
    STORE_NAME_KEYWORDS.map((k) => normalizeCustomerName(k.stem)),
    "store stems must be derived from STORE_NAME_KEYWORDS, not copied",
  );
  assert.deepEqual(
    stems.hospital,
    HOSPITAL_NAME_KEYWORDS.map((k) => normalizeCustomerName(k.stem)),
    "hospital stems must be derived from HOSPITAL_NAME_KEYWORDS, not copied",
  );
  // Folded, so they can be compared against a folded customer name: الشركة -> الشركه.
  assert.ok(stems.store.includes("الشركه"), "stems must be folded the way a name will be folded");
  assert.ok(!stems.store.includes(""), "a blank stem would match every name");

  // ── restricted products: excluded by default, revealable only by CEO / Super Admin ───────────
  // Those three codes are 81.5% of all sales value, so this gate decides whether the tab shows the
  // business or a fifth of it — and it must fail CLOSED for every other role.
  assert.deepEqual(
    excludedProductCodes("Super Admin", false),
    [...RESTRICTED_PRODUCT_CODES],
    "restricted products are excluded by DEFAULT even for a Super Admin",
  );
  assert.deepEqual(
    excludedProductCodes("Super Admin", true),
    [],
    "a Super Admin who opts in may reveal them",
  );
  assert.deepEqual(
    excludedProductCodes("CEO", true),
    [],
    "a CEO who opts in may reveal them",
  );
  assert.deepEqual(
    excludedProductCodes("Medical Rep", true),
    [...RESTRICTED_PRODUCT_CODES],
    "opting in must be IGNORED for every other role — API tampering cannot reveal them",
  );

  // ── attribution buckets ─────────────────────────────────────────────────────────────────────
  // Sales that reach no person are ~27% of value. They must survive as their own labelled rows,
  // because a per-rep table that adds to less than the company total is a table that gets
  // questioned — and the gap is the interesting part, not noise to hide.
  const rep = mapChannelsByRepRow({
    seat_id: "SEAT-1", rep_hr_id: "HR-1", rep_name: "Adel Srour",
    line_code: "cns", area_code: "A1", area_name: "Cairo East",
    hospital_value: 10, store_value: 20, pharmacy_value: 70, total_value: 100,
    hospital_customers: 1, store_customers: 2, pharmacy_customers: 7,
  });
  assert.equal(rep.attribution, "rep");
  assert.equal(rep.label, "Adel Srour", "a rep row is labelled with the person's name");

  // The tab prints this field on the table and the phone card; it printed "cns" until it did.
  assert.equal(rep.lineName, "CNS", "the line reads as its name, never its code");
  assert.equal(
    mapChannelsByRepRow({ line_code: "anti_infective" }).lineName,
    "Anti Infective",
    "anti_infective is the code most obviously not a name",
  );
  assert.equal(mapChannelsByRepRow({ line_code: "pedia" }).lineName, "Pedia");
  assert.equal(mapChannelsByRepRow({ line_code: null }).lineName, null, "no line stays no line, for the tab's dash");
  assert.equal(
    mapChannelsByRepRow({ line_code: "new_line" }).lineName,
    "new_line",
    "an unknown code stays visible rather than vanishing or being guessed at",
  );

  const channelsTabSource = readFileSync("src/components/sales/channels-by-rep-tab.tsx", "utf8");
  assert.ok(!channelsTabSource.includes('"lineCode"'), "the sort column must key on the name, or the Line header stops sorting");
  assert.equal(
    channelsTabSource.split("row.lineCode").length - 1,
    2,
    "the tab may use the code only in its two React keys; printing, sorting or searching it shows a code to the reader",
  );

  const vacant = mapChannelsByRepRow({
    seat_id: "SEAT-2", rep_hr_id: null, rep_name: null,
    area_code: "A2", area_name: "Giza West", total_value: 50,
  });
  assert.equal(vacant.attribution, "vacant-seat", "a seat with no occupant is its own bucket");
  assert.equal(vacant.label, "Vacant seat — Giza West");

  const unmapped = mapChannelsByRepRow({
    seat_id: null, rep_hr_id: null, rep_name: null, area_code: null, total_value: 25,
  });
  assert.equal(unmapped.attribution, "unmapped", "no seat at all is a third, distinct bucket");
  assert.equal(unmapped.label, "Not on the seat model");

  // A vacant seat with no area name still says what it is rather than rendering blank.
  assert.equal(labelFor({ areaCode: null, areaName: null, attribution: "vacant-seat", repName: null }), "Vacant seat");

  // ── totals ──────────────────────────────────────────────────────────────────────────────────
  const totals = totalsFor([rep, vacant, unmapped]);
  assert.equal(totals.totalValue, 175, "totals cover every row, attributed or not");
  assert.equal(
    totals.unattributedValue,
    75,
    "unattributed is the vacant seat plus the unmapped rows — never the rep's",
  );
  assert.equal(totals.pharmacyValue, 70);
  assert.equal(totals.hospitalValue, 10);
  assert.equal(totals.storeValue, 20);

  // ── which month a request reads ─────────────────────────────────────────────────────────────
  // The shape of production on 2026-11-01: the two newest months hold 1 and 55 rows. The whole history
  // takes about 30 s, so it must be asked for by name; nothing else may fall through to it.
  const available = ["2026-11", "2026-10", "2026-09", "2026-08"];
  const resolve = (requested: string | null | undefined, latestPublished: string | null = "2026-09") =>
    resolveChannelsByRepPeriod({ available, latestPublished, requested });

  assert.equal(resolve(null), "2026-09", "the tab opens on the newest published closing");
  assert.equal(resolve(undefined), "2026-09", "no month asked for is the same as null");
  assert.equal(resolve("2026-08"), "2026-08", "a month that was picked is the month read");
  assert.equal(resolve(CHANNELS_BY_REP_WHOLE_HISTORY), null, "the whole history, asked for by name");
  assert.equal(resolve("not-a-month"), "2026-09", "a malformed month must never become the whole history");
  assert.equal(resolve(""), "2026-09", "an empty month must never become the whole history");

  // Nothing published: the newest month that has started, never one a direct order booked ahead.
  assert.equal(
    resolveChannelsByRepPeriod({ available: ["2999-01", "2026-09"], latestPublished: null, requested: null }),
    "2026-09",
    "with nothing published, the newest month that has started",
  );
  assert.equal(
    resolveChannelsByRepPeriod({ available: ["2999-01"], latestPublished: null, requested: null }),
    "2999-01",
    "only future months: still one month, not the whole history",
  );
  assert.equal(
    resolveChannelsByRepPeriod({ available: [], latestPublished: null, requested: null }),
    null,
    "no months at all is the one other way to reach null, and there is nothing for it to read",
  );

  // ── the whole history with nothing excluded is refused, for every role ──────────────────────
  // Staging restarted uncleanly 7 min 45 s into this read, and nothing can stop it once it starts.
  // Reveal resolves to an empty list only for a CEO or Super Admin, so those are the roles at stake.
  for (const role of ["Super Admin", "CEO"] as const) {
    assert.throws(
      () => assertChannelsByRepReadAllowed(null, excludedProductCodes(role, true)),
      ChannelsByRepRefused,
      `the whole history with nothing excluded is refused for a ${role}`,
    );
    assert.doesNotThrow(
      () => assertChannelsByRepReadAllowed("2026-09", excludedProductCodes(role, true)),
      `one month with the restricted products revealed stays open for a ${role}`,
    );
  }
  assert.doesNotThrow(
    () => assertChannelsByRepReadAllowed(null, excludedProductCodes("Super Admin", false)),
    "the whole history with the restricted products excluded stays open",
  );

  // Refused means never started, and refused means a 400 that says why rather than a 500.
  const service = readFileSync(new URL("../src/lib/sales/channels-by-rep.ts", import.meta.url), "utf8");
  const refusedAt = service.indexOf("assertChannelsByRepReadAllowed(period, excluded);");
  assert.ok(refusedAt > 0, "the loader must run the refusal");
  assert.ok(refusedAt < service.indexOf('.rpc("phx_sales_channels_by_rep"'), "the refusal must run before the read");
  const route = readFileSync(new URL("../app/api/sales/channels-by-rep/route.ts", import.meta.url), "utf8");
  assert.match(
    route,
    /error instanceof ChannelsByRepRefused\) \{\s*return NextResponse\.json\(\{ success: false, error: error\.message \}, \{ status: 400 \}\);/,
    "the route must answer a refusal with a 400 carrying its words",
  );
}
