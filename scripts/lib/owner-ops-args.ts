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

export const OWNER_OPS_JOBS = ["link-doctor", "merge-venues", "merge-customers", "remove-customer-pharmacy", "pin-pharmacy", "load-crm-list", "seat-in-building", "tablet-agents", "start-tablet-agent", "bind-tablet-agent", "revoke-tablet-agent", "match-app-version", "lock-rep-tablets", "sync-insurance-master", "end-insurance-cover"] as const;
export type OwnerOpsJob = (typeof OWNER_OPS_JOBS)[number];

/** Every flag the runner knows, for refuseUnknownFlags. */
export const OWNER_OPS_FLAGS = [
  "--app",
  "--apply",
  "--body",
  "--building",
  "--customer",
  "--customers",
  "--employee",
  "--help",
  "--install",
  "--lat",
  "--lng",
  "--loser",
  "--pharmacy",
  "--reason",
  "--retired",
  "--seat",
  "--survivor",
  "--tablet",
  "-h",
] as const;

const VALUE_FLAGS_BY_JOB: Record<OwnerOpsJob, readonly string[]> = {
  "link-doctor": ["--body"],
  "merge-venues": ["--survivor", "--loser", "--reason", "--employee"],
  "merge-customers": ["--survivor", "--retired", "--reason"],
  "remove-customer-pharmacy": ["--customer", "--pharmacy", "--reason"],
  "pin-pharmacy": ["--pharmacy", "--lat", "--lng", "--employee"],
  "load-crm-list": ["--seat", "--body"],
  "seat-in-building": ["--seat", "--building", "--customers", "--reason"],
  "tablet-agents": [],
  "start-tablet-agent": ["--tablet"],
  "bind-tablet-agent": ["--install", "--tablet"],
  "revoke-tablet-agent": ["--install", "--reason"],
  "match-app-version": ["--app"],
  "lock-rep-tablets": [],
  "sync-insurance-master": [],
  "end-insurance-cover": ["--employee"],
};

