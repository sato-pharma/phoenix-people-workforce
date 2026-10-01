"use client";

/**
 * Phoenix CRM — the step form (owner, 2026-10-02: "i want the same form to be used in visits entry and
 * plans making in phx crm", with a screenshot of Report It).
 *
 * The SAME look as Report It's form (`src/components/report-it/report-it-form.tsx`), class for class:
 * the light progress strip ("Step 1 of 4 · 25%"), the numbered rail on the left with the active step's
 * orange bar, the compact stepper on a phone, the step's heading with its large "01", and Back / Next
 * at the foot. Report It itself is not touched — its design is the reference, never a template to edit.
 *
 * Two forms wear it: the rep's weekly plan (Week → Day → Customers → Send) and Add visit (Visit type →
 * Customer → Products and comment → Log the visit). On Add visit a TAP moves him on (owner, same day:
 * "a tap moves on") — choosing the visit type or the customer is the step's answer, so the visit costs
 * no extra press for the steps that are a choice.
 *
 * Square corners and no sideways scroll, like every other CRM screen.
 */

import { createContext, useContext, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export type CrmStep = {
  /** The rail's short name — "Week". */
  label: string;
  /** The rail's line under it — "Which week you plan". */
  description: string;
  /** The heading over the step's content — "Choose the week". */
  title: string;
};

/**
 * Inside the step form, a screen's own frame (`CrmPanel`'s card and `CrmBackBar`) is drawn by the form
 * instead: one card, one Back. The screens of Add visit were each a card with a back bar of their own,
 * and they keep that shape everywhere else.
 */
const CrmStepFrameContext = createContext(false);

export function CrmStepFrame({ children }: { children: ReactNode }) {
  return <CrmStepFrameContext.Provider value={true}>{children}</CrmStepFrameContext.Provider>;
}

export function useInsideCrmStepForm(): boolean {
  return useContext(CrmStepFrameContext);
}

// The same three buttons as Report It's form.
export const crmStepBackClassName =
  "inline-flex min-h-11 items-center gap-1.5 rounded-none border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";
export const crmStepNextClassName =
  "inline-flex min-h-11 items-center gap-1.5 rounded-none border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50";
export const crmStepFinishClassName =
  "inline-flex min-h-11 items-center gap-1.5 rounded-none border border-orange-600 bg-orange-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-orange-700 disabled:pointer-events-none disabled:opacity-50";

function VerticalStepper({
  canJump,
  onJump,
  step,
  steps,
}: {
  canJump: (n: number) => boolean;
  onJump: (n: number) => void;
  step: number;
  steps: ReadonlyArray<CrmStep>;
}) {
  return (
    <ol className="relative">
      {steps.map((entry, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const clickable = num !== step && canJump(num);
        const last = i === steps.length - 1;
        return (
          <li className="relative" key={entry.label}>
            {!last ? (
              <span aria-hidden className={cn("absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px", done ? "bg-orange-400" : "bg-slate-200")} />
            ) : null}
            <button
              aria-current={active ? "step" : undefined}
              className={cn(
                "group relative flex w-full items-start gap-3 rounded-none px-3 py-3 text-left transition",
                active ? "bg-orange-50" : "bg-transparent",
                clickable ? "cursor-pointer hover:bg-slate-50" : "cursor-default",
              )}
              disabled={!clickable}
              onClick={() => clickable && onJump(num)}
              type="button"
            >
              {active ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-orange-500" /> : null}
              <span
                className={cn(
                  "z-10 flex h-8 w-8 shrink-0 items-center justify-center text-xs font-black",
                  active ? "bg-orange-600 text-white" : done ? "bg-orange-100 text-orange-700" : "border border-slate-300 bg-white text-slate-400",
                )}
              >
                {done ? <Check className="h-4 w-4" /> : num}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-phx-xs font-black uppercase tracking-wide", active ? "text-slate-900" : done ? "text-slate-700" : "text-slate-400")}>
                  {entry.label}
                </span>
                <span className="mt-0.5 block break-words text-xs text-slate-400">{entry.description}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MobileStepper({
  canJump,
  onJump,
  step,
  steps,
}: {
  canJump: (n: number) => boolean;
  onJump: (n: number) => void;
  step: number;
  steps: ReadonlyArray<CrmStep>;
}) {
  return (
    <div className="flex items-center lg:hidden">
      {steps.map((entry, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        return (
          <div className={cn("flex items-center", i < steps.length - 1 ? "flex-1" : "")} key={entry.label}>
            <button
              aria-current={active ? "step" : undefined}
              aria-label={`Step ${num}: ${entry.label}`}
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-none text-phx-xs font-black",
                active ? "bg-orange-600 text-white" : done ? "bg-orange-100 text-orange-700" : "border border-slate-300 bg-white text-slate-400",
              )}
              disabled={active || !canJump(num)}
              onClick={() => onJump(num)}
              type="button"
            >
              {done ? <Check className="h-3.5 w-3.5" /> : num}
            </button>
            {i < steps.length - 1 ? <span className={cn("mx-1.5 h-px flex-1", done ? "bg-orange-400" : "bg-slate-200")} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Back on the left, the step's way on at the right — Report It's foot. */
export function CrmStepFooter({
  back,
  backLabel = "Back",
  children,
}: {
  /** Null greys Back out (the first step of a form opened on its own). */
  back: (() => void) | null;
  backLabel?: string;
  /** The buttons on the right: Next, or the step's own finishing button. */
  children?: ReactNode;
}) {
  return (
    <div className="mt-6 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-5">
      <button className={crmStepBackClassName} disabled={back === null} onClick={() => back?.()} type="button">
        <ChevronLeft aria-hidden className="h-4 w-4" />
        {backLabel}
      </button>
      {children ? <div className="flex min-w-0 flex-wrap justify-end gap-2">{children}</div> : null}
    </div>
  );
}

export function CrmStepNext({ children = "Next", disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={crmStepNextClassName} disabled={disabled} onClick={onClick} type="button">
      {children}
      <ChevronRight aria-hidden className="h-4 w-4" />
    </button>
  );
}

export function CrmStepForm({
  aside,
  canJump = () => true,
  children,
  chip,
  footer,
  onJump,
  required = false,
  step,
  steps,
}: {
  /** The rail's foot — one line on what the form does with what he enters. */
  aside?: ReactNode;
  /** Which steps the rail may open from here. Every one, unless the form says otherwise. */
  canJump?: (step: number) => boolean;
  children: ReactNode;
  /** Right of "Step 1 of 4" — what the form is about, in one word or two. */
  chip?: ReactNode;
  /** Usually a CrmStepFooter. A step that draws its own foot passes nothing. */
  footer?: ReactNode;
  /** A step on the rail was pressed. */
  onJump: (step: number) => void;
  /** Say "Fields marked with * are required." under the strip. */
  required?: boolean;
  /** 1-based. */
  step: number;
  steps: ReadonlyArray<CrmStep>;
}) {
  const current = steps[step - 1] ?? steps[0];
  const pct = Math.round((step / steps.length) * 100);
  return (
    <div className="min-w-0" data-crm-step-form="">
      <div className="border-b border-slate-100 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
            <span>
              Step {step} of {steps.length}
            </span>
            <span className="text-orange-600">{pct}%</span>
          </div>
          {chip ? (
            <span className="inline-flex max-w-full items-center gap-1.5 break-words border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
              {chip}
            </span>
          ) : null}
        </div>
        {required ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Fields marked with <span className="font-bold text-orange-600">*</span> are required.
          </p>
        ) : null}
        <div className="mt-3 h-1.5 w-full bg-slate-100">
          <div className="h-1.5 bg-orange-500 transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[244px_minmax(0,1fr)]">
        <aside className="hidden border-r border-slate-200 bg-slate-50/60 lg:flex lg:flex-col">
          <nav aria-label="Steps" className="p-3">
            <VerticalStepper canJump={canJump} onJump={onJump} step={step} steps={steps} />
          </nav>
          {aside ? (
            <div className="mt-auto border-t border-slate-200 p-4">
              <p className="text-xs leading-relaxed text-slate-500">{aside}</p>
            </div>
          ) : null}
        </aside>

        <div className="min-w-0 p-4 sm:p-6">
          <div className="mb-5 lg:hidden">
            <MobileStepper canJump={canJump} onJump={onJump} step={step} steps={steps} />
          </div>

          <div className="mb-5 flex items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div className="min-w-0">
              <p className="text-phx-2xs font-black uppercase tracking-[0.25em] text-orange-600">
                Step {step} of {steps.length}
              </p>
              <h2 className="mt-0.5 break-words text-lg font-black text-slate-900">{current.title}</h2>
            </div>
            <span aria-hidden className="select-none text-4xl font-black tabular-nums text-slate-200">
              {String(step).padStart(2, "0")}
            </span>
          </div>

          {/* The step's own blocks keep their padding rule; inside the form they sit flush with the heading. */}
          <div className="-mx-4 min-w-0 sm:-mx-5">{children}</div>

          {footer}
        </div>
      </div>
    </div>
  );
}
