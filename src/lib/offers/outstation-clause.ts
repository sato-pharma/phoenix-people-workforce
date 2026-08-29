/**
 * The outstation clause, written FROM the rules the engine actually enforces.
 *
 * WHY THIS FILE EXISTS. The clause used to be a sentence typed into two template files:
 *
 *   "…for business travel exceeding 60 km within your assigned territory, excluding Sharkia
 *    Governorate."
 *
 * It had been transcribed verbatim from one signed offer — Dr Samaa Shalaby, DSM Delta 3, ref
 * SP-HR-DSM-2026-019 — and then shipped as the default for every role in every territory. Two
 * things were wrong with that, and both cost money in a signed letter:
 *
 *   1. The engine has NO Sharkia rule. Nothing in `src/lib/outstation/` has ever excluded that
 *      governorate, so the letter named an exclusion the system does not apply.
 *   2. The engine DOES have a Cairo rule the letter never mentioned — a regional employee
 *      travelling to Cairo is paid transport but earns no per-diem (owner rule, 2026-08-15). That
 *      is the dangerous direction: a candidate signs a letter that appears to promise an allowance
 *      the system will refuse.
 *
 * It also aged badly. Sharkia 1 (`D24`) and Sharkia 2 (`D25`) move INTO Delta (3) on 2026-09-01,
 * so from that date the old wording carved a hole out of the middle of a Delta 3 rep's own patch.
 *
 * THE FIX IS THE IMPORTS, NOT THE WORDS. The distance and the excluded governorate are read from
 * the engine's own constants, so the letter cannot claim a threshold the engine does not enforce.
 * Change the policy minimum in one place and every offer letter says the new number. The clause is
 * still fully editable per template in the designer — this is only what a NEW template starts as.
 */
import { CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE } from "@/lib/outstation/cairo-allowance-rule";
import { OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM } from "@/lib/outstation/classification";

/** The clause heading, shared so the two shipped templates cannot drift apart. */
export const OFFER_OUTSTATION_CLAUSE_HEADING = "Outstation Expenses";

/**
 * The three rules in `decideOutstationRequest`'s ladder that decide whether a person is PAID, in
 * the order the engine applies them. The campaign-visit cap and the ticket-evidence rule are
 * deliberately absent: they are evidence requirements for a submitted claim, not terms of the
 * offer, and an offer letter is not a policy manual.
 */
export const OFFER_OUTSTATION_CLAUSE_TEXT =
  "You will be eligible for outstation expenses in accordance with company policy for business "
  + `travel exceeding ${OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM} km. Travel to a destination inside `
  + "your own governorate of residence does not qualify. Travel to "
  + `${CAIRO_ALLOWANCE_EXCLUDED_GOVERNORATE} is reimbursed for transport and other actual costs, but `
  + "does not earn a per-diem allowance.";
