import type { PhoenixRole } from "@/lib/auth/permissions";
import type { VenueType } from "@/lib/venues/venue-type";
import type { DirectOrderBasketLine } from "@/lib/direct-orders/basket-label";
import type { DirectOrderValidationRow } from "@/lib/direct-orders/pharmacy-validation";
import type { DirectOrderFieldEvidenceGap } from "@/lib/direct-orders/field-evidence-gap";
import type { ValidationBadge } from "@/lib/validation/validation-badge";
import type { DirectOrderGeographyCheck } from "@/lib/direct-orders/geography-check";
import type { DirectOrderInvoiceContentType, DirectOrderInvoiceSlotCount } from "@/lib/direct-orders/invoice-evidence";
// Type-only, and hold-decision.ts imports type-only from here — a types-only cycle is erased at
// compile time and has no runtime edge, which is why this does not need a third module.
import type { DirectOrderAutoLinkRefusal } from "@/lib/direct-orders/hold-decision";

// ─────────────────────────────────────────────────────────────────────────────
// Direct Order Request module — shared types.
//
// A Direct Order Request is one pharmacy and AT LEAST ONE product line, submitted
// by a sales/marketing manager and approved up a sequential chain that always ends
// at the CEO. It was one product per request until 2026-08-12; several lines are
// now possible, but ONLY from one product family and only from a family allowed to
// combine — today Lacto alone (see product-family.ts). Every order raised before
// that, and every non-Lacto order after it, still has exactly one line.
//
// Money-critical: for a BONUS deal a line's `salesValue` is `qty × pharmacyPrice`
// (bonus units never enter value), and the REQUEST's `salesValue` is the sum of its
// lines. The bonus is separately capped per product, and exceeding that cap FLAGS
// the request rather than blocking it.
//
// Requesters (phase 1, managers only): District Manager, Regional Manager,
// National Sales Manager, Product Manager, Group Product Manager.
// Approval ladder (owner-locked):
//   District Manager → Regional Manager → National Sales Manager → CEO
//   Regional Manager → National Sales Manager → CEO
//   National Sales Manager → CEO
//   Product Manager / Group Product Manager → CEO (straight to CEO)
// Each non-CEO rung is the requester's ACTUAL manager (resolved from the live org
// / seat model, vacancy-aware); the final rung is the CEO resolved BY ROLE.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles allowed to submit a direct order in phase 1 (Medical Rep added later). */
export const DIRECT_ORDER_REQUESTER_ROLES: readonly PhoenixRole[] = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
] as const;

export function isDirectOrderRequesterRole(role: PhoenixRole | string | null | undefined): boolean {
  return DIRECT_ORDER_REQUESTER_ROLES.includes(String(role ?? "").trim() as PhoenixRole);
}

/**
 * Request lifecycle. `pending_approval` covers every in-chain rung; the active step tells you
 * which. `held` stands OUTSIDE the chain entirely — an order whose pharmacy is not in the master
 * database: submitted and visible, but in no approver's queue, and it can only leave `held` by
 * the pharmacy passing validation (→ `pending_approval` from step 1) or by the 14-day clock
 * (→ `expired`, a terminal dead end that is logged and counted per requester).
 */
export type DirectOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "returned"
  | "reversed"
  | "held"
  | "expired"
  // Withdrawn by its requester while held — deliberately NOT `rejected`. A duplicate the requester
  // tidied up is not an order an approver turned down, and folding the two together would inflate
  // every rejection rate and per-rep counter that groups by status (audit F3).
  | "cancelled";

/**
 * The same nine statuses, at RUNTIME.
 *
 * Needed because the operational Orders query derives its status-group filters by asking
 * `describeDirectOrderStatus` about each status in turn, rather than hardcoding a second copy of
 * the grouping rule next to the SQL. A type union alone cannot be iterated.
 *
 * The assertion below is the point of the list: `satisfies` proves every entry is a real status,
 * and `_statusListIsExhaustive` fails to COMPILE if a status is ever added to the union above and
 * not added here. Without it this array would be a silent second source of truth — a tenth status
 * would simply never appear in any group filter, and the Orders list would quietly stop showing
 * those orders with nothing failing anywhere.
 */
export const DIRECT_ORDER_STATUS_VALUES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "returned",
  "reversed",
  "held",
  "expired",
  "cancelled",
] as const satisfies readonly DirectOrderStatus[];

type MissingDirectOrderStatus = Exclude<DirectOrderStatus, (typeof DIRECT_ORDER_STATUS_VALUES)[number]>;
const _statusListIsExhaustive: [MissingDirectOrderStatus] extends [never] ? true : never = true;
void _statusListIsExhaustive;

/** The three states a pharmacy's verification can be in. */
export type DirectOrderPharmacyVerificationStatus = "verified" | "pending_review" | "rejected";

/**
 * Turn whatever the database holds into a verification status, without inventing trust.
 *
 * This replaced a one-line ternary that read:
 *
 *     String(row.verification_status ?? "verified") === "pending_review" ? "pending_review" : "verified"
 *
 * which was BINARY: anything that was not `pending_review` became `verified`. Adding `rejected` to
 * the database while that line stood would have reported every rejected pharmacy as **verified** —
 * the exact inverse of the truth — in the picker, the approval detail and the registry manager,
 * with no type error and no failing test anywhere.
 *
 * Unknown values now resolve to `pending_review`, not `verified`: a value this code does not
 * recognise is a reason for a human to look, never a reason to trust. Only a null/absent column
 * still reads as `verified`, because that is the column's own default and predates all of this.
 */
