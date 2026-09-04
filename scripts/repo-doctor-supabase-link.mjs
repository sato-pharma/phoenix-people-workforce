// Which Supabase project the LOCAL Supabase CLI is linked to, and whether that is a project this
// repository has any business writing to.
//
// WHY THIS EXISTS. On 2026-09-04 an audit of this checkout found `supabase/.temp/project-ref`
// holding `plleofqyfbknvwcotzqo` — "Future Talents Hub", a live project in the same organization
// that has nothing to do with this app. It had been linked that way since 2026-08-16, nineteen
// days. AGENTS.md 8 pre-authorizes the `supabase` CLI end to end, `db push` included, with no
// approval prompt, so a bare `supabase db push` typed in this folder would have applied this
// repository's migrations to somebody else's database.
//
// Nothing could have caught it. `supabase/.temp/` is gitignored, so CI never sees it; the repo's
// own strong guard in apply-migrations-to-staging.ts refuses that exact ref by name, but that
// guard only protects one script and the CLI path does not go through it. The link is local
// state, so a local hygiene report is the only place this check can live.
//
// The classifier is a pure function over already-read strings so a test can drive every branch
// without a Supabase CLI, a network, or a linked project.

/** AGENTS.md 3. Pinned by tests/supabase-project-refs.test.ts against that table. */
export const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
export const STAGING_REF = "cifwmndunmlxjhyjugxa";

/**
 * Projects the account can see that this repository must never target. Named individually rather
 * than lumped into "not staging" so the report can say WHICH project and WHOSE — an operator who
 * reads "Future Talents Hub" understands instantly; one who reads "unrecognised ref" goes looking
 * for a typo. AGENTS.md 3 lists all four.
 */
export const FOREIGN_REFS = new Map([
  ["plleofqyfbknvwcotzqo", "Future Talents Hub (unrelated to this app)"],
  ["mlbpzvaanusdejqnimst", "the owner's personal project (a DIFFERENT organization)"],
]);

/**
 * Refs that no longer resolve to anything. Kept so a link left over from one of them reads as
 * "retired", not as "unknown" — a dead ref cannot be written to, so it is a lesser problem than a
 * live foreign one and must not be reported at the same volume.
 */
export const RETIRED_REFS = new Map([
  ["izhmxvgiktiafqusolot", "the pre-2026-07-11 free-tier staging project"],
  ["oaifhavixhdtwmseshff", "the retired sandbox"],
]);

/**
 * @param {{ projectRef: string | null, linkedName: string | null }} input
 *   `projectRef` is the trimmed contents of supabase/.temp/project-ref, or null when the file is
 *   absent OR could not be read. Those two collapse deliberately: both mean "no link is in
 *   effect", which is the safe state, and a CLI that cannot read its own link file cannot push.
 * @returns {{ severity: "ok" | "note" | "warn" | "alarm", state: string, lines: string[] }}
 */
export function classifySupabaseLink({ projectRef, linkedName }) {
  const ref = typeof projectRef === "string" ? projectRef.trim() : "";
  const name = typeof linkedName === "string" && linkedName.trim() !== "" ? linkedName.trim() : null;
  const named = name === null ? "" : ` ("${name}")`;

  if (ref === "") {
    return {
      severity: "ok",
      state: "unlinked",
      lines: [
        "  the Supabase CLI is NOT linked in this checkout — this is the correct resting state.",
        "  -> nothing in this repo's sanctioned workflow needs the link: staging migrations go",
        "     through scripts/apply-migrations-to-staging.ts, and a production migration needs the",
        "     owner's approval one at a time (AGENTS.md 6).",
      ],
    };
  }

  if (ref === STAGING_REF) {
    return {
      severity: "ok",
      state: "staging",
      lines: [`  linked to STAGING ${ref}${named} — safe.`],
    };
  }

  if (ref === PRODUCTION_REF) {
    return {
      severity: "warn",
      state: "production",
      lines: [
        `  linked to PRODUCTION ${ref}${named}.`,
        "  -> a bare `supabase db push` here writes to the database real payroll runs on, and",
        "     AGENTS.md 8 gives the CLI no approval prompt to stop it. Unlink unless you are",
        "     mid-way through an approved production migration:",
        "       rm -rf supabase/.temp",
      ],
    };
  }

  const foreign = FOREIGN_REFS.get(ref);
  if (foreign !== undefined) {
    return {
      severity: "alarm",
      state: "foreign",
      lines: [
        `  linked to ${ref}${named} — ${foreign}.`,
        "  -> THIS IS NOT A PHOENIX PROJECT. A `supabase db push` from this folder would apply",
        "     this repository's migrations to it. Unlink now:",
        "       rm -rf supabase/.temp",
      ],
    };
  }

  const retired = RETIRED_REFS.get(ref);
  if (retired !== undefined) {
    return {
      severity: "note",
      state: "retired",
      lines: [
        `  linked to ${ref}${named} — ${retired}, which no longer exists.`,
        "  -> harmless (a dead ref cannot be written to) but every CLI command will fail with a",
        "     connection error rather than an explanation. Clear it: rm -rf supabase/.temp",
      ],
    };
  }

  return {
    severity: "alarm",
    state: "unknown",
    lines: [
      `  linked to ${ref}${named}, which is not a ref this repository knows.`,
      "  -> resolve it with `list_projects` before running ANY Supabase command here (AGENTS.md 8).",
      "     If it is not Phoenix production or staging, unlink: rm -rf supabase/.temp",
    ],
  };
}
