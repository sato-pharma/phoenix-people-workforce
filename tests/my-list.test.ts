import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PORTAL_NAV_REGISTRY } from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import { employeePortalNavigationSections } from "../src/config/system-navigation.ts";
import { getMyListScope } from "../src/lib/crm/doctor-list-access.ts";
import {
  canAccessDoctorList,
  canAccessMyList,
  doctorListBasisForRole,
  DOCTOR_LIST_ACCESS_ROLES,
  MY_LIST_PORTAL_ROLES,
} from "../src/lib/crm/doctor-list-roles.ts";
import {
  describeSharing,
  findSharedCustomers,
  nameKey,
  phoneKey,
  scoreLocationConfidence,
  sharedWithCell,
  UNNAMED_REP,
  withRepNamesWithheld,
  type RosterEntry,
  type SharedWith,
} from "../src/lib/crm/location-confidence.ts";
import { buildPhoenixInsights } from "../src/lib/crm/phoenix-insights.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

/**
 * My List — the Reps List board in a Medical Rep's account, opened on the rep's own contact list.
 *
 * The owner's instruction, 2026-09-16: "show in medical reps accounts the reps-list scoped to
 * everyone scope and call is My List". Every seat reads the board at its own reach, and a rep's
 * reach is the rep alone.
 *
 * What is pinned here is what fails SILENTLY:
 *
 * · a reach taken from anything but the session — a `?rep=` or a picker — would open a colleague's
 *   list, and nothing on the page would look wrong;
 * · Medical Rep on the manager board's role list would admit reps to Reps List itself, whose picker
 *   names every rep in reach;
 * · a peer's NAME on a shared row breaks the locked downward rule (an employee never sees anyone at
 *   or above their own rank, and another rep is AT a rep's rank) — while dropping the partner instead
 *   would quietly take the highlight, the partner's visits and the insight off the rep's list;
 * · and the withheld label, repeated, reads "another rep and another rep", or collapses two reps
 *   into one when they are counted by name.
 */

const ROUTE = "/employee-portals/my-list";

