import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * THE DISTRIBUTION LISTS BELONG TO THE SATO EMAIL COMPOSER AND TO NOTHING ELSE.
 *
 * Owner 2026-09-11, in his own words: "I don't want this distribution list to be linked with
 * anything except the email composer that you will build."
 *
 * 🔴 WHY THIS NEEDS A TEST AT ALL, WHEN THE LISTS ARE ALREADY UNHOOKED. Re-linking one is a
 * one-line import that reads like an improvement every time. The Monthly Closing Cc was exactly
 * that: a list nobody had to maintain by hand, wired into the closing publish because it was
 * there. Unhooking it changed nothing about who receives that email — the same three roles are
 * named in code — but it means a later edit to a list can never silently change who a closing
 * reaches. Nothing in the type system says so, so the boundary is a pinned allowlist or it is
 * nothing.
 *
 * The list is expected to grow only with the composer's own files. A new path here is a decision:
 * is this screen the composer, or is it a second sender the owner did not ask for?
 */
const FILES_RESOLVING_A_DISTRIBUTION_LIST = [
  // The lists' own admin screen and its two routes — editing a list, and showing who it resolves to
  // so the person editing it can see the effect before saving.
  "app/(admin)/admin/distribution-lists/page.tsx",
  "app/api/admin/distribution-lists/[listKey]/route.ts",
  "app/api/admin/distribution-lists/route.ts",
  // The resolver itself, and the pure matcher underneath it.
  "src/lib/distribution-lists/service.ts",
  "src/lib/distribution-lists/spec.ts",
  // The composer. Its API routes are deliberately NOT here: they call previewSatoEmail /
  // sendSatoEmail, so there is exactly one place in the codebase where a picked list becomes an
  // audience, and one place to read to know what a send reaches.
  "src/lib/sato-email/service.ts",
];

/** The functions that turn a list into a set of real email addresses. */
const RESOLVER_NAMES = [
  "resolveDistributionListByKey",
  "resolveAllDistributionLists",
  "loadDistributionCandidates",
  "resolveDistributionList(",
];

function walkSources(): Array<{ relative: string; source: string }> {
  const out: Array<{ relative: string; source: string }> = [];
  const skip = new Set(["node_modules", ".next", ".git", ".claude", "__snapshots__"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("_wt-") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push({
          relative: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
          source: readFileSync(full, "utf8"),
        });
      }
    }
  };
  for (const root of ["app", "src"]) walk(path.join(REPO_ROOT, root));
  return out;
}

export function runSatoEmailListsOnlyComposerTests() {
  const sources = walkSources();
  // A POSITIVE CONTROL. Without it a walk that reached nothing — a renamed folder, a skip rule that
  // grew — would report an empty resolver list, and an empty list reads exactly like a clean one.
  assert.ok(sources.length > 2000, `the walk must reach the codebase; it found only ${sources.length} files`);

  // --- 1. Nobody but the composer resolves a list ------------------------------------------------
  const resolvers = sources
    .filter(({ source }) => RESOLVER_NAMES.some((name) => source.includes(name)))
    .map(({ relative }) => relative)
    .sort();

  assert.deepEqual(
    resolvers,
    [...FILES_RESOLVING_A_DISTRIBUTION_LIST].sort(),
    "a file turns a distribution list into email addresses. The owner scoped these lists to the " +
      "Sato Email Composer alone — confirm this file IS the composer before adding it to " +
      "FILES_RESOLVING_A_DISTRIBUTION_LIST",
  );

  // --- 2. The Monthly Closing Cc is roles in code, not a list ------------------------------------
  // The same three people still receive the closing. What changed is that a list edit can no longer
  // move them: the roles are written here, where changing them is a code review.
  const closing = readFileSync(path.join(REPO_ROOT, "src/lib/sales/closing-publish-recipients.ts"), "utf8");
  assert.ok(
    /FIXED_CC_ROLES[^=]*=\s*\[\s*"CEO",\s*"Marketing Manager",\s*"SFE Manager"\s*\]/.test(closing),
    "the closing Cc must name its three roles in code",
  );
  assert.ok(
    !closing.includes("distribution-lists"),
    "the monthly closing must not read a distribution list — a list edit would silently change who a " +
      "published closing reaches, and a sent closing cannot be recalled",
  );

  // --- 3. The older HR reply composer is untouched -----------------------------------------------
  // It has its own HR and Finance groups and the owner left it alone: "the other one, leave it now."
  const oldComposer = readFileSync(path.join(REPO_ROOT, "src/lib/email/email-composer-service.ts"), "utf8");
  assert.ok(
    !oldComposer.includes("distribution-lists"),
    "the older HR reply composer must not read a distribution list — the owner asked for a NEW composer, " +
      "not for the lists to reach into the old one",
  );

  // --- 4. A composer send is a manual email, and is NEVER waved past a guard ---------------------
  // 🔴 THE ASSERTION THIS FILE EXISTS FOR. The owner ruled that the Notification Confidence Gate's
  // fan-out hold is for automated mail: "i meant in automated emails must be a guard but in composer
  // its manual email by human". The correct expression of that is to omit `origin`, which makes the
  // fan-out check not-applicable for this send while the gate itself still runs and still records it.
  //
  // The WRONG expression — and the one a later session reaches for, because it reads as the same
  // sentence — is `bypassConfidenceGate: true`, which skips the gate outright. That flag is set by
  // exactly one file in this codebase (confidence-gate.ts, when a Super Admin approves a held item)
  // and setting it from domain code silently retires suppression checks for every composer send.
  const satoService = readFileSync(path.join(REPO_ROOT, "src/lib/sato-email/service.ts"), "utf8");
  const satoSendCall = satoService.slice(satoService.indexOf("await sendPhoenixEmail({"));
  assert.ok(satoSendCall.startsWith("await sendPhoenixEmail({"), "the composer must send through sendPhoenixEmail");
  const satoSendArgs = satoSendCall.slice(0, satoSendCall.indexOf("});") + 3);

  assert.ok(
    !/\bbypassConfidenceGate\b/.test(satoSendArgs),
    "a composer send must NEVER set bypassConfidenceGate — that flag skips the Notification Confidence " +
      "Gate entirely and belongs to confidence-gate.ts alone. The owner's ruling was about the FAN-OUT " +
      "hold, not about the gate",
  );
  assert.ok(
    !/\borigin\s*:/.test(satoSendArgs),
    "a composer send must pass no origin — with one, the fan-out anomaly check holds a hand-written " +
      "email to a large list, which is the automated-mail guard the owner explicitly excluded here",
  );
  assert.ok(
    /fanoutToBcc:\s*true/.test(satoSendArgs),
    "recipients stay hidden from each other — the owner chose Bcc-style fan-out",
  );
}
