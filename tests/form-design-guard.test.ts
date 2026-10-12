// A FORM THAT DOES NOT USE THE KIT — .claude/hooks/form-design-guard.mjs, 2026-10-12.
//
// `tests/form-design-system.test.ts` already refuses a form control that paints its own box (the
// self-skinned cap is 0, with no grandfather list) and a token override written as a template
// literal (an empty-list assertion). Both are the owner's 2026-10-06 rule that every form wears the
// Adverse Drug Reaction wizard's skin, and both are measured deep inside the required `validate`
// job — the slow half of 26 red PR runs on 12 Oct 2026, thirteen of them repo-wide contract gates
// of exactly this kind. The hook moves the same verdict to the Write or Edit that introduces the
// shape. This file pins three things:
//
//   1. The hook itself, driven as a subprocess with real tool payloads — the painted shapes
//      refused, the kit's own idioms allowed, every exemption the owner ruled on left alone.
//   2. Its wiring: a PreToolUse hook for Write, Edit and MultiEdit in the dispatch table.
//   3. That it and the CI test share ONE detector. The test imports
//      `.claude/hooks/lib/form-design-shapes.mjs` and defines none of the shapes itself; a hook
//      that drifts into refusing what CI accepts — or into silence about what CI rejects — is worse
//      than none.
//
// The fixtures below are class strings inside `<input>` tags, which is exactly what the CI sweep
// hunts. They are safe here because that sweep reads `src/components/**.tsx` and `app/**.tsx` only,
// never `tests/` — asserted below, so a widened sweep fails here instead of reporting this file's
// fixtures as real offenders.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EXEMPT,
  isSweptFormFile,
  paintsItsOwnBox,
  scanControls,
  templateConcatSites,
} from "../.claude/hooks/lib/form-design-shapes.mjs";
import { commandOf, dispatchedHookGroups } from "./support/hook-wiring.ts";

const HOOK = ".claude/hooks/form-design-guard.mjs";
const LIB = ".claude/hooks/lib/form-design-shapes.mjs";
const CI_TEST = "tests/form-design-system.test.ts";

/** A form file inside the sweep, used by every case that is about the shape rather than the path. */
const FORM = "src/components/hr/new-leave-form.tsx";

/** The hook's answer: the refusal reason, or "" for no opinion. */
function runHook(
  tool: string,
  filePath: string | null,
  toolInput: Record<string, unknown>,
  env: Record<string, string> = {},
): string {
  const raw = execFileSync(process.execPath, [resolve(HOOK)], {
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath, ...toolInput } }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
    env: { ...process.env, ...env },
  });
  if (!raw.trim()) return "";
  const decision = JSON.parse(raw).hookSpecificOutput ?? {};
  assert.equal(
    decision.permissionDecision,
    "deny",
    "the only verdict this hook may emit is deny — anything else would ask the owner to click " +
      "through a refusal whose remedy is an import of the token he already owns",
  );
  return String(decision.permissionDecisionReason ?? "");
}

const write = (filePath: string | null, content: string, env?: Record<string, string>) =>
  runHook("Write", filePath, { content }, env);

/** The painted shapes, each as a real site wrote one before the sweep. */
const PAINTED: ReadonlyArray<readonly [string, string]> = [
  ["the full hand-written field skin", '<input className="h-10 w-full rounded border border-slate-300 bg-white px-3 text-sm" />'],
  ["a radius alone", '<select className="rounded-md px-2">{options}</select>'],
  ["a full border alone", '<textarea className="border border-slate-200 p-2" rows={3} />'],
  ["a white ground alone", '<input className="bg-white px-3 py-2" />'],
  ["the Input wrapper given its own box", '<Input className="rounded-lg border bg-white" value={name} />'],
  ["a SearchableSelect given its own box", '<SearchableSelect className="rounded border bg-white" options={rows} />'],
  ["a skin reached through a local constant", 'const FIELD = "h-9 rounded border border-slate-300 bg-white px-2";\n<input className={FIELD} />'],
  ["a skin assembled by cn() from literals", '<input className={cn("rounded border bg-white px-3", dense && "h-8")} />'],
];

/** What the kit's own idioms look like, and the cases the sweep deliberately does not count. */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["the token itself", "<input className={phxFieldClassName} />"],
  ["a dense height through cn()", '<input className={cn(phxFieldClassName, "h-9")} />'],
  ["a local constant that reaches the token", 'const FIELD = cn(phxFieldClassName, "h-9");\n<input className={FIELD} />'],
  ["a wrapper with no className", "<Input value={name} onChange={set} />"],
  ["a checkbox, which is not a field", '<input type="checkbox" className="rounded border bg-white" />'],
  ["a file input, which is not a field", '<input type="file" className="rounded border bg-white" />'],
  ["a divider border on a transparent ground", '<input className="border-l border-slate-200 bg-transparent px-2" />'],
  ["border-0, the opposite of painting", '<input className="border-0 px-2" />'],
  ["a control quoted in a comment", '// A labeled <select className="rounded border bg-white"> with a chevron\nexport const X = 1;'],
  ["an unresolvable reference", "<input className={props.className} />"],
  ["text with no control and no token", "export const rows = data.map(toRow);"],
];

