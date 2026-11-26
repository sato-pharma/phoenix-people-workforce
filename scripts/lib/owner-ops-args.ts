// scripts/lib/owner-ops-args.ts
// ---------------------------------------------------------------------------
// THE COMMAND LINE OF scripts/owner-ops.ts, AND NOTHING ELSE — no imports, no database, no env.
//
// Kept apart from the runner so tests/owner-ops-runner.test.ts can pin the one rule that matters
// most here without a database: 🔴 A RUN IS A DRY RUN UNLESS THE LITERAL TOKEN `--apply` IS ON THE
// COMMAND LINE. `--apply=yes`, `--Apply`, `--aply` and `apply` (no dashes) never turn a dry run into a
// write; the first is refused here and the rest by the runner's unknown-flag gate or as a stray word.
//
// Each job takes only its own flags. A flag that belongs to another job is refused rather than ignored
// (`merge-venues --lat 31` is somebody who meant a different job), and a value flag given twice is
// refused rather than "last one wins".
// ---------------------------------------------------------------------------

export const OWNER_OPS_JOBS = ["link-doctor", "merge-venues", "merge-customers", "pin-pharmacy", "load-crm-list", "seat-in-building"] as const;
export type OwnerOpsJob = (typeof OWNER_OPS_JOBS)[number];

/** Every flag the runner knows, for refuseUnknownFlags. */
export const OWNER_OPS_FLAGS = [
  "--apply",
  "--body",
  "--building",
  "--customers",
  "--employee",
  "--help",
  "--lat",
  "--lng",
  "--loser",
  "--pharmacy",
  "--reason",
  "--retired",
  "--seat",
  "--survivor",
  "-h",
] as const;

const VALUE_FLAGS_BY_JOB: Record<OwnerOpsJob, readonly string[]> = {
  "link-doctor": ["--body"],
  "merge-venues": ["--survivor", "--loser", "--reason", "--employee"],
  "merge-customers": ["--survivor", "--retired", "--reason"],
  "pin-pharmacy": ["--pharmacy", "--lat", "--lng", "--employee"],
  "load-crm-list": ["--seat", "--body"],
  "seat-in-building": ["--seat", "--building", "--customers", "--reason"],
};

/** The database's own ceiling on one seating list (phoenix_crm_seat_waiting_customers_in_venue). */
export const SEAT_IN_BUILDING_MAX_CUSTOMERS = 60;

/**
 * Egypt's box, generously. A pin outside it is refused: usually latitude and longitude swapped. The two
 * ranges OVERLAP, so this catches a swap only where it lands outside Egypt (Aswan, 24.09 / 32.90, swapped
 * is latitude 32.90); a swapped Cairo or Delta pin (29.95 / 31.25) still reads as a place in Egypt, which
 * is why the runner prints the pin row and the proof read for a human to look at.
 */
export const EGYPT_LATITUDE_RANGE = [21.5, 32] as const;
export const EGYPT_LONGITUDE_RANGE = [24.5, 37] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnerOpsPlan =
  | { job: "link-doctor"; apply: boolean; bodyPath: string }
  | { job: "merge-venues"; apply: boolean; survivorId: string; loserId: string; reason: string; employeeHrId: string | null }
  | { job: "merge-customers"; apply: boolean; survivorId: string; retiredId: string; reason: string }
  | { job: "pin-pharmacy"; apply: boolean; pharmacyId: string; latitude: number; longitude: number; employeeHrId: string | null }
  | { job: "load-crm-list"; apply: boolean; seatId: string; bodyPath: string }
  | { job: "seat-in-building"; apply: boolean; seatId: string; buildingId: string; customerIds: string[]; reason: string };

export type OwnerOpsParse = { ok: true; plan: OwnerOpsPlan } | { ok: false; error: string };

