import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TRAIN_AC2_LOWEST_FARES, TRAIN_STATIONS } from "../src/lib/outstation/train-fares-data.ts";
import {
  noTicketFareRecord,
  readNoTicketFare,
  resolveNoTicketFare,
  trainFareBetween,
} from "../src/lib/outstation/train-fare.ts";
import { mapOutstationRequestRowToPayrollApproval } from "../src/lib/outstation/payroll-expense-mapping.ts";

// "No ticket" trips (owner, 2026-11-07): the Submit Expense trip is chosen as Fuel, Ticket or No
// ticket. Fuel is priced as a car trip, Ticket carries the read ticket and its typed price, and No
// ticket is paid the LOWEST second-class AC fare of a direct train between the stations nearest the
// home and the destination, there and back (× 2), which the employee cannot edit. When the nearest
// stations have no direct train the nearest pair that has one is used ("find the nearest station
// and calculate based on it").

const code = (path: string) => readFileSync(path, "utf8");

const CAIRO_HOME = { latitude: 30.0444, longitude: 31.2357 };

function priced(home: { latitude: number; longitude: number }, destination: { latitude: number; longitude: number }) {
  const fare = resolveNoTicketFare({ destination, home });
  assert.equal(fare.status, "priced", `expected a fare, got: ${fare.status === "unavailable" ? fare.reason : ""}`);
  if (fare.status !== "priced") throw new Error("unreachable");
  return fare;
}

function fares() {
  // The probe figures read off the railway's own site on 2026-11-08 (the lowest AC 2 fare per route).
  const asyut = priced(CAIRO_HOME, { latitude: 27.1809, longitude: 31.1837 });
  assert.equal(asyut.fromStation.name, "Cairo");
  assert.equal(asyut.toStation.name, "Asyut");
  assert.equal(asyut.oneWayFare, 210);
  assert.equal(asyut.totalFare, 420, "HEADLINE: there and back is the one-way fare × 2");
  assert.equal(asyut.nearestHadNoTrain, false);

  const aswan = priced(CAIRO_HOME, { latitude: 24.0889, longitude: 32.8998 });
  assert.equal(aswan.toStation.name, "Aswan");
  assert.equal(aswan.totalFare, 640);

  const luxor = priced({ latitude: 31.2001, longitude: 29.9187 }, { latitude: 25.6872, longitude: 32.6396 });
  assert.equal(luxor.fromStation.name, "Alexandria");
  assert.equal(luxor.toStation.name, "Luxor");
  assert.equal(luxor.totalFare, 780);

  // No direct AC 2 train runs Cairo → Port Said: the nearest pair that has one is used, and it says so.
  const portSaid = priced(CAIRO_HOME, { latitude: 31.2653, longitude: 32.3019 });
  assert.equal(portSaid.nearestHadNoTrain, true, "HEADLINE: the fallback to the next-closest stations is recorded");
  assert.notEqual(portSaid.toStation.name, "Port Said");
  assert.ok(trainFareBetween(portSaid.fromStation.index, portSaid.toStation.index) === portSaid.oneWayFare);

  // A destination far from any station (Hurghada) still prices from the nearest station with a train.
  const hurghada = priced(CAIRO_HOME, { latitude: 27.2579, longitude: 33.8116 });
  assert.equal(hurghada.toStation.name, "Qena");
  assert.equal(hurghada.totalFare, 520);
}

function unavailable() {
  const same = resolveNoTicketFare({ destination: { latitude: 30.0975, longitude: 31.3753 }, home: { latitude: 30.0566, longitude: 31.3301 } });
  assert.equal(same.status, "unavailable", "home and destination nearest one station: no train fare at all");

  for (const home of [null, undefined, { latitude: 0, longitude: 0 }, { latitude: Number.NaN, longitude: 31 }]) {
    const fare = resolveNoTicketFare({ destination: { latitude: 27.18, longitude: 31.18 }, home });
    assert.equal(fare.status, "unavailable", `no home on file is never priced as a fare: ${JSON.stringify(home)}`);
  }
  assert.equal(resolveNoTicketFare({ destination: null, home: CAIRO_HOME }).status, "unavailable");
}

function data() {
  assert.ok(TRAIN_STATIONS.length >= 30, "the stations the sweep covered");
  assert.ok(TRAIN_AC2_LOWEST_FARES.length >= 500, "the routes the sweep priced");
  const seen = new Set<string>();
  for (const [from, to, fare] of TRAIN_AC2_LOWEST_FARES) {
    assert.ok(from >= 0 && from < TRAIN_STATIONS.length && to >= 0 && to < TRAIN_STATIONS.length && from !== to);
    assert.ok(Number.isFinite(fare) && fare > 0 && fare < 5000, `a fare in pounds, never piastres: ${fare}`);
    const key = `${from}>${to}`;
    assert.ok(!seen.has(key), `one lowest fare per route: ${key}`);
    seen.add(key);
  }
}

