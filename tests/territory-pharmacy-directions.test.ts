import assert from "node:assert/strict";

import { addressDestination, pickPharmacyDirections, type PickDirectionsInput } from "../src/lib/sales/territory/pharmacy-directions.ts";
import { directionsFromLocationRows } from "../src/lib/sales/territory/pharmacy-directions-sources.ts";

// The Territory Drilldown pharmacy name opens Google Maps directions (owner, 27 Nov 2026: "make sure
// the pharmacies address are correct and that this update will correct work not make reps waste time
// and lost"; then "depend on ibnsina family and pos address to route through google maps").
//
// What this pins is the one thing that would send a rep to the wrong shop: a link where Phoenix has no
// trustworthy place. A confirmed on-site point wins; else the Ibn Sina family (IS, IS-S, IS-L) or POS
// (PS) sheet address with the brick's town; else NO link. Two distributors under one code, a point far
// outside its brick, and two points that disagree are all refused.

const BRICK = "GZ1-B01";
const CENTRE = { latitude: 30.0, longitude: 31.2 };

function input(overrides: Partial<PickDirectionsInput> = {}): PickDirectionsInput {
  return {
    sources: [
      { clientCode: "1001", distributorCode: "IS", clientName: "صيدلية النور", clientAddress: "ش 26 يوليو بجوار المطافي", brickId: BRICK },
    ],
    confirmedPoints: [],
    brickNames: new Map([[BRICK, "العياط"]]),
    brickCentroids: new Map([[BRICK, CENTRE]]),
    ...overrides,
  };
}

function destinationOf(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("destination") ?? "");
}