export function normalizePharmacyVerificationStatus(
  value: unknown,
): DirectOrderPharmacyVerificationStatus {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "verified";
  if (raw === "pending_review") return "pending_review";
  if (raw === "rejected") return "rejected";
  if (raw === "verified") return "verified";
  return "pending_review";
}

/**
 * Should this order be shown as "approved — awaiting Finance month"? (spec C2)
 *
 * Domain logic, not presentation, which is why it lives here beside the other status predicate
 * rather than inside the pill that renders it. The tests run under
 * `node --experimental-strip-types`, which cannot load a .tsx file at all — so a rule kept in the
 * component could only ever be checked by matching its source text, and a source match proves a
 * string is present, not that the rule is right.
 *
 * That distinction matters here because production cannot check it either: on 2026-08-05 every
 * direct order was rejected, leaving zero approved rows and zero rows carrying a sales_month.
 * Neither the case where the badge must appear nor the case where it must stay hidden exists in the
 * data, so this function is the only place the behaviour can actually be proven.
 */
export function showsAwaitingFinanceMonth(
  status: DirectOrderStatus | string,
  salesMonth: string | null,
): boolean {
  return String(status) === "approved" && !salesMonth;
}

export function isTerminalDirectOrderStatus(status: DirectOrderStatus): boolean {
  return (
    status === "approved" ||
    status === "rejected" ||
    status === "reversed" ||
    status === "expired" ||
    status === "cancelled"
  );
}

/** The three actions an approver can take at their rung. */
export type DirectOrderDecision = "approve" | "reject" | "return";

/** A rung is either a specific person (an actual manager) or a role (the CEO). */
export type DirectOrderApproverKind = "person" | "role";

export type DirectOrderStepStatus = "pending" | "approved" | "rejected";

/** One rung in a request's approval chain. `order` is 1-based and gates sequencing. */
export type DirectOrderStepState = {
  order: number;
  kind: DirectOrderApproverKind;
  /** Populated for role rungs (always "CEO" in phase 1). */
  role: PhoenixRole | null;
  /** Populated for person rungs (the requester's actual manager at this level). */
  approverHrId: string | null;
  /** Job-title / role label for the UI timeline (never hardcode DSM/RM/NSM in components). */
  label: string;
  status: DirectOrderStepStatus;
  /**
   * Decision record — optional because a rung under construction has none. The approval window
   * shows WHO decided, WHEN (Cairo) and WHAT THEY WROTE on every settled rung (spec D1), so
   * these ride the step rather than being re-fetched from events.
   */
  decidedByHrId?: string | null;
  decidedAt?: string | null;
  decisionComment?: string | null;
};

/** Bonus deal (qty × pharmacy price) or Discount deal (qty × public × (1−disc%)). */
export type DirectOrderDealType = "bonus" | "discount";

/** One mandatory distributor↔customer-code pair on a pharmacy (≥1 per pharmacy). */
export type DirectOrderPharmacyDistributorCode = {
  distributorCode: string;
  distributorName: string;
  customerCode: string;
  /** Brick/area/region the customer map resolves this code to (null when unmapped). */
  mappedBrickId: string | null;
  mappedAreaCode: string | null;
  mappedRegionCode: string | null;
};

/** The reusable pharmacy registry row (direct-side equivalent of a distributor client_code). */
/**
 * Whether Phoenix has established that a pharmacy exists (spec A3).
 *
 * Distinct from `verificationStatus`, which records whether an ADMIN looked at the registration.
 * This records whether the WORLD confirmed it: a distributor invoiced it, or its collection was
 * paid. An admin can be wrong; a footprint cannot be faked into a distributor's own sheet.
 */
export type DirectOrderPharmacyTrustState = "trusted" | "provisional" | "phantom_suspected";

/**
 * What the approval window says where a sales table would be (spec D2).
 *
 * Carries the sentence rather than only the numbers, because "an empty table must never read as
 * zero" is a rule about words. Built server-side in the domain so the window cannot phrase it a
 * second way — see `src/lib/direct-orders/pharmacy-standing.ts`.
 */
export type DirectOrderPharmacyStanding = {
  trustState: DirectOrderPharmacyTrustState;
  /** 1-based day within the probation window; null when the clock was never started. */
  probationDay: number | null;
  windowDays: number;
  /** Approver-facing prose for an empty history. Never a count. */
  noHistoryNote: string;
  /**
   * The same, for a pharmacy with NO distributor code at all.
   *
   * Separate from `noHistoryNote` because the two absences have different remedies — one needs a
   * code registered, the other needs the pharmacy to trade — but both must still name the trust
   * state. Without this, half the provisional pharmacies were told only that a code was missing,
   * which is the less alarming of the two facts and reads like paperwork.
   */
  noCodeNote: string;
};

/**
 * A distributor code a pharmacy CLAIMED but does not own.
 *
 * Recorded when the submitter was shown the pharmacy that already holds the code and answered that
 * theirs is a different pharmacy. The incumbent keeps the code — the unique index on
 * (distributor_code, customer_code) is what stops one distributor customer being attributed to two
 * pharmacies, and it stays. This is the reviewer's evidence that a human disagreed.
 *
 * The alternative was refusing the registration, and that is the one option already known to be
 * wrong here: refusing does not produce a correct code, it produces an invented one (owner rule,
 * 2026-08-04 — and the live proof is the pair of production pharmacies carrying "000000" and
 * "00000").
 */