/** A tablet's number as Headwind holds it — PHX-TAB-0008. Never a database row id. */
const TABLET_NUMBER = /^[A-Z0-9][A-Z0-9-]{2,39}$/i;

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
  | { job: "remove-customer-pharmacy"; apply: boolean; customerId: string; pharmacyId: string; reason: string }
  | { job: "pin-pharmacy"; apply: boolean; pharmacyId: string; latitude: number; longitude: number; employeeHrId: string | null }
  | { job: "load-crm-list"; apply: boolean; seatId: string; bodyPath: string }
  | { job: "seat-in-building"; apply: boolean; seatId: string; buildingId: string; customerIds: string[]; reason: string }
  | { job: "tablet-agents"; apply: boolean }
  | { job: "start-tablet-agent"; apply: boolean; deviceNumber: string }
  | { job: "bind-tablet-agent"; apply: boolean; installId: string; deviceNumber: string }
  | { job: "revoke-tablet-agent"; apply: boolean; installId: string; reason: string }
  | { job: "match-app-version"; apply: boolean; applicationId: number }
  | { job: "lock-rep-tablets"; apply: boolean }
  | { job: "sync-insurance-master"; apply: boolean }
  | { job: "end-insurance-cover"; apply: boolean; hrIds: string[] };

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
  remove-customer-pharmacy --customer <customer id> --pharmacy <pharmacy id> --reason "<why it comes off>"
      Switch off one pharmacy on one customer (the Customer Check page's "Remove"), e.g. the second
      copy of a pharmacy the customer already holds. Switched off, never deleted.
  pin-pharmacy --pharmacy <pharmacy id> --lat <latitude> --lng <longitude> [--employee <hr id>]
      Put a map pin on a saved pharmacy that has none (evidence stays pending: no shop photo).
  load-crm-list --seat <seat id> --body <file.json>
      Put customers on a rep's Phoenix CRM list as "to validate" (and hours on ones already waiting),
      through the SFE's own list-template upload. The rep validates each at the door.
  seat-in-building --seat <seat id> --building <building id> --customers <id,id,...> --reason "<why>"
      Seat customers still waiting to be validated (no place yet, hours set) in an approved building
      that has a timetable, at the building's point. The board then validates only the ones it names.
  tablet-agents
      List every Phoenix Position install that has said hello — which tablet each is bound to, when it
      last reported, and how many fixes it has sent. Reads only; --apply is meaningless here.
  start-tablet-agent --tablet <tablet number>
      Tell a tablet that already carries the position agent to start it now. Nobody can open it — it
      has no icon and no screen — and Android never lets an app that has never run receive anything,
      so until something starts it once the tablet says nothing to Phoenix. Refused when that tablet
      has not got the app.
  bind-tablet-agent --install <install id> --tablet <tablet number>
      Say which tablet an install belongs to (e.g. PHX-TAB-0008). The positions it sent before anybody
      knew whose they were are stamped with that tablet too. One live install per tablet.
  revoke-tablet-agent --install <install id> --reason "<why it comes out of service>"
      Take an install out of service: refused from its next call, and the tablet is free to re-bind.
  match-app-version --app <app number>
      Put an app's Headwind version row level with the APK it points at, reading the real
      versionCode/versionName out of the file itself. The tablet server refreshes these files on its
      own now, and a row that disagrees with its file makes every tablet re-download it hourly for
      ever. Reads the file by byte range — never the whole 80 MB.
  lock-rep-tablets
      Put the rep tablets' lock set on ALL THREE rep sets of rules (Android enforces them itself):
      no factory reset, no safe boot, no developer mode, no second user, location cannot be turned
      off, nothing can be uninstalled, Wi-Fi cannot be turned off, no aeroplane mode, no mobile
      network settings, no network reset, no side-loading, and Settings > Apps cannot force-stop or
      clear an app. It never sets no_install_apps (Android applies that to the device owner too, so
      nothing would ever install again) or no_config_wifi (the rep could not join a network). The
      mobile-data switch itself cannot be held by any Android lock.
  sync-insurance-master
      Fill the Employee Master from the medical insurance register: the Libano-Suisse card number
      (a blank one, or one from before this policy), and national ID, birth date, gender and mobile
      ONLY where the Employee Master is blank. A value that differs on both sides is listed, never
      written; Card Received (Yes-No) and every amount are never touched.
  end-insurance-cover --employee <HR id[,HR id…]>
      End the medical insurance cover of each named employee exactly as the Add/Remove screen would:
      only someone that screen lists to REMOVE, on the day and with the reason it gives (the last
      covered day for a leaver; the first day of cover, voided, for someone gone before it began).
      Their family on the policy ends the same day. Anyone the screen does not list is refused.

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
    return UUID.test(value) ? value.toLowerCase() : { error: `${name} must be ${job === "merge-customers" || name === "--customer" ? "a customer" : "a pharmacy"} id (a uuid), got "${value}"` };
  };

  if (job === "tablet-agents" || job === "lock-rep-tablets" || job === "sync-insurance-master") {
    return { ok: true, plan: { job, apply } };
  }

  if (job === "end-insurance-cover") {
    const raw = need("--employee");
    if (typeof raw !== "string") return { ok: false, ...raw };
    const hrIds = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
    if (hrIds.length === 0) return { ok: false, error: "--employee needs at least one HR id" };
    if (hrIds.length > 20) return { ok: false, error: "--employee takes at most 20 HR ids at once" };
    const bad = hrIds.find((hrId) => !/^[A-Za-z]{1,4}-\d{1,5}$/.test(hrId));
    if (bad) return { ok: false, error: `--employee takes HR ids like PD-0042, got "${bad}"` };
    return { ok: true, plan: { job, apply, hrIds } };
  }

  if (job === "match-app-version") {
    const raw = need("--app");
    if (typeof raw !== "string") return { ok: false, ...raw };
    // The app's number on the tablet server, never a uuid: a non-number would read as app NaN and
    // the runner would report "no app numbered NaN" for what is really a typo here.
    if (!/^[0-9]{1,9}$/.test(raw)) return { ok: false, error: `--app must be the app's number on the tablet server, got "${raw}"` };
    return { ok: true, plan: { job, apply, applicationId: Number(raw) } };
  }

  if (job === "start-tablet-agent") {
    const tablet = need("--tablet");
    if (typeof tablet !== "string") return { ok: false, ...tablet };
    if (!TABLET_NUMBER.test(tablet)) return { ok: false, error: `--tablet must be a tablet number like PHX-TAB-0008, got "${tablet}"` };
    return { ok: true, plan: { job, apply, deviceNumber: tablet.toUpperCase() } };
  }

  if (job === "bind-tablet-agent" || job === "revoke-tablet-agent") {
    const raw = need("--install");
    if (typeof raw !== "string") return { ok: false, ...raw };
    // The same shape the app's own readInstallId accepts — a mistyped id must be refused here rather
    // than reach the database and bind nothing.
    if (!UUID.test(raw)) return { ok: false, error: `--install must be the install's id (a uuid), got "${raw}"` };
    const installId = raw.toLowerCase();
    if (job === "revoke-tablet-agent") {
      const reason = need("--reason");
      if (typeof reason !== "string") return { ok: false, ...reason };
      if (reason.length < 10 || reason.length > 200) return { ok: false, error: "--reason must be 10 to 200 characters: it is the only record of why the install came out of service" };
      return { ok: true, plan: { job, apply, installId, reason } };
    }
    const tablet = need("--tablet");
    if (typeof tablet !== "string") return { ok: false, ...tablet };
    if (!TABLET_NUMBER.test(tablet)) return { ok: false, error: `--tablet must be a tablet number like PHX-TAB-0008, got "${tablet}"` };
    return { ok: true, plan: { job, apply, installId, deviceNumber: tablet.toUpperCase() } };
  }

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

  if (job === "remove-customer-pharmacy") {
    const customerId = id("--customer");
    if (typeof customerId !== "string") return { ok: false, ...customerId };
    const pharmacyId = id("--pharmacy");
    if (typeof pharmacyId !== "string") return { ok: false, ...pharmacyId };
    const reason = need("--reason");
    if (typeof reason !== "string") return { ok: false, ...reason };
    if (reason.length < 10 || reason.length > 500) return { ok: false, error: "--reason must be 10 to 500 characters: it is the only record of why the pharmacy came off" };
    return { ok: true, plan: { job, apply, customerId, pharmacyId, reason } };
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
