import assert from "node:assert/strict";

import { pharmacySearchText, pickPharmacyDirections, type PickDirectionsInput } from "../src/lib/sales/territory/pharmacy-directions.ts";
import { directionsFromLocationRows, matchedPlacesFromRows } from "../src/lib/sales/territory/pharmacy-directions-sources.ts";
import { listingNamesPharmacy, pickPlaceMatch, placeKind } from "../src/lib/sales/territory/pharmacy-place-match.ts";
import { directionsNote } from "../src/lib/sales/territory/drilldown-words.ts";

// The Territory Drilldown pharmacy name opens Google Maps (owner, 27 Nov 2026: "make sure the
// pharmacies address are correct and that this update will correct work not make reps waste time and
// lost"). The first version routed to the Ibn Sina / POS sheet address; on the preview he reported
// "many of the clickables customers when press google cant find a location" — those addresses are cut
// at about 30 characters and landed on a landmark for every one of 30 sampled. Paying Google to match
// each shop was refused ("find a way to keep it free").
//
// So what this pins: a point confirmed on site is exact directions; every other usable name is a
// FREE Google Maps search by name and town, cleaned of the sheet's payment and channel marks; a point
// far outside its brick, points that disagree, or one code under two distributors never make a pin.

const BRICK = "GZ1-B01";
const CENTRE = { latitude: 30.0, longitude: 31.2 };

function input(overrides: Partial<PickDirectionsInput> = {}): PickDirectionsInput {
  return {
    sources: [
      { clientCode: "1001", distributorCode: "IS", clientName: "اسامة - العياط    ن", clientAddress: "ش 26 يوليو بجوار المطافي", brickId: BRICK },
    ],
    displayName: "اسامة - العياط    ن",
    confirmedPoints: [],
    brickNames: new Map([[BRICK, "العياط"]]),
    brickCentroids: new Map([[BRICK, CENTRE]]),
    ...overrides,
  };
}

function param(url: string, name: string): string {
  return new URL(url).searchParams.get(name) ?? "";
}

