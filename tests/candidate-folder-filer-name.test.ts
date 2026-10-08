import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapCandidate } from "../src/lib/recruitment/db.ts";
import {
  managerLabel,
  managerLabelOrNull,
  personLabel,
  UNNAMED_MANAGER_LABEL,
} from "../src/lib/recruitment/person-labels.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Seen live: /hr/recruitment → Folders tab → Medical Representative → "Behira 1", 2026-09-11.
 *
 * A filed CV row read "New | filed 03 Sept 2026, 10:33 by B-10" — a raw HR id printed straight onto
 * the shelf. The owner's standing rule (AGENTS.md §4) is human-readable names, never raw codes or
 * ids, in both UI and chat. On production this is nearly always the owner's own id, filing a CV
 * himself (323 of 323 filed rows, 2026-09-11), so this bug put "B-10" on his own screen for his own
 * action.
 *
 * WHY SOURCE-PINNED RATHER THAN RENDERED. This component has no React Testing Library harness in
 * this repo — recruitment-folder-cv-popup.test.ts pins the same file the same way, for the same
 * reason: the regression is a one-line rewire (swap `filedByName` back for `filedByHrId`) that
 * produces no failing render and no type error, only a code where a name belongs. A fixed window
 * false-fails the moment the file shifts, so the window is bounded by the function's own braces.
 */

function code(source: string): string {
  return stripComments(source);
}

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** A top-level `function <name>(` through its own closing brace at column 0. */
function topLevelFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist — this pin is meaningless without it`);
  const end = source.slice(start).search(/^\}$/m);
  return end >= 0 ? source.slice(start, start + end) : source.slice(start);
}

export async function runCandidateFolderFilerNameTests() {
  // ── 1 · The shelf row never prints the raw HR id ────────────────────────────
  //
  // Reverting this fix — swapping `by ${personLabel(candidate.folder.filedByName, …)}` back for
  // `by ${candidate.folder.filedByHrId}` — makes both assertions below fail: the raw id reappears
  // in the "by " clause, and the resolved-name/unnamed-wording call vanishes. Proven by literally
  // reverting the component and re-running this test; see the PR description for that run's output.
  {
    const folders = code(read("src/components/recruitment/candidate-folders-tab.tsx"));
    const filedCvName = topLevelFunction(folders, "FiledCvName");

    assert.ok(
      !/by \$\{candidate\.folder\.filedByHrId\}/.test(filedCvName),
      "the folder row must never interpolate the raw HR id after 'by ' — that is the bug seen live on Behira 1",
    );
    assert.match(
      filedCvName,
      /by \$\{personLabel\(candidate\.folder\.filedByName, UNNAMED_FILER_LABEL\)\}/,
      "the folder row must render the resolved filer NAME, falling back to words (never the id) when it could not be resolved",
    );
    assert.match(
      folders,
      /import \{ personLabel, UNNAMED_FILER_LABEL \} from "@\/lib\/recruitment\/person-labels";/,
      "the name/words fallback must come from the shared person-labels module, not a one-off inline check",
    );
  }

  // ── 2 · The DTO carries a name field, resolved server-side ──────────────────
  //
  // mapCandidate is synchronous — it cannot itself run the `employees` lookup — so it must leave
  // `filedByName` present and null rather than omitting it, which is what listCandidates' async
  // attachFolderFilerNames then fills. A caller reading `filedByName` off a row this function alone
  // produced must see null, never undefined and never the id.
  {
    const filed = mapCandidate({
      folder_filed_at: "2026-09-03T10:33:00.000Z",
      folder_filed_by_hr_id: "B-10",
      folder_key: "Behira 1",
      folder_kind: "medical_rep",
      full_name: "Some Candidate",
      id: "c-1",
    });
    assert.ok(filed.folder, "a row with a folder stamp must map to a filed candidate");
    assert.equal(filed.folder?.filedByHrId, "B-10", "the raw id is still carried — it is the lookup key, never the display");
    assert.equal(filed.folder?.filedByName, null, "mapCandidate alone cannot resolve a name — it must leave the field null, not omit it");

    const unfiled = mapCandidate({ full_name: "Nobody Filed", id: "c-2" });
    assert.equal(unfiled.folder, null, "a candidate with no folder stamp stays unfiled");
  }

  // ── 3 · person-labels.ts — the wording every recruitment screen now shares ──
  {
    assert.equal(personLabel("  Omar Gawish  ", "fallback"), "Omar Gawish", "a real name is trimmed and used as-is");
    assert.equal(personLabel("", "fallback"), "fallback", "an empty name falls back to the given wording");
    assert.equal(personLabel("   ", "fallback"), "fallback", "a whitespace-only name counts as unresolved, not as a name");
    assert.equal(personLabel(null, "fallback"), "fallback", "null falls back");
    assert.equal(personLabel(undefined, "fallback"), "fallback", "undefined falls back");

    assert.equal(managerLabel("Ahmed Samir"), "Ahmed Samir", "a resolved manager name passes through");
    assert.equal(managerLabel(null), UNNAMED_MANAGER_LABEL, "an unresolved manager reads as words, never as an id or a blank");

    assert.equal(
      managerLabelOrNull("Ahmed Samir", "B-10"),
      "Ahmed Samir",
      "a resolved name wins even when an id is also present",
    );
    assert.equal(
      managerLabelOrNull(null, "B-10"),
      UNNAMED_MANAGER_LABEL,
      "a seat that names somebody whose id resolved to no employee reads as 'Unnamed manager', never as the id",
    );
    assert.equal(
      managerLabelOrNull(null, null),
      null,
      "a seat that names NOBODY at all is a genuine gap, not an unnamed person — callers render their own dash",
    );
    assert.equal(managerLabelOrNull(null, ""), null, "a blank id is the same as no id — still a genuine gap");
  }

  // ── 4 · The mixed-case HR id trap — the lookup must not use a bare .eq ──────
  //
  // AGENTS.md §2.1: HR ids in this database are mixed case, and a plain .eq silently under-returns.
  // The case-blind lookup now lives in the shared `namesByHrId` — three modules had their own copy
  // and they had drifted — so what this suite owns is that the shelf resolves its filer THERE, by
  // the id it holds, and still asks for the distinct set rather than one key per CV in the pool.
  // The trap itself (and the chunking, and the nickname) is pinned on behaviour in
  // `tests/employees-names-by-hr-id.test.ts`.
  {
    const candidates = code(read("src/lib/recruitment/candidates.ts"));
    const attach = topLevelFunction(candidates, "attachFolderFilerNames");
    assert.match(attach, /await namesByHrId\(/, "the filer lookup must go through the shared namesByHrId, not a bare .eq");
    assert.match(attach, /new Set\(/, "the DISTINCT filers go to the database — 323 filed CVs carry one filer in production");
    assert.match(
      attach,
      /names\.get\(candidate\.folder\.filedByHrId\)/,
      "read by the stored id itself: the accessor canonicalises, so no call site is left writing " +
        '`get(canonicalHrIdKey(id) ?? "")`, which looks up the EMPTY key when there is no id',
    );
    assert.ok(!/\.eq\("hr_id"/.test(attach), "a bare .eq('hr_id', …) is exactly the pattern that under-returns on mixed case");
    assert.ok(
      !/\.in\("hr_id"/.test(attach),
      "and no second copy of the lookup — this module's own version is what the shared one replaced",
    );
  }
}