export type DirectOrderContestedCodeClaim = {
  distributorCode: string;
  customerCode: string;
  /** The pharmacy that holds the code today. */
  heldByPharmacyId: string;
  heldByPharmacyCode: string;
  heldByPharmacyName: string;
  claimedAt: string;
};

/**
 * What the submit form asks BEFORE it registers a pharmacy by hand (owner, 2026-08-13).
 *
 * Two independent questions, because a rep can be about to create a duplicate in two different
 * ways and only one of them was ever checked:
 *
 *   codeConflicts — the code they typed already belongs to another pharmacy. Previously this
 *                   surfaced as "Could not create the pharmacy." AFTER a codeless orphan had
 *                   already been committed.
 *   nameMatches   — they gave no code at all, and a pharmacy of the same name already exists in
 *                   their region. Nothing checked this server-side; a code-only matcher cannot see
 *                   a pharmacy that has no code.
 *
 * Neither is a block. Both are questions, and "no" is always a valid answer.
 */
export type DirectOrderPharmacyPreflight = {
  codeConflicts: Array<{
    distributorCode: string;
    distributorName: string;
    customerCode: string;
    heldBy: {
      id: string;
      phoenixPharmacyCode: string;
      pharmacyName: string;
      areaCode: string | null;
      areaName: string;
      regionCode: string | null;
      regionName: string;
      pharmacyAddress: string | null;
      verificationStatus: "verified" | "pending_review" | "rejected";
    };
  }>;
  nameMatches: Array<{
    /** 'phoenix' = a pharmacy already registered here; 'directory' = the distributor's own list. */
    source: "phoenix" | "directory";
    pharmacyName: string;
    /** Both are shown to the rep — a name alone does not tell her which pharmacy this is. */
    distributorCode: string | null;
    distributorName: string;
    customerCode: string | null;
    phoenixPharmacyCode: string | null;
    areaCode: string | null;
    areaName: string;
    regionCode: string | null;
    regionName: string;
    pharmacyAddress: string | null;
  }>;
};

export type DirectOrderPharmacy = {
  id: string;
  /** Phoenix-generated stable code, e.g. "DOP-000123". */
  phoenixPharmacyCode: string;
  pharmacyName: string;
  /**
   * `pharmacy` or `nursery`. A nursery has no distributor account at all, so it can never carry a
   * distributor code and can never appear on an invoice line.
   *
   * Direct Orders never FORCED an invented code — a codeless pharmacy has been admissible here
   * since 2026-08-04, and none of the six nursery rows in production carries one (verified
   * 2026-08-23). What it had no way to say is what the venue IS, so a nursery was indistinguishable
   * from a pharmacy that simply had not given its code yet — which is what the probation sweep then
   * reported as missing proof. Marketing is where the invented codes actually landed.
   */
  venueType: VenueType;
  brickId: string | null;
  areaCode: string | null;
  regionCode: string | null;
  doctorName: string | null;
  pharmacyAddress: string | null;
  /**
   * The CRM contact this venue IS, as DECLARED by whoever registered it — never inferred.
   *
   * This is the whole direct-order half of the CRM contact link. `contact-trade.ts` has three rules
   * and an explicit id is rule 1, beating every name/area test; marketing already fires it through
   * `marketing_customer_contacts.crm_code`, while direct orders had no id to give and could only
   * reach the two inferred rules. Measured 2026-09-03, that left exactly ONE of 63 venues linked,
   * with a ceiling of 4 even if the area gate were removed entirely — the names do not meet.
   *
   * NULL is the normal, permitted case. The picker is optional on purpose (the 2026-08-04 rule:
   * refusing a field the submitter cannot answer produces an invented value, not a correct one).
   */
  crmContactId: number | null;
  /** Who declared {@link crmContactId}, and when. Null together with it. */
  crmContactLinkedByHrId: string | null;
  crmContactLinkedAt: string | null;
  /**
   * Distributor customer-code pairs, at most one per distributor. OPTIONAL since 2026-08-04 —
   * a submitter who does not know the distributor or the code registers the pharmacy without
   * them, and the request picks up the System Admin rung instead of being refused.
   */
  distributorCodes: DirectOrderPharmacyDistributorCode[];
  /**
   * Codes this pharmacy claimed but does not own. Empty on almost every pharmacy — see
   * {@link DirectOrderContestedCodeClaim}.
   */
  contestedCodeClaims: DirectOrderContestedCodeClaim[];
  /** Whether an admin has resolved a submitter-brick vs mapped-brick variance. */
  geoVarianceResolved: boolean;
  /**
   * 'pending_review' on every pharmacy registered by hand, until a System Admin approves the
   * acknowledgment rung. It covers all three ways Phoenix ends up not recognising a pharmacy:
   * it is brand new, its customer code is not in the distributor's own list, or no distributor
   * or code was given at all.
   *
   * It never blocks submission — it adds one rung to the chain (SFE → System Admin → the usual
   * line → CEO), because an unconfirmed code is how a different pharmacy's retail sales end up
   * attributed here.
   */
  /**
   * `rejected` is the outcome the model had no word for until 2026-08-05, when the owner ruled that
   * ten hand-created pharmacies were false. The only states available were `verified` and
   * `pending_review`, so the permanent record of that decision read "awaiting a look" — which is
   * not what happened. A refusal that the data cannot express becomes, over time, a refusal nobody
   * can find.
   *
   * Rejecting ALWAYS deactivates: `active = false` is what actually removes a pharmacy from the
   * picker, the directory search and the probation sweep (12 query sites filter on it), so a
   * rejected-but-active row would be a contradiction the rest of the module would not honour.
   */
  verificationStatus: "verified" | "pending_review" | "rejected";
  /** 'manual' when the pharmacy was registered by hand; 'catalogue' when it came from the list. */
  entrySource: "catalogue" | "manual";
  verifiedByHrId: string | null;
  verifiedAt: string | null;
  createdByHrId: string;
  active: boolean;
  /** See DirectOrderPharmacyTrustState. Column default is 'trusted'. */
  trustState: DirectOrderPharmacyTrustState;
  /**
   * When the 90-day window opened. NULL on every pharmacy that predates the clock — which today is
   * all 10 provisional ones — so it must never be read as "day zero".
   */
  probationStartedAt: string | null;
  /**
   * A System Admin's explicit ruling on a pharmacy whose distributor code proves nothing (owner
   * rule, 2026-08-08 — the live case is a placeholder code like `PS/000000`, which matches no
   * customer anywhere). `admin_released` lets its held orders into the chain; `kept_held` records
   * that somebody looked and decided they stay. NULL means nobody has ruled yet — which is NOT the
   * same as either answer, and must never be collapsed into one.
   *
   * Pharmacy-level rather than request-level, mirroring reviveHeldDirectOrdersForPharmacy: "I know
   * this pharmacy is real" is a statement about the pharmacy, so it has to cover its sibling orders
   * and the next one submitted, or every reorder re-freezes.
   */
  holdReleaseGround: "admin_released" | "kept_held" | null;
  holdReleaseReason: string | null;
  holdReleaseDecidedByHrId: string | null;
  holdReleaseDecidedAt: string | null;
};

