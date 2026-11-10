import { readPlacesToRecheck } from "@/lib/phoenix-crm/server/places-to-recheck";
import { formatCount, formatList } from "@/lib/reconciliation/compare";
import type { ReconciliationCheck, ReconciliationFinding, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Phoenix CRM places — the three invariants the validation audit of 11 November 2026 found broken with
 * nobody reading them (owner: "Build all six fixes"). Each door is now closed in code and in the
 * database; these checks are what says so every night, and what would say it first if one reopened.
 *
 * All three read REAL work only (`is_test = false`): about a thousand test customers were validated
 * before 21 October 2026 with no place at all, by design of the pilot, and they are nobody's defect.
 */

type Row = Record<string, unknown>;

const HELD_VISITS_PAGE = "/admin/phoenix-crm/far-visit-holds";

/** A doctor or an account is validated at a door; a pharmacy is validated by its own pin and holds no place row. */
const LISTS_WITH_A_PLACE = ["AM", "PM"] as const;

export type ValidatedCustomer = { id: string; name: string };

/** The validated customers that hold no active place. Pure, so the test can break it. */
export function validatedCustomersWithoutPlace(
  customers: readonly ValidatedCustomer[],
  customerIdsWithAnActivePlace: ReadonlySet<string>,
): ValidatedCustomer[] {
  return customers.filter((customer) => !customerIdsWithAnActivePlace.has(customer.id));
}

async function readActivePlaces(): Promise<Row[]> {
  const supabase = getSupabaseAdmin();
  return fetchAllRowsKeyset<Row>(
    () => supabase.from("phoenix_crm_places").select("id, customer_id, brick_id").eq("status", "active").eq("is_test", false),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
}

async function namesOf(customerIds: readonly string[]): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const names = new Map<string, string>();
  for (let from = 0; from < customerIds.length; from += 150) {
    const part = customerIds.slice(from, from + 150);
    const { data, error } = await supabase.from("phoenix_crm_customers").select("id, name").in("id", part);
    if (error) throw new Error(`phoenix_crm_customers: ${error.message}`);
    for (const row of (data ?? []) as Row[]) names.set(String(row.id), String(row.name ?? "").trim() || "A customer with no name");
  }
  return names;
}

const validatedCustomerHoldsAPlace: ReconciliationCheck = {
  id: "phoenix-crm-validated-customer-holds-a-place",
  title: "Every validated doctor and account on a list holds a place its visits are measured against",
  domain: "crm-sales",
  severity: "high",
  // It HOLDS since 11 Nov 2026: the 26 found that day (23 admitted by an add approval after their only place had
  // been retired, 3 hospital accounts stamped on 29 Oct with no place) went back to "To validate" on the owner's
  // word (scripts/phoenix-crm-validation-repair-plan.ts), and 20261111004733 and 20261111013233 closed the doors.
  expectation: "holds",
  run: async (): Promise<ReconciliationOutcome> => {
    const supabase = getSupabaseAdmin();
    const [customerRows, placeRows] = await Promise.all([
      fetchAllRowsKeyset<Row>(
        () =>
          supabase
            .from("phoenix_crm_customers")
            .select("id, name")
            .eq("status", "active")
            .eq("is_test", false)
            .in("list_type", [...LISTS_WITH_A_PLACE])
            .not("validated_at", "is", null),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
      readActivePlaces(),
    ]);
    const customers = customerRows.map((row) => ({ id: String(row.id), name: String(row.name ?? "").trim() || "A customer with no name" }));
    const placed = new Set(placeRows.map((row) => String(row.customer_id)));
    const without = validatedCustomersWithoutPlace(customers, placed);
    const findings: ReconciliationFinding[] = without.map((customer) => ({
      hrId: null,
      relatedTable: "phoenix_crm_customers",
      relatedId: customer.id,
      detail: `${customer.name} is validated and on a list with no place, so no visit to this customer can be measured.`,
    }));
    return {
      left: { source: "phoenix_crm_customers: active, validated, AM or PM, real", value: formatCount(customers.length, "validated customer") },
      right: {
        source: "the same customers with an active row in phoenix_crm_places",
        value: formatCount(customers.length - without.length, "validated customer"),
      },
      holds: without.length === 0,
      detail:
        without.length === 0
          ? `All ${formatCount(customers.length, "validated doctor and account", "validated doctors and accounts")} hold a place.`
          : `${formatCount(without.length, "validated customer")} with no place: ${formatList(without.map((customer) => customer.name))}`,
      findings,
    };
  },
};

const activePlaceHoldsABrick: ReconciliationCheck = {
  id: "phoenix-crm-active-place-holds-a-brick",
  title: "Every saved place is filed under a brick, so it sits in somebody's territory",
  domain: "crm-sales",
  severity: "medium",
  expectation: "known-open",
  openDefect:
    "1 since 11 Nov 2026. 30 were found that day, all saved before the seat's own area could reach past the trust radius; 29 were filed under today's rule on the owner's word (scripts/phoenix-crm-refile-no-brick-places.ts) and one sits 12.6 km from the nearest brick. The check reports that one place until a person moves it or a brick is added for it.",
  run: async (): Promise<ReconciliationOutcome> => {
    const places = await readActivePlaces();
    const unfiled = places.filter((row) => row.brick_id === null || row.brick_id === undefined);
    const names = await namesOf([...new Set(unfiled.map((row) => String(row.customer_id)))]);
    const findings: ReconciliationFinding[] = unfiled.map((row) => ({
      hrId: null,
      relatedTable: "phoenix_crm_places",
      relatedId: String(row.id),
      detail: `The place of ${names.get(String(row.customer_id)) ?? "a customer"} holds no brick, area or region.`,
    }));
    return {
      left: { source: "phoenix_crm_places: active, real", value: formatCount(places.length, "place") },
      right: { source: "the same places with a brick", value: formatCount(places.length - unfiled.length, "place") },
      holds: unfiled.length === 0,
      detail:
        unfiled.length === 0
          ? `All ${formatCount(places.length, "active place")} are filed under a brick.`
          : `${formatCount(unfiled.length, "active place")} with no brick: ${formatList(unfiled.map((row) => names.get(String(row.customer_id)) ?? "a customer"))}`,
      findings,
    };
  },
};

const placeReadingsAgree: ReconciliationCheck = {
  id: "phoenix-crm-place-readings-agree",
  title: "No saved place holds a pin and a photo reading that cannot both be its door",
  domain: "crm-sales",
  severity: "medium",
  expectation: "known-open",
  openDefect:
    "34 on 11 Nov 2026, all saved before the door compared the two readings (readingsApartMeters, far-visit-safeguards.ts); a capture like them is refused since. Each is on the held-visits page under Places to re-check, for the Super Admin or the SFE Manager to move or leave. A place a person moved or put on a trusted point is not counted.",
  run: async (): Promise<ReconciliationOutcome> => {
    // The page's own reader and rule, so the page and this check can never disagree about the list.
    const { list, places } = await readPlacesToRecheck();
    const apart = list.filter((entry) => entry.findings.some((finding) => finding.reason === "readings_apart"));
    const names = await namesOf([...new Set(apart.map((entry) => entry.customerId))]);
    const findings: ReconciliationFinding[] = apart.map((entry) => {
      const metres = entry.findings.find((finding) => finding.reason === "readings_apart")?.metres ?? null;
      return {
        hrId: null,
        relatedTable: "phoenix_crm_places",
        relatedId: entry.placeId,
        detail: `The place of ${names.get(entry.customerId) ?? "a customer"} holds a pin and a photo reading ${metres === null ? "too far" : `${Math.round(metres).toLocaleString("en-US")} m`} apart.`,
        moduleHref: HELD_VISITS_PAGE,
      };
    });
    return {
      left: { source: "phoenix_crm_places: active, real", value: formatCount(places.size, "place") },
      right: { source: "the same places whose two readings can both be the door (readingsApartMeters)", value: formatCount(places.size - apart.length, "place") },
      holds: apart.length === 0,
      detail:
        apart.length === 0
          ? `No active place holds two readings that disagree, across ${formatCount(places.size, "place")}.`
          : `${formatCount(apart.length, "active place")} with two readings that disagree: ${formatList(apart.map((entry) => names.get(entry.customerId) ?? "a customer"))}`,
      findings,
    };
  },
};

export const phoenixCrmPlacesReconciliationChecks: ReconciliationCheck[] = [
  validatedCustomerHoldsAPlace,
  activePlaceHoldsABrick,
  placeReadingsAgree,
];