export const OWNER_OPS_USAGE = `owner-ops — the owner's desk jobs, run from the app's own code against the database in .env.local.

A DRY RUN BY DEFAULT: the job runs fully through the app's own checks, every write it would make is
listed and none is sent. Only --apply writes. Every run ends with a proof read.

  link-doctor  --body <file.json>
      Link a doctor's pharmacies to an employee (the Super Admin desk entry). The file is the exact
      body of POST /api/marketing-requests/validation, onBehalfOfHrId included
      (docs/owner-operations-recipes.md).
  merge-venues --survivor <pharmacy id> --loser <pharmacy id> --reason "<why they are one shop>" [--employee <hr id>]
      Fold a duplicate pharmacy copy into the one that stays. One copy per run.
  merge-customers --survivor <customer id> --retired <customer id> --reason "<why they are one customer>"
      Fold a customer saved twice into the one that stays (the Customer Database's "Merge duplicate
      customers"). Same line, kind and area only; the database refuses anything else. One pair per run.
  pin-pharmacy --pharmacy <pharmacy id> --lat <latitude> --lng <longitude> [--employee <hr id>]
      Put a map pin on a saved pharmacy that has none (evidence stays pending: no shop photo).
  load-crm-list --seat <seat id> --body <file.json>
      Put customers on a rep's Phoenix CRM list as "to validate" (and hours on ones already waiting),
      through the SFE's own list-template upload. The rep validates each at the door.
  seat-in-building --seat <seat id> --building <building id> --customers <id,id,...> --reason "<why>"
      Seat customers still waiting to be validated (no place yet, hours set) in an approved building
      that has a timetable, at the building's point. The board then validates only the ones it names.

  --apply      write for real (refused from a tree behind origin/main)
  --employee   whose draft workspace the proof read opens; by default every employee holding a
               doctor linked to the pharmacy

Run:
  node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \\
    --import ./tests/register-alias-loader.mjs scripts/owner-ops.ts <job> <flags>`;

function flagName(token: string): string {
  return token.split("=")[0] ?? token;
}