function hookTests(): void {
  for (const [label, shape] of PAINTED) {
    const reason = write(FORM, shape);
    assert.ok(reason, `${label} must be refused at the Write — it is a self-skinned control, and the CI cap is 0`);
    assert.ok(
      reason.includes("phxFieldClassName"),
      `the refusal of ${label} must name the token, not merely complain: ${reason.slice(0, 160)}`,
    );
  }

  for (const [label, shape] of ALLOWED) {
    assert.equal(write(FORM, shape), "", `${label} must pass — the hook may never be stricter than the CI check it fronts for`);
  }

  // The template-literal override, both ways round, and the tail that legitimately stays a template.
  const templated = write(FORM, "const F = `${phxSelectClassName} h-9 px-2`;");
  assert.ok(templated.includes('cn(phxSelectClassName, "h-9 px-2")'), "the refusal must write the cn() remedy out in full");
  assert.ok(templated.includes("tailwind-merge"), "the refusal must say WHY the override silently loses");
  assert.ok(write(FORM, "const F = `text-xs ${phxFieldClassName}`;"), "the head form of the shape must be refused too");
  assert.ok(
    write(FORM, "const F = `phx-x h-9 ${phxFieldClassName}`;"),
    "a head that itself begins with phx must still be read as the head — the token is the SECOND group",
  );
  assert.equal(
    write(FORM, "const F = `${phxFieldClassName} tabular-nums truncate`;"),
    "",
    "a tail that conflicts with nothing the token sets may stay a template",
  );
  assert.equal(write(FORM, 'const F = cn(phxFieldClassName, "h-9 px-2");'), "", "the cn() form is the remedy and must pass");

  // Arrival shape: an Edit and a MultiEdit introduce text the same way a Write does, and an edit
  // that REMOVES an offender must always pass — a guard that blocked its own remedy would have to
  // be turned off to be obeyed.
  const skin = '<input className="rounded border border-slate-300 bg-white px-3" />';
  const fixed = "<input className={phxFieldClassName} />";
  assert.ok(runHook("Edit", FORM, { new_string: skin }), "an Edit introducing the shape must be refused");
  assert.ok(
    runHook("MultiEdit", FORM, { edits: [{ new_string: fixed }, { new_string: skin }] }),
    "a MultiEdit must be read edit by edit — the offender was the second one",
  );
  assert.equal(
    runHook("Edit", FORM, { old_string: skin, new_string: fixed }),
    "",
    "an edit that removes a painted control must pass: the hook reads only the text being introduced",
  );

  // Payload shapes that must never produce a refusal.
  assert.equal(write(null, skin), "", "a call with no file path is not an edit to refuse");
  assert.equal(runHook("Write", FORM, {}), "", "a Write with no content is not an edit to refuse");
  assert.equal(runHook("Read", FORM, { content: skin }), "", "only Write, Edit and MultiEdit are judged");
  assert.equal(runHook("MultiEdit", FORM, {}), "", "a MultiEdit with no edits is not an edit to refuse");

  // The stand-down, and the fact that it is the only way past.
  assert.equal(write(FORM, skin, { PHX_FORM_DESIGN_OFF: "1" }), "", "PHX_FORM_DESIGN_OFF=1 must stand the guard down");
  assert.ok(write(FORM, skin, { PHX_FORM_DESIGN_OFF: "0" }), "only the exact value 1 stands it down");

  const reason = write(FORM, skin);
  assert.ok(reason.includes("@/components/ui/form-tokens"), "the refusal must name the import path");
  assert.ok(reason.includes("form-kit"), "the refusal must point at the kit, not only the token strings");
  assert.ok(reason.includes("2026-10-06"), "the refusal must cite the owner's rule by date");
  assert.ok(reason.includes("PHX_FORM_DESIGN_OFF=1"), "the refusal must name its own escape hatch");
  assert.ok(reason.includes("EXEMPT"), "the refusal must say where a ruled exemption goes");
}

