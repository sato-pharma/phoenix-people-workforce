import assert from "node:assert/strict";
import {
  BACKFILLED_LINK_NOTE,
  LINK_STATUS_PRECEDENCE,
  findCustomerTargetLink,
  inheritedLinkStatus,
  linkStatusIsSelectable,
  linkStatusRankSql,
  requestTargetKind,
} from "../src/lib/marketing-requests/code-link-reach.ts";
import { LICENSE_ONLY_PHARMACY_NOTE } from "../src/lib/venues/pharmacy-license.ts";

export function runMarketingCodeLinkReachTests() {
  assert.equal(
    inheritedLinkStatus([]),
    null,
    "a customer with no existing link to the venue gets nothing — a backfill may not invent a customer-venue relationship",
  );

  assert.equal(
    inheritedLinkStatus(["pending"]),
    "pending",
    "an unvalidated link stays unvalidated; stamping the common value here would make a venue nobody validated suddenly selectable",
  );
  assert.equal(
    linkStatusIsSelectable(inheritedLinkStatus(["pending"])),
    false,
    "and that inherited status must keep the new link out of the picker, which is the whole point of inheriting it",
  );

  assert.equal(
    inheritedLinkStatus(["pending", "system_validated"]),
    "system_validated",
    "strongest wins when a customer somehow holds several links to one venue",
  );
  assert.equal(
    inheritedLinkStatus(["system_validated", "sfe_validated"]),
    "sfe_validated",
    "sfe_validated outranks system_validated — a human looked, and that must not be downgraded by a sibling",
  );

  assert.equal(linkStatusIsSelectable("system_validated"), true);
  assert.equal(linkStatusIsSelectable("sfe_validated"), true);
  assert.equal(
    linkStatusIsSelectable("rejected"),
    false,
    "an unknown status is never selectable — the picker allowlists, so this must fail closed",
  );
  assert.equal(linkStatusIsSelectable(null), false, "a missing status is not a selectable one");

  // The SQL copy of the ordering is the half no other test would catch drifting, so it is built
  // from the same constant and checked against it here.
  const sql = linkStatusRankSql("l.validation_status");
  const ranks = LINK_STATUS_PRECEDENCE.map((status) => {
    const match = sql.match(new RegExp(`when '${status}' then (\\d+)`));
    assert.ok(match, `the emitted SQL must rank ${status}`);
    return Number(match[1]);
  });
  assert.deepEqual(
    ranks,
    [...ranks].sort((a, b) => b - a),
    "the SQL ranks must descend in the same order as LINK_STATUS_PRECEDENCE, or the database picks a different winner than the TypeScript does",
  );
  assert.ok(
    ranks.every((rank) => rank > 1),
    "every listed status must outrank the else branch, which is what pushes an unvalidated status to the bottom",
  );
  assert.match(sql, /else 1 end$/, "anything unlisted ranks last rather than erroring");

  assert.throws(
    () => linkStatusRankSql("validation_status; drop table marketing_customer_pharmacies"),
    /plain column reference/,
    "the column is interpolated into SQL, so anything that is not a bare identifier must be refused",
  );

  assert.match(
    BACKFILLED_LINK_NOTE,
    /nothing was elevated/i,
    "the row has to explain the inheritance rule itself — a note that only says what happened leaves the next reader to guess why",
  );
  // -- Which links can be a request target (owner, 2026-10-21) ---------------------------------
  // ONE test, used by the picker and by the server, so the form can never offer what the server
  // refuses. Marketing Requests hold ONLY venues that carry a distributor code: a link with no code
  // is never a target — not a nursery, not a pharmacy a person released on its licence.
  const licenceLink = (status: string) => ({ distributorCodeId: null, notes: LICENSE_ONLY_PHARMACY_NOTE, status });
  assert.equal(requestTargetKind({ distributorCodeId: "code-1", status: "system_validated" }), "coded");
  assert.equal(requestTargetKind({ distributorCodeId: "code-1", status: "admin_approved" }), "coded");
  assert.equal(
    requestTargetKind({ distributorCodeId: null, status: "system_validated" }),
    null,
    "a codeless link (a nursery's included) is never a target — it is validated in Direct Orders",
  );
  for (const status of ["pending", "system_validated", "sfe_validated", "admin_approved"]) {
    assert.equal(
      requestTargetKind(licenceLink(status)),
      null,
      `a licence-only pharmacy is never a target, even ${status} — the 2026-10-14 release is retired`,
    );
  }
  assert.equal(requestTargetKind({ distributorCodeId: "code-1", status: "rejected" }), null);

  const targetLinks = [
    { distributorCodeId: "code-1", notes: null, pharmacyId: "pharm-1", status: "system_validated" },
    { distributorCodeId: null, notes: null, pharmacyId: "nursery-1", status: "system_validated" },
  ];
  assert.ok(findCustomerTargetLink(targetLinks, { distributorCodeId: "code-1", pharmacyId: "pharm-1" }));
  assert.ok(findCustomerTargetLink(targetLinks, { distributorCodeId: null, pharmacyId: "nursery-1" }));
  assert.equal(
    findCustomerTargetLink(targetLinks, { distributorCodeId: "code-1", pharmacyId: "pharm-2" }),
    undefined,
    "a code that hangs off a venue this customer is not linked to is not their target",
  );
  assert.equal(
    findCustomerTargetLink(targetLinks, { distributorCodeId: "code-2", pharmacyId: "pharm-1" }),
    undefined,
    "another code of the same venue is a different target - the link names ONE code",
  );
}
