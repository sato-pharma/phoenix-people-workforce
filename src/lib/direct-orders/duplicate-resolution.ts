import { normalizeCustomerCode } from "@/lib/direct-orders/hold-decision";

// ─────────────────────────────────────────────────────────────────────────────
// One real pharmacy, entered twice. One real order, submitted twice. (owner rules 1–5, 2026-08-09)
//
// THE LIVE CASE THIS WAS BUILT FROM. On 2026-08-06 a District Manager registered a pharmacy and
// typed the distributor's customer code into the NAME box (DOP-000017, name "1573270"), then
// submitted an order: LA001, 240 units, 25% discount, 59,400 EGP, collection 2026-09-11. The next
// evening she registered THE SAME pharmacy again — correctly this time (DOP-000021, "محمود احمد
// صالح", code PS/0001573270 in its proper column) — and submitted THE SAME order again. Identical
// product, quantity, deal, discount and collection date.
//
// Nothing noticed. Two pharmacy records for one pharmacy; two orders for one order; 59,400 EGP
// standing in the system twice, one copy already climbing the approval chain.
//
// The auto-link rule (hold-decision.ts) refused to repair DOP-000017, correctly — its code was
// already held by DOP-000021, and linking would have pointed two Phoenix records at one distributor
// customer and split that customer's sales between them. But refusing is only half an answer. The
// owner's instruction was the other half: "SINCE OUR SMART SYSTEM RECOGNIZE THEY ARE ONE WHY NOT
// HELP EMPLOYEES?" If the system can prove two records are one pharmacy, it should merge them
// rather than hand the mistake back to the person who made it.
//
// IDENTITY IS THE DISTRIBUTOR CUSTOMER CODE, wherever a code exists. Not the name — names are
// typed by hand, in two languages, with the code sometimes in the wrong box. Not the brick —
// thousands of pharmacies share one. The code is the only field whose match is a fact rather than a
// resemblance, which is the same reasoning the hold rule and the auto-link rule already run on. A
// pharmacy contributes two kinds of key: the codes actually LINKED to it, and — for the wrong-box
// case — the code its digit-shaped NAME resolves to.
//
// EVERYTHING HERE IS A PROPOSAL. Nothing in this module writes. It returns a plan for an SFE
// Manager to read, edit and confirm (owner rule 5), because a wrong merge is expensive and hard to
// unpick: it moves live approval chains onto a different pharmacy and cancels orders. Same shape as
// the standing rule on deductions — recommend, a human confirms, then it applies.
//
// THE NAME+AREA FALLBACK (owner, 2026-08-13) exists for a case the code match cannot see at all: a
// pharmacy registered with NO distributor code, ever — explicitly allowed, "owner rule 2026-08-04",
// so a rep who does not know the code is never blocked. Such a record carries zero identity keys,
// so the code matcher above has nothing to compare it against, not even a wrong answer. Confirmed
// live: "حضانه زمزم", area D15, registered twice the same day by the same rep — DOP-000018 and
// DOP-000019, both codeless, neither ever surfaced.
//
// This does NOT weaken "identity is the code": the fallback fires ONLY for pharmacies that carry
// ZERO identity keys on both sides of the comparison. A pharmacy with even one linked code is never
// pulled into a name cluster, and never loses a code-based match to one — the two passes below
// partition the input by "has a code" versus "has none" before either one runs. Matching is exact
// (Arabic-normalized name, same area), not fuzzy, because this feeds an actionable MERGE proposal —
// the same caution that makes survivorRank prefer a coded record over a coincidence.
// ─────────────────────────────────────────────────────────────────────────────

/** A (distributor, customer) pair, however it reached the pharmacy. */
export type PharmacyCodePair = { distributorCode: string; customerCode: string };

export type PharmacyForDedupe = {
  id: string;
  phoenixPharmacyCode: string;
  pharmacyName: string;
  brickId: string | null;
  areaCode: string | null;
  verificationStatus: string;
  active: boolean;
  /** ISO. Ties are broken toward the older record only after every stronger signal is equal. */
  createdAt: string | null;
  /** Pairs actually written to direct_order_pharmacy_distributor_codes. */
  linkedCodes: ReadonlyArray<PharmacyCodePair>;
  /** Pairs the digit-shaped NAME resolves to in the distributor master — the wrong-box case. */
  nameCodeCandidates: ReadonlyArray<PharmacyCodePair>;
  /**
   * `phx_normalize_arabic(pharmacyName)`, computed by the caller (duplicate-resolution.ts has no
   * database access and must not reimplement that folding). Empty string if not computed — a
   * pharmacy that already carries an identity key never reads this field, so callers that only
   * populate it for the codeless subset lose nothing.
   */
  normalizedName: string;
};

