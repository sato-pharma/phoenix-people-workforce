#!/usr/bin/env node
// Parse every Dockerfile in this repo and refuse the four breakages CI could not otherwise see.
//
// WHY THIS EXISTS. A Dockerfile change is the ONE kind of edit here that reaches production with no
// CI coverage at all. `validate` skips the Build on a pull request (deliberately — see
// tests/ci-pr-skips-build-and-smoke.test.ts for the measured reason), and the container image is
// built only by Railway, AFTER the merge. So a syntax error or a `$VAR` nothing declares surfaces as
// a FAILED PRODUCTION BUILD on a commit whose required checks were green — and per AGENTS.md §2.3 a
// commit whose deploy never succeeded is the hardest failure here to notice, because GitHub calls it
// `inactive`, the same word as a healthy superseded deploy.
//
// It was written after removing a dead `ARG NEXT_PUBLIC_COMMIT_SHA` (#4981). Proving that edit safe
// took a hand-rolled variable audit in a scratchpad, because nothing in the repo could answer it.
// That discipline is not a check: the next session will not know to do it.
//
// 🔴 WHY NOT `docker buildx build --check`. It is the authoritative parser, and it was deliberately
// NOT used. It needs a daemon and the build context, and it fails on STYLE rules this repo has not
// adopted — so wiring it into a REQUIRED check would go red on pre-existing warnings that break
// nothing, which is how a gate gets disabled. This script is deterministic, needs no daemon, runs in
// milliseconds, and asserts only things that genuinely break a build.
//
// 🔴 CONSERVATIVE ON PURPOSE, because a false positive in a required check is worse than a missed
// catch. Docker's real ARG scoping is subtle: a global ARG (before the first FROM) is NOT visible
// inside a stage unless re-declared. Asserting that exactly would red valid Dockerfiles, so the
// variable rule here fires only when a name is declared NOWHERE ABOVE ITS FIRST USE — which is the
// failure mode that actually deletes a value, and the one a removal creates.

import { readFileSync, existsSync } from "node:fs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-dockerfile",
  entry: import.meta.url,
  known: [],
});

/** Every Dockerfile that ships. Both are real: the app image, and the Headwind bridge's. */
const DOCKERFILES = ["Dockerfile", "infra/headwind-phoenix-actions/Dockerfile"];

/** Instructions BuildKit accepts. An unknown one is a typo, and docker fails the build on it. */
const INSTRUCTIONS = new Set([
  "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM", "HEALTHCHECK", "LABEL",
  "MAINTAINER", "ONBUILD", "RUN", "SHELL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR",
]);

/**
 * The instructions where DOCKER ITSELF substitutes variables at build time. The undeclared-variable
 * rule applies to these and to nothing else.
 *
 * 🔴 `RUN`, `CMD` and `ENTRYPOINT` ARE DELIBERATELY ABSENT, and leaving them in was measured wrong.
 * Their bodies are handed to a SHELL, which expands `$VAR` at run time and may well have assigned it
 * two lines earlier in the same script. The first version of this check scanned them and produced
 * **30 false positives on `infra/headwind-phoenix-actions/Dockerfile`** — every one a local shell
 * variable (`MARKER`, `FOUND`, `ARTIFACT`, a loop's `$V`) or one from the base image
 * (`CATALINA_HOME`, `LOGPROPS`). That file is correct; the rule was not. A required check that reds a
 * valid file is a check somebody disables, so this narrowing is the check staying useful.
 *
 * Narrowing costs nothing that matters here: the case this script was written for —
 * `ENV NAME=$NAME` left behind after its `ARG NAME` is deleted — is an ENV line.
 */
const SUBSTITUTED = new Set([
  "ADD", "COPY", "ENV", "EXPOSE", "FROM", "LABEL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR",
]);

/**
 * Names that exist without a Dockerfile declaration, so referencing one is not an orphan.
 *
 * The BuildKit platform args are injected by the builder. The rest come from the shell that RUN
 * executes in, or from the base image's own environment — this repo's images are node + Alpine.
 */
