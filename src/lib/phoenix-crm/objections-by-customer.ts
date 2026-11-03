/**
 * Phoenix CRM — objections by customer: each rep's customers, and what each customer objected to, with the
 * product, the day and the rep's note where the visit carries one. No I/O.
 *
 * Owner's decision, 3 November 2026, partly lifting the rule What the field heard keeps
 * (field-heard.ts, which is unchanged): he wants a per-customer list for the managers, counts only.
 *
 * ## 🔴 WHAT THE CUSTOMER SAID — NEVER A MARK AGAINST THE REP
 *
 * The objection is the CUSTOMER's (visit-outcome.ts). Naming the rep here says whose customers they are, so
 * a manager can help with them. It never measures him, so:
 *
 *   - only an objection a customer actually raised gets in. "No objection", a blank and an unknown key are
 *     dropped at the door, through `raisedObjection`, the rule What the field heard reads;
 *   - there is no percentage, no rate, no rank and no score, and no field of this output can carry one;
 *   - a rep carries NO total of his own. Counts sit on an objection, under a customer, and the only sum
 *     above that is the report's whole total;
 *   - every row sorts by NAME — rep, then customer — and never by a count, so the list can never read as a
 *     league table;
 *   - tests/phoenix-crm-objections-by-customer.test.ts refuses an import of this module from Phoenix Ranks,
 *     the KPIs, payroll, incentives, coaching or the integrity board.
 *
 * Reps never read it: the gate is `readsTeamReports`, asked first in `loadObjectionsByCustomerReport`.
 *
 * A pharmacy call is left out, as on What the field heard: it is not a customer. AM and PM stay two figures.
 */

import { HEARD_OBJECTIONS, raisedObjection, type HeardObjection, type HeardTally } from "@/lib/phoenix-crm/field-heard";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";

/** One visit as this report reads it, with its people and its customer already named. */
export type ObjectionVisit = {
  /** The person's key, so two reps who share a name stay two rows. Never printed. */
  repKey: string;
  repName: string;
  territoryName: string | null;
  customerId: string;
  customerName: string;
  speciality: string | null;
  visitDate: string;
  /** Raw, as the visit saved it: a pharmacy call is dropped here. */
  listType: unknown;
  products: ReadonlyArray<string>;
  /** Raw, as the visit saved it: only an objection a customer raised is kept. */
  objection: unknown;
  objectionNote: string | null;
};

/** One visit behind a count: the day, the list, the products discussed and the rep's own words. */
export type ObjectionVisitLine = {
  visitDate: string;
  listType: "AM" | "PM";
  products: string[];
  note: string | null;
};

/** One objection of one customer: how many times, AM and PM apart, and the visits it was raised on. */
export type CustomerObjection = HeardTally & {
  key: HeardObjection;
  label: string;
  /** Newest first. */
  visits: ObjectionVisitLine[];
};

export type ObjectingCustomer = {
  key: string;
  customerName: string;
  speciality: string | null;
  /** In the visit form's own order, never by how many. */
  objections: CustomerObjection[];
};

export type RepObjections = {
  key: string;
  repName: string;
  /** The territories these visits were made on, by name. */
  territories: string[];
  /** By the customer's name. A rep has no total of his own: that would be a figure about him. */
  customers: ObjectingCustomer[];
};

export type ObjectionsByCustomerResult = {
  /** By the rep's name, never by a count. */
  reps: RepObjections[];
  totals: { objections: HeardTally; customers: number; reps: number };
};

/** One row per customer, in the report's own order: what the screen and the workbook both list. */
export type ObjectionCustomerRow = {
  key: string;
  repName: string;
  territories: string[];
  customerName: string;
  speciality: string | null;
  objections: CustomerObjection[];
};

function cleanText(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || null;
}

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

type BuildingCustomer = { customerName: string; speciality: string | null; objections: Map<HeardObjection, { am: number; pm: number; visits: ObjectionVisitLine[] }> };
type BuildingRep = { repName: string; territories: Set<string>; customers: Map<string, BuildingCustomer> };

export function buildObjectionsByCustomer(visits: ReadonlyArray<ObjectionVisit>): ObjectionsByCustomerResult {
  const reps = new Map<string, BuildingRep>();
  const customersSeen = new Set<string>();
  const totals: HeardTally = { am: 0, pm: 0 };

  for (const visit of visits) {
    const objection = raisedObjection(visit.objection);
    const listType = doctorListType(visit.listType);
    if (!objection || !listType) continue;

    let rep = reps.get(visit.repKey);
    if (!rep) {
      rep = { repName: visit.repName, territories: new Set(), customers: new Map() };
      reps.set(visit.repKey, rep);
    }
    const territory = cleanText(visit.territoryName);
    if (territory) rep.territories.add(territory);

    let customer = rep.customers.get(visit.customerId);
    if (!customer) {
      customer = { customerName: visit.customerName, speciality: cleanText(visit.speciality), objections: new Map() };
      rep.customers.set(visit.customerId, customer);
    }
    customersSeen.add(visit.customerId);

    let entry = customer.objections.get(objection);
    if (!entry) {
      entry = { am: 0, pm: 0, visits: [] };
      customer.objections.set(objection, entry);
    }
    const side = listType === "AM" ? "am" : "pm";
    entry[side] += 1;
    totals[side] += 1;
    entry.visits.push({
      visitDate: visit.visitDate,
      listType,
      products: [...new Set(visit.products.map((name) => cleanText(name)).filter((name): name is string => name !== null))],
      note: cleanText(visit.objectionNote),
    });
  }

  return {
    reps: [...reps]
      .map(([key, rep]) => ({
        key,
        repName: rep.repName,
        territories: [...rep.territories].sort(byName),
        customers: [...rep.customers]
          .map(([customerKey, customer]) => ({
            key: customerKey,
            customerName: customer.customerName,
            speciality: customer.speciality,
            objections: HEARD_OBJECTIONS.flatMap(({ key: objectionKey, label }) => {
              const entry = customer.objections.get(objectionKey);
              if (!entry) return [];
              return [
                {
                  key: objectionKey,
                  label,
                  am: entry.am,
                  pm: entry.pm,
                  visits: [...entry.visits].sort((left, right) => right.visitDate.localeCompare(left.visitDate)),
                },
              ];
            }),
          }))
          .sort((left, right) => byName(left.customerName, right.customerName) || byName(left.key, right.key)),
      }))
      .sort((left, right) => byName(left.repName, right.repName) || byName(left.key, right.key)),
    totals: { objections: totals, customers: customersSeen.size, reps: reps.size },
  };
}

/** The grouped report as one row per customer, keeping its order: rep by name, then customer by name. */
export function objectionCustomerRows(result: Pick<ObjectionsByCustomerResult, "reps">): ObjectionCustomerRow[] {
  return result.reps.flatMap((rep) =>
    rep.customers.map((customer) => ({
      key: `${rep.key}|${customer.key}`,
      repName: rep.repName,
      territories: rep.territories,
      customerName: customer.customerName,
      speciality: customer.speciality,
      objections: customer.objections,
    })),
  );
}
