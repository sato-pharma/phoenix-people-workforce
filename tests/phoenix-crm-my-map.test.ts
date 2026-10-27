import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { groupPins, MY_MAP_GROUP_BELOW_ZOOM, evenSample, brickLabels } from "../src/lib/phoenix-crm/my-map-geometry.ts";
import {
  buildMyMapPins,
  countMyMap,
  mapLayerOf,
  myMapPerListText,
  MY_MAP_CUSTOMER_KEYS,
  MY_MAP_PIN_KEYS,
  type MyMapCustomerFact,
  type MyMapPlaceFact,
} from "../src/lib/phoenix-crm/my-map-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — My map (owner, 2026-10-27: "put a pin on the map for every validated customer … give a color
 * for the AM pins and for the PM pins … the rep can press and got directions from his current location").
 *
 * What it pins:
 *   1. A pin carries the allow-list and nothing else — no reading of where a photo or a phone was, and no
 *      measure of how far apart they were, ever reaches the browser (golden rule #1).
 *   2. A place's layer is its session when it has one, its customer's list otherwise; a pharmacy is a pharmacy.
 *   3. A pending customer, a customer of the other world, and a place on a seat the reader does not hold are
 *      never pins; a place with no usable point is COUNTED, never silently dropped.
 *   4. AM, PM and pharmacies are three figures side by side, never one total.
 *   5. Grouping at a country's zoom loses no pin and counts none twice.
 *   6. The loader reads active places of active customers in the reader's own world.
 *   7. The sidebar row and every companion declaration CI looks for.
 */

const read = (path: string) => readFileSync(path, "utf8");
// Built from parts: the blind half's own scan refuses the whole word in any Phoenix CRM string.
const CASE_WORD = ["integ", "rity"].join("");

const GRADE_TARGETS = { AM: { A: 4, B: 2, C: 1 }, PM: { A: 4, B: 2, C: 1 } };
const SEATS = [
  { seatId: "seat-1", name: "Nasr City 1", people: "Rep One", line: "CNS" },
  { seatId: "seat-2", name: "Heliopolis 2", people: "Rep Two", line: "CNS" },
];
// Cairo, well inside the country's bounds.
const CAIRO = { lat: 30.05, lon: 31.33 };

function place(id: string, overrides: Partial<MyMapPlaceFact> = {}): MyMapPlaceFact {
  return { id, seatId: "seat-1", customerId: "c-am", lat: CAIRO.lat, lon: CAIRO.lon, session: null, label: "Clinic", brick: "Nasr City", ...overrides };
}

function customer(id: string, overrides: Partial<MyMapCustomerFact> = {}): MyMapCustomerFact {
  return { id, listType: "AM", name: `Customer ${id}`, speciality: "Paediatrics", grade: "A", validatedOn: "2026-10-20", ...overrides };
}

function build(places: MyMapPlaceFact[], customers: MyMapCustomerFact[], visits: Array<{ customerId: string; visitDate: string }> = []) {
  return buildMyMapPins({ seats: SEATS, places, customers, visits, planned: null, newSince: "2026-10-21", gradeTargets: GRADE_TARGETS });
}

/** Every key at every depth of a value. */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, out);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysDeep(inner, out);
    }
  }
  return out;
}