/** A single direct order request (header + its one line, since grain = single line). */
export type DirectOrderRequest = {
  id: string;
  requesterHrId: string;
  requesterRole: PhoenixRole;
  status: DirectOrderStatus;
  line: string;
  productCode: string;
  productName: string;
  /**
   * The one family every line of this request belongs to — the direct-order basket allow-list, and
   * the invariant `phx_direct_order_item_family_guard` enforces across the two tables.
   *
   * Empty string where the column is null, which is a HISTORIC request whose product the catalogue
   * has since dropped, never a new one: every write path sets it. A null here is not inert — the
   * guard reads it, and treats "no family yet" as licence for the request to ADOPT whatever family
   * its first line brings, so a request missing it cannot refuse a mismatched line.
   */
  familyCode: string;
  /**
   * The pharmacy price this BONUS request was valued at. NULL only on a discount deal (which
   * prices on the public price). A bonus deal with no pharmacy price is now refused at submit,
   * so a bonus row can no longer carry a null here.
   * Snapshotted rather than re-read, so it keeps describing THIS row after the master changes.
   */
  pharmacyPriceSnapshot: number | null;
  qty: number;
  bonus: number;
  bonusOverrideReason: string | null;
  /** 'bonus' → value = qty × pharmacyPrice; 'discount' → value = qty × publicPrice × (1−disc%). */
  dealType: DirectOrderDealType;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  /** Bonus mode: qty × pharmacyPrice. Discount mode: qty × publicPrice × (1−disc%). */
  salesValue: number;
  pharmacyId: string;
  /** YYYY-MM; set to the CEO-final-approval month on final approval. */
  salesMonth: string | null;
  /** Expected money-collection date (YYYY-MM-DD), entered by the requester at submit. */
  collectionDate: string | null;
  /** When this request entered `held` (null otherwise). Drives the 14-day expiry clock. */
  heldAt: string | null;
  marketingRequestId: string | null;
  /** Post-approval, Finance-editable collections fields (outside the approval gate). */
  paymentDate: string | null;
  paidAmount: number | null;
  remainingAmount: number | null;
  /** Injection + reversal bookkeeping (phase C). */
  sosBatchId: string | null;
  reversalOfRequestId: string | null;
  reversedByRequestId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /**
   * The distributor invoice the requester used for this order (owner, 2026-09-14). Optional so every
   * hand-built request (tests, fixtures) stays valid; null when the order carries none — most do not.
   * A storage path, never a link: readers sign it through loadDirectOrderRequestInvoice.
   */
  invoiceStoragePath?: string | null;
  invoiceContentType?: DirectOrderInvoiceContentType | null;
  invoiceUploadedAt?: string | null;
};

/** The order's invoice as an approver sees it. */
export type DirectOrderRequestInvoice = {
  /** Short-lived signed link. Null when it could not be signed — said out loud, never left blank. */
  url: string | null;
  contentType: DirectOrderInvoiceContentType;
  uploadedAt: string | null;
  /** The requester's invoice slots — only while the pharmacy is still waiting to be confirmed. */
  requesterSlots: DirectOrderInvoiceSlotCount | null;
};

export const DIRECT_ORDER_WORKFLOW_MODULE_KEY = "direct_orders" as const;

// ─── Approvals-hub view models ───────────────────────────────────────────────

/** Which response buttons the current viewer may use on a request (the hub page is the ONLY approval gate). */
export type DirectOrderAvailableActions = {
  approve: boolean;
  reject: boolean;
  return: boolean;
};

/** A code paired with its human name. The UI shows the NAME (owner rule: names, never codes). */
export type DirectOrderCodeName = { code: string; name: string };

/**
 * A pharmacy's geography resolved to NAMES. Each entry is null when the master data has no
 * row for that code — a data gap, never a crash. The wrapper itself is non-nullable so
 * components never write `detail.geo?.brick?.name ?? "—"` chains; the fallback lives in one
 * place (buildDirectOrderDetailFields).
 */
export type DirectOrderPharmacyGeo = {
  brick: DirectOrderCodeName | null;
  area: DirectOrderCodeName | null;
  region: DirectOrderCodeName | null;
};