/** The evidence that two pharmacy records are one real pharmacy — a fact, or a strong resemblance. */
export type PharmacyMergeEvidence =
  | { kind: "code"; distributorCode: string; customerCode: string }
  | { kind: "name"; normalizedName: string; areaCode: string };

export type PharmacyMergeProposal = {
  /** The record that survives and receives every request. */
  survivorId: string;
  survivorCode: string;
  survivorName: string;
  /** Records folded into the survivor and then deactivated. */
  mergedIds: string[];
  /** What proves these are one pharmacy — a shared code, or a codeless name+area match. */
  provenBy: PharmacyMergeEvidence;
  /** Why this record won, in words. */
  reason: string;
};

/**
 * Every identity key a pharmacy carries: "PS|1573270".
 *
 * Normalized through the same `normalizeCustomerCode` the hold and auto-link rules use, so the
 * padded master spelling ("0001573270") and a hand-typed bare one ("1573270") land on one key.
 * Placeholders collapse to "0" and are dropped — "000000" denotes no customer, so two pharmacies
 * both carrying it are NOT thereby the same pharmacy. That guard matters: the placeholder is live on
 * two records today, and without it they would merge into each other.
 */
export function pharmacyIdentityKeys(pharmacy: PharmacyForDedupe): string[] {
  const keys = new Set<string>();
  for (const pair of [...pharmacy.linkedCodes, ...pharmacy.nameCodeCandidates]) {
    const distributor = String(pair.distributorCode ?? "").trim().toUpperCase();
    const customer = normalizeCustomerCode(pair.customerCode);
    if (!distributor || customer === null || customer === "0") continue;
    keys.add(`${distributor}|${customer}`);
  }
  return [...keys];
}

/** Is this name really a code in the wrong box? Mirrors the auto-link gate. */
function nameIsCode(pharmacyName: string): boolean {
  return /^\d{4,}$/.test(String(pharmacyName ?? "").trim());
}

/**
 * Which record survives a merge?
 *
 * Ranked by how much of the truth each one already holds, strongest signal first:
 *   1. it has a code in its proper column — that is the whole point of the record
 *   2. its name is a NAME, not a code that landed in the wrong box
 *   3. it is still active
 *   4. it has been verified by a human
 *   5. oldest wins, so the surviving Phoenix code is the one already quoted elsewhere
 *
 * `verification_status` is deliberately FOURTH, below "has a code". A record can be verified while
 * still being nonsense — DOP-000017 is `verified` and named "1573270" — so trusting it above the
 * code would keep the broken row and discard the good one. The code is the evidence; verification
 * only records that somebody looked.
 */