export function runPhoenixCrmMyMapTests(): void {
  // ── 1. The allow-list, and nothing a fact carried beside it ─────────────────────────────────────────
  const smuggled = {
    ...place("p-1"),
    accuracy: 12,
    distance: 340,
    pinReading: { lat: 1, lon: 1 },
    photoReading: { lat: 1, lon: 1 },
    pointSource: "photo",
    moved: true,
  } as MyMapPlaceFact;
  const withExtras = build([smuggled], [{ ...customer("c-am"), accuracy: 9 } as MyMapCustomerFact]);
  assert.equal(withExtras.pins.length, 1, "the place is a pin");
  assert.deepEqual(Object.keys(withExtras.pins[0]).sort(), [...MY_MAP_PIN_KEYS].sort(), "a pin carries exactly the pin allow-list");
  assert.deepEqual(Object.keys(withExtras.customers[0]).sort(), [...MY_MAP_CUSTOMER_KEYS].sort(), "a customer carries exactly the customer allow-list");
  const everyKey = keysDeep(withExtras);
  for (const banned of ["accuracy", "distance", "pinReading", "photoReading", "pointSource", "moved", CASE_WORD]) {
    assert.ok(!everyKey.has(banned), `no "${banned}" key reaches the browser at any depth`);
  }

  // ── 2. The layer ───────────────────────────────────────────────────────────────────────────────────
  assert.equal(mapLayerOf("PM", "AM"), "AM", "a PM customer's morning place is drawn in AM");
  assert.equal(mapLayerOf("AM", "PM"), "PM", "an AM customer's evening place is drawn in PM");
  assert.equal(mapLayerOf("AM", null), "AM", "no session: the customer's own list");
  assert.equal(mapLayerOf("PM", "evening"), "PM", "a session that is not AM or PM is ignored");
  assert.equal(mapLayerOf("Pharmacy", "AM"), "Pharmacy", "a pharmacy stays a pharmacy whatever its session reads");

  // ── 3. Who is never a pin, and who is counted instead ──────────────────────────────────────────────
  const mixed = build(
    [
      place("p-active"),
      place("p-pending", { customerId: "c-pending" }),
      place("p-other-seat", { seatId: "seat-9" }),
      place("p-no-point", { customerId: "c-pm", lat: null, lon: null }),
      place("p-abroad", { customerId: "c-pm", lat: 51.5, lon: -0.12 }),
    ],
    // The loader passes ACTIVE customers of the reader's own world only — "c-pending" is not among them.
    [customer("c-am"), customer("c-pm", { listType: "PM" })],
  );
  assert.deepEqual(
    mixed.pins.map((pin) => pin.id),
    ["p-active"],
    "a pending customer, a seat outside the reader's and a place with no usable point are never pins",
  );
  assert.equal(mixed.unplaced, 2, "the two places with no usable point are counted, never silently dropped");
  assert.equal(mixed.customers.length, 1, "a customer with no pin is not in the list either");

  // ── 4. The three lists side by side, never one total ───────────────────────────────────────────────
  assert.equal(myMapPerListText({ AM: 2, PM: 3, Pharmacy: 1 }), "2 AM · 3 PM · 1 pharmacy");
  assert.doesNotMatch(myMapPerListText({ AM: 2, PM: 3, Pharmacy: 1 }), /\b6\b/, "AM, PM and pharmacies are never added into one figure");
  assert.equal(myMapPerListText({ AM: 0, PM: 1200, Pharmacy: 3 }), "1,200 PM · 3 pharmacies", "a list with none is left out, the rest stay apart");
  assert.equal(myMapPerListText({ AM: 0, PM: 0, Pharmacy: 0 }), "None");

  const twoPlaces = build(
    [place("p-a1"), place("p-a2", { session: "PM" }), place("p-ph", { customerId: "c-ph" })],
    [customer("c-am"), customer("c-ph", { listType: "Pharmacy", grade: null })],
    [{ customerId: "c-am", visitDate: "2026-10-05" }],
  );
  const counts = countMyMap(twoPlaces.pins, twoPlaces.customers);
  assert.deepEqual(counts.places, { AM: 1, PM: 1, Pharmacy: 1 }, "pins are counted by the layer they are drawn in");
  assert.deepEqual(counts.customers, { AM: 1, PM: 0, Pharmacy: 1 }, "a customer with two places is ONE customer, on his own list");
  assert.equal(twoPlaces.customers[0].places, 2, "and the list says he has two places");
  assert.deepEqual(counts.behind, { AM: 1, PM: 0, Pharmacy: 0 }, "one visit against a grade of four is behind, on his own list");
  assert.deepEqual(counts.notVisited, { AM: 0, PM: 0, Pharmacy: 1 }, "the pharmacy nobody visited is not visited, on its own list");
  assert.equal(twoPlaces.customers[1].target, null, "a pharmacy has no grade number");

  // ── 5. Grouping loses no pin and counts none twice ─────────────────────────────────────────────────
  const scattered = Array.from({ length: 400 }, (_, index) => ({
    id: `pin-${index}`,
    lat: 24 + ((index * 37) % 800) / 100,
    lon: 25 + ((index * 53) % 1000) / 100,
  }));
  for (const zoom of [5, 6.5, 8, 10, 12, MY_MAP_GROUP_BELOW_ZOOM, 16]) {
    const ids = groupPins(scattered, zoom).flatMap((group) => group.members.map((member) => member.id));
    assert.equal(ids.length, scattered.length, `zoom ${zoom}: every pin is in a group`);
    assert.equal(new Set(ids).size, scattered.length, `zoom ${zoom}: and in exactly one`);
  }
  assert.ok(groupPins(scattered, 6).length < scattered.length, "at a country's zoom the pins are grouped");
  assert.equal(groupPins(scattered, MY_MAP_GROUP_BELOW_ZOOM).length, scattered.length, "at street zoom each pin stands alone");
  assert.equal(evenSample(scattered, 50).length, 50, "the landing card draws a sample of at most its share");
  const labels = brickLabels(
    [
      { lat: 30, lon: 31, brick: "Maadi" },
      { lat: 30.2, lon: 31.2, brick: "Maadi" },
      { lat: 30.1, lon: 31.1, brick: "Maadi" },
      { lat: 29, lon: 30, brick: "Giza" },
    ],
    5,
  );
  assert.deepEqual(labels[0], { name: "Maadi", pins: 3, lat: 30.1, lon: 31.1 }, "a brick is named at the median of its own pins");

  // ── 6. The loader's reads ──────────────────────────────────────────────────────────────────────────
  const loader = stripComments(read("src/lib/phoenix-crm/server/my-map.ts"));
  assert.match(
    loader,
    /selectByIds<Row>\("phoenix_crm_places", "[^"]*", "seat_id", seatIds, \(query\) =>\s*query\.eq\("status", "active"\)\.eq\("is_test", isTest\)/,
    "places: active only, in the reader's own world, paged by seat",
  );
  assert.match(
    loader,
    /selectByIds<Row>\("phoenix_crm_customers", CUSTOMER_COLUMNS, "seat_id", seatIds, \(query\) => query\.eq\("status", "active"\)\.eq\("is_test", isTest\)\)/,
    "customers: active (validated) only, in the reader's own world",
  );
  const selected = [...loader.matchAll(/selectByIds<Row>\("phoenix_crm_\w+", "([^"]+)"/g), ...loader.matchAll(/CUSTOMER_COLUMNS = "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(selected.length >= 3, "the column lists were found");
  for (const columns of selected) {
    assert.doesNotMatch(columns, new RegExp(`accuracy|pin_lat|pin_lon|photo|distance|moved|${CASE_WORD}|pharmacy_pin`), `the loader never reads a measurement column: ${columns}`);
  }

  // ── 7. The sidebar row and its companions ──────────────────────────────────────────────────────────
  assert.match(read("src/lib/phoenix-crm/server/sidebar-entries.ts"), /myMap: canReadMyMap\(viewer\)/, "the row asks the page's own gate");
  assert.match(read("src/lib/employee-portal/navigation.ts"), /showMyMapTab: hasMyMap === true/);
  assert.match(
    read("src/components/employee-portal/employee-portal-layout.tsx"),
    /showMyMapTab \? \[\{ href: "\/employee-portals\/my-map", label: "My map", icon: MapIcon \}\]/,
  );
  assert.match(
    read("src/components/employee-portal/employee-portal-nav-registry.ts"),
    /href: "\/employee-portals\/my-map", icon: MapIcon, flags: \["showMyMapTab"\], permission: \{ resource: "phoenix_crm", action: "read" \}/,
  );
  assert.match(read("src/lib/employee-portal/sidebar-rows.ts"), /\{ href: "\/employee-portals\/my-map", label: "My map", section: "Phoenix CRM" \}/);
  assert.match(read("src/lib/employee-portal/native-module-directory.ts"), /"\/employee-portals\/my-map": \{ icon: "map-outline", section: "Phoenix CRM" \}/);
  const catalog = read("src/config/system-navigation.ts");
  assert.ok(catalog.includes('{ href: "/employee-portals/my-map", icon: MapIcon, label: "My map"'), "the portal catalog lists it");
  assert.ok(catalog.includes('href: "/admin/phoenix-crm/my-map"'), "the admin shell lists the company's map");
  assert.ok(existsSync("app/employee-portals/my-map/loading.tsx"), "the portal route has its skeleton");
  for (const file of ["app/employee-portals/my-map/page.tsx", "app/(admin)/admin/phoenix-crm/my-map/page.tsx"]) {
    assert.match(read(file), /if \(!viewer \|\| !canReadMyMap\(viewer\)\) redirect\(/, `${file} turns away anyone the gate refuses`);
    assert.match(read(file), /<MyMapScreen browserKey=\{getBrowserKey\(\)\} view=\{view\} \/>/, `${file} hands the map its key from the server`);
  }
  // The canvas takes the key as a prop, like the territory map, and never reads it from the bundle itself.
  assert.doesNotMatch(stripComments(read("src/components/phoenix-crm/my-map/my-map-canvas.tsx")), /process\.env/, "the canvas reads no environment value");

  // The four landing pages carry the card, each under its own Suspense.
  for (const file of [
    "src/components/employee-portal/dashboards/dsm-command-center.tsx",
    "src/components/employee-portal/dashboards/nsm-command-center.tsx",
    "src/components/employee-portal/dashboards/rm-command-center.tsx",
    "src/components/employee-portal/portal-command-center.tsx",
  ]) {
    assert.match(stripComments(read(file)), /<Suspense fallback=\{<\w+ title="My map" \/>\}>\s*<MyMapSnapshotCard access=\{access\}/, `${file} streams the My map card`);
  }

  // Customer-facing words: the banned vocabulary never reaches a screen.
  for (const file of [
    "src/components/phoenix-crm/my-map/my-map-screen.tsx",
    "src/components/phoenix-crm/my-map/my-map-canvas.tsx",
    "src/components/phoenix-crm/my-map/my-map-list.tsx",
    "src/components/phoenix-crm/my-map/my-map-pin-card.tsx",
    "src/components/phoenix-crm/my-map/my-map-snapshot-card.tsx",
    "src/components/employee-portal/dashboards/my-map-snapshot-card.tsx",
  ]) {
    const source = stripComments(read(file));
    const strings = [...source.matchAll(/(?:"([^"\n]{3,})"|>([^<>{}\n]{3,})<)/g)].map((match) => match[1] ?? match[2] ?? "");
    for (const text of strings) assert.doesNotMatch(text, /\b(accounts?|doctors?)\b/i, `${file}: "${text}" uses a banned word — say customer`);
  }
}
