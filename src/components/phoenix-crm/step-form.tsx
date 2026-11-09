"use client";

/**
 * Phoenix CRM — the step form (owner, 2026-10-02: "i want the same form to be used in visits entry and
 * plans making in phx crm", with a screenshot of Report It).
 *
 * 🔴 IT IS NO LONGER A COPY. Until 2026-10-07 this file carried Report It's whole shell a second time,
 * class for class — the strip, the rail, the phone's stepper, the heading with its large "01" — so a
 * token change reached Report It and not the CRM, and the two could drift apart without either going
 * red. It is now a READER of the shared kit (`src/components/ui/form-kit.tsx`), exactly as Report It
 * is. What the CRM needs and Report It does not is expressed as PROPS of that kit, never as a second
 * implementation: a jump rule (`canJump`, because here a tap IS the step's answer), a footer the step
 * owns, no second card (`panel={false}` — the CRM panel already draws one), and blocks that run to the
 * edge (`bleed`). Report It itself is still untouched: its design is the reference, never a template
 * to edit.
 *
 * Two forms wear it: the rep's weekly plan (Week → Day → Customers → Send) and Add visit (Visit type →
 * Customer → Products and comment → Log the visit). On Add visit a TAP moves him on (owner, same day:
 * "a tap moves on") — choosing the visit type or the customer is the step's answer, so the visit costs
 * no extra press for the steps that are a choice.
 *
 * Square corners and no sideways scroll, like every other CRM screen.
 */

import { createContext, useContext, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { FormWizard } from "@/components/ui/form-kit";

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

/**
 * Inside a step of the validation form the step's own heading says what the step is, so the numbered
 * titles the shared editors print over their blocks ("3 · Signboard photo") would be a second heading
 * with a number that no longer matches the rail. Blocks read this and leave their title off.
 */
const CrmUntitledBlocksContext = createContext(false);

export function CrmUntitledBlocks({ children }: { children: ReactNode }) {
  return <CrmUntitledBlocksContext.Provider value={true}>{children}</CrmUntitledBlocksContext.Provider>;
}

export function useUntitledCrmBlocks(): boolean {
  return useContext(CrmUntitledBlocksContext);
}

// The same three buttons as Report It's form.
export const crmStepBackClassName =
  "inline-flex min-h-11 items-center gap-1.5 rounded-none border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40";
export const crmStepNextClassName =
  "inline-flex min-h-11 items-center gap-1.5 rounded-none border border-slate-900 bg-slate-900 px-5 py-2 text-sm font-bold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50";
export const crmStepFinishClassName =
  "inline-flex min-h-11 items-center gap-1.5 rounded-none border border-orange-600 bg-orange-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-orange-700 disabled:pointer-events-none disabled:opacity-50";

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
  return (
    <div className="min-w-0" data-crm-step-form="">
      <FormWizard
        badge={
          chip ? (
            <span className="inline-flex max-w-full items-center gap-1.5 break-words border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-sm font-black uppercase tracking-[0.18em] text-slate-500">
              {chip}
            </span>
          ) : undefined
        }
        bleed
        canJump={canJump}
        description={
          required ? (
            <>
              Fields marked with <span className="font-bold text-orange-600">*</span> are required.
            </>
          ) : undefined
        }
        // A step that draws its own foot passes nothing, and then the form shows no foot at all —
        // never the kit's Back / Next, which would be a second Back on the same screen.
        footer={footer ?? <></>}
        footnote={aside}
        footnoteIcon={false}
        header="strip"
        onStepChange={onJump}
        panel={false}
        step={step}
        steps={[...steps]}
      >
        {children}
      </FormWizard>
    </div>
  );
}