function survivorRank(pharmacy: PharmacyForDedupe): number[] {
  return [
    pharmacy.linkedCodes.length > 0 ? 1 : 0,
    nameIsCode(pharmacy.pharmacyName) ? 0 : 1,
    pharmacy.active ? 1 : 0,
    pharmacy.verificationStatus === "verified" ? 1 : 0,
    // Negated so "smaller timestamp" sorts as "better" under the same descending comparison.
    -(Date.parse(pharmacy.createdAt ?? "") || Number.MAX_SAFE_INTEGER),
  ];
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function describeSurvivor(pharmacy: PharmacyForDedupe): string {
  if (pharmacy.linkedCodes.length > 0 && !nameIsCode(pharmacy.pharmacyName)) {
    return "it is the complete record — a real name, and the distributor code in its proper column";
  }
  if (pharmacy.linkedCodes.length > 0) return "it is the only record with the distributor code linked";
  if (!nameIsCode(pharmacy.pharmacyName)) return "it is the only record with a real pharmacy name rather than a code";
  return "it is the oldest of the matching records";
}

/**
 * Group pharmacies that are provably the same real pharmacy, and pick each group's survivor.
 *
 * Transitive by design: if A shares a code with B and B shares a different code with C, all three
 * are one pharmacy. A distributor customer cannot belong to two pharmacies, so the chain holds.
 *
 * Deactivated records still participate. One already merged away must not be re-proposed, and a
 * record deactivated for some other reason still owns its history — leaving it out would let a
 * second duplicate of the same pharmacy be created later with nothing noticing.
 */
export function groupDuplicatePharmacies(pharmacies: ReadonlyArray<PharmacyForDedupe>): PharmacyMergeProposal[] {
  // Union-find over identity keys.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const byKey = new Map<string, string[]>();
  for (const pharmacy of pharmacies) {
    parent.set(pharmacy.id, parent.get(pharmacy.id) ?? pharmacy.id);
    for (const key of pharmacyIdentityKeys(pharmacy)) {
      const bucket = byKey.get(key) ?? [];
      bucket.push(pharmacy.id);
      byKey.set(key, bucket);
    }
  }
  // Remember which shared pair proved each cluster, for the "why" on screen.
  const provenByCluster = new Map<string, PharmacyMergeEvidence>();
  for (const [key, ids] of byKey) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
    const [distributorCode, customerCode] = key.split("|");
    provenByCluster.set(find(ids[0]), { kind: "code", distributorCode, customerCode });
  }

  // ── The name+area fallback, for pharmacies the code match cannot see at all ─────────────────
  //
  // Restricted to pharmacies with ZERO identity keys — a codeless record has nothing for the pass
  // above to compare, right or wrong, so this never competes with or dilutes a code-proven cluster.
  // Requires BOTH a normalized name and an area: area is the anchor that stops two unrelated
  // pharmacies sharing a common name (a very ordinary occurrence) from being proposed as one.
  const byNameKey = new Map<string, string[]>();
  for (const pharmacy of pharmacies) {
    if (pharmacyIdentityKeys(pharmacy).length > 0) continue;
    const name = pharmacy.normalizedName.trim();
    const area = String(pharmacy.areaCode ?? "").trim().toUpperCase();
    if (!name || !area) continue;
    const key = `${name}|${area}`;
    const bucket = byNameKey.get(key) ?? [];
    bucket.push(pharmacy.id);
    byNameKey.set(key, bucket);
  }
  for (const [key, ids] of byNameKey) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
    const [normalizedName, areaCode] = key.split("|");
    provenByCluster.set(find(ids[0]), { kind: "name", normalizedName, areaCode });
  }

  const clusters = new Map<string, PharmacyForDedupe[]>();
  for (const pharmacy of pharmacies) {
    const root = find(pharmacy.id);
    const bucket = clusters.get(root) ?? [];
    bucket.push(pharmacy);
    clusters.set(root, bucket);
  }

  const proposals: PharmacyMergeProposal[] = [];
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => compareRanks(survivorRank(a), survivorRank(b)));
    const survivor = ordered[0];
    proposals.push({
      survivorId: survivor.id,
      survivorCode: survivor.phoenixPharmacyCode,
      survivorName: survivor.pharmacyName,
      mergedIds: ordered.slice(1).map((pharmacy) => pharmacy.id),
      provenBy: provenByCluster.get(root) ?? { kind: "code", distributorCode: "", customerCode: "" },
      reason: describeSurvivor(survivor),
    });
  }
  // Stable output: the screen must not reshuffle between two reads of the same data.
  return proposals.sort((a, b) => a.survivorCode.localeCompare(b.survivorCode));
}

