"use client";

// ─── Phoenix form kit ─────────────────────────────────────────────────────────
//
// 🔒 Owner rule, 2026-10-06: every form in the system — admin shell or employee
// portal — wears the Adverse Drug Reaction Report's design. These are that
// form's own components, lifted here so a form is ASSEMBLED rather than
// re-skinned. The raw class strings live in `./form-tokens.ts`; this file is the
// markup around them.
//
// Use `FormField` for a labelled control, `FormWizard` for a multi-step form,
// `FormBlock` for a repeating sub-block, `FormActions` for the footer. A form
// that needs a shape none of these cover still takes its CLASSES from
// `form-tokens.ts` — the tokens are the rule, the components are the shortcut.

import type { ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  phxButtonAccentClassName,
  phxButtonAddBlockClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxFieldGridClassName,
  phxFieldMessageClassName,
  phxFormActionsClassName,
  phxFormBlockClassName,
  phxFormBlockHeaderClassName,
  phxFormErrorClassName,
  phxFormPanelClassName,
  phxHintClassName,
  phxLabelClassName,
  phxRequiredMarkClassName,
} from "./form-tokens";

// ─── Label and field ──────────────────────────────────────────────────────────

export function FieldLabel({
  children,
  required,
  htmlFor,
  className,
}: {
  children: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn(phxLabelClassName, className)}>
      {children}
      {required && <span className={phxRequiredMarkClassName}>*</span>}
    </label>
  );
}

/**
 * A labelled control. The label, the control, an optional hint and an optional
 * validation message, stacked in the one order every Phoenix form uses.
 */
export function FormField({
  label,
  required,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {label !== undefined && (
        <FieldLabel required={required} htmlFor={htmlFor}>
          {label}
        </FieldLabel>
      )}
      {children}
      {hint !== undefined && <span className={phxHintClassName}>{hint}</span>}
      {error ? <span className={phxFieldMessageClassName}>{error}</span> : null}
    </div>
  );
}

/** The standard field grid. See `phxFieldGridClassName` for why the ladder. */
export function FormGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(phxFieldGridClassName, className)}>{children}</div>;
}

// ─── Repeating blocks ─────────────────────────────────────────────────────────

export function FormBlockHeader({
  label,
  action,
  className,
}: {
  label: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(phxFormBlockHeaderClassName, className)}>
      <span className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-wide text-slate-700">
        <span aria-hidden className="h-3.5 w-1 bg-orange-500" />
        {label}
      </span>
      {action}
    </div>
  );
}

export function FormBlock({
  label,
  action,
  className,
  children,
}: {
  label?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(phxFormBlockClassName, className)}>
      {label !== undefined && <FormBlockHeader label={label} action={action} />}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function AddBlockButton({
  onClick,
  children,
  className,
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={cn(phxButtonAddBlockClassName, className)}>
      {children}
    </button>
  );
}

// ─── Checkable tile ───────────────────────────────────────────────────────────

export function CheckTile({
  checked,
  onChange,
  children,
  name,
  type = "checkbox",
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  name?: string;
  type?: "checkbox" | "radio";
  className?: string;
}) {
  return (
    <label className={cn(phxCheckTileClassName(checked), className)}>
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={phxCheckInputClassName}
      />
      {children}
    </label>
  );
}

// ─── Errors and actions ───────────────────────────────────────────────────────

export function FormError({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn(phxFormErrorClassName, className)}>
      {children}
    </p>
  );
}

/** The footer rule with the secondary action left and the primary one right. */
export function FormActions({
  left,
  right,
  className,
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(phxFormActionsClassName, className)}>
      <div className="flex items-center gap-2">{left}</div>
      <div className="flex items-center gap-2">{right}</div>
    </div>
  );
}

// ─── The step header every form section carries ───────────────────────────────