export function runMyListTests() {
  // ── WHO GETS THE DOOR ───────────────────────────────────────────────────────────────────────
  {
    assert.deepEqual([...MY_LIST_PORTAL_ROLES], ["Medical Rep"], "My List is the Medical Rep's door, and only theirs");
    assert.equal(canAccessMyList({ role: "Medical Rep" }), true);
    for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "Super Admin", "Employee"]) {
      assert.equal(canAccessMyList({ role }), false, `${role} keeps Reps List and gets no My List`);
    }
    assert.equal(
      canAccessDoctorList({ role: "Medical Rep" }),
      false,
      "a rep must never be admitted to Reps List itself — its picker names every rep in the viewer's reach",
    );
    assert.equal(
      doctorListBasisForRole("Medical Rep"),
      null,
      "Medical Rep stays out of the manager board's basis map, so every other caller of it keeps its answer",
    );
    for (const role of MY_LIST_PORTAL_ROLES) {
      assert.ok(
        !(DOCTOR_LIST_ACCESS_ROLES as readonly string[]).includes(role),
        `${role} must not be on both role lists — the two pages redirect each other's viewers, and a role on both would loop`,
      );
    }
  }

  // ── THE REACH IS THE SESSION'S OWN HR ID, AND IT FAILS CLOSED ──────────────────────────────
  {
    assert.deepEqual(
      getMyListScope({ hrId: "a-42", role: "Medical Rep" }),
      { agentHrIds: ["a-42"], kind: "agents", label: "Medical Rep · own list" },
      "a rep's reach is exactly one list: their own",
    );
    for (const hrId of [null, "", "   "]) {
      assert.equal(
        getMyListScope({ hrId, role: "Medical Rep" }).kind,
        "none",
        `a session with no HR id (${JSON.stringify(hrId)}) opens nothing — never someone else's list, never the company`,
      );
    }
    const manager = getMyListScope({ hrId: "b-7", role: "District Manager" });
    assert.equal(manager.kind, "none", "a manager reaching the resolver gets nothing from it, never `company`");
  }

  // ── THE NAV OFFERS THE ROW TO EXACTLY THE ROLES THE PAGE ADMITS ─────────────────────────────
  {
    const portalItems = employeePortalNavigationSections.flatMap((section) => section.items);
    const catalog = portalItems.find((item) => item.href === ROUTE);
    assert.ok(catalog, "the portal sidebar catalog must offer My List");
    assert.deepEqual(
      [...(catalog.roles ?? [])].sort(),
      [...MY_LIST_PORTAL_ROLES].sort(),
      "the catalog entry must name exactly MY_LIST_PORTAL_ROLES, or a row appears for a seat the page refuses",
    );
    assert.equal(catalog.label, "My List");

    const navSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
    const flagStart = navSource.indexOf("const showMyListTab");
    assert.ok(flagStart >= 0, "the portal My List visibility flag must exist");
    const flag = navSource.slice(flagStart, navSource.indexOf(";", flagStart) + 1);
    assert.ok(flag.includes("MY_LIST_PORTAL_ROLES"), "the flag must ask the shared list, not spell the roles out again");

    const rep = resolveEmployeePortalNavVisibility("Medical Rep", "Medical Rep");
    assert.equal(rep.showMyListTab, true, "a Medical Rep's sidebar shows My List");
    assert.equal(rep.showRepsListTab, false, "and not Reps List");
    const districtManager = resolveEmployeePortalNavVisibility("District Manager", "District Manager");
    assert.equal(districtManager.showMyListTab, false, "a District Manager's sidebar shows no My List");
    assert.equal(districtManager.showRepsListTab, true, "and keeps Reps List");
    const elevated = resolveEmployeePortalNavVisibility("Medical Rep", "National Sales Manager");
    assert.equal(
      elevated.showMyListTab,
      false,
      "the nav follows the access role, as the page gate does — a Medical Rep title on an NSM account is a manager seat",
    );

    const entries = PORTAL_NAV_REGISTRY.filter((entry) => entry.href === ROUTE);
    assert.equal(entries.length, 1, "one registry entry per href");
    assert.deepEqual(entries[0].flags, ["showMyListTab"]);
    assert.deepEqual(entries[0].permission, { action: "read", resource: "crm_visits" });
    assert.equal(entries[0].label, "My List");

    const layout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
    assert.ok(
      layout.includes('...(showMyListTab ? [{ href: "/employee-portals/my-list", label: "My List"'),
      "the portal sidebar must render the My List row behind its flag",
    );
  }

  // ── THE PAGE READS NO REP FROM THE URL, AND THE TWO DOORS SEND EACH OTHER'S VIEWERS ACROSS ──
  {
    const page = readFileSync("app/employee-portals/my-list/page.tsx", "utf8");
    assert.ok(page.includes("getMyListScope(access)"), "the reach comes from the session through getMyListScope");
    assert.ok(
      page.includes('if (!canAccessMyList(access) || !(await canAccess(access, "crm_visits", "read"))) {'),
      "the page asserts both the role list and the crm_visits:read matrix grant",
    );
    assert.ok(!page.includes("getDoctorListScope"), "My List must never resolve the manager board's reach");
    assert.ok(!/params\?\.rep\b|searchParams.*\brep\b/.test(page), "no URL parameter may name the rep whose list opens");
    assert.ok(page.includes("logPortalFailure("), "a load failure is logged, not swallowed");
    assert.ok(page.includes('badge="CRM"') && page.includes('title="My List"'));
    const managerRedirect = page.indexOf('if (canAccessDoctorList(access) && !canAccessMyList(access)) redirect("/employee-portals/reps-list");');
    const pageGate = page.indexOf("if (!canAccessMyList(access)");
    assert.ok(managerRedirect >= 0 && managerRedirect < pageGate, "a manager who lands on My List is sent to Reps List before the refusal");

    const repsList = readFileSync("app/employee-portals/reps-list/page.tsx", "utf8");
    const repRedirect = repsList.indexOf('if (canAccessMyList(access)) redirect("/employee-portals/my-list");');
    const repsListGate = repsList.indexOf("if (!canAccessDoctorList(access)");
    assert.ok(
      repRedirect >= 0 && repsListGate > repRedirect,
      "a rep who lands on Reps List from a stale link is sent to My List before the manager gate refuses them",
    );

    const view = readFileSync("src/components/crm/reps-list-board.tsx", "utf8");
    const viewStart = view.indexOf("export function MyListBoardView");
    assert.ok(viewStart >= 0, "the My List view must exist");
    const viewBody = view.slice(viewStart, view.indexOf("\n}\n", viewStart));
    assert.ok(!viewBody.includes("RepsListFilters") && !viewBody.includes("RepCard"), "My List offers no picker and no rep cards");
    assert.ok(viewBody.includes("monthPreserve={{}}"), "the month picker carries no rep and no cascade");
    assert.ok(viewBody.includes('exportTitle="My List"'), "the download is titled My List");
  }

  // ── THE LOADER SELECTS THE REP THROUGH THE REVIEWED CASCADE, AND WITHHOLDS EVERY PEER NAME ──
  {
    const loader = readFileSync("src/lib/crm/reps-list-board.ts", "utf8");
    const entry = loader.indexOf("export async function getMyListBoard");
    assert.ok(entry >= 0, "getMyListBoard must exist");
    const entryBody = loader.slice(entry, loader.indexOf("\n}\n", entry));
    assert.ok(
      entryBody.includes("params: { month?: string };") &&
        entryBody.includes("assembleBoard(await buildOwnListCascade(input.scope), input.params.month)"),
      "the board takes a month and nothing else from the page",
    );

    const start = loader.indexOf("async function buildOwnListCascade");
    assert.ok(start >= 0, "buildOwnListCascade must exist");
    const body = loader.slice(start, loader.indexOf("\n}\n", start));
    assert.ok(
      body.includes("buildRepsCascade({ params: { rep: coverageRepKey(hrId) }, scope })"),
      "the rep is selected by their own key off the scope-restricted tree — the join Reps List already reviews",
    );
    assert.ok(
      body.includes("repNameByRepKey: withRepNamesWithheld(cascade.repNameByRepKey)"),
      "every peer name must be withheld server-side — whatever reaches the page is in its payload",
    );
    assert.ok(body.includes("options: EMPTY_OPTIONS") && body.includes("selection: {}"), "a rep picks nobody");
  }

  // ── A WITHHELD NAME KEEPS THE MATCH, THE SCORE AND THE INSIGHT ──────────────────────────────
  {
    const named = new Map([
      ["10", "Mahmoud Alslamony"],
      ["20", "Omnia Ismael"],
      ["30", "Karim Fouad"],
    ]);
    const withheld = withRepNamesWithheld(named);
    assert.deepEqual([...withheld.keys()], [...named.keys()], "every key survives — a match needs the key");
    assert.ok([...withheld.values()].every((value) => value === UNNAMED_REP), "and no name does");

    const entry = (repKey: string, contactCrmId: number, name: string, phone: string | null, speciality: string | null = null): RosterEntry => ({
      contactCrmId,
      name,
      nameKey: nameKey(name),
      phoneKey: phoneKey(phone),
      regionKey: null,
      repKey,
      speciality,
    });
    const mine = [{ contactCrmId: 101, repKey: "10" }];
    const noPeerName = (value: unknown) =>
      !["Mahmoud Alslamony", "Omnia Ismael", "Karim Fouad"].some((name) => JSON.stringify(value).includes(name));

    // One partner, same name, same place.
    {
      const roster = [entry("10", 101, "Ahmed Fouad", "0100 123 4567"), entry("20", 201, "Ahmed Fouad", "0100 999 8888")];
      const pins = new Map([
        [101, { lat: 30, lon: 31 }],
        [201, { lat: 30.0005, lon: 31 }],
      ]);
      const asManager = findSharedCustomers(mine, roster, pins, named).get(101) ?? [];
      const asRep = findSharedCustomers(mine, roster, pins, withheld).get(101) ?? [];
      assert.equal(asRep.length, 1, "the rep's own list keeps the shared customer — dropping the partner would take the highlight off");
      assert.deepEqual(
        asRep.map(({ basis, contactCrmIds, metres }) => ({ basis, contactCrmIds, metres })),
        asManager.map(({ basis, contactCrmIds, metres }) => ({ basis, contactCrmIds, metres })),
        "the match, the partner's rows that feed the score and the distance are the manager's, unchanged",
      );
      assert.ok(noPeerName(asRep), "and no peer name is anywhere in what reaches the page");
      assert.equal(describeSharing(asRep), "Also on another rep's list — matched by same name, same place");
      assert.equal(
        describeSharing(asManager),
        "Also on Omnia Ismael's list — matched by same name, same place",
        "the manager's line is unchanged",
      );
    }

    // Two partners on one phone.
    {
      const roster = [
        entry("10", 101, "Ahmed Fouad", "0100 123 4567"),
        entry("20", 201, "Ahmed F.", "0100 123 4567"),
        entry("30", 301, "A. Fouad", "0100 123 4567"),
      ];
      const asRep = findSharedCustomers(mine, roster, new Map(), withheld).get(101) ?? [];
      assert.equal(asRep.length, 2, "two partners stay two");
      assert.equal(
        describeSharing(asRep),
        "Also on 2 other reps' lists — matched by same phone number",
        "unnamed partners are COUNTED — never 'another rep and another rep'",
      );
      assert.equal(sharedWithCell(asRep.map((shared) => shared.repName)), "2 other reps", "the export cell counts them too");
      const asManager = findSharedCustomers(mine, roster, new Map(), named).get(101) ?? [];
      assert.equal(
        sharedWithCell(asManager.map((shared) => shared.repName)).split(", ").sort().join(", "),
        "Karim Fouad, Omnia Ismael",
        "the manager's export cell is the names comma-joined, as it always was",
      );
    }

    const unnamed = (basis: SharedWith["basis"]): SharedWith => ({ basis, contactCrmIds: [], metres: null, repName: UNNAMED_REP });
    assert.equal(describeSharing([unnamed("shared phone")]), "Also on another rep's list — matched by same phone number");
    assert.equal(sharedWithCell([UNNAMED_REP]), "another rep");
    assert.equal(sharedWithCell([]), "");
    assert.equal(
      describeSharing([
        { basis: "shared phone", contactCrmIds: [], metres: null, repName: "Sara Mohy Eldeen" },
        { basis: "shared phone", contactCrmIds: [], metres: null, repName: "Omar Adel" },
      ]),
      "Also on Sara Mohy Eldeen and Omar Adel's list — matched by same phone number",
      "named partners read exactly as before",
    );

    // The popup: counted partners and refused partners, both unnamed.
    {
      const now = Date.parse("2026-09-16T12:00:00.000Z");
      const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
      const pin = { lat: 30, lon: 31 };
      const scored = scoreLocationConfidence(
        pin,
        [
          { at: daysAgo(5), lat: 30, lon: 31, repKey: "10" },
          { at: daysAgo(6), lat: 30, lon: 31, repKey: "20" },
          { at: daysAgo(7), lat: 30, lon: 31, repKey: "30" },
        ],
        now,
        { count: 2, distant: [{ metres: 11_000, repName: UNNAMED_REP }], repNames: [UNNAMED_REP, UNNAMED_REP] },
      );
      assert.ok(scored, "the pin scores");
      const counted = scored.reasons.find((reason) => reason.label === "Counted from a shared customer");
      assert.ok(counted, "the partners' visits are still counted and still explained");
      assert.ok(
        counted.detail.includes("2 of these visits are from 2 other reps' own records of the same customer"),
        `two unnamed reps are counted in the sentence: ${counted.detail}`,
      );
      const refused = scored.reasons.find((reason) => reason.label === "Shared, but not the same place");
      assert.ok(refused, "a refused partner is still explained");
      assert.ok(
        refused.detail.startsWith("Another rep shares this customer, but their record stands about 11.0 km away"),
        `the sentence opens capitalised and in English: ${refused.detail}`,
      );
      assert.ok(scored.reasons.every((reason) => !reason.detail.includes("another rep and another rep")));

      const twoRefused = scoreLocationConfidence(pin, [{ at: daysAgo(5), lat: 30, lon: 31, repKey: "10" }, { at: daysAgo(6), lat: 30, lon: 31, repKey: "10" }], now, {
        count: 0,
        distant: [
          { metres: 11_000, repName: UNNAMED_REP },
          { metres: 9_000, repName: UNNAMED_REP },
        ],
        repNames: [],
      });
      const twoLine = twoRefused?.reasons.find((reason) => reason.label === "Shared, but not the same place");
      assert.ok(
        twoLine?.detail.startsWith("2 other reps share this customer, but the nearest of their records stands about 9.0 km away"),
        `several refused partners read in the plural: ${twoLine?.detail}`,
      );
    }

    // The insight: the owner's own example — one rare name, far away, under other reps.
    {
      const at = (lat: number) => ({ lat, lon: 31 });
      const northOf = (km: number) => at(30 + (km * 1000) / 111_320);
      const one = [entry("10", 1, "Ahmed Fathy Nour", null, "Internal Medicine"), entry("20", 2, "Ahmed Fathy Nour", null, "Internal Medicine")];
      const onePins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const row = [{ contactCrmId: 1, points: [], repKey: "10" }];
      const asManager = buildPhoenixInsights(row, one, onePins, named).get(1) ?? [];
      const asRep = buildPhoenixInsights(row, one, onePins, withheld).get(1) ?? [];
      assert.equal(asRep.length, asManager.length, "the rep sees every insight the manager sees on the same list");
      assert.ok(asRep[0]?.detail.startsWith("This exact name is also on another rep's list, 40.0 km away"), asRep[0]?.detail);
      assert.ok(noPeerName(asRep), "without the peer's name");

      const two = [...one, entry("30", 3, "Ahmed Fathy Nour", null, "Internal Medicine")];
      const twoPins = new Map([...onePins, [3, northOf(60)]]);
      const twoAsRep = buildPhoenixInsights(row, two, twoPins, withheld).get(1) ?? [];
      assert.ok(
        twoAsRep[0]?.detail.startsWith("This exact name is also on 2 other reps' lists, the furthest 60.0 km away"),
        `partners are counted by rep, not by name — every withheld name is the same label, so a set of names reads two reps as one: ${twoAsRep[0]?.detail}`,
      );
      const twoAsManager = buildPhoenixInsights(row, two, twoPins, named).get(1) ?? [];
      assert.equal(twoAsManager[0]?.detail, twoAsRep[0]?.detail, "and the manager reads the same sentence");
    }
  }
}