// ── Look-alike venues the merge rule cannot prove ────────────────────────────
//
// WHY THIS IS SEPARATE, AND WHY IT PROPOSES NOTHING.
//
// `groupDuplicatePharmacies` answers one question — "can I PROVE these are one venue?" — and its
// two passes deliberately partition the input: the code pass sees only records carrying an identity
// key, the name+area pass only records carrying none. That partition is what stops a resemblance
// from diluting a distributor-proven fact, and it is right.
//
// It also has a blind spot, and the blind spot is occupied. Two live pairs share an exact
// Arabic-normalized name AND an area while sitting on opposite sides of that partition:
//
//   محمد فتحي أبو زيد  · AB5 · DOP-000040 (no code) + DOP-000041 (PS/0001576761)
//   المنصورية الجديدة · GZ3 · DOP-000009 (no code) + DOP-000049 (PS/0001539236)
//
// Each is one coded record beside one codeless one, so neither pass can see the pair at all: the
// code pass has nothing to compare the codeless row against, and the name pass excludes the coded
// row by design. Measured 2026-08-29 by running the real rule over live production rows — the one
// other exact name+area pair, "433106" in GZ1, IS already proposed (both rows are digit-named, so
// both pick up the same two name-code candidates and union normally).
//
// NONE OF THIS IS A MERGE PROPOSAL, which is the whole reason it is a separate function rather
// than a wider `groupDuplicatePharmacies`. Every group it can find has approved orders on at least
// one side, and the owner's rule of 2026-08-29 is that a venue row carrying confirmed orders is
// never touched: "If rejected, do this. If confirmed, don't ever touch." Widening the merge pass to
// reach these would put rows with committed money behind a checkbox that is ticked by default, and
// `confirmDirectOrderCleanup` repoints requests with no status filter — so a merge moves approved
// orders too, silently. So this returns a REVIEW LIST: what looks alike, why the system will not
// rule on it, and what is at stake on each side. A human decides, and acts elsewhere.

/** Why the merge rule will not rule on a look-alike pair. */
export type VenueLookAlikeBlocker = "one-side-has-a-code" | "different-codes";

export type VenueLookAlikeGroup = {
  normalizedName: string;
  areaCode: string;
  /** Every record in the group, strongest-ranked first — the same order a merge would survive in. */
  memberIds: string[];
  blocker: VenueLookAlikeBlocker;
  /** Why the system is not deciding this itself, in words a reviewer can act on. */
  explanation: string;
};

const LOOK_ALIKE_EXPLANATION: Record<VenueLookAlikeBlocker, string> = {
  "one-side-has-a-code":
    "One record carries a distributor code and the other carries none. The code check has nothing " +
    "to compare the codeless record against, and the name check deliberately ignores any record " +
    "that already has a code — so neither one can see this pair.",
  "different-codes":
    "Both records carry distributor codes, and the codes are different. A distributor customer " +
    "belongs to one venue, so the system will not call two different customers one venue on the " +
    "strength of a matching name.",
};

/**
 * Exact name+area matches that `groupDuplicatePharmacies` did not already cluster.
 *
 * Exact, never fuzzy, and anchored on the area — the same caution the merge rule runs on. A
 * reviewer reading this list is being asked to look, not to approve a write, but a list padded with
 * coincidences is one nobody reads twice.
 */
export function findLookAlikeVenues(
  pharmacies: ReadonlyArray<PharmacyForDedupe>,
  proposals: ReadonlyArray<PharmacyMergeProposal>,
): VenueLookAlikeGroup[] {
  const clusterOf = new Map<string, string>();
  for (const proposal of proposals) {
    for (const id of [proposal.survivorId, ...proposal.mergedIds]) clusterOf.set(id, proposal.survivorId);
  }

  const byNameKey = new Map<string, PharmacyForDedupe[]>();
  for (const pharmacy of pharmacies) {
    const name = pharmacy.normalizedName.trim();
    const area = String(pharmacy.areaCode ?? "").trim().toUpperCase();
    if (!name || !area) continue;
    const key = `${name}|${area}`;
    const bucket = byNameKey.get(key) ?? [];
    bucket.push(pharmacy);
    byNameKey.set(key, bucket);
  }

  const groups: VenueLookAlikeGroup[] = [];
  for (const [key, members] of byNameKey) {
    if (members.length < 2) continue;

    // Already one merge proposal? The desk is handling it, and listing it here too would ask the
    // same question twice and invite two different answers.
    const clusters = new Set(members.map((member) => clusterOf.get(member.id) ?? `unclustered:${member.id}`));
    if (clusters.size === 1 && clusterOf.has(members[0].id)) continue;

    // A wholly codeless group belongs to the name+area pass, which has already clustered it and so
    // was caught above. Reaching here means the group is mixed or wholly coded.
    const coded = members.filter((member) => pharmacyIdentityKeys(member).length > 0);
    if (coded.length === 0) continue;

    const blocker: VenueLookAlikeBlocker =
      coded.length === members.length ? "different-codes" : "one-side-has-a-code";
    const [normalizedName, areaCode] = key.split("|");
    groups.push({
      normalizedName,
      areaCode,
      memberIds: [...members].sort((a, b) => compareRanks(survivorRank(a), survivorRank(b))).map((m) => m.id),
      blocker,
      explanation: LOOK_ALIKE_EXPLANATION[blocker],
    });
  }

  // Still-live confusion first — a pair whose records are both active is one a rep can pick the
  // wrong half of today; a pair with one record already closed is history worth consolidating but
  // is not misleading anybody right now. Ties broken on area then name so the screen is stable.
  const liveCount = (group: VenueLookAlikeGroup) =>
    group.memberIds.filter((id) => pharmacies.find((pharmacy) => pharmacy.id === id)?.active).length;
  return groups.sort(
    (a, b) =>
      liveCount(b) - liveCount(a) ||
      a.areaCode.localeCompare(b.areaCode) ||
      a.normalizedName.localeCompare(b.normalizedName),
  );
}

