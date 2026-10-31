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

// ─── Rating scale ─────────────────────────────────────────────────────────────

export type RatingScaleOption = {
  value: number;
  /** Printed in the tile, e.g. "4". */
  label: string;
  /** The tile's tooltip and screen-reader name, e.g. "4 - Strong". */
  title?: string;
};

/**
 * A row of score tiles in the CheckTile skin — a 0 to 5 rating, with an optional "not rated" tile
 * for a score that may be left empty (the Team Coaching Skills Survey's "Not observed"). One tap is
 * the answer; tapping the chosen tile again does nothing. Square, like every tile in the kit.
 */
export function RatingScale({
  options,
  value,
  onChange,
  emptyLabel,
  disabled,
  ariaLabel,
  className,
}: {
  options: RatingScaleOption[];
  value: number | null;
  onChange: (next: number | null) => void;
  /** When given, an extra tile that clears the score. */
  emptyLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "grid gap-1.5",
        emptyLabel
          ? "grid-cols-6 sm:grid-cols-[repeat(6,minmax(0,1fr))_minmax(0,2fr)]"
          : "grid-cols-6",
        className,
      )}
    >
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-label={option.title ?? option.label}
            aria-pressed={checked}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              phxCheckTileClassName(checked),
              "justify-center px-0 tabular-nums",
              checked && "font-black",
              disabled && "cursor-default opacity-70",
            )}
          >
            {option.label}
          </button>
        );
      })}
      {emptyLabel ? (
        <button
          type="button"
          aria-pressed={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
          className={cn(
            phxCheckTileClassName(value === null),
            "col-span-6 justify-center sm:col-span-1",
            disabled && "cursor-default opacity-70",
          )}
        >
          {emptyLabel}
        </button>
      ) : null}
    </div>
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
  canJump,
}: {
  steps: FormWizardStep[];
  step: number;
  onJump: (target: number) => void;
  /** Which steps the rail may open. Default: the ones already answered. */
  canJump?: (target: number) => boolean;
}) {
  return (
    <ol className="relative">
      {steps.map((s, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const clickable = canJump ? num !== step && canJump(num) : num < step;
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

function MobileStepper({
  steps,
  step,
  onJump,
  canJump,
}: {
  steps: FormWizardStep[];
  step: number;
  onJump: (target: number) => void;
  canJump?: (target: number) => boolean;
}) {
  return (
    <div className="flex items-center lg:hidden">
      {steps.map((s, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const clickable = canJump ? num !== step && canJump(num) : num < step;
        return (
          <div key={s.label} className={["flex items-center", i < steps.length - 1 ? "flex-1" : ""].join(" ")}>
            <button
              type="button"
              aria-label={`Step ${num}: ${s.label}`}
              aria-current={active ? "step" : undefined}
              disabled={!clickable}
              onClick={() => clickable && onJump(num)}
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center text-phx-2xs font-black",
                clickable ? "cursor-pointer" : "cursor-default",
                active
                  ? "bg-orange-600 text-white"
                  : done
                    ? "bg-orange-100 text-orange-700"
                    : "border border-slate-300 bg-white text-slate-400",
              ].join(" ")}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : num}
            </button>
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
  panel = true,
  canJump,
  footer,
  bleed = false,
  footnoteIcon = true,
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
  /** Called on Next — validate there and return false to stay on this step. Unused when `footer` is given. */
  onNext?: () => boolean | void;
  onSubmit?: () => void;
  /**
   * `panel` paints the titled header (admin shell). `strip` paints only the
   * progress strip, for a page whose shell already prints the title — a second
   * dark header on one page is a defect the owner has had removed twice.
   */
  header?: "panel" | "strip";
  /**
   * `strip` draws the kit's own card around the form. False when the page already
   * draws one — Phoenix CRM's panels do, and two cards on one screen is the defect
   * the owner has had removed twice.
   */
  panel?: boolean;
  /**
   * Which steps the rail and the phone's stepper may open. The default is the ones
   * already answered; a form where a tap IS the answer passes its own rule.
   */
  canJump?: (target: number) => boolean;
  /** Replaces Back / Next / Submit, for a form whose steps finish in their own way. */
  footer?: ReactNode;
  /** Let the step's own blocks run to the card's edge, as Phoenix CRM's do. */
  bleed?: boolean;
  /** The shield beside the rail's footnote. Off for a note that is not a reassurance. */
  footnoteIcon?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const total = steps.length;
  const pct = Math.round((step / total) * 100);
  const current = steps[step - 1];
  const next = onNext ?? (() => true);
  const submit = onSubmit ?? (() => {});

  return (
    <div className={cn(header === "panel" ? "overflow-hidden" : panel ? phxFormPanelClassName : "min-w-0", className)}>
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
            <VerticalStepper steps={steps} step={step} canJump={canJump} onJump={onStepChange} />
          </nav>
          {footnote !== undefined && (
            <div className="mt-auto border-t border-slate-200 p-4">
              <div className="flex items-start gap-2.5">
                {footnoteIcon && <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />}
                <p className="text-xs leading-relaxed text-slate-500">{footnote}</p>
              </div>
            </div>
          )}
        </aside>

        <div className="min-w-0 p-4 sm:p-6">
          <div className="mb-5 lg:hidden">
            <MobileStepper steps={steps} step={step} canJump={canJump} onJump={onStepChange} />
          </div>

          <FormStepHeading
            eyebrow={`Step ${step} of ${total}`}
            title={current?.title ?? current?.label ?? ""}
            ordinal={step}
          />

          {bleed ? <div className="-mx-4 min-w-0 sm:-mx-5">{children}</div> : children}

          {error ? <FormError className="mt-5">{error}</FormError> : null}

          {footer ?? (
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
                    if (next() !== false) onStepChange(step + 1);
                  }}
                >
                  {nextLabel}
                  <ChevronRight className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  className={phxButtonAccentClassName}
                  onClick={submit}
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : submitLabel}
                </button>
              )
            }
          />
          )}
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
