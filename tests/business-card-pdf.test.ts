import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runBusinessCardPdfTests() {
  const route = source("app/api/business-cards/mine/route.ts");
  const component = source("src/components/business-cards/employee-business-card.tsx");
  const registry = source("src/lib/security/access-registry.ts");

  // ── The employee's own card is rendered as the REAL print-ready PDF (front and back) ───────────
  // The same renderBusinessCardsPdf the HR generator uses — so the employee sees exactly the admin
  // card, Sato logo and all.
  assert.match(route, /renderBusinessCardsPdf\(\[fields\]/, "the route renders the real print-ready card PDF");
  assert.match(route, /getOwnBusinessCard\(access\)/, "the card is the caller's OWN, resolved from their record");
  assert.match(route, /"Content-Type": "application\/pdf"/, "the route returns a PDF");

  // ── Scoped to the signed-in employee, and only name + mobile are theirs ────────────────────────
  assert.match(route, /assertPermission\(access, "employee_profile", "read"\)/, "gated to the signed-in employee");
  assert.match(route, /assertSameOriginMutation\(request\)/, "the render is CSRF-guarded");
  assert.doesNotMatch(route, /body\.hrId/, "the route must never read an hrId from the body — it can only render the caller's own card");
  assert.match(
    route,
    /\{ \.\.\.own, mobile: clean\(body\.cardMobile\), name \}/,
    "only the name and mobile overlay the record; the title, line·area, email and company details stay the record's",
  );

  // ── The page SHOWS the card (front and back) and offers a printable-PDF download ────────────────
  assert.match(component, /\/api\/business-cards\/mine/, "the component renders via the own-card PDF endpoint");
  assert.match(component, /<iframe/, "the real card is embedded and shown, not a hand-drawn HTML stand-in");
  assert.match(component, /front and back/i, "the preview is labelled front and back");
  assert.match(component, /Download printable PDF/, "there is a high-quality printable-PDF download");
  assert.match(
    component,
    /cardName: name\.trim\(\), cardMobile: mobile\.trim\(\)/,
    "only the name and mobile are sent to render — never an email",
  );

  // ── Registered, and BEFORE the HR export so the exact /mine path never falls to the HR gate ─────
  assert.match(
    registry,
    /pattern: "\/api\/business-cards\/mine", permission: \{ resource: "employee_profile", action: "read" \}/,
    "the own-card route is registered for every employee",
  );
  const mineIdx = registry.indexOf('pattern: "/api/business-cards/mine"');
  const hrExportIdx = registry.indexOf('pattern: "/api/business-cards",');
  assert.ok(
    mineIdx > -1 && hrExportIdx > -1 && mineIdx < hrExportIdx,
    "/api/business-cards/mine must be registered before the HR /api/business-cards export",
  );
}