const PROVIDED = new Set([
  // BuildKit injects these into every build.
  "TARGETPLATFORM", "TARGETOS", "TARGETARCH", "TARGETVARIANT",
  "BUILDPLATFORM", "BUILDOS", "BUILDARCH", "BUILDVARIANT",
  // Shell and base-image environment.
  "PATH", "HOME", "PWD", "SHELL", "TERM", "USER", "HOSTNAME", "LANG", "LC_ALL", "TMPDIR",
]);

const problems = [];

function report(file, line, rule, message) {
  problems.push({ file, line, rule, message });
}

/**
 * One Dockerfile.
 *
 * Continuation lines (a line ending in `\`) are joined before parsing, because an instruction split
 * across lines is one instruction and its second half does not start with a keyword.
 */
function checkFile(file) {
  const raw = readFileSync(file, "utf8");
  const physical = raw.split(/\r?\n/);

  /** Logical instructions: the joined text, plus the line the instruction STARTED on. */
  const logical = [];
  let buffer = "";
  let startedAt = 0;
  physical.forEach((text, index) => {
    const lineNo = index + 1;
    const trimmed = text.trim();
    if (buffer === "") {
      // A comment or a blank line outside a continuation carries no instruction.
      if (trimmed === "" || trimmed.startsWith("#")) return;
      startedAt = lineNo;
    }
    if (trimmed.endsWith("\\")) {
      buffer += `${trimmed.slice(0, -1)} `;
      return;
    }
    logical.push({ text: buffer + trimmed, line: startedAt });
    buffer = "";
  });
  if (buffer !== "") {
    logical.push({ text: buffer.trim(), line: startedAt });
  }

  const declaredAt = new Map(); // NAME -> first line that declares it
  const stages = new Set(); // stage names a later COPY --from may target
  let sawFrom = false;

  for (const { text, line } of logical) {
    const keyword = text.split(/\s+/, 1)[0].toUpperCase();

    // 1. An unknown instruction. Docker refuses the build outright.
    if (!INSTRUCTIONS.has(keyword)) {
      report(file, line, "unknown-instruction",
        `\`${keyword}\` is not a Dockerfile instruction. Docker refuses the whole build on this, ` +
        `and no check in this repo sees a Dockerfile before Railway builds it after the merge.`);
      continue;
    }

    if (keyword === "FROM") {
      sawFrom = true;
      const named = text.match(/^FROM\s+\S+(?:\s+[Aa][Ss]\s+(\S+))?/);
      if (named?.[1]) stages.add(named[1]);
    }

    // 2. A COPY --from=<stage> whose stage does not exist above it. Docker treats an unknown name
    //    as an IMAGE and tries to pull it, so the failure reads as a registry error, not a typo.
    if (keyword === "COPY" || keyword === "ADD") {
      const from = text.match(/--from=([A-Za-z0-9_.-]+)/);
      if (from) {
        const target = from[1];
        const looksLikeAnImage = target.includes("/") || target.includes(":");
        if (!stages.has(target) && !looksLikeAnImage && !/^\d+$/.test(target)) {
          report(file, line, "unknown-stage",
            `--from=${target} names no stage declared above it (stages so far: ` +
            `${[...stages].join(", ") || "none"}). Docker then reads it as an IMAGE and tries to ` +
            `pull it, so the build fails with a registry error that hides the real cause.`);
        }
      }
    }

    // 🔴 WHAT THIS LINE CAN SEE IS WHAT IS DECLARED **ABOVE** IT, NEVER ITS OWN DECLARATIONS.
    //
    // This snapshot is load-bearing and its absence made rule 4 INERT. The first version collected
    // this line's declarations first, so that `ENV X=$X` would not be reported against itself — and
    // `ENV X=$X` with no `ARG X` above it is EXACTLY the orphan that deleting an ARG leaves behind,
    // i.e. the one case this script was written for. Proven by breaking it: the fixture
    // `ENV NEXT_PUBLIC_COMMIT_SHA=$NEXT_PUBLIC_COMMIT_SHA` with nothing declaring it passed clean.
    //
    // Reading strictly upward is also what Docker does: within one `ENV A=1 B=$A`, `$A` takes the
    // value from BEFORE the instruction, so a same-line reference to an otherwise-undeclared name
    // really does expand to empty.
    const declaredAbove = new Set(declaredAt.keys());

    if (keyword === "ARG" || keyword === "ENV") {
      for (const name of declarationsIn(text, keyword)) {
        if (!declaredAt.has(name)) declaredAt.set(name, line);
      }
      // 3. The legacy space form. It warns on EVERY production build, and all five instances in
      //    the app Dockerfile were converted to `key=value` during the Railway audit.
      if (keyword === "ENV" && /^ENV\s+[A-Za-z_][A-Za-z0-9_]*\s+[^=\s]/.test(text)) {
        report(file, line, "legacy-env-format",
          `\`ENV key value\` is the legacy space form and warns on every build. Write ` +
          `\`ENV key=value\`. The app Dockerfile's five instances were converted during the ` +
          `2026-09-30 Railway audit; this keeps them gone.`);
      }
    }

    // 4. A $VAR nothing declares above it. This is the rule that would have caught an orphan left
    //    behind by removing an ARG — the reason this script exists. Scoped to the instructions
    //    Docker substitutes in; see SUBSTITUTED for the 30 false positives that scoping prevents.
    if (!SUBSTITUTED.has(keyword)) continue;
    for (const { name, column } of referencesIn(text)) {
      if (PROVIDED.has(name) || declaredAbove.has(name)) continue;
      // Before the first FROM, only build args exist; after it, a missing name resolves to EMPTY
      // rather than failing — which is worse than an error, because the image ships broken.
      report(file, line, "undeclared-variable",
        `$${name} (at column ${column}) is referenced with no ARG or ENV declaring it above. ` +
        `Docker does NOT fail on this — it substitutes an EMPTY STRING — so the image builds ` +
        `green and ships with the value missing.${sawFrom ? "" : " (Before the first FROM, only build args exist.)"}`);
    }
  }
}

