"use client";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE HR FORMS CONTROL TAB (owner, 2026-11-27): "a tab in HR Forms where I can rearrange the forms
// that appear, remove a form, add a form I want to appear — move it from another paper to new hire,
// or from new hire to another paper." And then: "some things are obviously for new hires — Form 1 and
// the contract. Be smart. Remove them from rearrange; the ones you are unsure of, make them movable."
//
// So each package column opens with its FIXED papers, locked and never moved, then the movable papers
// in the order chosen here. Another paper is every movable paper on neither list, one click from
// either package. Nothing is stored until Save. The rules of what may sit where are `forms-layout.ts`,
// and the server cleans every list again before keeping it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  AlertTriangle,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  CheckCircle2,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { documentLabel } from "@/lib/hiring-pack/document-registry";
import { buildFormsDrive } from "@/lib/hiring-pack/forms-drive";
import {
  ARRANGED_PACKAGES,
  DEFAULT_FORMS_LAYOUT,
  FIXED_STEPS,
  mayArrange,
  movableSteps,
  sameFormsLayout,
  stepOfDocument,
  stepsOutsidePackages,
  type ArrangedPackage,
  type FormsLayout,
} from "@/lib/hiring-pack/forms-layout";
import type { StoredFormsLayout } from "@/lib/hiring-pack/forms-layout-store";
import { EXIT_FORM_STEP, type LeaverStep } from "@/lib/hiring-pack/hr-forms-wizard";

const PACKAGE_TITLES: Record<ArrangedPackage, string> = { leaver: "Leaver", newHire: "New hire" };

/** The step's name on this tab: the exit form is the one step that asks which of the two. */
export function arrangedStepLabel(step: LeaverStep): string {
  return step === EXIT_FORM_STEP ? "Exit form — resignation or mutual termination" : documentLabel(step);
}

/** Each paper's drive folder, so the lists read in the cabinet's own groups. Built once. */
const FOLDER_OF_STEP: ReadonlyMap<string, string> = (() => {
  const folders = new Map<string, string>();
  for (const folder of buildFormsDrive([])) {
    for (const entry of folder.entries) {
      const step = stepOfDocument(entry.document);
      if (!folders.has(step)) folders.set(step, folder.labelEn);
    }
  }
  return folders;
})();

function groupByFolder(steps: readonly LeaverStep[]): [string, LeaverStep[]][] {
  const groups = new Map<string, LeaverStep[]>();
  for (const step of steps) {
    const folder = FOLDER_OF_STEP.get(step) ?? "Other papers";
    groups.set(folder, [...(groups.get(folder) ?? []), step]);
  }
  return [...groups.entries()];
}

const columnClassName = "flex min-w-0 flex-col border border-phx-line bg-white";
const columnHeaderClassName = "flex items-baseline justify-between gap-2 border-b border-phx-line px-4 py-3";
const sectionLabelClassName = "px-4 pb-1 pt-3 text-phx-xs font-black uppercase tracking-wide text-phx-ink-soft";

