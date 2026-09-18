import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// THE SCREENING VERDICTS ARE GATED ON THE GRANT THEIR ROUTES ASSERT — candidates:update.
//
// Until 2026-09-18 both screening pages computed `canDecide` from `recruitment: update`, while every
// verdict the screen offers — Shortlist, Reject, the stars, the bulk marks and Undo — lands on a
// /api/recruitment/candidates/** route that asserts `candidates: update`. The two grants are held by
// the same seats today, so nobody saw a wrong button; but `canAccess` also checks a per-account
// module lock PER RESOURCE, so a lock on `candidates` alone would have left the verdict buttons on
// screen and every press answering 403. The same fix found two riders:
//
//   · the WhatsApp reply box rode on `canDecide`, though its route asserts `recruitment: update` —
//     it now has its own `canReply`;
//   · the header drew Shortlist and Reject whatever `canDecide` said (only the hotkeys and the stars
//     honoured it) — both buttons and the reject panel now sit behind it.
//
// Source pins rather than a render: these are client components on a service-role data path, and
// what regresses is a gate re-spelled in one of five files, not behaviour a render would show.

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

const SCREENING_PAGES = [
  "app/(admin)/recruitment/screening/page.tsx",
  "app/employee-portals/recruitment/screening/page.tsx",
];

export function runScreeningDecideGateTests(): void {
  // ── 1. HEADLINE: both screening pages spell the verdict gate the way its routes do ──
  for (const path of SCREENING_PAGES) {
    const page = read(path);
    assert.match(
      page,
      /const canDecide = await canAccess\(access, "candidates", "update"\);/,
      `${path}: canDecide must be candidates:update — the grant the status, bulk-status, revert-status and rating routes assert`,
    );
    assert.match(page, /canDecide=\{canDecide\}/, `${path}: the verdict gate is handed to the screen as computed`);
    assert.doesNotMatch(
      page,
      /canDecide=\{canUpdate\}/,
      `${path}: canDecide must never ride on recruitment:update again`,
    );
    // The reply box keeps recruitment:update — its own route's grant, not the verdicts'.
    assert.match(page, /const canUpdate = await canAccess\(access, "recruitment", "update"\);/, `${path}: canUpdate stays recruitment:update`);
    assert.match(page, /canReply=\{canUpdate\}/, `${path}: the WhatsApp reply box follows recruitment:update, the grant its route asserts`);
    assert.match(page, /canWriteNotes=\{canUpdate\}/, `${path}: the note box keeps recruitment:update`);
  }

  // ── 2. The routes the gates promise ──
  const verdictRoutes = [
    "app/api/recruitment/candidates/[id]/status/route.ts",
    "app/api/recruitment/candidates/bulk-status/route.ts",
    "app/api/recruitment/candidates/revert-status/route.ts",
    "app/api/recruitment/candidates/[id]/rating/route.ts",
  ];
  for (const path of verdictRoutes) {
    assert.match(
      read(path),
      /requireRecruitmentAccess\(request, "candidates", "update"\)/,
      `${path}: a verdict route asserts candidates:update — if this moves, the screening canDecide must move with it`,
    );
  }
  const replyRoute = read("app/api/recruitment/candidates/[id]/whatsapp-reply/route.ts");
  assert.equal(
    replyRoute.match(/requireRecruitmentAccess\(request, "recruitment", "update"\)/g)?.length ?? 0,
    2,
    "the WhatsApp reply route asserts recruitment:update on both GET and POST — the grant canReply follows",
  );

  // ── 3. The props travel through the client without being swapped ──
  const pageClient = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  assert.match(pageClient, /canDecide=\{canDecide\}/, "the page client passes the verdict gate through");
  assert.match(pageClient, /canReply=\{canReply\}/, "the page client passes the reply gate through, as its own prop");

  const workstation = read("src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(workstation, /canDecide=\{canDecide\}/, "the workstation hands the header the verdict gate");
  assert.match(workstation, /canReply=\{canReply\}/, "the workstation hands the header the reply gate");
  assert.doesNotMatch(workstation, /canReply=\{canDecide\}/, "the reply box must never ride on the verdict gate again");
  assert.match(workstation, /canRate=\{canDecide\}/, "the stars land on the rating route, which asserts candidates:update");

  // ── 4. The header draws Shortlist, Reject and the reject panel only behind canDecide ──
  const header = read("src/components/recruitment/workstation/workstation-review-header.tsx");
  const gateAt = header.indexOf("{canDecide ? (");
  assert.notEqual(gateAt, -1, "the header must gate its verdict buttons on canDecide");
  const gateEnd = header.indexOf(") : null}", gateAt);
  assert.notEqual(gateEnd, -1, "the canDecide block must close");
  const gated = header.slice(gateAt, gateEnd);
  for (const label of ['label="Shortlist"', 'label="Reject"']) {
    assert.ok(gated.includes(label), `${label} must sit inside the canDecide block — the header drew it for everyone before 2026-09-18`);
    assert.equal(header.split(label).length - 1, 1, `${label} must be drawn in exactly one place, the gated one`);
  }
  assert.match(header, /\{rejecting && canDecide \? \(\s*<RejectPanel/, "the reject panel is gated too, not only the button that opens it");
}
