import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Recurrence guard for the "raw NUL byte written into a source file" class.
//
// WHAT HAPPENED. Three files shipped to production carrying a literal 0x00 inside a template
// literal where the author meant a separator — `${areaCode}\0${productCode}`. The intended source
// was either a space or the escape `\u0000`; a tool that interprets escapes when writing the file
// (a Python heredoc, a shell here-doc, a codegen step) turned the two-character escape into the
// one byte it denotes.
//
// WHY IT SURVIVED. Runtime behaviour is IDENTICAL — a NUL is a perfectly legal string character, so
// every one of these maps kept working, and nothing downstream could notice. It compiles, it lints,
// it typechecks, it builds, it deploys. What it breaks is READING the code: git/grep classify a
// file containing 0x00 as BINARY and silently skip it, so `git grep` over such a file reports zero
// hits — indistinguishable from "the pattern is not there". Every repo-wide sweep run while those
// three files were corrupt was quietly incomplete, and the count it printed looked authoritative.
//
// So this is not a style rule. It is the only check in the repository that can see the defect at
// all: lint, typecheck and the build are all blind to it by construction, and the tool a human
// would reach for to investigate is the exact tool the defect disables.
//
// SCOPE. Tracked TEXT files only. Real binary assets (png/jpg/xlsx/woff2/…) contain NUL legitimately
// and are excluded by extension. Enumeration goes through `git ls-files` rather than a directory
// walk on purpose: this checkout carries ~1.9M gitignored path entries under worktrees and
// node_modules (AGENTS.md §5), and a naive walk takes over a minute.
export function runNoNulBytesInSourceTests() {
  const TEXT_EXTENSIONS = new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "sql", "json", "jsonc",
    "md", "mdx", "css", "scss", "html", "yml", "yaml", "sh", "txt", "env",
  ]);

  // -z: NUL-separated output, so a filename can never be mis-split. Read as a Buffer, never a
  // string, so the separator survives.
  const listed = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  const files = listed
    .toString("utf8")
    .split("\u0000")
    .filter((f) => f.length > 0);

  assert.ok(
    files.length > 500,
    `git ls-files returned only ${files.length} paths — the sweep did not actually run, so a green ` +
      `result here would certify nothing`,
  );

  const textFiles = files.filter((f) => {
    const dot = f.lastIndexOf(".");
    if (dot < 0) return false;
    return TEXT_EXTENSIONS.has(f.slice(dot + 1).toLowerCase());
  });

  assert.ok(
    textFiles.length > 100,
    `only ${textFiles.length} tracked text files matched the extension list — the filter is wrong`,
  );

  const offenders: string[] = [];

  for (const file of textFiles) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue; // listed in the index but absent from the working tree — not this test's business
    }
    const at = bytes.indexOf(0);
    if (at < 0) continue;
    const line = bytes.subarray(0, at).toString("utf8").split("\n").length;
    const total = bytes.filter((b) => b === 0).length;
    offenders.push(`${file}:${line} (${total} NUL byte${total === 1 ? "" : "s"})`);
  }

  assert.deepEqual(
    offenders,
    [],
    `Source files contain raw NUL (0x00) bytes. git and grep treat these files as BINARY and skip ` +
      `them silently, so every repo-wide search over them returns a false zero. Replace the NUL with ` +
      `the separator that was meant — usually a space or "|", matching the file's own convention — ` +
      `or write the escape "\u0000" if a NUL really is intended.\n  ${offenders.join("\n  ")}`,
  );
}
