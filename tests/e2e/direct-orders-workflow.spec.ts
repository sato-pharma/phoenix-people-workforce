import { test, expect, type Page } from "@playwright/test";

/**
 * Full E2E workflow for the Direct Order Request module.
 *
 * Actors (real STAGING HR IDs, set via /api/dev-auth). The approval chain is the
 * requester's live manager ladder up to the CEO:
 *   B-154   District Sales Manager   – the requester (submits)
 *   PD-0001 Regional Sales Manager   – rung 1 (B-154's manager)
 *   A-12    National Sales Manager   – rung 2 (PD-0001's manager)
 *   AA      CEO                      – final approval → injection fires
 *
 * Workflow: submit → approve(RM) → approve(NSM) → approve(CEO) → approved
 * (final CEO approval rebuilds the DirectReq SoS batch and credits the area rep).
 *
 * Requirements:
 *   - NODE_ENV=development (dev-auth is 404 in production)
 *   - Local dev server on :3000 whose env points at STAGING (never production —
 *     this workflow mutates data). .env.development.local supplies the staging creds.
 *
 * Run:
 *   pnpm exec playwright test --config playwright.dev-auth.config.ts tests/e2e/direct-orders-workflow.spec.ts
 */

const BASE = "http://localhost:3000";

const DM = { role: "District Manager", hrId: "B-154" };
const RM = { role: "Regional Manager", hrId: "PD-0001" };
const NSM = { role: "National Sales Manager", hrId: "A-12" };
const CEO = { role: "CEO", hrId: "AA" };

const REQUESTER_HOME = "/employee-portals/direct-orders";
const APPROVALS_HOME = "/admin/direct-orders?view=needs-action";

async function devAuth(page: Page, role: string, hrId: string, next: string) {
  const qs = new URLSearchParams({ hrId, next, role });
  await page.goto(`${BASE}/api/dev-auth?${qs.toString()}`, { waitUntil: "domcontentloaded" });
}

type ApiJson = {
  success?: boolean;
  message?: string;
  result?: { id?: string; status?: string; salesMonth?: string };
  pharmacy?: { id?: string };
};

/**
 * POST JSON via Playwright's request context (shares the dev-auth cookie from the
 * page context) with an explicit same-origin Origin header to satisfy the CSRF guard.
 * This is independent of page hydration/CSP, unlike an in-page fetch.
 */
async function apiPost(page: Page, path: string, body: Record<string, unknown>) {
  const res = await page.request.post(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", Origin: BASE },
    data: body,
  });
  return { status: res.status(), json: (await res.json()) as ApiJson };
}

async function devAuthAvailable(page: Page) {
  const res = await page.request.get(`${BASE}/api/dev-auth?role=Super+Admin&hrId=B-10&next=/`, { maxRedirects: 0 });
  return res.status() !== 404;
}

test("direct order submits and is approved up the sales line to the CEO", async ({ page }) => {
  test.skip(!(await devAuthAvailable(page)), "dev-auth unavailable (production build) — staging dev server required");

  const stamp = `${page.context().browser()?.version() ?? "e2e"}-${test.info().workerIndex}`;
  let pharmacyId = "";
  let requestId = "";

  await test.step("DM creates a pharmacy + submits a direct order", async () => {
    await devAuth(page, DM.role, DM.hrId, REQUESTER_HOME);

    const pharmacy = await apiPost(page, "/api/direct-orders/pharmacies", {
      pharmacyName: `E2E Pharmacy ${stamp}`,
      areaCode: "AB1",
      regionCode: "AB",
      distributorCodes: [{ distributorCode: "DIRECT", customerCode: `E2E-${stamp}` }],
    });
    expect(pharmacy.json.success, `pharmacy create: ${pharmacy.json.message ?? ""}`).toBe(true);
    pharmacyId = String(pharmacy.json.pharmacy?.id);

    const submit = await apiPost(page, "/api/direct-orders/submit", {
      productCode: "SA001",
      pharmacyId,
      qty: 100,
      dealType: "bonus",
      bonus: 10,
      collectionDate: "2026-08-15",
    });
    expect(submit.json.success, `submit: ${submit.json.message ?? ""}`).toBe(true);
    expect(submit.json.result?.status).toBe("pending_approval");
    requestId = String(submit.json.result?.id);
  });

  await test.step("RM approves (rung 1) — chain still pending", async () => {
    await devAuth(page, RM.role, RM.hrId, APPROVALS_HOME);
    const res = await apiPost(page, `/api/direct-orders/${requestId}/decision`, { decision: "approve" });
    expect(res.json.success, `RM approve: ${res.json.message ?? ""}`).toBe(true);
    expect(res.json.result?.status).toBe("pending_approval");
  });

  await test.step("NSM approves (rung 2) — chain still pending", async () => {
    await devAuth(page, NSM.role, NSM.hrId, APPROVALS_HOME);
    const res = await apiPost(page, `/api/direct-orders/${requestId}/decision`, { decision: "approve" });
    expect(res.json.success, `NSM approve: ${res.json.message ?? ""}`).toBe(true);
    expect(res.json.result?.status).toBe("pending_approval");
  });

  await test.step("CEO gives final approval — order is approved + injected", async () => {
    await devAuth(page, CEO.role, CEO.hrId, APPROVALS_HOME);
    const res = await apiPost(page, `/api/direct-orders/${requestId}/decision`, { decision: "approve" });
    expect(res.json.success, `CEO approve: ${res.json.message ?? ""}`).toBe(true);
    expect(res.json.result?.status).toBe("approved");
    expect(String(res.json.result?.salesMonth ?? "")).toMatch(/^\d{4}-\d{2}$/);
  });
});