export function HrFormsControl({
  initial,
  onSaved,
}: {
  initial: StoredFormsLayout;
  onSaved: (stored: StoredFormsLayout) => void;
}) {
  const [saved, setSaved] = useState<FormsLayout>(initial.layout);
  const [draft, setDraft] = useState<FormsLayout>(initial.layout);
  const [adding, setAdding] = useState<Record<ArrangedPackage, string>>({ leaver: "", newHire: "" });
  const [busy, setBusy] = useState(false);
  const [arranged, setArranged] = useState(initial.arranged.newHire || initial.arranged.leaver);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(
    initial.ready ? null : { text: "Saving is not ready yet — the arrangement table has not been created.", tone: "danger" },
  );

  const outside = stepsOutsidePackages(draft);
  const dirty = !sameFormsLayout(draft, saved);
  const isStandard = sameFormsLayout(draft, DEFAULT_FORMS_LAYOUT);

  /** A package's list from its movable papers: the fixed papers always open it. */
  const withMovable = (pack: ArrangedPackage, movable: readonly LeaverStep[]): LeaverStep[] => [
    ...FIXED_STEPS[pack],
    ...movable,
  ];
  const change = (next: FormsLayout) => {
    setDraft(next);
    setMessage(null);
  };
  const move = (pack: ArrangedPackage, index: number, by: -1 | 1) => {
    const list = movableSteps(draft, pack);
    const target = index + by;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    change({ ...draft, [pack]: withMovable(pack, list) });
  };
  const remove = (pack: ArrangedPackage, step: LeaverStep) => {
    if (!mayArrange(step)) return;
    change({ ...draft, [pack]: draft[pack].filter((value) => value !== step) });
  };
  const add = (pack: ArrangedPackage, step: LeaverStep) => {
    if (!mayArrange(step) || draft[pack].includes(step)) return;
    change({ ...draft, [pack]: [...draft[pack], step] });
  };
  const moveAcross = (from: ArrangedPackage, step: LeaverStep) => {
    if (!mayArrange(step)) return;
    const to: ArrangedPackage = from === "newHire" ? "leaver" : "newHire";
    change({
      ...draft,
      [from]: draft[from].filter((value) => value !== step),
      [to]: draft[to].includes(step) ? draft[to] : [...draft[to], step],
    });
  };

  const save = async (body: Record<ArrangedPackage, LeaverStep[] | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/hiring-pack/forms-layout", {
        body: JSON.stringify({ layout: body }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as (StoredFormsLayout & { message?: string }) | null;
      if (!response.ok || !payload?.layout) {
        setMessage({ text: payload?.message ?? "The arrangement could not be saved.", tone: "danger" });
        return;
      }
      setSaved(payload.layout);
      setDraft(payload.layout);
      setArranged(payload.arranged.newHire || payload.arranged.leaver);
      onSaved(payload);
      setMessage({ text: "Saved. HR Forms now walks through the papers in this order.", tone: "success" });
    } catch {
      setMessage({ text: "The arrangement could not be saved — check the connection and try again.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm font-semibold leading-relaxed text-phx-ink-soft">
        Each package opens with the papers it can never go without — those are locked. Below them, arrange
        the rest: move a paper up or down, across to the other package, or out to Another paper. Nothing
        changes until you save.
      </p>

      {message ? (
        <AdminCallout tone={message.tone}>
          {message.tone === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{message.text}</span>
        </AdminCallout>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {ARRANGED_PACKAGES.map((pack) => {
          const fixed = FIXED_STEPS[pack];
          const movable = movableSteps(draft, pack);
          const other: ArrangedPackage = pack === "newHire" ? "leaver" : "newHire";
          // Every movable paper not already here — one on the other package is marked so.
          const addable = groupByFolder(
            [...outside, ...movableSteps(draft, other)].filter((step) => !movable.includes(step)),
          );
          return (
            <section className={columnClassName} key={pack}>
              <header className={columnHeaderClassName}>
                <h3 className="text-sm font-black text-phx-ink">{PACKAGE_TITLES[pack]}</h3>
                <span className="text-phx-xs font-bold text-phx-ink-soft">
                  {fixed.length + movable.length} papers · {fixed.length} locked
                </span>
              </header>

              <p className={sectionLabelClassName}>Always included</p>
              <ol className="flex flex-col pb-2">
                {fixed.map((step, index) => (
                  <li className="flex items-start gap-2 px-4 py-1.5" key={step}>
                    <span className="w-5 shrink-0 text-sm font-black text-phx-ink-faint">{index + 1}</span>
                    <span className="min-w-0 flex-1 break-words text-sm font-semibold text-phx-ink-soft">
                      {arrangedStepLabel(step)}
                    </span>
                    <Lock aria-label="Locked" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
                  </li>
                ))}
              </ol>

              <p className={`${sectionLabelClassName} border-t border-phx-line`}>Then, in this order</p>
              {movable.length === 0 ? (
                <p className="px-4 pb-3 text-sm font-semibold text-phx-ink-soft">Nothing else — add a paper below.</p>
              ) : (
                <ol className="flex flex-col">
                  {movable.map((step, index) => (
                    <li className="flex flex-col gap-2 border-b border-phx-line px-4 py-2.5 last:border-b-0" key={step}>
                      <div className="flex items-start gap-2">
                        <span className="w-5 shrink-0 text-sm font-black text-phx-accent">{fixed.length + index + 1}</span>
                        <span className="min-w-0 flex-1 break-words text-sm font-bold text-phx-ink">
                          {arrangedStepLabel(step)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pl-7">
                        <Button
                          aria-label={`Move ${arrangedStepLabel(step)} up`}
                          className="h-8 w-8 px-0"
                          disabled={busy || index === 0}
                          onClick={() => move(pack, index, -1)}
                          size="xs"
                          title="Move up"
                          type="button"
                          variant="outline"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          aria-label={`Move ${arrangedStepLabel(step)} down`}
                          className="h-8 w-8 px-0"
                          disabled={busy || index === movable.length - 1}
                          onClick={() => move(pack, index, 1)}
                          size="xs"
                          title="Move down"
                          type="button"
                          variant="outline"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          className="h-8 gap-1"
                          disabled={busy}
                          onClick={() => moveAcross(pack, step)}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                          To {PACKAGE_TITLES[other]}
                        </Button>
                        <Button
                          className="h-8 gap-1"
                          disabled={busy}
                          onClick={() => remove(pack, step)}
                          size="xs"
                          title="Move to Another paper"
                          type="button"
                          variant="ghost"
                        >
                          <X className="h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <div className="flex flex-col gap-2 border-t border-phx-line bg-phx-paper px-4 py-3">
                <label className={phxLabelClassName} htmlFor={`hr-forms-add-${pack}`}>
                  Add a paper to {PACKAGE_TITLES[pack]}
                </label>
                <div className="flex flex-wrap gap-2">
                  <select
                    className={`${phxSelectClassName} min-w-0 flex-1 basis-48`}
                    disabled={busy || addable.length === 0}
                    id={`hr-forms-add-${pack}`}
                    onChange={(event) => setAdding((current) => ({ ...current, [pack]: event.target.value }))}
                    value={adding[pack]}
                  >
                    <option value="">— choose a paper —</option>
                    {addable.map(([folder, steps]) => (
                      <optgroup key={folder} label={folder}>
                        {steps.map((step) => (
                          <option key={step} value={step}>
                            {arrangedStepLabel(step)}
                            {draft[other].includes(step) ? ` (also on ${PACKAGE_TITLES[other]})` : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <Button
                    className="h-10 gap-1.5"
                    disabled={busy || !adding[pack]}
                    onClick={() => {
                      add(pack, adding[pack] as LeaverStep);
                      setAdding((current) => ({ ...current, [pack]: "" }));
                    }}
                    type="button"
                    variant="secondary"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </Button>
                </div>
              </div>
            </section>
          );
        })}

        <section className={columnClassName}>
          <header className={columnHeaderClassName}>
            <h3 className="text-sm font-black text-phx-ink">Another paper</h3>
            <span className="text-phx-xs font-bold text-phx-ink-soft">
              {outside.length} {outside.length === 1 ? "paper" : "papers"}
            </span>
          </header>
          <p className="px-4 pt-3 text-phx-xs font-semibold leading-relaxed text-phx-ink-soft">
            Chosen one at a time, for one person. Add any of them to a package.
          </p>
          {outside.length === 0 ? (
            <p className="px-4 py-3 text-sm font-semibold text-phx-ink-soft">Every paper is on a package.</p>
          ) : (
            // A long list scrolls inside its own column on a desk, so the three columns stay side by side.
            <div className="mt-2 lg:max-h-[70vh] lg:overflow-y-auto">
              {groupByFolder(outside).map(([folder, steps]) => (
                <div key={folder}>
                  <p className="border-y border-phx-line bg-phx-paper px-4 py-1.5 text-phx-xs font-black uppercase tracking-wide text-phx-ink-soft">
                    {folder}
                  </p>
                  <ul className="flex flex-col">
                    {steps.map((step) => (
                      <li
                        className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-phx-line px-4 py-2 last:border-b-0"
                        key={step}
                      >
                        <span className="min-w-0 flex-1 basis-40 break-words text-sm font-bold text-phx-ink">
                          {arrangedStepLabel(step)}
                        </span>
                        <span className="flex gap-1.5">
                          {ARRANGED_PACKAGES.map((pack) => (
                            <Button
                              aria-label={`Add ${arrangedStepLabel(step)} to ${PACKAGE_TITLES[pack]}`}
                              className="h-8 gap-1"
                              disabled={busy}
                              key={pack}
                              onClick={() => add(pack, step)}
                              size="xs"
                              type="button"
                              variant="outline"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {PACKAGE_TITLES[pack]}
                            </Button>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-phx-line pt-3">
        <Button className="h-10 gap-1.5" disabled={busy || !dirty} onClick={() => save(draft)} type="button">
          <Save className="h-4 w-4" />
          {busy ? "Saving" : "Save the arrangement"}
        </Button>
        <Button
          className="h-10 gap-1.5"
          disabled={busy || !dirty}
          onClick={() => change(saved)}
          type="button"
          variant="outline"
        >
          <Undo2 className="h-4 w-4" />
          Undo changes
        </Button>
        <Button
          className="h-10 gap-1.5"
          disabled={busy || (isStandard && !arranged)}
          onClick={() => save({ leaver: null, newHire: null })}
          type="button"
          variant="ghost"
        >
          <RotateCcw className="h-4 w-4" />
          Put back the standard order
        </Button>
        {dirty ? <span className="text-phx-xs font-black uppercase tracking-wide text-phx-warn">Not saved yet</span> : null}
      </div>
    </div>
  );
}