/**
 * One distributor pairing on the approval window, with its mapped brick already resolved to a
 * NAME. The raw pairs live on `DirectOrderPharmacy.distributorCodes`; this is the display form,
 * so a component never has to reach for a bare `mappedBrickId`.
 */
export type DirectOrderDistributorRow = {
  distributorName: string;
  /** The distributor's own code, e.g. "Direct", "IbnSina". Shown alongside the name, never instead. */
  distributorCode: string;
  /** The code THIS distributor files the pharmacy under (their customer number). */
  customerCode: string;
  /** Where the customer map resolves this code to — names, null when the code is unmapped. */
  mappedBrickName: string | null;
  mappedAreaName: string | null;
  mappedRegionName: string | null;
};

/**
 * One summarized line of a pharmacy's ordering history: what it took of a product, from a
 * distributor, in a month. Aggregated across every request for that pharmacy so an approver
 * can see the pattern before deciding — is this the usual quantity, or ten times it?
 */
/**
 * Where a line of sales came from. The two must never be summed blindly: RETAIL is what the
 * distributor invoiced this pharmacy (uploaded monthly from their file); DIRECT is what Phoenix
 * booked from an approved direct order. They are different channels and are reported separately.
 */
export type DirectOrderSalesSource = "retail" | "direct";

/** One month of retail (distributor-invoiced) sales for a pharmacy, per product and distributor. */
export type DirectOrderRetailHistoryRow = {
  month: string;
  productCode: string;
  productName: string;
  distributorName: string;
  distributorCode: string;
  /** The distributor's own customer code for this pharmacy — how the match was made. */
  customerCode: string;
  qty: number;
  bonus: number;
  salesValue: number;
};

export type DirectOrderPharmacyHistoryRow = {
  /** YYYY-MM. The sales month once final-approved, otherwise the month it was submitted. */
  month: string;
  /** True when `month` came from the submission date because the order is not yet final. */
  monthIsProvisional: boolean;
  productCode: string;
  productName: string;
  distributorName: string;
  distributorCode: string;
  orders: number;
  qty: number;
  bonus: number;
  salesValue: number;
};

/**
 * The medical rep covering a pharmacy's (line, area), resolved LIVE from the seat model at
 * read time. Never stored on the request and never a form field — the org tree is the truth.
 *
 * `resolved` and `isVacant` mean different things and must not be collapsed: no REP seat at all
 * for this (line, area) is "we cannot say" (UI shows "—"), whereas a seat that exists with no
 * occupant is a genuine, reportable vacancy (UI shows "Vacant").
 */
export type DirectOrderAreaRep = {
  resolved: boolean;
  isVacant: boolean;
  repHrId: string | null;
  repName: string | null;
  /** Every occupied rep seat on this (line, area); >1 only on a split area. Never truncated. */
  repNames: string[];
};

/** A row in the "Direct Orders Approvals" list (awaiting or history). Names, never bare codes. */
export type DirectOrderApprovalListItem = {
  id: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  line: string;
  /** Every product joined with " + " on a basket; line 1's name on a one-product order. */
  productName: string;
  /**
   * The one product's units; NULL on a basket. Never a sum — units of different products are never
   * added (owner rule). A basket's units are each line's own, in `items`.
   */
  qty: number | null;
  /**
   * One entry per product, so a surface can show what the basket's single `salesValue` is FOR.
   * See @/lib/direct-orders/basket-label — the composed `productName` above cannot be split back
   * apart safely, and a reader who only sees line 1 is reading one product's name against the
   * whole basket's money.
   */
  items?: readonly DirectOrderBasketLine[];
  bonus: number;
  /** 'bonus' → `bonus` is the meaningful number; 'discount' → `discountPct` is. */
  dealType: DirectOrderDealType;
  discountPct: number | null;
  salesValue: number;
  pharmacyName: string;
  pharmacyCode: string;
  /** Geography as NAMES (owner rule). "" when the master data has no name for the code. */
  brickName: string;
  areaName: string;
  regionName: string;
  /** Rep display name; "" when vacant OR unresolved — `medicalRepVacant` distinguishes them. */
  medicalRepName: string;
  medicalRepVacant: boolean;
  /** Distributor NAMES only ("Ibn Sina · Overseas"); the name→code pairs live on the detail. */
  distributorNames: string;
  status: DirectOrderStatus;
  /**
   * The month Finance booked this order into, or null.
   *
   * On this list type specifically, because `approved` alone is misleading everywhere it is shown.
   * CEO approval never injects sales (the GOLDEN RULE, spec C2) — injection happens only when the
   * Finance Manager books the order into a month. Without this field the four surfaces that render
   * an approval list item can only say "Approved", which reads as "the money is counted" when it is
   * not. On 2026-08-05 two orders sat approved with a null month and nothing injected; nothing on
   * screen said so.
   */
  salesMonth: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** The rung currently waiting (empty for terminal requests). */
  activeStepLabel: string;
  activeStepOrder: number | null;
  /** True when the bonus/discount exceeds its product cap — flagged for the approver, NOT blocked. */
  bonusOverCap: boolean;
};

/** Everything the detail page needs, including the viewer's allowed actions. */
/**
 * One fully-denormalized row for the Direct Orders report page + xlsx export.
 * Carries EVERY field (request + pharmacy + requester + approval progress) — the
 * owner's requirement is "do not minus even one field".
 */
