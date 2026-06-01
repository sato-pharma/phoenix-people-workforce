import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

export function runOfferLifecycleHardeningTests() {
  const migration = source("supabase/migrations/20260531235753_offer_lifecycle_10_10_hardening.sql");
  assert.match(migration, /create schema if not exists private/i);
  assert.match(migration, /private\.phx_approve_accepted_offer_v2/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /public\.phx_approve_accepted_offer[\s\S]*security invoker/i);
  assert.match(migration, /pv\.department_id = v_offer\.department_id/i);
  assert.match(migration, /Ambiguous vacancy match/i);
  assert.match(migration, /status = 'hired'/i);
  assert.match(migration, /accepted_terms_snapshot/i);
  assert.match(migration, /job_offer_decision_events/i);
  assert.match(migration, /status in \('draft', 'sent', 'accepted', 'rejected', 'expired', 'hired', 'withdrawn', 'cancelled'\)/i);

  const service = source("src/lib/offers/service.ts");
  assert.match(service, /type OfferDecisionContext/);
  assert.match(service, /assertOfferDecisionRateLimit/);
  assert.match(service, /recordOfferDecisionEvent/);
  assert.match(service, /validateSelectedOfferVacancy/);
  assert.match(migration, /status = 'hired'/);
  assert.doesNotMatch(service, /await closeVacancyForOffer\(\{[\s\S]*vacancy_id: offer\.vacancy_id/);
  assert.match(service, /runOfferAdminAction/);
  assert.match(service, /secure_token_hash: hashToken\(token\)/);
  assert.match(service, /revoked_at: now/);

  const createRoute = source("app/api/offers/route.ts");
  assert.match(createRoute, /payload\?\.vacancyId/);
  assert.match(createRoute, /invalid_offer_expiry/);

  const approveRoute = source("app/api/offers/[offerRef]/approve/route.ts");
  assert.match(approveRoute, /postApprovalWarning/);
  assert.match(approveRoute, /markOfferPostApprovalStatus/);

  const workflowRoute = source("app/api/offers/[offerRef]/workflow/route.ts");
  assert.match(workflowRoute, /resend/);
  assert.match(workflowRoute, /withdraw/);
  assert.match(workflowRoute, /cancel/);

  const dashboard = source("src/components/offers/offer-lifecycle-dashboard.tsx");
  assert.match(dashboard, /vacancyId: String\(vacancy\.vacancyId\)/);
  assert.match(dashboard, /runWorkflowAction/);
  assert.match(dashboard, /exportCsv/);
  assert.match(dashboard, /statusFilter/);

  for (const page of [
    "app/offers/[token]/accept/page.tsx",
    "app/offers/[token]/reject/page.tsx",
    "app/offers/[token]/details/page.tsx",
  ]) {
    assert.match(source(page), /robots:[\s\S]*index: false/);
  }
}