function scopeTests(): void {
  // Inside the control sweep.
  assert.ok(write("app/hr/leave/page.tsx", '<input className="rounded border bg-white" />'), "an app/ page is in scope");
  assert.ok(
    write("src/components/sales/deep/filter-row.tsx", '<input className="rounded border bg-white" />'),
    "the sweep's git pathspec matches at any depth, so a nested component is in scope",
  );
  assert.ok(
    write("F:\\Phoenix Workforce\\_wt-x\\src\\components\\hr\\x.tsx", '<input className="rounded border bg-white" />'),
    "a worktree's absolute Windows path must resolve to the same repo-relative file",
  );

  // Outside it.
  assert.equal(
    write("src/lib/hr/leave.ts", '<input className="rounded border bg-white" />'),
    "",
    "the control sweep reads .tsx only — a hook stricter than the check it fronts for refuses work CI would accept",
  );
  assert.equal(write("tests/form-design-guard.test.ts", '<input className="rounded border bg-white" />'), "", "tests/ is outside both sweeps");
  assert.ok(
    !isSweptFormFile("tests/form-design-guard.test.ts"),
    "this file's own fixtures are only safe while tests/ is outside the sweep — widen the sweep and fix these fixtures in the same change",
  );

  // Every exemption the owner ruled on.
  for (const exempt of EXEMPT) {
    const file = exempt.endsWith(".tsx") || exempt.endsWith(".ts") ? exempt : `${exempt}thing.tsx`;
    assert.equal(
      write(file.endsWith(".ts") || file.endsWith(".tsx") ? file : `${file}.tsx`, '<input className="rounded border bg-white" />'),
      "",
      `${exempt} is exempt in the CI sweep, so the hook must leave it alone too`,
    );
  }

  // The merge-semantics sweep is wider than the control sweep, and the hook honours the difference.
  assert.ok(
    write("src/lib/hr/leave-classes.ts", "const F = `${phxFieldClassName} h-9`;"),
    "the template check reads every .ts/.tsx under src/ and app/, not only components",
  );
  assert.equal(
    write("src/components/ui/form-tokens.ts", "const F = `${phxFieldClassName} h-9`;"),
    "",
    "the token file declares the tokens and is the one file that check skips",
  );
}

function wiringTests(): void {
  const groups = dispatchedHookGroups("PreToolUse").filter((group) =>
    (group.hooks ?? []).some((hook) => String(commandOf(hook) ?? "").includes("form-design-guard.mjs")),
  );
  assert.equal(groups.length, 1, "the guard must be wired exactly once in the PreToolUse table");
  const matcher = groups[0]?.matcher ?? "";
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    assert.ok(
      matcher.split("|").includes(tool),
      `the guard must run on ${tool} — that is how the text arrives; the matcher is "${matcher}"`,
    );
  }
  assert.ok(
    !matcher.split("|").includes("Bash"),
    "a Bash matcher would read a shell command as a file write and refuse a grep for the shape",
  );
}

function oneDetectorTests(): void {
  const ci = readFileSync(CI_TEST, "utf8");
  assert.ok(ci.includes("form-design-shapes.mjs"), `${CI_TEST} must import the shared detector`);
  for (const own of [
    /function\s+paintsItsOwnBox/,
    /function\s+findControls/,
    /function\s+classNameExpr/,
    /function\s+commentMask\s*\(/,
    /function\s+fileConstants/,
    /function\s+reachesToken/,
    /const\s+EXEMPT\s*=/,
    /const\s+TOKEN_GROUPS\s*=/,
    /const\s+CONTROL_TAGS\s*=/,
  ]) {
    assert.ok(
      !own.test(ci),
      `${CI_TEST} must not define its own ${String(own)} — the detector lives in ${LIB}, and two copies are how a hook starts refusing what CI accepts`,
    );
  }

  const hook = readFileSync(HOOK, "utf8");
  assert.ok(hook.includes("./lib/form-design-shapes.mjs"), "the hook must import the shared detector");
  assert.ok(
    !/function\s+paintsItsOwnBox|const\s+EXEMPT\s*=/.test(hook),
    "the hook must not keep its own copy of the paint test or the exemptions",
  );

  // The shared module is the thing both sides read, so its own behaviour is pinned here once.
  assert.equal(paintsItsOwnBox("rounded border bg-white px-3"), true, "a radius paints a box");
  assert.equal(paintsItsOwnBox("border-l border-slate-200"), false, "a directional border is a divider, not a box");
  assert.equal(paintsItsOwnBox("border-0 bg-white"), false, "border-0 is the opposite of painting");
  assert.equal(
    scanControls('<input className="rounded border bg-white" />').offenders.length,
    1,
    "the scan must find the painted control it is given",
  );
  assert.equal(
    scanControls("<input className={phxFieldClassName} />").onDesign,
    1,
    "a control wearing the token must be counted as on-design, not merely left unreported",
  );
  assert.equal(
    templateConcatSites("const F = `${phxFieldClassName} h-9`;").length,
    1,
    "the template shape must be found by the shared detector",
  );

  // And the hook's own selftest, which carries the cases that are cheapest to read as a table.
  const selftest = execFileSync(process.execPath, [resolve(HOOK), "--selftest"], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.ok(/\d+ cases, 0 failed/.test(selftest), `the guard's selftest must pass in full:\n${selftest.slice(-800)}`);
}

export async function runFormDesignGuardTests(): Promise<void> {
  hookTests();
  scopeTests();
  wiringTests();
  oneDetectorTests();
}