export type DirectOrderReportRow = {
  id: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  status: DirectOrderStatus;
  line: string;
  productCode: string;
  productName: string;
  /** The pharmacy price a bonus deal was valued at; null on a discount deal (public-priced). */
  pharmacyPriceSnapshot: number | null;
  /**
   * The one product's units; NULL on a basket. Never a sum — units of different products are never
   * added (owner rule). A basket's units are in `basketUnits`.
   */
  qty: number | null;
  /** The one product's bonus units; NULL on a basket, for the same reason as `qty`. */
  bonus: number | null;
  /**
   * A basket's units PER PRODUCT, as text in the order `productName` names them ("72 + 24" and
   * "40 + 0"); null on a one-product order. The report's Qty and Bonus cells print these, so the
   * columns keep their place for the owner's Google Sheet (owner, 2026-10-19). Optional because a
   * hand-built row need not supply it.
   */
  basketUnits?: { qty: string; bonus: string } | null;
  bonusOverrideReason: string | null;
  dealType: DirectOrderDealType;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  salesValue: number;
  collectionDate: string | null;
  salesMonth: string | null;
  marketingRequestId: string | null;
  paymentDate: string | null;
  paidAmount: number | null;
  remainingAmount: number | null;
  reversalOfRequestId: string | null;
  reversedByRequestId: string | null;
  sosBatchId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** When the order entered `held`. Drives the 14-day expiry clock shown on the report. */
  heldAt: string | null;
  /** Who put the order in its current state; "(system)" when no human actor is recorded. */
  decidedByName: string;
  activeStepLabel: string;
  activeStepOrder: number | null;
  // pharmacy (from the registry)
  pharmacyCode: string;
  pharmacyName: string;
  pharmacyAddress: string;
  brickId: string;
  brickName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
  doctorName: string;
  /** All distributor customer-code pairs, joined: "Ibn Sina: #####; Overseas: @@@@@". */
  distributorCodesText: string;
};

/** How much of the report the viewer may see (owner-tiered). */
export type DirectOrderReportScope = "all" | "hierarchy" | "line" | "own";

/** A real distributor customer whose code happens to equal this pharmacy's stored NAME. */
export type DirectOrderPossibleDistributorMatch = {
  distributorCode: string;
  distributorName: string;
  customerCode: string;
  customerName: string;
  areaCode: string | null;
  /**
   * Carried so the geography panel can compare BRICK, not just area.
   *
   * Without it the panel answered half the question: area resolved against the master and read
   * "agrees", while brick — the field sales attribution actually follows — read "nothing to check"
   * for the very same customer. A comparison that can only check the less important half looks
   * broken, and it hid that the brick genuinely does agree here (B201-3 both sides).
   */
  brickId: string | null;
  /**
   * The OTHER Phoenix pharmacy already holding this exact (distributor, customer code) pair — the
   * single fact that decides whether auto-link may act, and the one this panel could not previously
   * state. Found live on 2026-08-08: DOP-000017 ("1573270") matches PS/0001573270, but DOP-000021
   * already holds it — the same real pharmacy registered twice by the same person, each carrying its
   * own 59,400 EGP order. Without naming the holder the screen can only say "not linked
   * automatically" and leave the reader to guess why.
   *
   * `"unknown"` in the code field means the ownership CHECK failed, which the rule treats as owned.
   */
  ownedByPharmacyCode: string | null;
  ownedByPharmacyName: string | null;
};

/** One product line of a direct order. A request has at least one; only a family basket has more. */
export type DirectOrderRequestItem = {
  lineNo: number;
  productCode: string;
  productName: string;
  /** The family every line of a request shares — enforced in the database, not just here. */
  familyCode: string;
  dealType: DirectOrderDealType;
  qty: number;
  bonus: number;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  pharmacyPriceSnapshot: number | null;
  /** THIS line's money. The request's salesValue is the sum of every line's. */
  salesValue: number;
  /** Over this product's own cap. Flagged, never blocking — see the note on the request. */
  overCap: boolean;
};