export function runTerritoryPharmacyDirectionsTests() {
  // 1. An Ibn Sina address routes, with the brick's town and the country added.
  const byAddress = pickPharmacyDirections(input());
  assert.ok(byAddress, "an IS pharmacy with a real address gets a link");
  assert.equal(byAddress.kind, "distributor_address");
  assert.equal(byAddress.address, "ش 26 يوليو بجوار المطافي، العياط، مصر");
  assert.equal(destinationOf(byAddress.url), "ش 26 يوليو بجوار المطافي، العياط، مصر");
  assert.ok(byAddress.url.startsWith("https://www.google.com/maps/dir/?api=1&destination="));

  // The town is not repeated when the sheet already names it.
  assert.equal(addressDestination("شارع الجيش العياط", "العياط"), "شارع الجيش العياط، مصر");

  // 2. POS and the other Ibn Sina channels route too; IS + IS-S under one code is one shop.
  for (const code of ["PS", "IS-S", "IS-L"]) {
    const picked = pickPharmacyDirections(input({ sources: [{ ...input().sources[0], distributorCode: code }] }));
    assert.equal(picked?.kind, "distributor_address", `${code} is an address-routing distributor`);
  }
  const twoIbnSinaChannels = pickPharmacyDirections(
    input({ sources: [input().sources[0], { ...input().sources[0], distributorCode: "IS-S", clientAddress: null }] }),
  );
  assert.equal(twoIbnSinaChannels?.kind, "distributor_address", "two Ibn Sina channels share one customer list");

  // 3. Every other distributor's address gets NO link, however good it looks.
  assert.equal(pickPharmacyDirections(input({ sources: [{ ...input().sources[0], distributorCode: "UCP" }] })), null);

  // 4. One code from two different distributors may be two shops: no link at all.
  assert.equal(
    pickPharmacyDirections(input({ sources: [input().sources[0], { ...input().sources[0], distributorCode: "UCP" }] })),
    null,
    "IS + another distributor under one code",
  );
  assert.equal(
    pickPharmacyDirections(input({ sources: [input().sources[0], { ...input().sources[0], distributorCode: "PS" }] })),
    null,
    "Ibn Sina + POS under one code",
  );

  // 5. A point confirmed on site wins over the address and goes to the exact coordinates.
  const onSite = { latitude: 30.0012, longitude: 31.2008, distributorCode: "IS", clientCode: "1001" };
  const confirmed = pickPharmacyDirections(input({ confirmedPoints: [onSite, { ...onSite, latitude: 30.0013 }] }));
  assert.equal(confirmed?.kind, "confirmed_on_site");
  assert.equal(confirmed?.address, null);
  assert.equal(destinationOf(confirmed!.url), "30.001200,31.200800");

  // A confirmed point routes even for a distributor whose address is not trusted.
  const ucp = pickPharmacyDirections(
    input({ sources: [{ ...input().sources[0], distributorCode: "UCP" }], confirmedPoints: [{ ...onSite, distributorCode: "UCP" }] }),
  );
  assert.equal(ucp?.kind, "confirmed_on_site");

  // A point tied to another distributor's code is not this shop's.
  assert.equal(
    pickPharmacyDirections(input({ confirmedPoints: [{ ...onSite, distributorCode: "UCP" }] }))?.kind,
    "distributor_address",
  );

  // 6. A point far outside its brick is a mistyped code: ignored, the address is used instead.
  const far = { ...onSite, latitude: 30.5 }; // about 55 km north of the brick centre
  assert.equal(pickPharmacyDirections(input({ confirmedPoints: [far] }))?.kind, "distributor_address");

  // 7. Two points that disagree by more than 300 m: Phoenix cannot tell which is the shop.
  const apart = { ...onSite, latitude: 30.0112 }; // about 1.1 km from the first
  assert.equal(pickPharmacyDirections(input({ confirmedPoints: [onSite, apart] }))?.kind, "distributor_address");
  assert.equal(
    pickPharmacyDirections(
      input({ sources: [{ ...input().sources[0], distributorCode: "UCP" }], confirmedPoints: [{ ...onSite, distributorCode: "UCP" }, { ...apart, distributorCode: "UCP" }] }),
    ),
    null,
    "disagreeing points and no trusted address: no link",
  );

  // 8. An address too thin to route to gets no link.
  for (const thin of [null, "", "  -- ", "12", "١٢ ش"]) {
    assert.equal(
      pickPharmacyDirections(input({ sources: [{ ...input().sources[0], clientAddress: thin }] })),
      null,
      `thin address ${JSON.stringify(thin)}`,
    );
  }

  // 9. The database rows → one entry per trimmed customer code, points parsed from the jsonb list.
  const rows = directionsFromLocationRows([
    {
      client_code: " 1001 ",
      distributor_code: "is",
      client_name: "صيدلية النور",
      client_address: "ش 26 يوليو بجوار المطافي",
      brick_id: BRICK,
      brick_name: "العياط",
      brick_latitude: "30.0",
      brick_longitude: 31.2,
      confirmed_points: [],
    },
    {
      client_code: "2002",
      distributor_code: "UCP",
      client_name: "صيدلية الأمل",
      client_address: "شارع الهرم امام البنك",
      brick_id: BRICK,
      brick_name: "العياط",
      brick_latitude: 30.0,
      brick_longitude: 31.2,
      confirmed_points: [["30.0012", "31.2008"], ["bad", null]],
    },
    {
      client_code: "3003",
      distributor_code: "UCP",
      client_name: "صيدلية الشفاء",
      client_address: "شارع الهرم امام البنك",
      brick_id: BRICK,
      brick_name: "العياط",
      brick_latitude: 30.0,
      brick_longitude: 31.2,
      confirmed_points: [],
    },
  ]);
  assert.equal(rows.get("1001")?.kind, "distributor_address");
  assert.equal(rows.get("1001")?.address, "ش 26 يوليو بجوار المطافي، العياط، مصر");
  assert.equal(rows.get("2002")?.kind, "confirmed_on_site");
  assert.equal(rows.has("3003"), false, "another distributor with no confirmed point has no entry");
}
