/**
 * Price the District Manager claims already WAITING on Expense Approvals from the manager's home to
 * the first double visit of each trip (owner, 2026-11-23: "Applies to new claims and the waiting
 * claims"; src/lib/outstation/dm-double-visit-distance.ts).
 *
 * New claims are priced at submit and every morning at 07:02 Cairo; this is the same pricing
 * (`priceClaimOnFirstDoubleVisit`), run once over the claims filed before it, so they need not wait
 * for the next morning. Report only unless `--apply`.
 *
 *   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
 *     --import ./tests/register-alias-loader.mjs scripts/outstation/price-dm-claims-on-double-visit.ts          report only
 *   … scripts/outstation/price-dm-claims-on-double-visit.ts --apply                                             write
 *
 * 🔴 `--apply` WRITES PRODUCTION money when `.env.local` points there (it does). Announce it first.
 * 🔴 Waiting claims only, never one a payroll row carries, and each write is pinned to the version it
 *    read: a claim decided or edited meanwhile is left as it is.
 * 🔴 The report measures road distances with Google (one call per first double visit) and writes nothing.
 */
import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

import { priceClaimOnFirstDoubleVisit, waitingDistrictManagerClaimIds } from "@/lib/outstation/dm-double-visit-distance-server";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "price-dm-claims-on-double-visit",
  entry: import.meta.url,
  known: ["--apply"],
});

const egp = (value: number) => `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const km = (value: number | null) => (value === null ? "—" : `${Math.round(value)} km`);

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const ref = url.replace(/^https:\/\//, "").split(".")[0] || "unknown";
  console.log(`project ${ref} · ${apply ? "APPLY — pricing each waiting claim" : "report only (add --apply to write)"}`);

  const ids = await waitingDistrictManagerClaimIds();
  let priced = 0;
  let moved = 0;
  let noVisit = 0;
  let net = 0;
  for (const id of ids) {
    const outcome = await priceClaimOnFirstDoubleVisit(id, { write: apply });
    if (outcome.result !== "written" && outcome.result !== "would_write") {
      console.log(`claim ${id} · left as it is (${outcome.result.replace(/_/g, " ")})`);
      continue;
    }
    priced += 1;
    if (outcome.basis.basis === "no_double_visit") noVisit += 1;
    if (outcome.moneyMoved) moved += 1;
    net += outcome.claimedAfter - outcome.claimedBefore;
    const visit = outcome.basis.visit;
    console.log(
      [
        `claim ${id}`,
        outcome.basis.basis.replace(/_/g, " "),
        `captured ${km(outcome.basis.capturedKm)}`,
        `first double visit ${visit ? `${km(visit.km)} (${visit.visitDate}${visit.repName ? `, with ${visit.repName}` : ""})` : "none"}`,
        outcome.basis.held ? `held: ${outcome.basis.held}` : null,
        `travel ${egp(outcome.travelBefore)} → ${egp(outcome.travelAfter)}`,
        `claim ${egp(outcome.claimedBefore)} → ${egp(outcome.claimedAfter)}`,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  console.log(
    `${ids.length} waiting District Manager claims · ${priced} ${apply ? "priced" : "would be priced"} · ${moved} with money moved · ${noVisit} with no double visit · net ${egp(net)}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
