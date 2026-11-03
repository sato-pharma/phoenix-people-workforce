/**
 * Phoenix CRM — objections by doctor: each rep's doctors, and what each doctor objected to, with the
 * product, the day and the rep's note where the visit carries one. No I/O.
 *
 * Owner's decision, 3 November 2026, partly lifting the rule What the field heard keeps
 * (field-heard.ts, which is unchanged): he wants a per-doctor list for the managers, counts only.
 *
 * ## 🔴 WHAT THE DOCTOR SAID — NEVER A MARK AGAINST THE REP
 *
 * The objection is the DOCTOR's (visit-outcome.ts). Naming the rep here says whose doctors they are, so
 * a manager can help with them. It never measures him, so:
 *
 *   - only an objection a doctor actually raised gets in. "No objection", a blank and an unknown key are
 *     dropped at the door, through `raisedObjection`, the rule What the field heard reads;
 *   - there is no percentage, no rate, no rank and no score, and no field of this output can carry one;
 *   - a rep carries NO total of his own. Counts sit on an objection, under a doctor, and the only sum
 *     above that is the report's whole total;
 *   - every row sorts by NAME — rep, then doctor — and never by a count, so the list can never read as a
 *     league table;
 *   - tests/phoenix-crm-objections-by-doctor.test.ts refuses an import of this module from Phoenix Ranks,
 *     the KPIs, payroll, incentives, coaching or the integrity board.
 *
 * Reps never read it: the gate is `readsTeamReports`, asked first in `loadObjectionsByDoctorReport`.
 *
 * A pharmacy call is left out, as on What the field heard: it is not a doctor. AM and PM stay two figures.
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
  doctorName: string;
  speciality: string | null;
  visitDate: string;
  /** Raw, as the visit saved it: a pharmacy call is dropped here. */
  listType: unknown;
  products: ReadonlyArray<string>;
  /** Raw, as the visit saved it: only an objection a doctor raised is kept. */
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

/** One objection of one doctor: how many times, AM and PM apart, and the visits it was raised on. */
export type DoctorObjection = HeardTally & {
  key: HeardObjection;
  label: string;
  /** Newest first. */
  visits: ObjectionVisitLine[];
};

export type ObjectingDoctor = {
  key: string;
  doctorName: string;
  speciality: string | null;
  /** In the visit form's own order, never by how many. */
  objections: DoctorObjection[];
};

export type RepObjections = {
  key: string;
  repName: string;
  /** The territories these visits were made on, by name. */
  territories: string[];
  /** By the doctor's name. A rep has no total of his own: that would be a figure about him. */
  doctors: ObjectingDoctor[];
};

export type ObjectionsByDoctorResult = {
  /** By the rep's name, never by a count. */
  reps: RepObjections[];
  totals: { objections: HeardTally; doctors: number; reps: number };
};

/** One row per doctor, in the report's own order: what the screen and the workbook both list. */
export type ObjectionDoctorRow = {
  key: string;
  repName: string;
  territories: string[];
  doctorName: string;
  speciality: string | null;
  objections: DoctorObjection[];
};

function cleanText(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || null;
}

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

type BuildingDoctor = { doctorName: string; speciality: string | null; objections: Map<HeardObjection, { am: number; pm: number; visits: ObjectionVisitLine[] }> };
type BuildingRep = { repName: string; territories: Set<string>; doctors: Map<string, BuildingDoctor> };

export function buildObjectionsByDoctor(visits: ReadonlyArray<ObjectionVisit>): ObjectionsByDoctorResult {
  const reps = new Map<string, BuildingRep>();
  const doctorsSeen = new Set<string>();
  const totals: HeardTally = { am: 0, pm: 0 };

  for (const visit of visits) {
    const objection = raisedObjection(visit.objection);
    const listType = doctorListType(visit.listType);
    if (!objection || !listType) continue;

    let rep = reps.get(visit.repKey);
    if (!rep) {
      rep = { repName: visit.repName, territories: new Set(), doctors: new Map() };
      reps.set(visit.repKey, rep);
    }
    const territory = cleanText(visit.territoryName);
    if (territory) rep.territories.add(territory);

    let doctor = rep.doctors.get(visit.customerId);
    if (!doctor) {
      doctor = { doctorName: visit.doctorName, speciality: cleanText(visit.speciality), objections: new Map() };
      rep.doctors.set(visit.customerId, doctor);
    }
    doctorsSeen.add(visit.customerId);

    let entry = doctor.objections.get(objection);
    if (!entry) {
      entry = { am: 0, pm: 0, visits: [] };
      doctor.objections.set(objection, entry);
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
        doctors: [...rep.doctors]
          .map(([doctorKey, doctor]) => ({
            key: doctorKey,
            doctorName: doctor.doctorName,
            speciality: doctor.speciality,
            objections: HEARD_OBJECTIONS.flatMap(({ key: objectionKey, label }) => {
              const entry = doctor.objections.get(objectionKey);
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
          .sort((left, right) => byName(left.doctorName, right.doctorName) || byName(left.key, right.key)),
      }))
      .sort((left, right) => byName(left.repName, right.repName) || byName(left.key, right.key)),
    totals: { objections: totals, doctors: doctorsSeen.size, reps: reps.size },
  };
}

/** The grouped report as one row per doctor, keeping its order: rep by name, then doctor by name. */
export function objectionDoctorRows(result: Pick<ObjectionsByDoctorResult, "reps">): ObjectionDoctorRow[] {
  return result.reps.flatMap((rep) =>
    rep.doctors.map((doctor) => ({
      key: `${rep.key}|${doctor.key}`,
      repName: rep.repName,
      territories: rep.territories,
      doctorName: doctor.doctorName,
      speciality: doctor.speciality,
      objections: doctor.objections,
    })),
  );
}