// ── Duplicate REQUESTS ───────────────────────────────────────────────────────

/**
 * Statuses a duplicate may be cancelled from.
 *
 * `approved` is deliberately absent. An approved order is money already committed and, once a sales
 * month is set, injected into Source of Sales — undoing it is a REVERSAL, which has its own action,
 * its own re-approval and its own audit trail. Quietly cancelling one as "a duplicate" would remove
 * booked sales with no reversal record. The terminal statuses are absent for the obvious reason.
 */
export const DEDUPE_OPEN_STATUSES = ["draft", "held", "pending_approval", "returned"] as const;

/** One product on a request. A request with several is a family basket — today, Lacto only. */
export type DedupeLine = {
  productCode: string;
  qty: number;
  bonus: number;
  dealType: string;
  discountPct: number | null;
};

export type RequestForDedupe = {
  id: string;
  pharmacyId: string;
  status: string;
  productCode: string;
  qty: number;
  bonus: number;
  dealType: string;
  discountPct: number | null;
  collectionDate: string | null;
  requesterHrId: string;
  submittedAt: string | null;
  /** Rungs already decided. The real measure of how much human work a cancellation would discard. */
  approvedStepCount: number;
  /**
   * EVERY product on the request, not just the first.
   *
   * Optional so a caller that has not loaded the line items still works: it falls back to the
   * request's singular columns, which for a one-product order are exactly the same thing. But a
   * caller that CAN load them must, and the reason is in `basketKey` below.
   */
  lines?: readonly DedupeLine[];
};

export type DuplicateRequestProposal = {
  /** The copy that survives. */
  keeperId: string;
  /** Copies to be marked cancelled, each pointing at the keeper. */
  duplicateIds: string[];
  /** The fields that were identical — the evidence, shown on screen. */
  matchedOn: {
    pharmacyId: string;
    /** The first line's code — kept because every existing reader expects one product. */
    productCode: string;
    /** EVERY product that matched. One entry for an ordinary order, several for a family basket. */
    productCodes: string[];
    qty: number;
    bonus: number;
    dealType: string;
    discountPct: number | null;
    collectionDate: string | null;
  };
  reason: string;
};

const STATUS_RANK: Record<string, number> = { pending_approval: 3, returned: 2, held: 1, draft: 0 };

function lineKey(line: DedupeLine): string {
  return [
    String(line.productCode ?? "").trim().toUpperCase(),
    Number(line.qty ?? 0),
    Number(line.bonus ?? 0),
    String(line.dealType ?? "").trim().toLowerCase(),
    line.discountPct == null ? "" : Number(line.discountPct),
  ].join("~");
}

/**
 * The commercial identity of a request: EVERY product on it, on identical terms.
 *
 * A request may now carry more than one product (Lacto Advanced 1 + 2 on one order). Its singular
 * `product_code`/`qty`/`bonus` columns hold only the FIRST line, so keying on them alone would call
 * "Lacto 1 + Lacto 2" and "Lacto 1 alone" the same order whenever their first lines happened to
 * match — and an SFE Manager, shown two orders the system says are identical, would confirm the
 * cancellation of a line the pharmacy actually wants.
 *
 * Sorted, so the two concentrations entered in either order are still recognised as one order.
 *
 * Falls back to the singular columns when a caller supplies no lines, which keeps a one-product
 * request keyed exactly as it was before baskets existed.
 */
