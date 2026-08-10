"use client";

/**
 * Self-contained UI kit for the Resignations module.
 *
 * Owner directive (2026-08-10): this page reuses NO existing component. Three earlier attempts were
 * assembled from admin-design-system / ceo-command-center / portal-primitives / components-ui and
 * were rejected on sight, so everything visual here is written from scratch and lives only in this
 * module. Nothing outside imports it, and it imports nothing visual from outside.
 *
 * House style, deliberately narrow so the page cannot drift:
 *   surfaces  border border-slate-200, white, square, NO radius / shadow / gradient / hover-lift
 *   headers   flat black bar (#0B1220-ish slate-950) with tiny uppercase white type
 *   density   text-xs, px-3 py-2, ONE line per row
 *   accent    orange only for the active tab and the primary action
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ── Hero ─────────────────────────────────────────────────────────────────────

export function RgHero({
  actions,
  eyebrow,
  subtitle,
  title,
}: {
  actions?: ReactNode;
  eyebrow: string;
  subtitle: string;
  title: string;
}) {
  return (
    <section className="border border-slate-900 bg-slate-950 px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <span className="inline-flex items-center border border-orange-500/40 bg-orange-500/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.22em] text-orange-300">
            {eyebrow}
          </span>
          <h1 className="mt-3 whitespace-nowrap text-2xl font-black tracking-tight text-white">
            {title}
          </h1>
          <p className="mt-1 text-xs font-medium text-slate-400">{subtitle}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}

// ── KPI tile ─────────────────────────────────────────────────────────────────

export type RgTone = "slate" | "orange" | "rose" | "emerald";

const toneText: Record<RgTone, string> = {
  emerald: "text-emerald-700",
  orange: "text-orange-700",
  rose: "text-rose-700",
  slate: "text-slate-900",
};

export function RgTile({ label, sub, tone = "slate", value }: {
  label: string;
  sub: string;
  tone?: RgTone;
  value: number | string;
}) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className="whitespace-nowrap text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-black leading-none ${toneText[tone]}`}>{value}</p>
      <p className="mt-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
        {sub}
      </p>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function RgPanel({ action, children, title }: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="border border-slate-200 bg-white">
      <header className="flex items-center justify-between gap-3 bg-slate-950 px-4 py-2.5">
        <h2 className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.16em] text-white">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

export function RgTabs<T extends string>({ onChange, tabs, value }: {
  onChange: (id: T) => void;
  tabs: ReadonlyArray<{ count: number; id: T; label: string }>;
  value: T;
}) {
  return (
    <div className="flex w-full border-b border-slate-200 bg-white" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            aria-selected={active}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-[11px] font-black uppercase tracking-[0.12em] transition ${
              active
                ? "border-orange-500 text-slate-900"
                : "border-transparent text-slate-400 hover:text-slate-700"
            }`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
            <span
              className={`ml-2 px-1.5 py-0.5 text-[10px] font-black ${
                active ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Badge ────────────────────────────────────────────────────────────────────

const badgeTone: Record<RgTone, string> = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  orange: "border-orange-200 bg-orange-50 text-orange-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  slate: "border-slate-200 bg-slate-50 text-slate-600",
};

export function RgBadge({ children, title, tone = "slate" }: {
  children: ReactNode;
  title?: string;
  tone?: RgTone;
}) {
  return (
    <span
      className={`inline-flex whitespace-nowrap border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${badgeTone[tone]}`}
      title={title}
    >
      {children}
    </span>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────

const buttonKind = {
  danger: "border-rose-300 bg-white text-rose-700 hover:bg-rose-50",
  ghost: "border-transparent bg-transparent text-slate-500 hover:text-slate-900",
  onDark: "border-white/25 bg-white/10 text-white hover:bg-white/20",
  primary: "border-orange-600 bg-orange-600 text-white hover:bg-orange-700",
  quiet: "border-slate-200 bg-white text-slate-700 hover:border-slate-400",
} as const;

export function RgButton({
  children,
  disabled,
  kind = "quiet",
  onClick,
  title,
}: {
  children: ReactNode;
  disabled?: boolean;
  kind?: keyof typeof buttonKind;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap border px-2.5 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${buttonKind[kind]}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

// ── Text input / search ──────────────────────────────────────────────────────

export function RgInput({
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "date";
  value: string;
}) {
  return (
    <input
      className="h-8 w-full border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-orange-400"
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      type={type}
      value={value}
    />
  );
}

export function RgSelect({
  children,
  onChange,
  value,
}: {
  children: ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <select
      className="h-8 w-full border border-slate-200 bg-white px-2 text-xs font-medium text-slate-900 outline-none transition focus:border-orange-400"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {children}
    </select>
  );
}

export function RgField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block whitespace-nowrap text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

// ── Table shell ──────────────────────────────────────────────────────────────

export function RgTable({ children, head }: { children: ReactNode; head: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-slate-900 text-left">{head}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function RgTh({ align = "left", children }: { align?: "left" | "right"; children: ReactNode }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-200 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function RgTd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 align-middle ${className}`}>{children}</td>;
}

/**
 * Employee identity block: name on top, then a single muted meta line carrying the HR ID and
 * whatever else belongs to the person rather than to the workflow (line, hire date). Keeping those
 * out of their own columns is what lets the money columns fit without the table sprawling.
 */