export function runTerritoryPharmacyDirectionsTests() {
  // 1. A name with no confirmed point opens a Google Maps SEARCH by name and town — never the address.
  const search = pickPharmacyDirections(input());
  assert.ok(search, "a pharmacy with a usable name gets a link");
  assert.equal(search.kind, "google_search");
  assert.ok(search.url.startsWith("https://www.google.com/maps/search/?api=1&query="));
  assert.equal(param(search.url, "query"), "صيدلية اسامة العياط", "dash and channel mark gone, town not repeated");
  assert.equal(search.url.includes(encodeURIComponent("المطافي")), false, "the cut-off sheet address is never searched");

  // 2. The sheet's payment and channel marks never reach Google; "صيدلية" is not doubled; the town is added.
  assert.equal(pharmacySearchText("رامى مصر الجديدة نقدي", "النزهه الجديدة"), "صيدلية رامى مصر الجديدة النزهه الجديدة");
  assert.equal(pharmacySearchText("ذكرى الميرغني اجل", "الكوربة"), "صيدلية ذكرى الميرغني الكوربة");
  assert.equal(pharmacySearchText("منه الله ابو السعد ن.م", "الحوامديه"), "صيدلية منه الله ابو السعد الحوامديه");
  assert.equal(pharmacySearchText("شركةصيدليات السداوى-اشرف", "ميدان الحجاز"), "شركةصيدليات السداوى اشرف ميدان الحجاز");
  assert.equal(pharmacySearchText("Fathy Amer pharmacy", "(unmapped)"), "Fathy Amer pharmacy");

  // 3. A name too thin to search for gets no link at all.
  for (const thin of [null, "", " - ", "12", "ن", "٥٥ ن"]) {
    assert.equal(pickPharmacyDirections(input({ displayName: thin as string })), null, `thin name ${JSON.stringify(thin)}`);
  }

  // 4. Any distributor's pharmacy gets the search — the name, not the sheet, is what Google looks for.
  assert.equal(pickPharmacyDirections(input({ sources: [{ ...input().sources[0], distributorCode: "UCP" }] }))?.kind, "google_search");

  // 5. A point confirmed on site wins and goes to the exact coordinates.
  const onSite = { latitude: 30.0012, longitude: 31.2008, distributorCode: "IS", clientCode: "1001" };
  const confirmed = pickPharmacyDirections(input({ confirmedPoints: [onSite, { ...onSite, latitude: 30.0013 }] }));
  assert.equal(confirmed?.kind, "confirmed_on_site");
  assert.equal(confirmed?.searchText, null);
  assert.ok(confirmed!.url.startsWith("https://www.google.com/maps/dir/?api=1&destination="));
  assert.equal(param(confirmed!.url, "destination"), "30.001200,31.200800");

  // A point tied to another distributor's code is not this shop's: the search link instead.
  assert.equal(pickPharmacyDirections(input({ confirmedPoints: [{ ...onSite, distributorCode: "UCP" }] }))?.kind, "google_search");

  // 6. A point far outside its brick is a mistyped code: never a pin.
  const far = { ...onSite, latitude: 30.5 }; // about 55 km north of the brick centre
  assert.equal(pickPharmacyDirections(input({ confirmedPoints: [far] }))?.kind, "google_search");

  // 7. Two points more than 300 m apart: Phoenix cannot tell which is the shop, so no pin.
  const apart = { ...onSite, latitude: 30.0112 }; // about 1.1 km from the first
  assert.equal(pickPharmacyDirections(input({ confirmedPoints: [onSite, apart] }))?.kind, "google_search");

  // 8. One code under two distributors may be two shops: a confirmed point is not trusted for it.
  //    Two Ibn Sina channels share one customer list, so their point stands.
  const twoDistributors = input({ sources: [input().sources[0], { ...input().sources[0], distributorCode: "UCP" }], confirmedPoints: [onSite] });
  assert.equal(pickPharmacyDirections(twoDistributors)?.kind, "google_search");
  const twoIbnSina = input({ sources: [input().sources[0], { ...input().sources[0], distributorCode: "IS-S" }], confirmedPoints: [onSite] });
  assert.equal(pickPharmacyDirections(twoIbnSina)?.kind, "confirmed_on_site");

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
      client_address: null,
      brick_id: BRICK,
      brick_name: "العياط",
      brick_latitude: 30.0,
      brick_longitude: 31.2,
      confirmed_points: [["30.0012", "31.2008"], ["bad", null]],
    },
    {
      client_code: "3003",
      distributor_code: "UCP",
      client_name: "12",
      client_address: "شارع الهرم امام البنك",
      brick_id: BRICK,
      brick_name: "العياط",
      brick_latitude: 30.0,
      brick_longitude: 31.2,
      confirmed_points: [],
    },
  ]);
  assert.equal(rows.get("1001")?.kind, "google_search");
  assert.equal(rows.get("1001")?.searchText, "صيدلية النور العياط");
  assert.equal(rows.get("2002")?.kind, "confirmed_on_site");
  assert.equal(rows.has("3003"), false, "a name with no letters has no entry");

  // 10. The note tells the rep which kind of link it is.
  assert.equal(directionsNote(null), "No location yet");
  assert.match(directionsNote({ kind: "google_search" }), /check the listing name/);
  assert.match(directionsNote({ kind: "confirmed_on_site" }), /confirmed on site/);

  assert.match(directionsNote({ kind: "google_place" }), /own Google Maps listing/);

  // ── Free top-pharmacy match (owner, 27 Nov 2026: "Free top-2,616 match") ─────────────────────────
  // 11. A matched Google place opens THAT listing; the search text stays as the fallback words.
  const place = { distributorCode: "IS", clientCode: "1001", placeId: "ChIJ-abc_123" };
  const matched = pickPharmacyDirections(input({ matchedPlaces: [place] }));
  assert.equal(matched?.kind, "google_place");
  assert.equal(param(matched!.url, "query_place_id"), "ChIJ-abc_123");
  assert.equal(param(matched!.url, "query"), "صيدلية اسامة العياط");
  // A point a rep confirmed on site still wins over Google's listing.
  assert.equal(pickPharmacyDirections(input({ matchedPlaces: [place], confirmedPoints: [onSite] }))?.kind, "confirmed_on_site");
  // Another distributor's match, two distributors under one code, or two different places: the search.
  assert.equal(pickPharmacyDirections(input({ matchedPlaces: [{ ...place, distributorCode: "UCP" }] }))?.kind, "google_search");
  const twoShops = input({ sources: [input().sources[0], { ...input().sources[0], distributorCode: "UCP" }], matchedPlaces: [place] });
  assert.equal(pickPharmacyDirections(twoShops)?.kind, "google_search");
  const twoPlaces = input({
    sources: [input().sources[0], { ...input().sources[0], distributorCode: "IS-S" }],
    matchedPlaces: [place, { ...place, distributorCode: "IS-S", placeId: "ChIJ-other" }],
  });
  assert.equal(pickPharmacyDirections(twoPlaces)?.kind, "google_search");
  const viaRows = directionsFromLocationRows(
    [{ client_code: "1001", distributor_code: "IS", client_name: "صيدلية النور", client_address: null, brick_id: BRICK, brick_name: "العياط", brick_latitude: 30, brick_longitude: 31.2, confirmed_points: [] }],
    matchedPlacesFromRows([
      { distributor_code: "is", client_code: " 1001 ", google_place_id: "ChIJ-abc_123" },
      { distributor_code: "IS", client_code: "9999", google_place_id: null },
    ]),
  );
  assert.equal(viaRows.get("1001")?.kind, "google_place");

  // 12. The listing names the pharmacy: it may DROP the sheet's street or town, never ADD a name.
  assert.equal(listingNamesPharmacy("اسامة - العياط    ن", "صيدلية اسامة", "العياط"), true, "the brick's town set aside, one name word");
  assert.equal(listingNamesPharmacy("محمد عادل – الحوامدية ن", "صيدلية محمد عادل", "الحوامديه"), true);
  //     A name of two words or more needs two of them in the listing: a first name alone is not the shop.
  assert.equal(listingNamesPharmacy("عمر بن الخطاب - طهطا", "صيدلية د/ عمر", "طهطا"), false);
  assert.equal(listingNamesPharmacy("سامى الحوفى", "صيدلية د. سامى", "الهجانه"), false);
  assert.equal(listingNamesPharmacy("صيدلية جامعة الازهر", "صيدلية الجامعة", "مدينه نصر"), false);
  assert.equal(listingNamesPharmacy("ميرلاند", "صيدلية ميريلاند"), true, "one letter off on a long word");
  assert.equal(listingNamesPharmacy("علياء نادى-البدرشين", "صيدليه دكتوره علياء نادي"), true);
  assert.equal(listingNamesPharmacy("سلمى -البدرشين", "salma pharmacy(صيدليه سلمى)", "البدرشين"), true);
  assert.equal(listingNamesPharmacy("اسلام على", "صيدلية د اسلام محمد"), false, "the listing adds a name: another pharmacist");
  assert.equal(listingNamesPharmacy("بيتر مدحت العبور", "صيدليات شكشك - فرع العبور"), false);
  assert.equal(listingNamesPharmacy("رامى مصر الجديدة", "صيدلية مصر الجديدة"), false, "the pharmacy's own first name must be in the listing");
  //     One letter off is a different person on a short name: أحمد / محمد, البدرى / البكرى.
  assert.equal(listingNamesPharmacy("محمد السيد", "صيدلية د. أحمد محمد السيد"), false);
  assert.equal(listingNamesPharmacy("محمد الباجورى منشية البكرى", "صيدلية د. محمد البدرى"), false);
  //     A listing named only with the commonest given names tells no shop apart.
  assert.equal(listingNamesPharmacy("محمد ميجا", "صيدلية دكتور محمد"), false);
  assert.equal(listingNamesPharmacy("احمد السيد شنو الجديدة", "صيدليه الدكتور أحمد السيد"), false);
  //     A name in Latin letters only cannot be compared with the Arabic sheet name.
  assert.equal(listingNamesPharmacy("فتحى عامر", "Fathy Amer pharmacy"), false);

  // 13. Same kind of place only: a distributor is never a corner pharmacy, a hospital never a shop.
  assert.equal(placeKind("يونس لتجارةوتوزيع الادوية"), "trade");
  assert.equal(placeKind("مستشفى الرحمة اكتوبر"), "hospital");
  assert.equal(placeKind("صيدلية بهجت"), "pharmacy");
  assert.equal(listingNamesPharmacy("يونس لتجارةوتوزيع الادوية", "صيدلية يونس"), false);
  assert.equal(listingNamesPharmacy("الرواد لتجارة وتوزيع الادوية", "شركة الرواد لتجارة وتوزيع الادوية"), true);
  assert.equal(listingNamesPharmacy("مستشفى الرحمة اكتوبر", "مستشفى الرحمة", "6 اكتوبر"), true);

  // 14. The verdict: within 5 km of the brick, exactly one passing place, a failed lookup never guessed.
  const centre = { latitude: 30.0, longitude: 31.2 };
  const shop = { placeId: "P1", name: "صيدلية اسامة", lat: 30.004, lng: 31.203 };
  assert.deepEqual(pickPlaceMatch({ pharmacyName: "اسامة - العياط", brickName: "العياط", brickCentre: centre, listings: [shop] }).status, "matched");
  assert.equal(pickPlaceMatch({ pharmacyName: "اسامة - العياط", brickName: "العياط", brickCentre: centre, listings: [{ ...shop, lat: 30.06 }] }).status, "no_match", "6.7 km away");
  assert.equal(
    pickPlaceMatch({ pharmacyName: "اسامة - العياط", brickName: "العياط", brickCentre: centre, listings: [shop, { ...shop, placeId: "P2", lng: 31.21 }] }).status,
    "ambiguous",
    "two branches of one name",
  );
  assert.equal(pickPlaceMatch({ pharmacyName: "اسامة - العياط", brickName: "العياط", brickCentre: centre, listings: [shop, shop] }).status, "matched", "the same place twice is one place");
  assert.equal(pickPlaceMatch({ pharmacyName: "اسامة - العياط", brickName: "العياط", brickCentre: centre, listings: null }).status, "lookup_failed");
  assert.equal(pickPlaceMatch({ pharmacyName: "اسامة - العياط", brickName: "العياط", brickCentre: centre, listings: [] }).status, "no_match");
}
