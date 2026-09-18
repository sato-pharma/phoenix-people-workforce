import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createAccessContext,
  permissionMatrix,
  phoenixRoles,
  systemAccessContext,
} from "../src/lib/auth/permissions.ts";
import { canManageWhatsAppTemplates, canSendWhatsAppTemplate } from "../src/lib/recruitment/access.ts";

// WHO MAY REWRITE THE WHATSAPP TEMPLATES — the owner, as a real session carries him.
//
// Until 2026-09-18 canManageWhatsAppTemplates was `access.scope === "system"` and nothing else. But
// scopeForRole gives a signed-in Super Admin scope "company" — the same scope as the CEO, the Finance
// Manager and HR Operations — and "system" is only ever the synthetic systemAccessContext. So the
// template editor was hidden from the owner, the one person the write routes (POST, PATCH and
// DELETE, all asserting admin:update) would have let save, and it was shown to nobody at all. The
// same defect was caught in isInterviewCalendarOwner the same day (#4071).
//
// Every context here is built by createAccessContext, the way resolveAccessContext builds a real
// session. A hand-written `{ role: "Super Admin", scope: "system" }` literal is exactly the fixture
// that let the scope-only test look correct.

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

export function runWhatsAppTemplateManageGateTests(): void {
  // ── 1. HEADLINE: the signed-in owner sees the template editor ──
  const owner = createAccessContext({ hrId: "B-10", role: "Super Admin" });
  assert.equal(owner.scope, "company", "a signed-in Super Admin carries scope company, not system — the premise of this test");
  assert.equal(
    canManageWhatsAppTemplates(owner),
    true,
    "the signed-in Super Admin (B-10, scope company) must be handed the template editor — the write routes already let him save",
  );
  assert.equal(canManageWhatsAppTemplates(systemAccessContext), true, "a system job may still manage the templates");

  // ── 2. Nobody else is widened — the seats that share his scope, and the HR Business Partner ──
  for (const role of ["HR Advisory", "HR Operations", "CEO", "Finance Manager"]) {
    const other = createAccessContext({ hrId: "A-99", role });
    assert.equal(
      canManageWhatsAppTemplates(other),
      false,
      `${role} (scope ${other.scope}) must not rewrite what every recruiter sends in the company's name`,
    );
  }
  // HR Advisory keeps the split the HR shell row promises: she sends, she does not edit.
  const advisory = createAccessContext({ hrId: "A-99", role: "HR Advisory" });
  assert.equal(canSendWhatsAppTemplate(advisory), true, "HR Advisory still sends a template");
  assert.equal(canManageWhatsAppTemplates(advisory), false, "HR Advisory still cannot edit one");

  // ── 3. The screen and the API admit the same people, role by role ──
  // The write routes assert admin:update. If the editor's gate and that grant ever disagree, somebody
  // is either shown a Save that 403s or refused a Save the server would take — the exact shape of
  // the defect above.
  for (const role of phoenixRoles) {
    const context = createAccessContext({ hrId: "A-99", role });
    const apiAdmits = (permissionMatrix[context.role]?.admin ?? []).includes("update");
    assert.equal(
      canManageWhatsAppTemplates(context),
      apiAdmits,
      `${role}: the template editor is ${canManageWhatsAppTemplates(context) ? "shown" : "hidden"} but admin:update is ${apiAdmits ? "held" : "not held"}`,
    );
  }

  // ── 4. The page hands the editor this gate, and the write routes assert admin:update ──
  const page = read("app/(admin)/recruitment/whatsapp-templates/page.tsx");
  assert.match(page, /canManage=\{canManageWhatsAppTemplates\(access\)\}/, "the page must hand the manager this gate");
  const create = read("app/api/recruitment/whatsapp-templates/route.ts");
  assert.match(create, /requireRecruitmentAccess\(request, "admin", "update"\)/, "POST (create) asserts admin:update");
  const edit = read("app/api/recruitment/whatsapp-templates/[id]/route.ts");
  assert.equal(
    (edit.match(/requireRecruitmentAccess\(request, "admin", "update"\)/g) ?? []).length,
    2,
    "PATCH and DELETE both assert admin:update",
  );
}
