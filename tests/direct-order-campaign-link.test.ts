import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PICKABLE_CAMPAIGN_STATUSES,
  resolveSubmittedCampaignId,
} from "../src/lib/direct-orders/campaign-link.ts";
import { approvedMarketingRequestStatuses } from "../src/lib/marketing-requests/service.ts";

// `direct_order_requests.marketing_request_id` shipped with the module's foundation migration and
// was READ in five places — the report column, the export, the approval card, Customer 360's
// campaign attribution, and the reversal that deliberately copies it forward — while NOTHING wrote
// it. Measured on production 2026-09-03: 93 orders, 0 carrying a campaign, ever. Every one of those
// readers rendered a permanent blank and no one could tell that from "no campaigns were used".
//
// That is the failure mode this file exists to prevent, and it is a QUIET one: if any link in the
// chain goes away, the picker simply stops appearing, orders keep saving, nothing errors, and the
// column silently returns to being dead. So the chain is pinned end to end — form → route →
// service insert — plus the two rules that decide what may be attached at all.

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/direct-orders/service.ts", import.meta.url)),
  "utf8",
);
const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/direct-orders/submit/route.ts", import.meta.url)),
  "utf8",
);
const OPTIONS_ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/direct-orders/campaign-options/route.ts", import.meta.url)),
  "utf8",
);
const FORM_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/direct-orders/direct-order-submit-form.tsx", import.meta.url)),
  "utf8",
);
const LINK_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/direct-orders/campaign-link.ts", import.meta.url)),
  "utf8",
);

export async function runDirectOrderCampaignLinkTests() {
  // 1. The pickable set is the marketing module's own "approved money" list minus `closed`.
  // Pinned in BOTH directions so neither side can drift: a status added there must be considered
  // here, and a status removed here must be a deliberate edit to this assertion.
  const expected = approvedMarketingRequestStatuses.filter((status) => status !== "closed");
  assert.deepEqual(
    [...PICKABLE_CAMPAIGN_STATUSES].sort(),
    [...expected].sort(),
    "PICKABLE_CAMPAIGN_STATUSES must be approvedMarketingRequestStatuses minus 'closed' — a closed campaign's ROI window has ended, and every other approved state must stay attachable",
  );
  assert.ok(
    !PICKABLE_CAMPAIGN_STATUSES.includes("closed"),
    "a closed campaign must never be offered — its ROI window is already reported and settled",
  );
  assert.ok(
    !PICKABLE_CAMPAIGN_STATUSES.includes("rejected") && !PICKABLE_CAMPAIGN_STATUSES.includes("pending_approval"),
    "an order must never be attachable to a campaign whose money was not approved",
  );

  // 2. "No campaign" is the ordinary answer and must resolve to null WITHOUT a lookup — 93 of 93
  // production orders have none, so this is the hot path, and an empty string reaching the query
  // would be looked up as an id and fail a submission that is perfectly valid.
  const access = { hrId: "a-1", role: "District Manager", scope: "sales", source: "session" } as never;
  assert.equal(await resolveSubmittedCampaignId(access, null, "Pedia"), null, "null campaign resolves to null");
  assert.equal(await resolveSubmittedCampaignId(access, "", "Pedia"), null, "empty campaign resolves to null");
  assert.equal(await resolveSubmittedCampaignId(access, "   ", "Pedia"), null, "blank campaign resolves to null");

  // 3. The gate is the same one that guards raising an order. A role that cannot raise a direct
  // order must be refused BEFORE any query runs — checked here with a role that is deliberately
  // not in DIRECT_ORDER_REQUESTER_ROLES.
  await assert.rejects(
    () =>
      resolveSubmittedCampaignId(
        { hrId: "a-2", role: "Medical Rep", scope: "self", source: "session" } as never,
        "some-campaign-id",
        "Pedia",
      ),
    /cannot raise direct orders/i,
    "a role that cannot raise a direct order must not be able to attach one to a campaign",
  );

  // 4. The service actually STORES it, and validates before it does. Both halves matter: the insert
  // without the validation would trust the request body, and the validation without the insert
  // would be the exact dead column this whole file is about.
  assert.match(
    SERVICE_SOURCE,
    /const marketingRequestId = await resolveSubmittedCampaignId\(access, input\.marketingRequestId, product\.line\)/,
    "submitDirectOrder must re-validate the declared campaign server-side, against the order's own line",
  );
  assert.match(
    SERVICE_SOURCE,
    /marketing_request_id: marketingRequestId,/,
    "submitDirectOrder's insert must write marketing_request_id — without this the column stays dead",
  );

  // 5. The reversal must keep carrying the original's campaign. It already did, and that behaviour
  // only started mattering the moment the column became non-null, so it is pinned here too: a
  // reversal that loses the link leaves the original crediting a campaign its reversal does not.
  assert.match(
    SERVICE_SOURCE,
    /marketing_request_id: original\.marketingRequestId,/,
    "a direct-order reversal must carry the original's marketing_request_id",
  );

  // 6. The route passes it through, and the form sends it. These are the two links that, if
  // dropped, leave a working server nobody can reach — the shape of every "shipped but reachable
  // by nobody" defect in this module's history.
  assert.match(
    ROUTE_SOURCE,
    /marketingRequestId: body\.marketingRequestId \?\? null,/,
    "the submit route must pass marketingRequestId to the service",
  );
  assert.match(
    FORM_SOURCE,
    /marketingRequestId: marketingRequestId \|\| null,/,
    "the submit form must post the chosen campaign",
  );
  assert.match(
    FORM_SOURCE,
    /api\/direct-orders\/campaign-options\?line=/,
    "the submit form must load the campaign list for the chosen product's line",
  );

  // 7. SECURITY. The picker is open to every direct-order requester, so its query must return
  // labels only. A campaign's cost and ROI targets are marketing money and are not part of raising
  // an order — if one of these ever appears in the select, this fails rather than shipping quietly.
  const selectLine = LINK_SOURCE.split("\n").find((line) => line.includes('.select("id, request_code'));
  assert.ok(selectLine, "the campaign list must select an explicit column list, never '*'");
  for (const forbidden of ["estimated_cost", "expected_roi_value", "required_roi_value", "roi_coverage_ratio"]) {
    assert.ok(
      !selectLine.includes(forbidden),
      `the campaign picker must not read ${forbidden} — it returns labels only, and is not a reason to widen what a requester can see`,
    );
  }
  assert.ok(
    !LINK_SOURCE.includes('.select("*")'),
    "the campaign link module must never select '*' from marketing_requests",
  );

  // 8. The options endpoint must not invent its own permission rule. The service is the boundary;
  // a route that gated differently would be a second authority, and the looser of the two wins.
  assert.match(
    OPTIONS_ROUTE_SOURCE,
    /listDirectOrderCampaignOptions\(access, line\)/,
    "the options route must delegate to the domain service, which holds the role and line rules",
  );
}
