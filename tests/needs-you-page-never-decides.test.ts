import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccessSystemAdministratorWorkspace,
  permissionMatrix,
  type AccessScope,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { stripCommentsCompact } from "./support/comment-strip.ts";
import { hasEntryExit, isShellGated } from "./support/page-gate-reader.ts";

/**
 * 🔴 THE NEEDS YOU BOARD LINKS, AND IT NEVER ACTS.
 *
 * Every row's only control is a `<Link>` to the screen that already owns the decision. There is no
 * form, no button, no server action and no non-GET fetch anywhere under this route.
 *
 * WHY A TEST AND NOT A COMMENT. The change this catches is the obvious, well-meant improvement:
 * someone reads "12 leave requests awaiting your approval", notices the extra click, and adds an
 * Approve button. The moment that lands, this stops being the ONE screen that tells you where to go
 * and becomes the fourteenth screen that can approve something — with its own copy of an approval
 * rule, on a page whose sources are badges and counts rather than the rows a decision needs. Worse,
 * it would put a write behind a page whose entire remaining job is to be trusted about what it can
 * see: a board that can act is a board with a second reason to be wrong.
 *
 * It is a SOURCE SCAN, deliberately, and this is the one place in the module where that is the right
 * instrument. The property being checked is the ABSENCE of a capability, and absence is exactly what
 * a rendered page cannot demonstrate — a screenshot of a page with no Approve button looks identical
 * to a page whose Approve button happens to be disabled today. Comments are stripped first, because
 * the header above (and the component's own) explain in prose why there is no `<form` here, and a
 * plain substring search would read that explanation as the defect it warns against.
 */

const FILES = [
  "app/(admin)/admin/needs-you/page.tsx",
  "src/components/admin/needs-you-board.tsx",
  "src/lib/needs-you/render/sections.ts",
] as const;

/**
 * Comments out, then string and template literals blanked. What is left is code.
 *
 * 🔴 THE COMMENTS GO THROUGH `stripCommentsCompact`, NEVER A HAND-ROLLED REGEX. A bare
 * `source.replace(/\/\*[\s\S]*?\*\//g, "")` cannot tell a comment from a string literal: given a
 * route pattern like `"/api/auth/*"` it reads the `*` as a comment opener and deletes everything to
 * the next close delimiter, usually hundreds of lines away. Measured across this repo it eats real
 * code from 39 files — 53% of `system-navigation.ts` among them — and a test that strips one of
 * those and then asserts an ABSENCE is checking a third of a file and reporting a pin. Nothing goes
 * red; the guard is simply decorative. `tests/comment-strip-ratchet.test.ts` exists to catch exactly
 * that, and this file is not going to be the next entry in it.
 *
 * COMPACT rather than plain `stripComments` because the gate checks below slice a fixed-SIZE window
 * (`pageCode.slice(at, at + 160)`). The offset-preserving strip blanks a comment in place and KEEPS
 * its bytes, so the long explanation sitting above this page's guards would push the `redirect(`
 * straight out of that window and turn the test red on correct code — the documented failure that
 * `stripCommentsCompact` was added for.
 *
 * The literals are blanked afterwards because the page PRINTS sentences about what it does not do —
 * "Finance books the month; nothing here changes one." — and a search for `method` or `form` across
 * ordinary English hits it. Those three regexes run over code that is already comment-free, which is
 * what makes them safe; they are not a general-purpose tokenizer.
 *
 * `[\s\S]` and never the `s` (dotAll) flag: this repository targets ES2017, where TypeScript rejects
 * it outright as TS1501, and a local typecheck is denied here (bash-guard C8) so it would only ever
 * surface as a red `checks` job.
 */
function codeOnly(source: string): string {
  return stripCommentsCompact(source)
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "``")
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""')
    .replace(/'(?:[^'\\]|\\[\s\S])*'/g, "''");
}

/**
 * Each entry is the exact shape of a decision reaching this page, and the sentence says which one.
 * A new spelling of any of them belongs here rather than being argued about in a review.
 */
const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  {
    pattern: /use server/,
    what: "a server action. That is a write endpoint minted inside the one module whose job is to report.",
  },
  { pattern: /<form/i, what: "a form. A form exists to submit; this page has nothing to submit." },
  {
    pattern: /\bmethod\s*[:=]/,
    what: "an HTTP method being chosen, which only a non-GET request needs.",
  },
  {
    pattern: /onClick/,
    what: "a click handler. Every affordance here is a link the browser follows; a handler is a decision.",
  },
  { pattern: /useFormState|useFormStatus|useActionState/, what: "a form-state hook, i.e. a submitted form." },
  { pattern: /\brevalidatePath\b|\brevalidateTag\b/, what: "a cache invalidation, which only a write needs." },
  {
    pattern: /\baction\s*=\s*\{/,
    what: "an `action` prop, which is how a server action is wired to an element.",
  },
];

