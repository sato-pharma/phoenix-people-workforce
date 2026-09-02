import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The folder row opens the CV, in place.
//
// The owner, 2026-09-02: *"in the recruitments folders i want to when i press on the name of someone
// in the folder his cv pops up without redirecting me to any other page open as a pop up and have a
// download button"*.
//
// Before that, pressing the name in an opened folder called `onOpenCandidate`, which sets
// `?candidate=<id>`, switches the workspace to the Candidates tab and draws the profile panel under
// a 555-row table. Three interactions to read one CV, and the shelf the reader had opened was gone.
//
// WHY THIS IS PINNED IN SOURCE RATHER THAN BEHAVIOUR. The regression is a one-line rewire — a later
// session "tidying" the row back onto the shared `onOpenCandidate` handler restores the redirect
// with no error, no failing render and no visible difference until somebody presses a name. There is
// no unit-testable seam: the whole change is which component the click mounts. So the four things
// that cannot silently drift are checked against the files themselves, each bounded by a real
// syntactic edge rather than a byte offset — a fixed window false-fails the moment the file shifts.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** A top-level `function <name>(` through its own closing brace at column 0. */
function topLevelFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist — this pin is meaningless without it`);
  const end = source.slice(start).search(/^\}$/m);
  return end >= 0 ? source.slice(start, start + end) : source.slice(start);
}

export function runRecruitmentFolderCvPopupTests() {
  const folders = code(read("src/components/recruitment/candidate-folders-tab.tsx"));

  // ── 1. The name mounts the CV modal, and does NOT redirect ──────────────────
  {
    const filedCvName = topLevelFunction(folders, "FiledCvName");

    assert.match(
      filedCvName,
      /<CvPreviewModal/,
      "the name control must open the house CV modal in place — that is the whole request",
    );
    assert.ok(
      !/onOpenCandidate/.test(filedCvName),
      "the name must not reach onOpenCandidate — that handler sets ?candidate= and is the redirect the owner asked us to remove",
    );

    // The modal is what makes it a popup rather than a panel: it must be the one the rest of
    // recruitment already uses, not a second viewer that drifts from it.
    assert.match(
      folders,
      /import \{ CvPreviewModal \} from "@\/components\/recruitment\/cv-preview-modal";/,
      "reuse the shared CvPreviewModal — a second CV viewer is how the two paths diverge",
    );
  }

  // ── 2. The download button is real, not a prop nobody renders ───────────────
  {
    const filedCvName = topLevelFunction(folders, "FiledCvName");
    assert.match(
      filedCvName,
      /downloadUrl=\{`\/api\/recruitment\/files\/\$\{file\.id\}\/download`\}/,
      "the modal must be handed the file's download route — the owner asked for a download button",
    );

    // And the modal must still turn that prop into a control. Passing downloadUrl to a header that
    // stopped rendering the anchor would satisfy the line above while shipping no button at all.
    const modal = code(read("src/components/recruitment/cv-preview-modal.tsx"));
    const header = topLevelFunction(modal, "CvPreviewModal");
    assert.match(header, /href=\{downloadUrl\}/, "CvPreviewModal's header must render downloadUrl as a real link");
    assert.match(header, /Download/, "that link must still be labelled Download");
  }

  // ── 3. Profile survives as the way to the OTHER CVs ─────────────────────────
  //
  // 105 of 632 candidates carry more than one CV and one carries 11. The popup shows the newest, so
  // the row must keep a route to the full file list, the status control and the history. Deleting
  // this button is the tempting "simplification" that would quietly make those files unreachable
  // from the shelf.
  {
    const row = topLevelFunction(folders, "CandidateFoldersTab");
    assert.match(
      row,
      /onClick=\{\(\) => onOpenCandidate\(candidate\.id\)\}/,
      "the row must keep a Profile control — it is the only route from the shelf to a candidate's other CVs",
    );
  }

  // ── 4. Newest CV wins — a cross-file coupling with no local symptom ─────────
  //
  // The component takes `files.find(entry => entry.kind === "cv")`, so WHICH CV it shows is decided
  // entirely by the order the service returns. Flip that query to ascending and the folder popup
  // starts serving the oldest CV on file: no error, no warning, and nothing on this screen to read
  // as wrong. The two halves are pinned together because they cannot be read together.
  {
    const filedCvName = topLevelFunction(folders, "FiledCvName");
    assert.match(
      filedCvName,
      /files\.find\(\(entry\) => entry\.kind === "cv"\)/,
      "the popup picks the first cv-kind file, which is only correct while the service sorts newest first",
    );

    const service = code(read("src/lib/recruitment/files.ts"));
    const listing = topLevelFunction(service, "listCandidateFiles");
    assert.match(
      listing,
      /\.order\("created_at", \{ ascending: false \}\)/,
      "listCandidateFiles must stay newest-first — the folder popup's choice of CV depends on it silently",
    );
  }
}