/** The names an ARG/ENV line declares. Handles `ENV A=1 B=2` and a bare `ARG A`. */
function declarationsIn(text, keyword) {
  const body = text.slice(keyword.length).trim();
  const names = [];
  // `ENV A=1 B=2` / `ARG A=1` / `ARG A`
  for (const m of body.matchAll(/(^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) names.push(m[2]);
  if (names.length === 0) {
    const bare = body.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (bare) names.push(bare[1]);
  }
  return names;
}

/**
 * The variables a line REFERENCES.
 *
 * `$$` is an escaped dollar and references nothing. `${NAME:-default}` and `${NAME:+alt}` reference
 * NAME, so the modifier is dropped. A `$` followed by anything else is not a variable.
 */
function referencesIn(text) {
  const found = [];
  const pattern = /\$(\$)?(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::[-+][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const m of text.matchAll(pattern)) {
    if (m[1]) continue; // `$$` — escaped, not a reference
    const name = m[2] ?? m[3];
    if (name) found.push({ name, column: m.index + 1 });
  }
  return found;
}

// Paths may be passed explicitly, which is how tests/dockerfile-parse-gate.test.ts points this at
// broken fixtures to prove each rule still fires. With no arguments it checks what actually ships,
// which is what `pnpm run check:dockerfile` and the `validate` job do.
const targets = process.argv.slice(2);
const files = targets.length > 0 ? targets : DOCKERFILES;

for (const file of files) {
  if (!existsSync(file)) {
    problems.push({
      file,
      line: 0,
      rule: "missing-file",
      message:
        "listed in this script's DOCKERFILES but not present. If it was moved or deleted on " +
        "purpose, update the list — a silently skipped file is an unchecked file.",
    });
    continue;
  }
  checkFile(file);
}

if (problems.length > 0) {
  console.error(`\n🔴 check:dockerfile — ${problems.length} problem(s)\n`);
  for (const { file, line, rule, message } of problems) {
    console.error(`  ${file}:${line}  [${rule}]`);
    console.error(`    ${message}\n`);
  }
  console.error(
    "A Dockerfile is not built by a pull request's CI — Railway builds it after the merge — so\n" +
    "this check is the only thing standing between a broken Dockerfile and a failed production\n" +
    "deploy on a commit that read green.\n",
  );
  process.exit(1);
}

console.log(
  `check:dockerfile — ${files.length} file(s) parsed, no problems ` +
  "(unknown instruction · unknown --from stage · legacy ENV space form · undeclared $VAR).",
);