function basketKey(request: RequestForDedupe): string {
  const lines: readonly DedupeLine[] = request.lines?.length
    ? request.lines
    : [
        {
          productCode: request.productCode,
          qty: request.qty,
          bonus: request.bonus,
          dealType: request.dealType,
          discountPct: request.discountPct,
        },
      ];
  return lines.map(lineKey).sort().join("+");
}

/**
 * Two open requests are the same order when the pharmacy, EVERY product, and the commercial terms
 * on each of them all match.
 *
 * The REQUESTER is deliberately not part of the key. Two people entering the same order for the same
 * pharmacy on the same collection date is still one order — arguably a worse duplicate, since
 * neither of them knows about the other.
 *
 * The residual risk is a pharmacy that genuinely orders the same product twice, on identical terms,
 * for the same collection date. In practice that is ordered as one larger quantity, and this is
 * exactly why nothing here cancels anything on its own: an SFE Manager sees the pair and confirms.
 *
 * `pharmacyIdToCanonical` folds merged records first, so the two halves of a duplicated pharmacy do
 * not hide a duplicated order between them — which is precisely how the live pair escaped notice.
 */
export function findDuplicateRequestGroups(
  requests: ReadonlyArray<RequestForDedupe>,
  pharmacyIdToCanonical: ReadonlyMap<string, string> = new Map(),
): DuplicateRequestProposal[] {
  const open = requests.filter((request) => (DEDUPE_OPEN_STATUSES as readonly string[]).includes(request.status));
  const groups = new Map<string, RequestForDedupe[]>();
  for (const request of open) {
    const pharmacyId = pharmacyIdToCanonical.get(request.pharmacyId) ?? request.pharmacyId;
    const key = [pharmacyId, basketKey(request), request.collectionDate ?? ""].join("|");
    const bucket = groups.get(key) ?? [];
    bucket.push(request);
    groups.set(key, bucket);
  }

  const proposals: DuplicateRequestProposal[] = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    // Keep the copy that would cost the most to recreate: decided rungs first, then how far along
    // the chain it sits, then the earliest submission. Cancelling the one with approvals already on
    // it would throw away work several managers have done.
    const ordered = [...members].sort((a, b) => {
      if (a.approvedStepCount !== b.approvedStepCount) return b.approvedStepCount - a.approvedStepCount;
      const rankA = STATUS_RANK[a.status] ?? -1;
      const rankB = STATUS_RANK[b.status] ?? -1;
      if (rankA !== rankB) return rankB - rankA;
      const timeA = Date.parse(a.submittedAt ?? "") || Number.MAX_SAFE_INTEGER;
      const timeB = Date.parse(b.submittedAt ?? "") || Number.MAX_SAFE_INTEGER;
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });
    const keeper = ordered[0];
    proposals.push({
      keeperId: keeper.id,
      duplicateIds: ordered.slice(1).map((request) => request.id),
      matchedOn: {
        pharmacyId: pharmacyIdToCanonical.get(keeper.pharmacyId) ?? keeper.pharmacyId,
        productCode: keeper.productCode,
        productCodes: (keeper.lines?.length ? keeper.lines : [{ productCode: keeper.productCode }]).map((line) =>
          String(line.productCode ?? "").trim().toUpperCase(),
        ),
        qty: keeper.qty,
        bonus: keeper.bonus,
        dealType: keeper.dealType,
        discountPct: keeper.discountPct,
        collectionDate: keeper.collectionDate,
      },
      reason:
        keeper.approvedStepCount > 0
          ? `kept because ${keeper.approvedStepCount} approval(s) have already been given on it`
          : keeper.status === "pending_approval"
            ? "kept because it is the copy already in the approval chain"
            : "kept because it is the earliest submission",
    });
  }
  return proposals.sort((a, b) => a.keeperId.localeCompare(b.keeperId));
}

/** pharmacyId → the id it will be merged into. Feeds findDuplicateRequestGroups. */
export function canonicalPharmacyMap(merges: ReadonlyArray<PharmacyMergeProposal>): Map<string, string> {
  const map = new Map<string, string>();
  for (const merge of merges) {
    for (const mergedId of merge.mergedIds) map.set(mergedId, merge.survivorId);
  }
  return map;
}
