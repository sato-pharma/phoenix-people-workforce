import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — plan making and Add visit wear Report It's step form (owner, 2026-10-02: "i want the
 * same form to be used in visits entry and plans making in phx crm", sent with a screenshot of
 * Report It's form).
 *
 * Pinned, because each one goes wrong QUIETLY:
 *   (a) THE LOOK IS REPORT IT'S — the "Step N of 4 · %" strip, the numbered rail with the active
 *       step's orange bar, the step heading with its large "01", Back / Next at the foot. Square, never
 *       an ellipsis. Report It's own file is the reference and is not edited.
 *   (b) THE PLAN: the rep's own board is four steps — Week, Day, Customers, Send. A tap on his week
 *       moves him to its days and a tap on a day to its customers. A manager reviewing from Team keeps
 *       his whole board — except a week WAITING FOR HIS DECISION, which since 2026-10-02 is read as its
 *       own four steps, Week, Day, Customers, Decide (tests/phoenix-crm-plan-review.test.ts).
 *   (c) ADD VISIT: four steps — Visit type, Customer, Products and comment, Log the visit. A tap on a
 *       type or a customer moves him on (owner: "a tap moves on"); no Next for a step whose answer is a
 *       choice. The visit form stays MOUNTED across steps 3 and 4 — remounting it would lose what he
 *       typed and restart the silent clock — and its ONE Log visit is on step 4.
 *   (d) INSIDE THE FORM, A SCREEN LOSES ONLY ITS FRAME: `CrmPanel` drops its card and `CrmBackBar`
 *       draws nothing, so there is one card and one Back.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function raw(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

export function runPhoenixCrmStepFormTests(): void {
  const shell = source("src/components/phoenix-crm/step-form.tsx");
  const board = source("src/components/phoenix-crm/plan-board.tsx");
  const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
  const tab = source("src/components/phoenix-crm/visits-tab.tsx");
  const form = source("src/components/phoenix-crm/visit-log-form.tsx");
  const ui = source("src/components/phoenix-crm/ui.tsx");

  // ── (a) Report It's look ──────────────────────────────────────────────────────────────────────
  {
    const reportIt = raw("src/components/report-it/report-it-form.tsx");
    // The pieces the owner's screenshot shows, with Report It's own classes.
    for (const [what, piece] of [
      ["the strip's progress bar", '<div className="mt-3 h-1.5 w-full bg-slate-100">'],
      ["the active step's orange bar", 'className="absolute inset-y-0 left-0 w-[3px] bg-orange-500"'],
      ["the rail's column", "lg:grid-cols-[244px_minmax(0,1fr)]"],
      ["the step's large number", 'className="select-none text-4xl font-black tabular-nums text-slate-200"'],
      ["the heading's eyebrow", "text-phx-2xs font-black uppercase tracking-[0.25em] text-orange-600"],
    ] as const) {
      assert.ok(reportIt.includes(piece), `Report It still carries ${what} — the reference moved`);
      assert.ok(shell.includes(piece), `the CRM step form carries ${what}, as Report It does`);
    }
    assert.ok(shell.includes('{String(step).padStart(2, "0")}'), "the step's number reads 01, 02 …");
    assert.match(shell, /Step \{step\} of \{steps\.length\}/, "and the strip says Step N of 4");
    assert.ok(shell.includes("const pct = Math.round((step / steps.length) * 100);"), "with the percent Report It shows");
    const rounded = [...shell.matchAll(/(?<![\w-])rounded(?:-[\w./[\]-]+)?(?![\w-])/g)].map((match) => match[0]).filter((token) => token !== "rounded-none");
    assert.deepEqual(rounded, [], "the step form is square");
    assert.equal(/\b(truncate|text-ellipsis|line-clamp-\d)\b/.test(shell), false, "and never cuts a word short");
  }

  // ── (b) The plan: Week → Day → Customers → Send ──────────────────────────────────────────────
  {
    const labels = [...board.matchAll(/\{ label: "([^"]+)", description: "[^"]+", title: /g)].map((match) => match[1]);
    assert.deepEqual(labels, ["Week", "Day", "Customers", "Send"], "the rep's plan is four steps, in the owner's order");
    assert.match(board, /\{repBoard \? \(\s*<div[^>]*ref=\{stepRef\}>\s*<CrmStepForm/, "the rep's own board is the step form");
    assert.match(
      board,
      /\) : \(\s*<>\s*\{monthBlock\}\s*\{pendingBlock\}\s*\{weeksBlock\}\s*<div className="min-w-0 scroll-mt-24" ref=\{weekRef\}>\s*\{reviewElement \?\? weekPanelElement\}/,
      "a manager reviewing from Team keeps the whole board — a week waiting for his decision takes the week panel's place as review steps (owner, 2026-10-02)",
    );
    assert.ok(
      board.includes('const panelSection: "days" | "day" | "send" | undefined = repBoard ? (planStep === 2 ? "days" : planStep === 3 ? "day" : "send") : undefined;'),
      "steps 2 to 4 show the week a part at a time",
    );
    // An element, never a function called during render: the React compiler reads every handler built
    // inside such a function as running during render (react-hooks/refs) — lint failed on it 2026-10-02.
    assert.equal(/weekPanel\(/.test(board), false, "the week panel is an element built once, not a function called in render");
    assert.match(board, /function chooseWeek\(next: string\) \{[\s\S]*?if \(repBoard\) goStep\(2\);/, "a tap on his week moves him to its days");
    assert.match(
      board,
      /function openDay\(date: string\) \{\s*setDay\(date\);\s*setDaySession\("AM"\);\s*if \(!repBoard\) return;\s*goStep\(3\);\s*fillDay\(date, false\);/,
      "a tap on a day moves him to its customers — its AM list first, filled the first time",
    );
    assert.ok(board.includes("onDay={openDay}"), "every day the panel offers goes through that tap");
    assert.ok(board.includes("Next day · {dayLabel(nextDay.date)}"), "step 3 walks the week a day at a time");

    for (const [section, flag] of [
      ["days", 'const showWeekSuggest = whole || section === "days";'],
      ["day", 'const showDay = whole || section === "day";'],
      ["send", 'const showHeader = whole || section === "send";'],
    ] as const) {
      assert.ok(panel.includes(flag), `the week panel's "${section}" part is its own`);
    }
    assert.ok(panel.includes("const whole = section === undefined;"), "and unset is the whole week, as a reviewer sees it");
  }

  // ── (c) Add visit: Visit type → Customer → Products and comment → Log the visit ──────────────────
  {
    const labels = [...tab.matchAll(/\{ label: "([^"]+)", description: "[^"]+", title: "[^"]+" \}/g)].map((match) => match[1]);
    assert.deepEqual(labels, ["Visit type", "Customer", "Products and comment", "Log the visit"], "Add visit is four steps, in the owner's order");
    // Eight since 2026-10-03: the Pharmacy visit picker is a screen of step 2 like the other two
    // (owner: a pharmacy visit "is logged normally"), still four steps and still inside the form.
    // Nine the same night: Add a pharmacy (owner: "he can also add a pharmacy without any validation
    // or without any approval") is another screen of step 2, inside the form like the picker it opens from.
    assert.equal((tab.match(/return shell\(/g) ?? []).length, 9, "every screen of Add visit sits inside the step form");
    assert.equal(/CrmStepNext/.test(tab), false, "no Next on a step whose answer is a choice — a tap moves him on");
    assert.ok(tab.includes("footer={n >= 3 ? undefined : <CrmStepFooter back={back} />}"), "steps 1 and 2 have Back only");
    assert.ok(tab.includes("canJump={(target) => target < n && (n < 3 || target >= 3)}"), "the rail only goes back, and never out of the visit form past its own exit");

    assert.ok(tab.includes("onPart={(part) => onStep({ ...formStep, part })}"), "steps 3 and 4 are one visit form, moved between by its part");
    assert.ok(tab.includes("key={formStep.customerId}"), "keyed on the customer only, so moving between 3 and 4 never remounts it");
    assert.ok(form.includes('{part === "log" ? ('), "step 4 reads the visit back");
    const logAt = form.indexOf('{part === "log" ? (\n                <CrmButton busy={saving}');
    const logAtLoose = /\{part === "log" \? \(\s*<CrmButton busy=\{saving\}[^>]*onClick=\{\(\) => void save\(Date\.now\(\)\)\}/.test(form);
    assert.ok(logAt !== -1 || logAtLoose, "and its ONE Log visit is on step 4");
    assert.match(form, /function toLog\(\) \{[\s\S]*?if \(openStep !== null\) \{\s*setTried\(true\);\s*showStep\(openStep\);/, "step 3's Next first sends him to anything still missing");
    assert.equal((form.match(/void save\(Date\.now\(\)\)/g) ?? []).length, 1, "and the form still has exactly one way to save");
    assert.ok(form.includes('if (part === "log") onPart("details");'), "a missing answer found from step 4 takes him back to step 3, where the box is");
  }

  // ── (e) Plan step 3, all three ways (owner, 2026-10-02: "step 3 … too long, confusing") ──────────
  {
    const day = source("src/components/phoenix-crm/plan-day-panel.tsx");
    // AM, then PM — two short screens; a Thursday (AM only) has no PM screen — unless a PM customer is
    // still on it (or on a day off), whom he must reach to take off (owner, 2026-10-02).
    assert.ok(board.includes('planStep === 3 && daySession === "AM" && dayHoldsPm'), "step 3 is AM first, then PM where the day has one");
    assert.match(
      board,
      /const dayHoldsPm =\s*selectedDay !== null &&\s*\(selectedDay\.listTypes\.includes\("PM"\) \|\|\s*\(selected\?\.items \?\? \[\]\)\.some\(\(item\) => item\.planDate === selectedDay\.date && byId\.get\(item\.customerId\)\?\.listType === "PM"\)\);/,
      "a day holds a PM screen when it holds a PM list, or a PM customer still to take off",
    );
    assert.match(board, /setDaySession\("PM"\);\s*goStep\(3\);\s*\}\}\s*>\s*Next: PM/, "AM's way on is Next: PM");
    assert.ok(board.includes('dayFocus={repBoard && panelSection === "day" ? daySession : undefined}'), "the day panel shows the one list the step is on");
    // Suggestion first — once per day, only an empty one, through the same way in as Suggest this day.
    assert.match(board, /function fillDay\(date: string, force: boolean\) \{[\s\S]*?if \(!force && filledDays\.has\(key\)\) return;[\s\S]*?if \(!force && selected\.items\.some\(\(item\) => item\.planDate === date\)\) return;[\s\S]*?suggestDay\([\s\S]*?addCopies\(/, "a day is filled with its suggestion once, only when empty, through addCopies");
    assert.match(day, /Clear \{focus\}/, "and one tap clears the list");
    // Owner, 2026-10-02: "where the combo box? where the suggest? where the copy iReports period and week
    // plan? in step 3" — every way to fill the list on ONE row above it, the filters under it, none folded.
    assert.match(
      day,
      /variant="primary">\s*Suggest this day\s*<\/CrmButton>\s*\) : null\}\s*\{copyMenu\}\s*\{planCopyMenu\}/,
      "Suggest this day, the day copies and the week copies share one row",
    );
    assert.ok(day.includes('<div className="mt-3 min-w-0">{filterBar}</div>'), "the filter dropdowns sit right above the list, never folded");
    const weekPanelSource = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.ok(
      weekPanelSource.includes('scope={{ kind: "month", monthStart: monthStartOf(week.weekStart), weeks: [target] }}'),
      "the period plan copies onto this week only",
    );
    assert.ok(weekPanelSource.includes('scope={{ kind: "week", target }}'), "and last week's plan sits beside it");
    const copyMenuSource = source("src/components/phoenix-crm/plan-copy-menu.tsx");
    assert.ok(copyMenuSource.includes('label: compact ? "Copy the period plan" : "Copy last month"'), "named the period plan on step 3");
    assert.ok(copyMenuSource.includes('crmUrl("/api/phoenix-crm/plans/history"'), "which falls back to his iReports360 plan in his first Phoenix month");
    // Customers first — the ones he can see that day lead; the rest are folded, never refused.
    assert.ok(day.includes("const ofTheDay = rows.filter((row) => row.placed || row.receives);"), "only who receives that day (or whose hours are not known yet) leads");
    assert.match(day, /Show \$\{countText\(others\)\} more who do not receive on \$\{weekdayName\}/, "the others are one button away");
    assert.ok(day.includes('{moreOpen ? "Hide" : "Start times and activities"}'), "only the start times and activities are folded");
    // His own board saves itself as he ticks (owner, 2026-10-02), so a fill is KEPT — and told it is not sent.
    assert.ok(day.includes("Nothing is sent until you press Send."), "and he is told the fill is not sent");
    assert.ok(!day.includes("Nothing is saved or sent until you do."), "never that it waits for a Save his board no longer has");
  }

  // ── (d) Inside the form, a screen loses only its frame ───────────────────────────────────────
  {
    assert.ok(ui.includes("<section className={cn(framed ? undefined : crmPanelClassName, \"min-w-0\", className)}>"), "a panel inside the form drops its card");
    const backBarAt = ui.indexOf("export function CrmBackBar(");
    assert.ok(
      backBarAt !== -1 && ui.slice(backBarAt, ui.indexOf("return (", backBarAt)).includes("if (useInsideCrmStepForm()) return null;"),
      "and its back bar: the form's foot has the one Back",
    );
    assert.ok(tab.includes("<CrmStepFrame>{content}</CrmStepFrame>"), "Add visit's screens are drawn inside that frame");
  }

  console.log("phoenix-crm step form: OK");
}
