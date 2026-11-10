/**
 * OPS SCRIPT — validate ONE customer on the TRUSTED POINT his reps' own readings agree on, as the Super Admin.
 *
 * Owner, 2026-11-10: "we will search all locations for this customer in phx crm, then we will compare with
 * the locations of checkins of this customer from the old crm until we find a trusted point or trusted
 * average location... based on this location we will extract the brick, area and all what we need."
 * It is the same door the Super Admin's screen uses (src/lib/phoenix-crm/server/trusted-point.ts): the
 * readings, the rule (`findTrustedPoint`), the brick and area resolver and the RPC are all shared, so a
 * customer validated here is exactly one validated on the screen. Account: docs/phoenix-crm-trusted-point.md.
 *
 * DRY RUN IS THE DEFAULT: it prints the readings it gathered, the point (or why there is none), the brick,
 * area and region, and whether the customer can be validated — and writes nothing.
 * --apply writes ONE place and validates ONE customer (not a bulk change), then measures that customer's
 * earlier visits against the point. --actor is the HR id recorded as the one who decided (the Super Admin).
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs scripts/phoenix-crm-trusted-point.ts \
 *     --customer <uuid> --actor <HR id> [--apply]
 */
import { applyTrustedPointFor, previewTrustedPointFor, type TrustedPointPreview } from "@/lib/phoenix-crm/server/trusted-point";

const known = new Set(["customer", "actor", "apply"]);
const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const entry = argv[index];
  if (!entry.startsWith("--")) throw new Error(`Unexpected argument ${entry} — refused rather than ignored.`);
  const body = entry.slice(2);
  const eq = body.indexOf("=");
  const [rawName, inline] = eq === -1 ? [body, undefined] : [body.slice(0, eq), body.slice(eq + 1)];
  if (!known.has(rawName)) throw new Error(`Unknown flag ${entry} — refused rather than ignored.`);
  if (rawName === "apply") {
    flags.set("apply", "true");
    continue;
  }
  const value = inline ?? argv[index + 1];
  if (inline === undefined) index += 1;
  if (!value || value.startsWith("--")) throw new Error(`--${rawName} needs a value.`);
  flags.set(rawName, value.trim());
}

const customerId = flags.get("customer") ?? "";
const actor = flags.get("actor") ?? "";
const apply = flags.get("apply") === "true";
if (!customerId) throw new Error("Pass --customer <uuid>.");
if (apply && !actor) throw new Error("--apply needs --actor <HR id> (who decided).");

function describe(preview: TrustedPointPreview): void {
  const { counts, result, location } = preview;
  console.log(`Customer: ${preview.customerName} (${preview.status}${preview.isTest ? ", test" : ""}) · seat ${preview.seatId}`);
  console.log(
    `Read: ${counts.phoenixVisits} Phoenix visits · ${counts.placeReadings} place readings · ${counts.oldCrmCheckins} old CRM check-ins` +
      (counts.copiedVisitsSkipped > 0 ? ` · ${counts.copiedVisitsSkipped} copied visits counted once, as their old CRM check-in` : ""),
  );
  console.log(`Rule: at least ${preview.rule.minReadings} readings on ${preview.rule.minDays} different days within ${preview.rule.coreMeters} m.`);
  if (!result.trusted) {
    console.log(`NO TRUSTED POINT — ${result.reason}`);
    return;
  }
  console.log(`Point: ${result.lat}, ${result.lon} · https://www.google.com/maps?q=${result.lat},${result.lon}`);
  console.log(
    `Agree: ${result.readings} of ${result.of} (${result.sources.phoenix} Phoenix, ${result.sources.old_crm} old CRM)` +
      ` · ${result.days} days ${result.firstDay} to ${result.lastDay} · ${result.reps} reps` +
      ` · spread median ${result.medianSpreadMeters} m, widest ${result.maxSpreadMeters} m`,
  );
  console.log(`Brick: ${location?.brickName ?? "none near"}${location?.brickDistanceKm !== null && location?.brickDistanceKm !== undefined ? ` (${location.brickDistanceKm} km)` : ""}`);
  console.log(`Area: ${[location?.areaName, location?.regionName].filter(Boolean).join(" · ") || "not resolved"}`);
  console.log(`Address: ${location?.address ?? "none read"}`);
  console.log(preview.blockedReason ? `BLOCKED — ${preview.blockedReason}` : "Can be validated on this point.");
}

if (!apply) {
  const preview = await previewTrustedPointFor(customerId);
  describe(preview);
  console.log("\nDry run — nothing written. Add --apply --actor <HR id> to validate.");
} else {
  const applied = await applyTrustedPointFor(customerId, actor);
  describe(applied.preview);
  console.log(`\nAPPLIED — place ${applied.placeId} written (${applied.event}); the customer's earlier visits were measured against it.`);
}
