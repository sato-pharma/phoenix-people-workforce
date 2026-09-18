import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import { saveScopeVisibilityForLogin, saveWeeklyProductScopeForPerson } from "../src/lib/sales/product-scope-list.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

// Source of Sales audit, finding portal-sos-dashboard.ts:401: a Product Manager's products lived in
// two lists that nothing kept in step, so a list set on Scope & Visibility never reached Source of
// Sales (which reads the Weekly Sales list), and one set on the Weekly Sales screen never reached
// Sales Analytics, marketing requests or the closing download. Owner, 2026-09-18: "make both
// product-scope screens save the same list".
//
// Every person here is fake. The suite runs with PRODUCTION credentials, so these writes must only
// ever reach the in-memory fake.

type FakeClient = ReturnType<typeof fakeSupabaseClient>;

function seededClient(options: { failOn?: Record<string, string> } = {}): FakeClient {
  return fakeSupabaseClient(
    {
      app_auth_users: [
        { login_id: "TEST-PM-1", hr_id: "TEST-PM-1", line_scope_override: ["Pedia"], product_scope_override: ["GU001"], sales_scope_override: "LINE" },
        { login_id: "TEST-PM-2", hr_id: "TEST-PM-2", line_scope_override: null, product_scope_override: ["SA001", "RO001"], sales_scope_override: "LINE" },
        { login_id: "TEST-ADMIN", hr_id: null, line_scope_override: null, product_scope_override: null, sales_scope_override: null },
      ],
      weekly_sales_product_scope: [
        { hr_id: "test-pm-1", product_code: "GU001", created_by: "B-10" },
        { hr_id: "test-pm-1", product_code: "OS001", created_by: "B-10" },
        { hr_id: "test-pm-2", product_code: "SA001", created_by: "B-10" },
        { hr_id: "test-pm-2", product_code: "RO001", created_by: "B-10" },
      ],
    },
    options,
  );
}

function weeklyList(client: FakeClient, hrKey: string): string[] {
  return client
    .rows("weekly_sales_product_scope")
    .filter((row) => row.hr_id === hrKey)
    .map((row) => String(row.product_code))
    .sort();
}

function scopeVisibilityList(client: FakeClient, loginId: string): unknown {
  return client.rows("app_auth_users").find((row) => row.login_id === loginId)?.product_scope_override ?? null;
}