export function parseOwnerOpsArgs(argv: readonly string[]): OwnerOpsParse {
  const [jobToken, ...rest] = argv;
  if (!jobToken || jobToken.startsWith("-")) {
    return { ok: false, error: `name the job first: ${OWNER_OPS_JOBS.join(", ")}` };
  }
  if (!(OWNER_OPS_JOBS as readonly string[]).includes(jobToken)) {
    return { ok: false, error: `"${jobToken}" is not a job this runner knows; it knows ${OWNER_OPS_JOBS.join(", ")}` };
  }
  const job = jobToken as OwnerOpsJob;
  const allowed = VALUE_FLAGS_BY_JOB[job];

  let apply = false;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    const name = flagName(token);
    if (name === "--apply") {
      if (token !== "--apply") return { ok: false, error: "--apply takes no value; write it on its own" };
      apply = true;
      continue;
    }
    if (!token.startsWith("-")) {
      return { ok: false, error: `"${token}" is not a flag or a flag's value — quote a value that has spaces in it` };
    }
    if (!allowed.includes(name)) {
      return { ok: false, error: `${name} is not a flag of ${job}; it takes ${allowed.join(" ")} and --apply` };
    }
    if (values.has(name)) return { ok: false, error: `${name} is given twice` };
    let value: string | undefined;
    if (token.includes("=")) {
      value = token.slice(token.indexOf("=") + 1);
    } else {
      value = rest[index + 1];
      index += 1;
    }
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      return { ok: false, error: `${name} needs a value` };
    }
    values.set(name, value.trim());
  }

  const need = (name: string): string | { error: string } => values.get(name) ?? { error: `${job} needs ${name}` };
  const id = (name: string): string | { error: string } => {
    const value = need(name);
    if (typeof value !== "string") return value;
    return UUID.test(value) ? value.toLowerCase() : { error: `${name} must be ${job === "merge-customers" ? "a customer" : "a pharmacy"} id (a uuid), got "${value}"` };
  };

  if (job === "link-doctor") {
    const bodyPath = need("--body");
    if (typeof bodyPath !== "string") return { ok: false, ...bodyPath };
    return { ok: true, plan: { job, apply, bodyPath } };
  }

  if (job === "load-crm-list") {
    const bodyPath = need("--body");
    if (typeof bodyPath !== "string") return { ok: false, ...bodyPath };
    const seatId = need("--seat");
    if (typeof seatId !== "string") return { ok: false, ...seatId };
    if (!/^SEAT-[A-Z0-9-]+$/i.test(seatId)) return { ok: false, error: `--seat must be a territory seat id like SEAT-PED-REP-D12, got "${seatId}"` };
    return { ok: true, plan: { job, apply, seatId: seatId.toUpperCase(), bodyPath } };
  }

  if (job === "seat-in-building") {
    const seatId = need("--seat");
    if (typeof seatId !== "string") return { ok: false, ...seatId };
    if (!/^SEAT-[A-Z0-9-]+$/i.test(seatId)) return { ok: false, error: `--seat must be a territory seat id like SEAT-PED-REP-D12, got "${seatId}"` };
    const buildingId = need("--building");
    if (typeof buildingId !== "string") return { ok: false, ...buildingId };
    if (!UUID.test(buildingId)) return { ok: false, error: `--building must be the building's id (a uuid), got "${buildingId}"` };
    const list = need("--customers");
    if (typeof list !== "string") return { ok: false, ...list };
    const customerIds = list.split(",").map((part) => part.trim()).filter(Boolean);
    if (customerIds.length === 0) return { ok: false, error: "--customers names no customer" };
    const bad = customerIds.find((part) => !UUID.test(part));
    if (bad) return { ok: false, error: `--customers takes customer ids (uuids) separated by commas, got "${bad}"` };
    const unique = [...new Set(customerIds.map((part) => part.toLowerCase()))];
    if (unique.length !== customerIds.length) return { ok: false, error: "--customers names a customer twice" };
    if (unique.length > SEAT_IN_BUILDING_MAX_CUSTOMERS) return { ok: false, error: `--customers names more than ${SEAT_IN_BUILDING_MAX_CUSTOMERS} customers` };
    const reason = need("--reason");
    if (typeof reason !== "string") return { ok: false, ...reason };
    if (reason.length < 10 || reason.length > 500) return { ok: false, error: "--reason must be 10 to 500 characters" };
    return { ok: true, plan: { job, apply, seatId: seatId.toUpperCase(), buildingId: buildingId.toLowerCase(), customerIds: unique, reason } };
  }

  if (job === "merge-customers") {
    const survivorId = id("--survivor");
    if (typeof survivorId !== "string") return { ok: false, ...survivorId };
    const retiredId = id("--retired");
    if (typeof retiredId !== "string") return { ok: false, ...retiredId };
    if (survivorId === retiredId) return { ok: false, error: "--survivor and --retired are the same customer" };
    const reason = need("--reason");
    if (typeof reason !== "string") return { ok: false, ...reason };
    if (reason.length < 10 || reason.length > 500) return { ok: false, error: "--reason must be 10 to 500 characters: it is the only record of why two rows were judged one customer" };
    return { ok: true, plan: { job, apply, survivorId, retiredId, reason } };
  }

  if (job === "merge-venues") {
    const survivorId = id("--survivor");
    if (typeof survivorId !== "string") return { ok: false, ...survivorId };
    const loserId = id("--loser");
    if (typeof loserId !== "string") return { ok: false, ...loserId };
    if (survivorId === loserId) return { ok: false, error: "--survivor and --loser are the same pharmacy" };
    const reason = need("--reason");
    if (typeof reason !== "string") return { ok: false, ...reason };
    return { ok: true, plan: { job, apply, survivorId, loserId, reason, employeeHrId: values.get("--employee") ?? null } };
  }

  const pharmacyId = id("--pharmacy");
  if (typeof pharmacyId !== "string") return { ok: false, ...pharmacyId };
  const coordinate = (name: string, [low, high]: readonly [number, number]): number | { error: string } => {
    const raw = need(name);
    if (typeof raw !== "string") return raw;
    const value = Number(raw);
    if (!Number.isFinite(value)) return { error: `${name} must be a number, got "${raw}"` };
    if (value < low || value > high) {
      return { error: `${name} ${value} is outside Egypt (${low} to ${high}) — are latitude and longitude swapped?` };
    }
    return value;
  };
  const latitude = coordinate("--lat", EGYPT_LATITUDE_RANGE);
  if (typeof latitude !== "number") return { ok: false, ...latitude };
  const longitude = coordinate("--lng", EGYPT_LONGITUDE_RANGE);
  if (typeof longitude !== "number") return { ok: false, ...longitude };
  return { ok: true, plan: { job, apply, pharmacyId, latitude, longitude, employeeHrId: values.get("--employee") ?? null } };
}