export function FormStepHeading({
  eyebrow,
  title,
  ordinal,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Printed as the big ghost number on the right, e.g. `3` → `03`. */
  ordinal?: number;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex items-center justify-between border-b border-slate-200 pb-4", className)}>
      <div className="min-w-0">
        {eyebrow !== undefined && (
          <p className="text-phx-2xs font-black uppercase tracking-[0.25em] text-orange-600">{eyebrow}</p>
        )}
        <h2 className="mt-0.5 text-lg font-black text-slate-900">{title}</h2>
      </div>
      {ordinal !== undefined && (
        <span className="select-none text-4xl font-black tabular-nums text-slate-200" aria-hidden>
          {String(ordinal).padStart(2, "0")}
        </span>
      )}
    </div>
  );
}

// ─── The wizard shell ─────────────────────────────────────────────────────────

export type FormWizardStep = {
  /** Short rail label, e.g. "Patient Info". */
  label: string;
  /** One line under the rail label, e.g. "Who the report is about". */
  description?: string;
  /** The heading over the step body, e.g. "Patient Information". */
  title?: string;
};

function VerticalStepper({
  steps,
  step,
  onJump,
}: {
  steps: FormWizardStep[];
  step: number;
  onJump: (target: number) => void;
}) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const clickable = num < step;
        const last = i === steps.length - 1;
        return (
          <li key={s.label} className="relative">
            {!last && (
              <span
                aria-hidden
                className={[
                  "absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px",
                  done ? "bg-orange-400" : "bg-slate-200",
                ].join(" ")}
              />
            )}
            <button
              type="button"
              onClick={() => clickable && onJump(num)}
              disabled={!clickable}
              aria-current={active ? "step" : undefined}
              className={[
                "group relative flex w-full items-start gap-3 px-3 py-3 text-left transition",
                active ? "bg-orange-50" : "bg-transparent",
                clickable ? "cursor-pointer hover:bg-slate-50" : "cursor-default",
              ].join(" ")}
            >
              {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-orange-500" />}
              <span
                className={[
                  "z-10 flex h-8 w-8 shrink-0 items-center justify-center text-xs font-black",
                  active
                    ? "bg-orange-600 text-white"
                    : done
                      ? "bg-orange-100 text-orange-700"
                      : "border border-slate-300 bg-white text-slate-400",
                ].join(" ")}
              >
                {done ? <Check className="h-4 w-4" /> : num}
              </span>
              <span className="min-w-0">
                <span
                  className={[
                    "block text-phx-xs font-black uppercase tracking-wide",
                    active ? "text-slate-900" : done ? "text-slate-700" : "text-slate-400",
                  ].join(" ")}
                >
                  {s.label}
                </span>
                {s.description && <span className="mt-0.5 block text-xs text-slate-400">{s.description}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MobileStepper({ steps, step }: { steps: FormWizardStep[]; step: number }) {
  return (
    <div className="flex items-center lg:hidden">
      {steps.map((s, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        return (
          <div key={s.label} className={["flex items-center", i < steps.length - 1 ? "flex-1" : ""].join(" ")}>
            <span
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center text-phx-2xs font-black",
                active
                  ? "bg-orange-600 text-white"
                  : done
                    ? "bg-orange-100 text-orange-700"
                    : "border border-slate-300 bg-white text-slate-400",
              ].join(" ")}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : num}
            </span>
            {i < steps.length - 1 && (
              <span className={["mx-1.5 h-px flex-1", done ? "bg-orange-400" : "bg-slate-200"].join(" ")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The progress strip: "Step 2 of 4", the percentage, and the orange bar. */
export function FormProgress({
  step,
  total,
  className,
}: {
  step: number;
  total: number;
  className?: string;
}) {
  const pct = Math.round((step / total) * 100);
  return (
    <div className={className}>
      <div className="flex items-center justify-between text-phx-2xs font-black uppercase tracking-wide text-slate-500">
        <span>
          Step {step} of {total}
        </span>
        <span className="text-orange-600">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full bg-slate-200">
        <div className="h-full bg-orange-600 transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * The whole multi-step form shell: the titled header with its progress bar, the
 * numbered rail on desktop, the compact stepper on a phone, the step heading,
 * the error banner, and the Back / Next / Submit footer.
 *
 * The caller owns the step state and the validation — this owns the look.
 */
export function FormWizard({
  steps,
  step,
  onStepChange,
  eyebrow,
  title,
  description,
  badge,
  footnote,
  error,
  submitting,
  submitLabel = "Submit",
  nextLabel = "Next",
  backLabel = "Back",
  onNext,
  onSubmit,
  header = "panel",
  className,
  children,
}: {
  steps: FormWizardStep[];
  step: number;
  onStepChange: (next: number) => void;
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  /** The reassurance line pinned to the bottom of the desktop rail. */
  footnote?: ReactNode;
  error?: ReactNode;
  submitting?: boolean;
  submitLabel?: string;
  nextLabel?: string;
  backLabel?: string;
  /** Called on Next — validate there and return false to stay on this step. */
  onNext: () => boolean | void;
  onSubmit: () => void;
  /**
   * `panel` paints the titled header (admin shell). `strip` paints only the
   * progress strip, for a page whose shell already prints the title — a second
   * dark header on one page is a defect the owner has had removed twice.
   */
  header?: "panel" | "strip";
  className?: string;
  children: ReactNode;
}) {
  const total = steps.length;
  const pct = Math.round((step / total) * 100);
  const current = steps[step - 1];

  return (
    <div className={cn(header === "panel" ? "overflow-hidden" : phxFormPanelClassName, className)}>
      {header === "panel" ? (
        <div className="border-b border-phx-line bg-[#FCFDFE] px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              {eyebrow !== undefined && (
                <p className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-600">{eyebrow}</p>
              )}
              {title !== undefined && <h2 className="mt-1 text-lg font-black text-slate-900">{title}</h2>}
              {description !== undefined && (
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
              )}
            </div>
            {badge}
          </div>
          <FormProgress step={step} total={total} className="mt-4" />
        </div>
      ) : (
        <div className="border-b border-slate-100 px-5 py-4 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
              <span>
                Step {step} of {total}
              </span>
              <span className="text-orange-600">{pct}%</span>
            </div>
            {badge}
          </div>
          {description !== undefined && <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>}
          <div className="mt-3 h-1.5 w-full bg-slate-100">
            <div className="h-1.5 bg-orange-500 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[244px_minmax(0,1fr)]">
        <aside className="hidden border-r border-slate-200 bg-slate-50/60 lg:flex lg:flex-col">
          <nav className="p-3" aria-label="Form steps">
            <VerticalStepper
              steps={steps}
              step={step}
              onJump={(target) => {
                if (target < step) onStepChange(target);
              }}
            />
          </nav>
          {footnote !== undefined && (
            <div className="mt-auto border-t border-slate-200 p-4">
              <div className="flex items-start gap-2.5">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                <p className="text-xs leading-relaxed text-slate-500">{footnote}</p>
              </div>
            </div>
          )}
        </aside>

        <div className="p-4 sm:p-6">
          <div className="mb-5 lg:hidden">
            <MobileStepper steps={steps} step={step} />
          </div>

          <FormStepHeading
            eyebrow={`Step ${step} of ${total}`}
            title={current?.title ?? current?.label ?? ""}
            ordinal={step}
          />

          {children}

          {error ? <FormError className="mt-5">{error}</FormError> : null}

          <FormActions
            left={
              <button
                type="button"
                className={phxButtonGhostClassName}
                onClick={() => onStepChange(step - 1)}
                disabled={step === 1}
              >
                <ChevronLeft className="h-4 w-4" />
                {backLabel}
              </button>
            }
            right={
              step < total ? (
                <button
                  type="button"
                  className={phxButtonPrimaryClassName}
                  onClick={() => {
                    if (onNext() !== false) onStepChange(step + 1);
                  }}
                >
                  {nextLabel}
                  <ChevronRight className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  className={phxButtonAccentClassName}
                  onClick={onSubmit}
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : submitLabel}
                </button>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

export {
  phxButtonAccentClassName,
  phxButtonAddBlockClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxFieldGridClassName,
  phxFieldGridTwoClassName,
  phxFieldInvalidClassName,
  phxFormPanelClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "./form-tokens";