function record() {
  const fare = priced(CAIRO_HOME, { latitude: 27.1809, longitude: 31.1837 });
  const stored = noTicketFareRecord(fare);
  assert.equal(stored.fromStationArabic, "القاهره");
  assert.match(stored.line, /Cairo → Asyut · second-class AC · EGP 210 each way · EGP 420 there and back/);
  assert.deepEqual(readNoTicketFare(JSON.parse(JSON.stringify(stored))), stored, "the stored column reads back whole");
  for (const bad of [null, "x", 7, {}, { oneWayFare: 1, totalFare: 2 }, { fromStation: "A", oneWayFare: "1", toStation: "B", totalFare: 2 }]) {
    assert.equal(readNoTicketFare(bad), null);
  }

  // The approvals deck reads the claim through this mapper: the stations line reaches it, and only on a No-ticket trip.
  const row = { id: 1, status: "submitted", transportation_type: "no_ticket", trip_start_date: "2026-11-02", trip_end_date: "2026-11-04" };
  assert.equal(
    mapOutstationRequestRowToPayrollApproval({ ...row, no_ticket_fare: JSON.parse(JSON.stringify(stored)) }).noTicketFareLine,
    stored.line,
    "HEADLINE: the approver sees the stations and the fixed fare",
  );
  assert.equal(mapOutstationRequestRowToPayrollApproval({ ...row, no_ticket_fare: null, transportation_type: "train" }).noTicketFareLine, null);
}

function wiring() {
  const service = code("src/lib/outstation/service.ts");
  assert.match(
    service,
    /if \(input\.transportationType === "no_ticket"\) \{[\s\S]{0,900}?if \(fare\.status !== "priced"\) throw new NoTicketFareUnavailableError\(fare\.reason\);[\s\S]{0,200}?ticketAmount = roundMoney\(fare\.totalFare\);/,
    "HEADLINE: the server prices a No-ticket trip itself and refuses one it cannot price",
  );
  assert.match(
    service,
    /const reportTravelCost = noTicketFare\s*\?\s*computedTravelCost\s*:/,
    "HEADLINE: a typed travel cost never replaces the fixed fare",
  );
  assert.match(service, /go_ticket_amount: nonTravel \? 0 : calculation\.noTicketFare \? calculation\.noTicketFare\.oneWayFare :/);
  assert.match(service, /return_ticket_amount: nonTravel \? 0 : calculation\.noTicketFare \? calculation\.noTicketFare\.oneWayFare :/);
  assert.match(service, /no_ticket_fare: calculation\.noTicketFare \?\? null,/);
  assert.match(service, /noTicketFare: readNoTicketFare\(row\.no_ticket_fare\),/);

  for (const route of ["app/api/outstation/calculate/route.ts", "app/api/outstation/submit/route.ts", "app/api/outstation/sync-offline/route.ts"]) {
    assert.match(code(route), /instanceof NoTicketFareUnavailableError/, `${route}: an unpriceable No-ticket trip is a 400 with its reason`);
  }

  const managerCreate = code("app/api/admin/outstation/manager-expenses/route.ts");
  assert.match(managerCreate, /if \(transportationType === "no_ticket"\) \{\s*return NextResponse\.json\(/, "HR never records a No-ticket trip by hand");

  const migration = code("supabase/migrations/20261107090000_outstation_no_ticket_train_fare.sql");
  assert.match(migration, /check \(transportation_type in \('car', 'train', 'bus', 'other', 'no_ticket'\)\)/);
  assert.match(migration, /add column if not exists no_ticket_fare jsonb;/);

  const wizard = code("src/components/outstation/mobile-outstation-wizard.tsx");
  const transportOptions = /const transportOptions[^=]*= \[([\s\S]*?)\];/.exec(wizard)?.[1] ?? "";
  assert.match(
    transportOptions,
    /^\s*\{ label: "Fuel", value: "car" \},\s*\{ label: "Ticket", value: "train" \},\s*\{ label: "No ticket", value: "no_ticket" \},\s*$/,
    "HEADLINE: the employee chooses Fuel, Ticket or No ticket, and nothing else",
  );
  const panel = wizard.slice(wizard.indexOf("function NoTicketFarePanel"), wizard.indexOf("function NoTicketFarePanel") + 2400);
  assert.ok(panel.length > 100);
  assert.doesNotMatch(panel, /<input|<InputField|onChange/, "the fixed fare is shown, never typed");

  const deck = code("src/components/outstation/expense-review/review-deck/deck-subject.tsx");
  assert.match(deck, /record\.noTicketFareLine \? \(\s*<SubjectFact className="col-span-2" label="Fixed train fare">/, "the approvals deck prints the stations line");
}

export function runOutstationNoTicketTrainFareTests() {
  fares();
  unavailable();
  data();
  record();
  wiring();
}