export async function runProductScopeOneListTests() {
  // ── Scope & Visibility's Save reaches the list Source of Sales reads (the headline) ────────────
  {
    const client = seededClient();
    await saveScopeVisibilityForLogin(
      { loginId: "TEST-PM-1", lineNames: ["Pedia"], productCodes: ["GU001", "IV001"], salesScopeOverride: "LINE" },
      "B-10",
      client as never,
    );
    assert.deepEqual(
      weeklyList(client, "test-pm-1"),
      ["GU001", "IV001"],
      "a product list saved on Scope & Visibility must also become the person's Weekly Sales list, the one Source of Sales reads",
    );
    assert.deepEqual(scopeVisibilityList(client, "TEST-PM-1"), ["GU001", "IV001"], "Scope & Visibility keeps the list it saved");
    assert.deepEqual(weeklyList(client, "test-pm-2"), ["RO001", "SA001"], "another person's weekly list is untouched");
    assert.deepEqual(scopeVisibilityList(client, "TEST-PM-2"), ["SA001", "RO001"], "another person's Scope & Visibility list is untouched");
  }

  // ── The Weekly Sales screen's Save reaches Scope & Visibility ──────────────────────────────────
  {
    const client = seededClient();
    await saveWeeklyProductScopeForPerson("test-pm-2", [" sa001", "TG001", "SA001"], "B-10", client as never);
    assert.deepEqual(weeklyList(client, "test-pm-2"), ["SA001", "TG001"], "the weekly list holds the saved codes, trimmed and once each");
    assert.deepEqual(
      scopeVisibilityList(client, "TEST-PM-2"),
      ["SA001", "TG001"],
      "a product list saved on the Weekly Sales screen must also become the person's Scope & Visibility list",
    );
    assert.deepEqual(scopeVisibilityList(client, "TEST-PM-1"), ["GU001"], "another person's Scope & Visibility list is untouched");
  }

  // ── Clearing a list on either screen clears it on both ─────────────────────────────────────────
  {
    const client = seededClient();
    await saveScopeVisibilityForLogin(
      { loginId: "TEST-PM-1", lineNames: ["Pedia"], productCodes: null, salesScopeOverride: "LINE" },
      "B-10",
      client as never,
    );
    assert.equal(scopeVisibilityList(client, "TEST-PM-1"), null, "Scope & Visibility's empty pick is saved as no list");
    assert.deepEqual(weeklyList(client, "test-pm-1"), [], "no list on Scope & Visibility leaves no weekly list either");

    await saveWeeklyProductScopeForPerson("TEST-PM-2", [], "B-10", client as never);
    assert.deepEqual(weeklyList(client, "test-pm-2"), [], "the weekly screen's cleared list is gone");
    assert.equal(scopeVisibilityList(client, "TEST-PM-2"), null, "a cleared weekly list is no list on Scope & Visibility, never an empty one");
  }

  // ── Only one side exists: a login with no employee, an employee with no login ─────────────────
  {
    const client = seededClient();
    const weeklyRowsBefore = client.rows("weekly_sales_product_scope").length;
    await saveScopeVisibilityForLogin(
      { loginId: "TEST-ADMIN", lineNames: null, productCodes: ["GU001"], salesScopeOverride: null },
      "B-10",
      client as never,
    );
    assert.deepEqual(scopeVisibilityList(client, "TEST-ADMIN"), ["GU001"], "a login with no HR_ID still saves its own list");
    assert.equal(client.rows("weekly_sales_product_scope").length, weeklyRowsBefore, "a login with no HR_ID writes no weekly row");

    const loginsBefore = JSON.stringify(client.rows("app_auth_users"));
    await saveWeeklyProductScopeForPerson("TEST-NO-LOGIN", ["RO001"], "B-10", client as never);
    assert.deepEqual(weeklyList(client, "test-no-login"), ["RO001"], "a person with no login still gets a weekly list");
    assert.equal(JSON.stringify(client.rows("app_auth_users")), loginsBefore, "a person with no login changes no login");
  }

  // ── A second write that fails is said out loud, never swallowed ────────────────────────────────
  {
    const client = seededClient({ failOn: { weekly_sales_product_scope: "weekly table unavailable" } });
    await assert.rejects(
      saveScopeVisibilityForLogin(
        { loginId: "TEST-PM-1", lineNames: ["Pedia"], productCodes: ["IV001"], salesScopeOverride: "LINE" },
        "B-10",
        client as never,
      ),
      /Saved on Scope & Visibility, but the Weekly Sales product list did not update\. Save again\./,
      "when the weekly list fails, Scope & Visibility's save must not report success",
    );
    assert.deepEqual(scopeVisibilityList(client, "TEST-PM-1"), ["IV001"], "the message is true: Scope & Visibility did save");
  }
  {
    const client = seededClient({ failOn: { app_auth_users: "logins table unavailable" } });
    await assert.rejects(
      saveWeeklyProductScopeForPerson("TEST-PM-2", ["TG001"], "B-10", client as never),
      // Named, not `instanceof`: the module under test reaches the class through the "@/" alias, and
      // the route maps a SalesWorkflowError to its own message and status.
      (error: unknown) =>
        (error as SalesWorkflowError).name === "SalesWorkflowError" &&
        (error as SalesWorkflowError).code === "scope_visibility_not_updated" &&
        /Saved the Weekly Sales product list, but Scope & Visibility did not update\. Save again\./.test(
          (error as SalesWorkflowError).message,
        ),
      "when Scope & Visibility fails, the weekly screen's save must not report success",
    );
    assert.deepEqual(weeklyList(client, "test-pm-2"), ["TG001"], "the message is true: the weekly list did save");
  }

  // ── Both screens save through the one module, and nothing else writes either list ──────────────
  const scopeRoute = readFileSync(new URL("../app/api/admin/scope-visibility/route.ts", import.meta.url), "utf8");
  assert.match(scopeRoute, /saveScopeVisibilityForLogin\(/, "Scope & Visibility saves through product-scope-list");
  assert.doesNotMatch(scopeRoute, /updateUserScopeOverride\(/, "Scope & Visibility must not write its list alone");
  const weeklyRoute = readFileSync(new URL("../app/api/sales/weekly/product-scope/route.ts", import.meta.url), "utf8");
  assert.match(weeklyRoute, /saveWeeklyProductScopeForPerson\(/, "the weekly screen saves through product-scope-list");
  assert.doesNotMatch(weeklyRoute, /replaceWeeklyProductScope\(/, "the weekly screen must not write its list alone");
}