export type DirectOrderApprovalDetail = {
  request: DirectOrderRequest;
  requesterName: string;
  /** Display name for pharmacy.createdByHrId — codeNameLabel needs a name, not a bare HR-ID. */
  pharmacyRegisteredByName: string | null;
  pharmacy: DirectOrderPharmacy | null;
  /** Brick / area / region as NAMES. Non-null wrapper; see DirectOrderPharmacyGeo. */
  geo: DirectOrderPharmacyGeo;
  /** Resolved live from the seat model on every read. Non-null wrapper; see DirectOrderAreaRep. */
  medicalRep: DirectOrderAreaRep;
  /**
   * The product's CURRENT prices, distinct from the snapshots on the request.
   *
   * A snapshot is null whenever that basis did not price THIS deal — a discount order stores no
   * pharmacy price. Reading that as "no pharmacy price exists" is wrong, and was actively
   * misleading: a live discount order displayed "Pharmacy price — not set" for a product whose
   * pharmacy price was 281.688. These fields let the window distinguish "never entered" from
   * "entered, but not the basis for this deal".
   */
  productPharmacyPrice: number | null;
  productPublicPrice: number | null;
  /**
   * EVERY line on this request, in entry order.
   *
   * An approver decides a number, so they must see every line that adds up to it. Before baskets a
   * request had one product and the singular fields above WERE the whole order; a Lacto basket
   * makes those fields line 1 only, and an approver reading them alone would be approving money
   * they cannot see. Always populated — a one-item request returns its single line here, so no
   * reader needs to branch on "is this a basket".
   */
  items: DirectOrderRequestItem[];
  /** "Ibn Sina: 1234567; Overseas: 7654321" — the same projection the report and email use. */
  distributorCodesText: string;
  /** The same pairs as display rows, with codes kept and mapped geography resolved to names. */
  distributors: DirectOrderDistributorRow[];
  /**
   * This pharmacy's ordering history — month x product x distributor — EXCLUDING the request
   * being decided, so the approver reads "what it normally takes" rather than a total that
   * already contains the number they are judging.
   */
  pharmacyHistory: DirectOrderPharmacyHistoryRow[];
  /**
   * Retail sales the DISTRIBUTORS invoiced this pharmacy, kept strictly separate from the
   * direct-order history above. Matched on (distributor code + customer code) together —
   * a customer code alone is not unique across distributors and would attribute another
   * pharmacy's sales to this one.
   */
  retailHistory: DirectOrderRetailHistoryRow[];
  /** True when the pharmacy has no distributor pair that can be matched to retail sales at all. */
  retailUnmatchable: boolean;
  /**
   * The read FAILED, as opposed to returning nothing.
   *
   * These two are opposite facts and used to be indistinguishable: the loaders' catch paths returned
   * a bare empty list, so a timeout or a permission error rendered `pharmacyStanding.noHistoryNote`
   * — "The pharmacy is established, so this means it has not bought" — which is a confident lie
   * about a query that never ran. Never render the trusted sentence when these are true.
   */
  retailLoadFailed: boolean;
  directLoadFailed: boolean;
  /**
   * Distinct products withheld from THIS viewer (restricted codes + the Head Office line, plus any
   * other line when the viewer is line-scoped). Shown as a count only — never names, codes or
   * figures. Owner rule, 2026-08-08: the confidential products are ~81.5% of sales value, so a
   * silently filtered table would read as "this pharmacy barely buys" when the opposite is true.
   */
  hiddenConfidentialCount: number;
  /**
   * How many (distributor, customer code) pairs the retail match actually ran against. A pharmacy
   * trading with three distributors but carrying one linked code shows a third of its sales — this
   * is what stops that partial view from reading as the complete picture.
   */
  retailMatchedPairs: number;
  /**
   * Why the retail table is empty, in words (spec D2). Null only when the request has no pharmacy
   * at all. Read this INSTEAD of inferring anything from `retailHistory.length === 0`: a trusted
   * pharmacy that has not bought and a provisional one that has never been proved both produce
   * zero rows, and they are opposite risks.
   */
  pharmacyStanding: DirectOrderPharmacyStanding | null;
  steps: Array<DirectOrderStepState & { approverName: string | null; decidedByName: string | null }>;
  availableActions: DirectOrderAvailableActions;
  /** True when the bonus/discount exceeds its product cap — flagged for the approver, NOT blocked. */
  bonusOverCap: boolean;
  /**
   * True when this chain has NO management rung for a requester who is owed one — it climbs
   * SFE → CEO with nobody from the sales line on it. Flagged for the approver, NOT blocked
   * (owner decision, 2026-08-19). See directOrderChainMissingManagementLine.
   */
  missingManagementLine: boolean;
  /**
   * The pharmacy's held/validation evidence (photo, GPS, AI sign-check), when this request ever
   * went through that lane. Null for the common case — most orders never touch a held pharmacy.
   * `evidenceCheck` on this row is stripped to null when the viewer is the request's own requester
   * (owner rule, 2026-08-08): they see their own photo, not the adjudicator-facing AI reading.
   */
  pharmacyEvidence: DirectOrderValidationRow | null;
  /**
   * The "already validated · by whom · when" stamp for the approver window (owner, 2026-09-22).
   * Null when the pharmacy is NOT yet validated — a fresh pending_review or a rejected pharmacy — so
   * a nullish check is the render gate. See resolveDirectOrderPharmacyValidationBadge.
   */
  pharmacyValidation: ValidationBadge | null;
  /**
   * Why this venue holds NO live photo and no GPS fix, or null when one exists (owner, 2026-09-29).
   * Independent of the stamp above: a venue can be validated — by invoice, or off the distributor
   * catalogue — and still have had nobody stand in front of it. Optional so hand-built details stay
   * valid. See directOrderFieldEvidenceGap.
   */
  pharmacyFieldEvidenceGap?: DirectOrderFieldEvidenceGap | null;
  /**
   * EVERY validation photo on file for the venue this order stands on, each with its full captured
   * details (owner, 2026-10-21: the SFE and managerial approvers must see the validation photo of the
   * pharmacy AND the customer with 100% of its data — "never hide a picture if available"). The
   * Direct Order field claims, the marketing pharmacy's photos, and the photos of every marketing
   * customer validated at that pharmacy. Optional so hand-built details stay valid.
   */
  venueValidationPhotos?: DirectOrderVenueValidationPhoto[];
  /**
   * The distributor invoice saved with THIS order (owner, 2026-09-14: the SFE Manager must clearly see
   * the invoice that was used). Null when the order carries none. Optional so hand-built details stay
   * valid.
   */
  orderInvoice?: DirectOrderRequestInvoice | null;
  /** The pharmacy is new and has a distributor account, so an invoice is what the SFE Manager decides on. */
  invoiceExpected?: boolean;
  /** This viewer may attach or replace the invoice — the requester, while it can still inform a decision. */
  canAttachInvoice?: boolean;
  /**
   * Only populated when the pharmacy has NO distributor code on file: candidates where the
   * pharmacy's own stored NAME happens to be a real distributor customer code (the "829575 \
   * 1533576" failure mode, spotted live 2026-08-08 — a submitter typed a customer code into the
   * name field instead of an actual pharmacy name).
   *
   * These are now AUTO-LINKED when the match is unambiguous (owner rule, 2026-08-08 — "if the
   * pharmacy matches automatic link"). So anything still sitting here has been REFUSED, and
   * `autoLinkRefusal` says by which rule. A populated list is therefore no longer "look at this
   * match" — it is "the system saw this and declined to act; here is why."
   */
  possibleDistributorMatches: DirectOrderPossibleDistributorMatch[];
  /**
   * Why the candidates above were not linked automatically. Null when there are none to link.
   * Rendered as a sentence, never a bare code — see `describeDirectOrderAutoLinkRefusal`.
   */
  autoLinkRefusal: DirectOrderAutoLinkRefusal | null;
  /**
   * The three-way geography comparison: the distributor's own recorded brick/area for the matched
   * customer code, versus the brick/area declared on this request, versus the free-text address the
   * submitter typed.
   *
   * Replaces the old single "Geography check: Not flagged" field, which printed one identical string
   * for three opposite situations — agrees, never checked, and not checkable. Null only when there
   * is no pharmacy at all.
   */
  geographyCheck: DirectOrderGeographyCheck | null;
  /**
   * Whether THIS viewer may book the order into a sales month. Finance (Ahmed El Maraghy) and
   * Super Admin can; the CEO and SFE Manager see the month but cannot change it.
   */
  canSetSalesMonth: boolean;
  /**
   * Whether THIS viewer may record money collected against the order. Same person as
   * canSetSalesMonth today, but a separate flag because they are separate duties — booking a
   * month decides which period the SALES count in, recording a collection only says what has
   * been PAID. Everyone else sees the figures read-only.
   */
  canRecordCollection: boolean;
  /**
   * Whether THIS viewer is the Administrator, who may record a service fee owed to the pharmacy's
   * doctor as a request raised and executed in one click, settled against this order.
   */
  canSettleServiceFee: boolean;
  /** The order's requester and the pharmacy's doctor, in words, for the service-fee control. */
  serviceFeeDefaults: { beneficiaryName: string; requesterName: string } | null;
  /**
   * Whether THIS viewer may correct and resubmit the order — true only when it is `returned` AND
   * the viewer raised it (or is a System Admin acting for them). See `reviseDirectOrder`.
   */
  canCorrectAndResubmit: boolean;
  /**
   * The approver's reason for sending it back, shown prominently to the requester.
   *
   * Read from `direct_order_events`, NOT from the approval step: the decision RPC only writes
   * `decision_comment` when the step moves to approved/rejected, so a RETURN never stores its
   * reason on the step at all. The event is the only durable copy.
   */
  returnComment: { message: string; byName: string | null; at: string } | null;
};