export function runNeedsYouPageNeverDecidesTests() {
  for (const file of FILES) {
    const code = codeOnly(readFileSync(file, "utf8"));

    for (const rule of FORBIDDEN) {
      assert.ok(
        !rule.pattern.test(code),
        `${file} contains ${rule.pattern} — ${rule.what}\n\n` +
          `The Needs You board LINKS, it never acts. Put the control on the screen that already owns ` +
          `the decision, and let this board point at it.`,
      );
    }

    // A `fetch` at all is suspicious here: the page is `force-dynamic` and reads its services
    // directly, so nothing under this route has a reason to make an HTTP call — least of all back
    // into its own app, whose badge route degrades to `{count: 0}`, the one shape this page must
    // never have.
    assert.ok(
      !/\bfetch\s*\(/.test(code),
      `${file} calls fetch(). Every source is read through its own domain service in ` +
        `src/lib/needs-you/sources.ts. An HTTP hop from a server component back into this app needs ` +
        `the session cookie, doubles the latency, and inherits the called route's fallback — which for ` +
        `/api/approvals/badge-counts is a deliberate {count: 0} that would render a dead queue as a ` +
        `clean one.`,
    );
  }

  // The route really is dynamic. A statically rendered board would be a cached answer to "is anything
  // waiting on you" — stale in the direction that says no.
  const page = readFileSync(FILES[0], "utf8");
  assert.ok(
    /export const dynamic = "force-dynamic"/.test(page),
    `${FILES[0]} must export dynamic = "force-dynamic". A cached render of this page answers ` +
      `"is anything waiting on you" from whenever it was built.`,
  );

  // And the gate is server-side, before anything is read. Hiding the nav row is UX only.
  //
  // 🔴 EACH PREDICATE IS PAIRED WITH ITS OWN REDIRECT, not merely present somewhere in the file.
  // Proving this guard by breaking it is what showed why: deleting the Super Admin check entirely
  // left the test green, because the page still mentioned the function (in the dead statement the
  // break left behind) and still contained a `redirect(` — the employee-portal one, two lines up.
  // Two independent facts ANDed together are not the same as one fact, and the version that ANDed
  // them would have certified a page anyone in the admin shell could open.
  const pageCode = codeOnly(page);
  // Each anchor is the CALL SITE's own spelling, never the bare function name — the bare name also
  // appears in the import block at the top of the file, and anchoring there put the 160-character
  // window over the rest of the import list instead of over the guard. That version failed on
  // correct code, which is the other way an assertion can be useless.
  const pairedRedirect = (callSite: string, why: string) => {
    const at = pageCode.indexOf(callSite);
    assert.ok(at !== -1, `${FILES[0]}: no "${callSite}" check at all. ${why}`);
    assert.ok(
      /redirect\s*\(/.test(pageCode.slice(at, at + 160)),
      `${FILES[0]}: "${callSite}" is checked but nothing redirects on it. ${why}`,
    );
  };
  pairedRedirect(
    "!canAccessSystemAdministratorWorkspace(access)",
    "Server-side access control is the security boundary; system-navigation.ts hiding the link is UX only, " +
      "and this board composes sixteen approval queues that belong to one person.",
  );
  pairedRedirect(
    "resolveNavigationMode(access) ===",
    "An employee-portal viewer belongs in their own shell, the same way /admin/ceo-command-center sends them.",
  );

  // ── The gate, read by the REPOSITORY'S OWN reader rather than by a pattern of this file's own ──
  //
  // `tests/support/page-gate-reader.ts` exists because two tests had each written their own parser
  // and they disagreed on 72 pages — and an under-reading parser FAILS OPEN, reporting a gated page
  // as ungated. Driving it here means this file cannot become a third copy that quietly disagrees.
  assert.ok(hasEntryExit(page), `${FILES[0]}: the shared gate reader sees no redirect/notFound exit at all.`);
  assert.ok(isShellGated(page), `${FILES[0]}: the shared gate reader sees no employee-portal shell gate.`);

  // ── ...and the gate itself, driven over EVERY role in the matrix ───────────────────────────────
  //
  // This is the role sweep, run against the real predicate rather than inferred from the nav row.
  // `system-navigation.ts` naming `roles: ["Super Admin"]` is UX only; what actually keeps the other
  // sixteen roles off this board is this function returning false for them, and that is what is
  // asserted here. A widened gate — a role added to `systemAdministratorRoles`, or the page's check
  // swapped for a looser one — turns this red instead of silently handing sixteen roles a board of
  // approval queues they cannot act on.
  // EVERY non-system scope, not one sample. `canAccessSystemAdministratorWorkspace` is
  // `scope === "system" || role === "Super Admin"`, so a sweep that fixed the scope would pass even
  // if the role half were deleted and the scope half widened — the two have to be separated.
  const roles = Object.keys(permissionMatrix) as PhoenixRole[];
  const nonSystemScopes: AccessScope[] = ["self", "team", "hierarchy", "line", "company", "none"];
  const admitted = [
    ...new Set(
      nonSystemScopes.flatMap((scope) =>
        roles.filter((role) => canAccessSystemAdministratorWorkspace({ role, scope })),
      ),
    ),
  ];
  assert.deepEqual(
    admitted,
    ["Super Admin"],
    `The Needs You gate admits ${JSON.stringify(admitted)} at a non-system scope. It must admit the ` +
      `Super Admin and nobody else — this board composes sixteen approval queues, and every row on ` +
      `it names a decision that is the owner's alone.`,
  );
  assert.ok(
    roles.length > 10,
    `Only ${roles.length} roles were swept. The sweep above is an ABSENCE check, so a short matrix ` +
      `makes it pass for the wrong reason.`,
  );
  // The `scope === "system"` half of the same predicate — the service account's route in.
  assert.ok(
    canAccessSystemAdministratorWorkspace({ role: "Medical Rep", scope: "system" }),
    "A system-scope caller must still reach the board, as it does on every other system-administrator page.",
  );
}
