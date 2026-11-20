"use client";

/**
 * Phoenix CRM — the module's own building blocks.
 *
 * Every Phoenix CRM screen draws with these and nothing else, so the whole module is restyled here in
 * one place. Since 2026-11-20 they wear the portal's LANDING KIT (`employee-portal/landing-kit.tsx`):
 * white panels on a hairline with the platform's soft depth token, the orange tick and navy small
 * capitals for a title, status as a coloured small-capital word on a thin rail instead of a filled
 * pill, navy figures in tabular numerals, and navy buttons (orange is never a fill behind words). The
 * header sentence a screen passes as `description` carries `phx-header-note`, which the portal shell
 * does not draw (owner, 2026-11-20: "DELETE ANY TEXT UNDER ANY HEADER") and the admin shell keeps.
 * Two house rules are built in:
 * no rounded corners anywhere (`rounded-none` is written out, because a phone's native input and
 * select draw their own), and nothing that scrolls sideways — rows wrap, choices wrap, tables are
 * fixed-width with named columns and turn into cards below the `md` breakpoint.
 */

import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { ArrowLeft, ChevronDown, LoaderCircle, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { approvalActionToneClassName } from "@/components/approvals-hub/approval-action-kit";
import { LANDING_FOCUS, LANDING_INK, LandingTick, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { countText, type Tone } from "@/components/phoenix-crm/format";
import { useInsideCrmStepForm, useUntitledCrmBlocks } from "@/components/phoenix-crm/step-form";
import { useCrmComboBoxes } from "@/components/phoenix-crm/surface";
import {
  phxCheckInputClassName,
  phxFieldClassName,
  phxFieldMessageClassName,
  phxHintClassName,
  phxLabelTextClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

/** The landing kit's white sheet: a hairline and the platform's soft depth token, square. */
export const crmPanelClassName = `rounded-none border border-slate-200 bg-white ${adminSoftDepthClassName}`;

/** The small capitals every label, column head and quiet heading is set in. */
export const crmLabelClassName = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

export const crmInputClassName =
  `${phxFieldClassName} min-w-0`;

export const crmSelectClassName = crmInputClassName;

export const crmTextareaClassName =
  cn(phxTextareaClassName, "min-h-24 min-w-0 leading-6");

export function CrmPanel({
  actions,
  children,
  className,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title?: ReactNode;
}) {
  const hasHeader = Boolean(title || eyebrow || description || actions);
  // Inside the step form the form IS the card: a screen keeps its content and loses only its frame.
  const framed = useInsideCrmStepForm();
  return (
    <section className={cn(framed ? undefined : crmPanelClassName, "min-w-0", className)}>
      {hasHeader ? (
        // The landing panel's header: the eyebrow (the area) in slate capitals over the title, the
        // title behind the orange tick in navy capitals, the actions on the right. It WRAPS, so a long
        // title drops its actions to a second line on a 280px phone rather than squeezing either.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-3 py-2.5 sm:px-4">
          <div className="min-w-0 flex-1">
            {title && eyebrow ? <p className={cn("mb-1 break-words", crmLabelClassName)}>{eyebrow}</p> : null}
            {title || eyebrow ? (
              <h2 className={cn("flex min-w-0 items-center gap-2 break-words text-phx-sm font-black uppercase tracking-[0.1em]", LANDING_INK)}>
                <LandingTick />
                <span className="min-w-0">{title ?? eyebrow}</span>
              </h2>
            ) : null}
            {description ? <div className="phx-header-note mt-1 max-w-3xl text-sm leading-6 text-slate-500">{description}</div> : null}
          </div>
          {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A labelled block inside a panel. */
export function CrmBlock({
  actions,
  children,
  className,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  const untitled = useUntitledCrmBlocks();
  const shownTitle = untitled ? undefined : title;
  return (
    <div className={cn("min-w-0 px-4 py-4 sm:px-5", className)}>
      {shownTitle || actions ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {shownTitle ? <h3 className={cn("break-words", crmLabelClassName)}>{shownTitle}</h3> : <span />}
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * A note is the landing kit's rail line: a white sheet on a hairline, its tone on a 4px rail at the left
 * and in the title's small capitals — never a tinted box. The words stay slate and wrap.
 */
const NOTE_TONES = {
  bad: { rail: "bg-rose-500", title: "text-rose-700" },
  good: { rail: "bg-emerald-500", title: "text-emerald-700" },
  info: { rail: "bg-sky-500", title: "text-sky-700" },
  neutral: { rail: "bg-slate-300", title: LANDING_INK },
  warn: { rail: "bg-amber-500", title: "text-amber-700" },
} as const;

export type NoteTone = keyof typeof NOTE_TONES;

export function CrmNote({
  children,
  className,
  title,
  tone = "neutral",
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  tone?: NoteTone;
}) {
  return (
    <div
      className={cn("flex min-w-0 gap-3 rounded-none border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-700", className)}
      role={tone === "bad" ? "alert" : undefined}
    >
      <span aria-hidden="true" className={cn("w-1 shrink-0 self-stretch", NOTE_TONES[tone].rail)} />
      <div className="min-w-0 flex-1">
        {title ? <p className={cn("break-words text-phx-xs font-bold uppercase leading-5 tracking-[0.1em]", NOTE_TONES[tone].title)}>{title}</p> : null}
        {children ? <div className={cn("break-words", title ? "mt-0.5" : undefined)}>{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * The kit's action shape (`landingActionClassName`): navy solid for the one primary action, a navy
 * frame for the rest, small tracked capitals, the orange focus outline. `success` and `danger` are a
 * decision's two halves, so they take the approvals hub's own approve and reject colours
 * (`approval-action-kit.tsx`) — one look for every decision in the platform.
 */
const BUTTON_VARIANTS = {
  danger: approvalActionToneClassName.reject,
  ghost: "border border-transparent bg-transparent text-slate-600 hover:bg-slate-50 hover:text-[#08111f]",
  primary: landingActionClassName("solid"),
  secondary: landingActionClassName("outline"),
  success: approvalActionToneClassName.approve,
} as const;

export type CrmButtonVariant = keyof typeof BUTTON_VARIANTS;

export function CrmButton({
  busy = false,
  children,
  className,
  disabled,
  size = "md",
  type = "button",
  variant = "secondary",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  size?: "sm" | "md";
  variant?: CrmButtonVariant;
}) {
  return (
    <button
      {...rest}
      aria-busy={busy || undefined}
      className={cn(
        BUTTON_VARIANTS[variant],
        // `shrink` undoes the kit's `shrink-0`: a long label in a narrow row wraps inside its button.
        "inline-flex min-w-0 shrink items-center justify-center gap-2 rounded-none text-center font-bold uppercase tracking-[0.08em] transition disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        LANDING_FOCUS,
        // A small button is still a thumb's target on a phone (40px); it tightens to 36px from `md` up.
        // The medium one keeps the 44px floor at every width (the kit's own 32px from `sm` is undone).
        size === "sm" ? "min-h-10 px-3 py-1.5 text-phx-xs sm:min-h-10 md:min-h-9" : "min-h-11 px-4 py-2 text-phx-sm sm:min-h-11",
        className,
      )}
      disabled={disabled || busy}
      type={type}
    >
      {busy ? <LoaderCircle aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function CrmField({
  children,
  className,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  className?: string;
  error?: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  label: ReactNode;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <label className={phxLabelTextClassName} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className={cn(phxHintClassName, "mt-0 break-words text-slate-500")}>{hint}</p> : null}
      {error ? <p className={cn(phxFieldMessageClassName, "mt-0 break-words")}>{error}</p> : null}
    </div>
  );
}

/**
 * A status is a coloured small-capital WORD on a thin rail, never a filled pill (the landing kit's
 * rule). `orange` keeps its name for the callers, but orange is the title tick's alone now, so the
 * word it marks is set in navy — the "this one is yours" emphasis, not an alarm.
 */
const PILL_TONES = {
  bad: { rail: "bg-rose-500", text: "text-rose-700" },
  good: { rail: "bg-emerald-500", text: "text-emerald-700" },
  info: { rail: "bg-sky-500", text: "text-sky-700" },
  neutral: { rail: "bg-slate-300", text: "text-slate-500" },
  orange: { rail: "bg-[#08111f]", text: LANDING_INK },
  warn: { rail: "bg-amber-500", text: "text-amber-700" },
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function CrmPill({ children, className, tone = "neutral" }: { children: ReactNode; className?: string; tone?: PillTone }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-none text-phx-xs font-bold uppercase leading-4 tracking-[0.08em]",
        PILL_TONES[tone].text,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("h-3 w-0.5 shrink-0", PILL_TONES[tone].rail)} />
      {children}
    </span>
  );
}

export function CrmEmpty({ action, message, title }: { action?: ReactNode; message?: ReactNode; title: ReactNode }) {
  return (
    // The kit's empty line: one calm statement, no icon in a tinted square.
    <div className="px-4 py-6 sm:px-5">
      <p className={cn("break-words text-sm font-bold", LANDING_INK)}>{title}</p>
      {message ? <div className="mt-1 max-w-2xl break-words text-sm leading-6 text-slate-500">{message}</div> : null}
      {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

export function CrmLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="grid gap-2 px-4 py-5 sm:px-5">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="h-4 w-2/5 animate-pulse rounded-none bg-slate-100 motion-reduce:animate-none" />
      <div aria-hidden="true" className="h-4 w-4/5 animate-pulse rounded-none bg-slate-100 motion-reduce:animate-none" />
      <div aria-hidden="true" className="h-4 w-3/5 animate-pulse rounded-none bg-slate-100 motion-reduce:animate-none" />
    </div>
  );
}

/** A load that failed, with a way to try again. */
export function CrmLoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <CrmNote tone="bad">
        <span>{message}</span>
        {onRetry ? (
          <span className="mt-2 block">
            <CrmButton onClick={onRetry} size="sm">
              Try again
            </CrmButton>
          </span>
        ) : null}
      </CrmNote>
    </div>
  );
}

/**
 * A save that did not go through, with the one thing a rep can do about it.
 *
 * 🔴 THE BUTTON APPEARS ONLY WHEN SENDING THE SAME THING AGAIN CAN WORK — pass `action.retry`,
 * which `useCrmAction` leaves null for a refusal and for a signed-out session, so a decision the
 * server already made never grows a button that asks the rep to press it twice. A dropped
 * connection is the case this exists for: before it, the sentence stood alone and the rep had to
 * find the form, fill it in and press Save again.
 */
export function CrmSaveError({
  message,
  onRetry,
  title = "Not saved",
  tone = "bad",
}: {
  message: string;
  onRetry?: (() => void) | null;
  title?: ReactNode;
  tone?: NoteTone;
}) {
  return (
    <CrmNote title={title} tone={tone}>
      <span className="block">{message}</span>
      {onRetry ? (
        <span className="mt-2 block">
          <CrmButton onClick={onRetry} size="sm">
            Try again
          </CrmButton>
        </span>
      ) : null}
    </CrmNote>
  );
}

/** A toned figure carries its tone on a 2px rail as well; a neutral one is a plain hairline cell. */
const STAT_BARS: Record<Tone, string> = {
  bad: "border-l-2 border-l-rose-500",
  good: "border-l-2 border-l-emerald-500",
  neutral: "",
  warn: "border-l-2 border-l-amber-500",
};

const STAT_VALUES: Record<Tone, string> = {
  bad: "text-rose-700",
  good: "text-emerald-700",
  neutral: LANDING_INK,
  warn: "text-amber-700",
};

export function CrmStat({ label, note, tone = "neutral", value }: { label: ReactNode; note?: ReactNode; tone?: Tone; value: ReactNode }) {
  return (
    <div className={cn("min-w-0 rounded-none border border-slate-200 bg-white px-3 py-2.5", STAT_BARS[tone])}>
      <p className={cn("break-words", crmLabelClassName)}>{label}</p>
      {/* `leading-tight`, not `leading-none`: a value such as "3 AM · 12 PM" wraps on a phone, and its
          two lines must not touch. */}
      <p className={cn("mt-1.5 break-words text-[22px] font-bold leading-tight tracking-[-0.02em] tabular-nums", STAT_VALUES[tone])}>{value}</p>
      {note ? <p className="mt-1 break-words text-xs leading-5 text-slate-500">{note}</p> : null}
    </div>
  );
}

/**
 * Two a row on a phone, four from `md`. A tablet (768–1023px, no sidebar) is wider than a 1024px
 * desktop with the sidebar open, so it gets the desktop's four rather than the phone's two.
 */
export function CrmStatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2 md:grid-cols-4", className)}>{children}</div>;
}

/**
 * How full something is, as one square hairline — the shape Today's AM and PM bars already use, so a
 * filling list reads the same everywhere: ORANGE while it fills, EMERALD the moment it is full.
 */
export function CrmFillBar({ full, label, of, value }: { full: boolean; label: string; of: number; value: number }) {
  const percent = of > 0 ? Math.min(100, Math.round((value / of) * 100)) : 0;
  return (
    <div
      aria-label={label}
      aria-valuemax={of}
      aria-valuemin={0}
      aria-valuenow={value}
      className="h-1.5 min-w-0 border border-slate-200 bg-slate-100"
      role="progressbar"
    >
      <div className={cn("h-full transition-[width] duration-500", full ? "bg-emerald-600" : "bg-orange-500")} style={{ width: `${percent}%` }} />
    </div>
  );
}

export type CrmChoiceOption<T extends string> = {
  value: T;
  label: ReactNode;
  note?: ReactNode;
  disabled?: boolean;
  /** "good" lights the option with an emerald rail and a soft bloom off it — a plan day that is full. */
  tone?: "good";
};

/** A one-of-several pick that wraps onto more rows instead of scrolling sideways. */
export function CrmChoice<T extends string>({
  className,
  columns = 3,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  columns?: 2 | 3 | 4 | 7;
  label: string;
  onChange: (next: T) => void;
  options: ReadonlyArray<CrmChoiceOption<T>>;
  value: T | null;
}) {
  // 7 is the module's OWN seven-way formula, plus the one thing it does not need and this does:
  // SEVEN IS PRIME, so every column count except 7 leaves a hole in the last row. The last option
  // spans the gap at 2 and 4 columns and goes back to one at lg, where all seven share a row. That
  // ragged last row is exactly what the owner called unfinished on the List (2026-09-30).
  //, lifted from phoenix-crm-app's TAB_COLUMNS: a 4-column
  // grid holding seven options leaves a hole in its last row, which is the unfinished look the owner
  // called out on the List (2026-09-30). Three on a phone, four from sm, all seven in one row at lg.
  const grid = { 2: "grid-cols-2", 3: "grid-cols-2 sm:grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4", 7: "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1" }[columns];
  return (
    <div aria-label={label} className={cn("grid gap-1.5", grid, className)} role="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className={cn(
              "min-h-11 min-w-0 rounded-none border px-3 py-2 text-left text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
              LANDING_FOCUS,
              // The chosen option's colours stay as they are: tests/phoenix-crm-plan-board.test.ts pins
              // the full day's emerald rail and "orange still wins where he stands" beside them, and
              // that test pins the plan day panel too, which is not this module's restyle to make.
              selected ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-[#08111f]",
              // Full: a 3px emerald rail with the colour blooming off it and fading away, never a
              // flat fill — and the orange of the option he is on still wins.
              option.tone === "good" &&
                cn("border-l-[3px] border-l-emerald-500", selected ? "bg-orange-50" : "bg-gradient-to-r from-emerald-50 via-emerald-50/40 to-white"),
            )}
            disabled={option.disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="radio"
            type="button"
          >
            <span className="block break-words">{option.label}</span>
            {option.note ? <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">{option.note}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The module's one dropdown.
 *
 * On the EMPLOYEE PORTAL it is a native select — a phone opens its own picker, with the module's own
 * arrow since `appearance-none` drops the phone's.
 *
 * 🔒 ON AN ADMIN ACCOUNT IT IS A COMBO BOX HE CAN TYPE INTO (owner, 2026-10-03: *"make any droplist
 * have a combo box not just droplist … i am talking now on admin account"*). The admin surface is the
 * one that picks from lists nobody scrolls — every rep seat in the company, every line, twelve
 * months — and it is the repo's own `SearchableSelect`, never a second one written here: that
 * component already carries the measured fixes a hand-rolled combo box would have to relearn (the
 * magnifier painting over a long value, the portal-rendered menu a panel's `overflow` would clip).
 *
 * 🔴 THE CALLER'S `<option>` CHILDREN ARE THE WHOLE API EITHER WAY, so no call site changes and none
 * can drift: a screen rendered on both surfaces gets the right control from the context alone. The
 * module's own class is passed FIRST and `pr-9` after it, so `rounded-none` beats the shared
 * component's radius (the square-edge golden rule) and a long value never paints under the magnifier.
 *
 * 🔴 `optgroup` LABELS ARE LOST IN THE COMBO BOX — it flattens the groups and keeps the options. A
 * caller carrying meaning in a group heading (the territory picker's line name) folds that word into
 * the option's own label on this surface, which is what makes it typeable anyway.
 */
export function CrmSelect({ children, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  if (useCrmComboBoxes()) {
    return (
      <div className="relative min-w-0">
        <SearchableSelect {...rest} className={cn(crmSelectClassName, "pr-9", className)}>
          {children}
        </SearchableSelect>
      </div>
    );
  }
  return (
    <div className="relative min-w-0">
      <select {...rest} className={cn(crmSelectClassName, "appearance-none pr-9", className)}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-slate-400" />
    </div>
  );
}

/**
 * The same combo-box rule as `CrmSelect`, for a dropdown that keeps the CALLER'S OWN look and its own
 * label — the customer list board's filter row, whose fields are shorter and tighter than the
 * module's standard field because five of them sit on one line.
 *
 * It exists so that rule lives in ONE place. The alternative was a second `useCrmComboBoxes()` branch
 * written out in that file, which is how a screen ends up with a native dropdown for an admin six
 * months later: nobody greps for a condition they do not know was duplicated.
 */
export function CrmBareSelect({ children, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  if (useCrmComboBoxes()) {
    return (
      <SearchableSelect {...rest} className={className}>
        {children}
      </SearchableSelect>
    );
  }
  return (
    <select {...rest} className={className}>
      {children}
    </select>
  );
}

/** A labelled search box; the list under it narrows as the person types. */
export function CrmSearchField({
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  id: string;
  label: ReactNode;
  onChange: (next: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <CrmField htmlFor={id} label={label}>
      <div className="relative min-w-0">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
        <input
          autoComplete="off"
          className={cn(crmInputClassName, "appearance-none pl-9")}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type="search"
          value={value}
        />
      </div>
    </CrmField>
  );
}

/**
 * Under a list shown a page at a time: "Show 25 more of the 40 left", and "Show the last 7" when one more
 * page holds the rest ("Show 7 more of the 7 left" read as a sum). Nothing when nothing is left.
 */
export function CrmShowMore({ left, onMore, page }: { left: number; onMore: () => void; page: number }) {
  if (left <= 0) return null;
  return (
    <div className="border-t border-slate-200 px-4 py-3 sm:px-5">
      <CrmButton onClick={onMore} size="sm">
        {left <= page ? (left === 1 ? "Show the last one" : `Show the last ${countText(left)}`) : `Show ${countText(page)} more of the ${countText(left)} left`}
      </CrmButton>
    </div>
  );
}

/** Tick box with its sentence; the whole row is the target. */
export function CrmCheck({
  checked,
  children,
  disabled,
  onChange,
}: {
  checked: boolean;
  children: ReactNode;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={cn("flex min-w-0 cursor-pointer items-start gap-2.5 text-sm font-semibold leading-6 text-slate-700", disabled && "cursor-not-allowed opacity-60")}>
      <input
        checked={checked}
        className={cn(phxCheckInputClassName, "mt-1 rounded-none")}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="min-w-0 break-words">{children}</span>
    </label>
  );
}

/** The bar above a screen opened from a list (Add Visit, one customer, one plan day). */
export function CrmBackBar({ backLabel = "Back", onBack, title }: { backLabel?: string; onBack: () => void; title: ReactNode }) {
  // Inside the step form, Back sits in the form's own foot and the step's heading names the screen.
  if (useInsideCrmStepForm()) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 sm:px-4">
      <CrmButton onClick={onBack} size="sm" variant="ghost">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        {backLabel}
      </CrmButton>
      <h2 className={cn("flex min-w-0 items-center gap-2 break-words text-phx-sm font-black uppercase tracking-[0.1em]", LANDING_INK)}>
        <LandingTick />
        <span className="min-w-0">{title}</span>
      </h2>
    </div>
  );
}

/** One row as a card, for phones (and for lists that read better as cards everywhere). */
export function CrmCard({
  accent = "border-l-slate-300",
  actions,
  children,
  className,
  meta,
  status,
  title,
}: {
  accent?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  meta?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
}) {
  return (
    <article className={cn("min-w-0 border-l-[3px] bg-white px-4 py-3.5", accent, className)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className={cn("break-words text-sm font-bold", LANDING_INK)}>{title}</h3>
          {meta ? <div className="mt-1 break-words text-xs leading-5 text-slate-500">{meta}</div> : null}
        </div>
        {/* 🔴 THE PILLS TAKE THEIR OWN LINE ON A PHONE (owner, 2026-09-30, of a card whose name read
            one character per line). The title is `flex-1 min-w-0`, so it may shrink to nothing,
            while a pill sets its own intrinsic width — one long label therefore squeezed an Arabic
            name into a two-character gutter and broke "Grade A" across lines mid-word. `basis-full`
            below `sm` drops the pills under the name instead, where they have the full width; from
            `sm` they sit beside it as before. */}
        {status ? <div className="flex w-full max-w-full flex-wrap gap-1 sm:w-auto sm:justify-end">{status}</div> : null}
      </div>
      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

/** Label/value pairs inside a card. */
export function CrmFacts({ facts }: { facts: ReadonlyArray<{ label: ReactNode; value: ReactNode }> }) {
  return (
    // Hairline cells, two a row: the container draws the top and left of the frame, each cell its own
    // right and bottom, so no tinted box sits on the card.
    <dl className="grid grid-cols-2 border-l border-t border-slate-200">
      {facts.map((fact, index) => (
        <div className="min-w-0 rounded-none border-b border-r border-slate-200 px-2.5 py-2" key={index}>
          <dt className={cn("break-words", crmLabelClassName)}>{fact.label}</dt>
          <dd className={cn("mt-0.5 min-w-0 break-words text-xs font-bold tabular-nums", LANDING_INK)}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A desktop table: fixed layout with named column widths, so it fits the panel and never scrolls
 * sideways. Hidden below `md`, where the same rows are cards.
 */
export function CrmTable({
  children,
  className,
  columns,
  desktopOnly = true,
}: {
  children: ReactNode;
  className?: string;
  /** One width per column (e.g. "28%"); a column without one shares what is left. */
  columns: ReadonlyArray<string | null>;
  desktopOnly?: boolean;
}) {
  return (
    <div className={cn(desktopOnly ? "hidden md:block" : "block", "min-w-0")}>
      <table className={cn("w-full table-fixed border-collapse text-left text-sm", className)}>
        <colgroup>
          {columns.map((width, index) => (
            <col key={index} style={width ? { width } : undefined} />
          ))}
        </colgroup>
        {children}
      </table>
    </div>
  );
}

export const crmThClassName =
  "border-b border-slate-200 px-3 py-2.5 align-bottom text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

export const crmTdClassName = "border-b border-slate-200 px-3 py-2.5 align-top break-words text-sm text-slate-700";

/** Cards below `md`, the table from `md` up — the rows are drawn once per layout. */
export function CrmCardsOnPhone({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-slate-200 md:hidden">{children}</div>;
}