export function RgPerson({ hrId, meta = [], name }: {
  hrId: string;
  /** Extra facts joined with a middot. Falsy entries are dropped. */
  meta?: Array<string | null | undefined>;
  name: string;
}) {
  const parts = [hrId || "No HR ID", ...meta.filter((item): item is string => Boolean(item && item !== "-"))];

  return (
    <span className="block whitespace-nowrap leading-tight">
      <span className="block text-[13px] font-bold text-slate-900">{name}</span>
      <span className="mt-0.5 block text-[10px] font-medium text-slate-400">
        <span className="font-mono text-slate-500">{parts[0]}</span>
        {parts.slice(1).map((part) => (
          <span key={part}>
            <span className="mx-1.5 text-slate-300">·</span>
            {part}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Two stacked money figures for the Part 1 / Part 2 split. */
export function RgSplit({ covered, firstPart, secondPart }: {
  covered: boolean;
  firstPart: string;
  secondPart: string;
}) {
  if (covered) {
    return (
      <span className="inline-flex whitespace-nowrap border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-emerald-700">
        Part 1 covers it
      </span>
    );
  }

  return (
    <span className="block whitespace-nowrap leading-tight">
      <span className="block text-[11px] font-bold text-slate-900">Part 1 {firstPart}</span>
      <span className="mt-0.5 block text-[10px] font-bold text-orange-700">Part 2 {secondPart}</span>
    </span>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

export function RgEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-xs font-semibold text-slate-400">{children}</p>;
}

// ── Pager ────────────────────────────────────────────────────────────────────

export function RgPager({ onPage, page, pageSize, total }: {
  onPage: (page: number) => void;
  page: number;
  pageSize: number;
  total: number;
}) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">
        {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <RgButton disabled={page === 0} onClick={() => onPage(page - 1)}>
          Prev
        </RgButton>
        <span className="px-2 text-[10px] font-bold text-slate-500">
          {page + 1} / {pages}
        </span>
        <RgButton disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          Next
        </RgButton>
      </div>
    </div>
  );
}

// ── Dialog ───────────────────────────────────────────────────────────────────

/**
 * Modal with its own focus trap, ESC-to-close, scroll lock and focus restore. Written here rather
 * than imported so this module stays self-contained. A dialog is the one surface allowed a shadow
 * — it floats above a backdrop.
 */
export function RgDialog({
  children,
  footer,
  onClose,
  subtitle,
  title,
}: {
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  subtitle?: string;
  title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    ref.current?.querySelector<HTMLElement>(focusable)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      const node = ref.current;
      if (!node) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(focusable));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      const target = restoreRef.current;
      if (target && target instanceof HTMLElement) target.focus();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/70 p-4">
      <div
        aria-label={title}
        aria-modal="true"
        className="flex max-h-[85vh] w-full max-w-xl flex-col border border-slate-300 bg-white shadow-2xl"
        ref={ref}
        role="dialog"
      >
        <header className="shrink-0 bg-slate-950 px-4 py-3">
          <p className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.16em] text-white">
            {title}
          </p>
          {subtitle ? (
            <p className="mt-0.5 whitespace-nowrap text-[11px] text-slate-400">{subtitle}</p>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-4 py-3">
          {footer}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ── Notice ───────────────────────────────────────────────────────────────────

export function RgNotice({ children, tone }: { children: ReactNode; tone: "rose" | "emerald" }) {
  const cls =
    tone === "rose"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : "border-emerald-200 bg-emerald-50 text-emerald-800";
  return <div className={`border px-4 py-2.5 text-xs font-semibold ${cls}`}>{children}</div>;
}