export type DirectOrderWorkspaceData = {
  awaiting: DirectOrderApprovalListItem[];
  history: DirectOrderApprovalListItem[];
  /**
   * Held/expired requests within the viewer's own visibility scope (owner rule, 2026-08-08: held
   * status is no longer Super-Admin-only — everyone in a request's normal chain sees it). Scoped
   * identically to `resolveDirectOrderReportScope`/`resolveVisibleRequesterHrIds`, NOT company-wide.
   * The Held Desk's management actions (resend notice, cancel, force-expire) stay Super-Admin-only
   * and untouched — this is read visibility only.
   */
  held: DirectOrderApprovalListItem[];
};

// ── Direct-sales reconciliation (manual DIRECT vs module DirectReq) ────────────
/** One (period, line, region, product) bucket where BOTH direct sources have value. */
export type DirectSalesReconciliationOverlap = {
  period: string;
  line: string;
  regionCode: string;
  productCode: string;
  manualValue: number;
  manualQty: number;
  moduleValue: number;
  moduleQty: number;
  /** least(manual, module) — the amount at risk of being counted twice. */
  overlapExposure: number;
};

export type DirectSalesReconciliationPeriod = {
  period: string;
  manualValue: number;
  moduleValue: number;
  overlapExposure: number;
};

export type DirectSalesReconciliationResult = {
  periodFrom: string | null;
  periodTo: string | null;
  groupedRows: number;
  overlapRows: number;
  totalManualDirect: number;
  totalModuleDirect: number;
  overlapExposure: number;
  /** True when there is no overlap between the two direct sources. */
  pass: boolean;
  overlaps: DirectSalesReconciliationOverlap[];
  byPeriod: DirectSalesReconciliationPeriod[];
};

/** Where a venue validation photo was taken for: the Direct Order desk, or Marketing's pharmacy or customer capture. */
export type DirectOrderVenueValidationPhotoSource = "direct_order_claim" | "marketing_pharmacy" | "marketing_customer";

/**
 * One validation photo on a direct-order venue, with everything captured beside it (owner, 2026-10-21).
 * `photoUrl` is null only when the file is recorded but could not be signed — the card then says so
 * instead of disappearing, so an approver knows a picture exists.
 */
export type DirectOrderVenueValidationPhoto = {
  key: string;
  source: DirectOrderVenueValidationPhotoSource;
  /** "Pharmacy — Marketing validation", "Customer — Marketing validation", "Pharmacy — Direct Order validation". */
  title: string;
  /** The pharmacy or customer the photo is of. */
  subject: string;
  photoUrl: string | null;
  photoCapturedAt: string | null;
  photoLatitude: number | null;
  photoLongitude: number | null;
  photoAccuracyMeters: number | null;
  /** Every captured detail, in words, label first — never a raw code where a name exists. */
  details: Array<{ label: string; value: string }>;
};
