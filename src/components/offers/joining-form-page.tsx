"use client";

import { useMemo, useState } from "react";

import {
  JOINING_FORM_EDUCATION_OPTIONS,
  JOINING_FORM_GENDER_OPTIONS,
  JOINING_FORM_GOVERNORATES,
  JOINING_FORM_OTHER_AREA,
  readEgyptianNationalId,
  validateJoiningForm,
  type JoiningFormAnswers,
  type JoiningFormField,
} from "@/lib/offers/joining-form";
import type { JoiningFormView } from "@/lib/offers/joining-form-service";

/**
 * The candidate's joining form — 100% Sato Pharma (owner, 2026-10-08), never Phoenix.
 *
 * Built in satopharma.com's own language, from the `sato-pharma-identity` skill: a navy hero with a
 * header bar and the Arabic calligraphy as its watermark, an eyebrow led by a light-blue rule, a 48px headline, a framed card with white corner
 * ticks beside a vertical tick rule, the 14px tick rule and the 3px brand-blue seam closing the
 * band, and the site's numbered footer with its "Success is Acquired by Talented Operators" line.
 * Every piece of data the candidate reads sits in a zebra table. Micro labels (10.5px bold
 * uppercase, 0.2em tracking), 1px hairlines, one brand blue, and every corner 90°. No soft shadows,
 * no gradient washes, no circles. Exempt from the Phoenix form kit for the same reason `offers/`
 * is — this page is the company's.
 *
 * Mobile first: the candidate opens it from a phone's mail app. One column at 375px, the step rail
 * only from 1024px, nothing that scrolls sideways, and nothing cut with an ellipsis.
 */

type OpenView = Extract<JoiningFormView, { kind: "open" }>;
type Done = { hrId: string; satoEmail: string | null; satoEmailReason: string | null };

const SATO_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const micro = "text-[10.5px] font-bold uppercase tracking-[0.2em]";
const PENDING = "To be confirmed by HR";

// A square caret for the selects — the platform's own arrow is rounded on iOS and differs per browser.
const CARET =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0h10L5 6z' fill='%23111820'/%3E%3C/svg%3E\")";

/**
 * The page's motion and engraving, scoped by the `jf-` prefix: the ink grid, the website's tick
 * rules and outlined lettering, outline numerals, a rise and a mask reveal on entry, the check
 * drawing in its seal, the footer's marquee, and the bar that runs while Submit is working.
 * Reduced motion and print get none of it.
 */
const SATO_CSS = `
.jf-ink-grid{background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:56px 56px}
.jf-tick-x{background-image:linear-gradient(to right,currentColor 1px,transparent 1px),linear-gradient(to right,currentColor 1px,transparent 1px);background-size:8px 6px,40px 14px;background-repeat:repeat-x;background-position:left bottom,left bottom}
.jf-tick-y{background-image:linear-gradient(to bottom,currentColor 1px,transparent 1px),linear-gradient(to bottom,currentColor 1px,transparent 1px);background-size:6px 8px,14px 40px;background-repeat:repeat-y}
.jf-arabic{filter:brightness(0) invert(1);opacity:.13}
.jf-outline-marquee{color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.22)}
.jf-ghost{color:transparent;-webkit-text-stroke:1px #d3dce1;font-weight:700;line-height:.8;letter-spacing:-.04em;font-variant-numeric:tabular-nums;transition:-webkit-text-stroke-color .5s}
.jf-section:focus-within .jf-ghost{-webkit-text-stroke-color:#0879b8}
@keyframes jf-rise{from{opacity:0;transform:translateY(14px)}}
.jf-rise{animation:jf-rise .9s cubic-bezier(.16,1,.3,1) var(--jf-delay,0ms) backwards}
@keyframes jf-mask{from{clip-path:inset(0 0 100% 0);transform:translateY(.35em)}to{clip-path:inset(0 0 -10% 0);transform:none}}
.jf-mask{animation:jf-mask 1.1s cubic-bezier(.16,1,.3,1) var(--jf-delay,0ms) backwards}
@keyframes jf-draw-x{from{transform:scaleX(0)}}
.jf-draw{transform-origin:left;animation:jf-draw-x 1.1s cubic-bezier(.16,1,.3,1) .35s backwards}
@keyframes jf-check{to{stroke-dashoffset:0}}
.jf-check path{stroke-dasharray:44;stroke-dashoffset:44;animation:jf-check .8s cubic-bezier(.65,0,.35,1) .45s forwards}
@keyframes jf-run{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
.jf-run{animation:jf-run 1.1s cubic-bezier(.65,0,.35,1) infinite}
@keyframes jf-marquee{to{transform:translateX(-50%)}}
.jf-marquee{width:max-content;animation:jf-marquee 70s linear infinite}
.jf-fill{transition:width .6s cubic-bezier(.16,1,.3,1)}
@media (prefers-reduced-motion:reduce){.jf-rise,.jf-mask,.jf-draw,.jf-run,.jf-marquee{animation:none!important}.jf-check path{animation:none!important;stroke-dashoffset:0}.jf-fill{transition:none}}
@media print{.jf-rise,.jf-mask,.jf-draw,.jf-run,.jf-marquee{animation:none!important}.jf-check path{animation:none!important;stroke-dashoffset:0}.jf-no-print{display:none!important}}
`;

function SatoStyles() {
  return (
    <style href="sato-joining-form" precedence="default">
      {SATO_CSS}
    </style>
  );
}

function delay(ms: number): React.CSSProperties {
  return { "--jf-delay": `${ms}ms` } as React.CSSProperties;
}

function money(value: number): string {
  return `EGP ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value)}`;
}

function letterDate(iso: string, month: "long" | "short" = "long"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "To be confirmed";
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month, timeZone: "UTC", year: "numeric" });
}

function genderLabel(value: string): string {
  return JOINING_FORM_GENDER_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/** Corner ticks on a frame, as the website draws them. The frame needs `relative`. */
function FrameTicks({ tone = "ink" }: { tone?: "ink" | "white" }) {
  const tick = `pointer-events-none absolute z-10 h-5 w-5 ${tone === "white" ? "border-white" : "border-[#111820]"}`;
  return (
    <>
      <span aria-hidden className={`${tick} -left-px -top-px border-l-2 border-t-2`} />
      <span aria-hidden className={`${tick} -right-px -top-px border-r-2 border-t-2`} />
      <span aria-hidden className={`${tick} -bottom-px -left-px border-b-2 border-l-2`} />
      <span aria-hidden className={`${tick} -bottom-px -right-px border-b-2 border-r-2`} />
    </>
  );
}

/** The website's eyebrow: a short rule, then the micro label. */
function Eyebrow({ children, tone = "brand" }: { children: React.ReactNode; tone?: "brand" | "light" }) {
  return (
    <p className={`${micro} flex items-center gap-3 ${tone === "light" ? "text-[#5db7e8]" : "text-[#0879b8]"}`}>
      <span aria-hidden className={`jf-draw h-px w-10 shrink-0 ${tone === "light" ? "bg-[#5db7e8]" : "bg-[#0879b8]"}`} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

type BandRow = { label: string; value: string };
type BandCard = { meta?: string | null; rows: BandRow[]; title: string };

/** The hero's framed card — the website frames a photograph here; this page frames the offer. */
function HeroCard({ card }: { card: BandCard }) {
  return (
    <div className="jf-rise relative pl-6 sm:pl-7" style={delay(260)}>
      <div aria-hidden className="jf-tick-y absolute inset-y-2 left-0 w-4 text-white/50" />
      <div className="relative border border-white/20 bg-[#111820]/35">
        <FrameTicks tone="white" />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-white/15 px-5 py-3.5">
          <p className={`${micro} text-[#5db7e8]`}>{card.title}</p>
          {card.meta ? <p className={`${micro} text-[#6f7c86] [overflow-wrap:anywhere]`}>{card.meta}</p> : null}
        </div>
        <table className="w-full table-fixed border-collapse text-left">
          <caption className="sr-only">{card.title}</caption>
          <colgroup>
            <col className="w-[44%]" />
            <col />
          </colgroup>
          <tbody>
            {card.rows.map((row, index) => (
              <tr className={`border-b border-white/[0.08] last:border-b-0 ${index % 2 ? "bg-white/[0.045]" : ""}`} key={row.label}>
                <th className={`${micro} py-3.5 pl-5 pr-3 align-top leading-[1.6] text-[#8d9aa4]`} scope="row">
                  {row.label}
                </th>
                <td className="py-3 pr-5 text-right align-top text-[15px] font-bold leading-snug tabular-nums text-white [overflow-wrap:anywhere] sm:text-base">
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SatoBand({
  card,
  eyebrow,
  subtitle,
  tag = "Joining form",
  title,
}: {
  card?: BandCard;
  eyebrow: string;
  subtitle?: string;
  tag?: string;
  title: string;
}) {
  return (
    <header className="relative overflow-hidden bg-[#111820] text-white">
      <div aria-hidden className="jf-ink-grid pointer-events-none absolute inset-0" />
      {/* The company's own Arabic calligraphy (ساتو فارما) as the band's watermark, drawn in white
          behind everything else — on the right, its ink laid to the trim and never past it, because
          the right edge is where both words begin (owner, 2026-10-08: the Arabic mark, not the
          English one). The official file Phoenix's documents already use, recoloured by a filter. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden
        className="jf-arabic pointer-events-none absolute right-0 top-[92px] max-h-[calc(100%-126px)] w-[86%] max-w-[520px] select-none object-contain object-right sm:top-[100px] sm:w-[60%] lg:bottom-[22px] lg:top-auto lg:h-[min(380px,calc(100%-96px))] lg:max-h-none lg:w-auto lg:max-w-none"
        src="/brand/sato-pharma-arabic-on-light.png"
      />

      {/* The header bar, as the website opens: the reverse mark, then the page's place. */}
      <div className="relative border-b border-[#26313b]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          {/* The reverse mark: SATO is drawn in white, so this file belongs on navy only. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Sato Pharma" className="h-8 w-auto sm:h-9" src="/brand/sato-pharma-logo.png" />
          <div className="flex items-center gap-5">
            <span className={`${micro} hidden text-[#9aa6af] md:inline`}>Human Resources</span>
            <span aria-hidden className="hidden h-4 w-px bg-[#3a4652] md:inline-block" />
            <span className={`${micro} border border-[#3a4652] px-2.5 py-1.5 text-white`}>{tag}</span>
          </div>
        </div>
      </div>

      <div
        className={`relative mx-auto grid max-w-6xl gap-10 px-5 pb-12 pt-10 sm:px-8 sm:pb-14 sm:pt-14 ${
          card ? "lg:grid-cols-[minmax(0,1fr)_420px] lg:items-end lg:gap-16 lg:pb-16 lg:pt-20" : "lg:pb-16 lg:pt-20"
        }`}
      >
        <div className="min-w-0">
          <div className="jf-rise">
            <Eyebrow tone="light">{eyebrow}</Eyebrow>
          </div>
          <h1 className="jf-mask mt-5 break-words text-[32px] font-bold leading-[1.05] tracking-[-0.02em] sm:text-[48px]" style={delay(80)}>
            {title}
          </h1>
          {subtitle ? (
            <p className="jf-rise mt-5 max-w-xl text-base leading-relaxed text-[#9aa6af]" style={delay(160)}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {card ? <HeroCard card={card} /> : null}
      </div>

      <div aria-hidden className="jf-tick-x relative h-[14px] text-white/[0.14]" />
      <div aria-hidden className="relative h-[3px] bg-[#0879b8]" />
    </header>
  );
}

const FOOTER_COLUMNS = [
  { body: "This offer was prepared for you by Sato Pharma's Human Resources team.", title: "Human Resources" },
  { body: "If you have any question about your offer, reply to the offer email and our team will answer.", title: "Questions" },
  { body: "This page is private to you. The link carries your offer, so please keep it to yourself.", title: "Privacy" },
];

const MARQUEE = ["Success is Acquired by Talented Operators", "Sato Pharma", "Success is Acquired by Talented Operators", "Sato Pharma"];

export function SatoFooter() {
  return (
    <footer className="relative mt-16 overflow-hidden bg-[#111820] text-white lg:mt-24">
      <div aria-hidden className="relative h-[3px] bg-[#0879b8]" />
      <div aria-hidden className="jf-ink-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pt-12 sm:px-8 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] lg:gap-12 lg:pt-16">
        <div className="min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Sato Pharma" className="h-9 w-auto" src="/brand/sato-pharma-logo.png" />
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-[#9aa6af]">
            <span className="font-bold text-white">SATO</span> — Success is Acquired by Talented Operators.
          </p>
        </div>
        {FOOTER_COLUMNS.map((column, index) => (
          <div className="min-w-0 border-t border-[#26313b] pt-5 lg:border-t-0 lg:pt-0" key={column.title}>
            <p className={`${micro} text-[#6f7c86]`}>
              <span className="text-[#5db7e8]">{String(index + 1).padStart(2, "0")}</span> — {column.title}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#8d9aa4]">{column.body}</p>
          </div>
        ))}
      </div>

      {/* The website's marquee of outlined lettering — two copies, so the loop never shows a seam. */}
      <div aria-hidden className="relative mt-12 overflow-hidden border-y border-[#26313b] py-5 lg:mt-16 lg:py-7">
        <div className="jf-marquee flex whitespace-nowrap">
          {[0, 1].map((copy) => (
            <div className="flex shrink-0" key={copy}>
              {MARQUEE.map((word, index) => (
                <span className="flex items-center" key={`${copy}-${index}`}>
                  <span className="jf-outline-marquee px-6 text-[40px] font-bold leading-none tracking-[-0.02em] sm:text-[64px]">{word}</span>
                  <span className="h-2 w-2 shrink-0 bg-[#0879b8]" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col gap-2 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className={`${micro} text-[#6f7c86]`}>© {new Date().getFullYear()} Sato Pharma · Human Resources</p>
        <a className={`${micro} text-[#9aa6af] transition-colors hover:text-white`} href="https://satopharma.com" rel="noreferrer" target="_blank">
          satopharma.com
        </a>
      </div>
    </footer>
  );
}

function SealCheck() {
  return (
    <span aria-hidden className="relative inline-block h-16 w-16 shrink-0 bg-[#0879b8]">
      <span className="absolute inset-[12%] border border-white/40" />
      <svg className="jf-check absolute inset-0 h-full w-full" viewBox="0 0 72 72">
        <path d="M22 37 L32 47 L51 25" fill="none" stroke="#fff" strokeLinecap="square" strokeWidth="5" />
      </svg>
    </span>
  );
}

function Section({
  children,
  delay: ms = 0,
  flush = false,
  framed = false,
  index,
  note,
  title,
}: {
  children: React.ReactNode;
  delay?: number;
  flush?: boolean;
  framed?: boolean;
  index: string;
  note?: string;
  title: string;
}) {
  return (
    <section
      className={`jf-section jf-rise relative scroll-mt-20 bg-white ${framed ? "border border-[#111820]" : "border border-[#dde4e8]"}`}
      id={`jf-step-${index}`}
      style={delay(ms)}
    >
      {framed ? <FrameTicks /> : null}
      <header className="flex items-end justify-between gap-4 border-b border-[#dde4e8] px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
        <div className="min-w-0">
          <Eyebrow>Step {index}</Eyebrow>
          <h2 className="mt-3 text-[24px] font-bold leading-[1.1] tracking-[-0.015em] text-[#111820] sm:text-[30px]">{title}</h2>
          {note ? <p className="mt-2 text-[14px] leading-relaxed text-[#69757e]">{note}</p> : null}
        </div>
        <span aria-hidden className="jf-ghost shrink-0 text-[52px] sm:text-[84px]">
          {index}
        </span>
      </header>
      <div className={`px-5 pt-6 sm:px-7 ${flush ? "" : "pb-7"}`}>{children}</div>
    </section>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className={`${micro} flex items-center gap-3 text-[#8a959d]`}>
      <span>{children}</span>
      <span aria-hidden className="h-px flex-1 bg-[#e1e7eb]" />
    </p>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className={`${micro} inline-block border border-[#b9d8e9] bg-[#f3f9fc] px-1.5 py-0.5 text-[9.5px] text-[#06628f]`}>{children}</span>;
}

type DataRow = { label: string; note?: string | null; tag?: string; value: React.ReactNode | null };
type DataGroup = { rows: DataRow[]; title?: string };

/**
 * Every fact the candidate reads, as one zebra table: a micro-labelled head row per group ruled in
 * ink, then white and canvas rows in turn, edge to edge across the section. Fixed columns, so it fits
 * a 375px phone by wrapping, never by scrolling sideways.
 */
function DataTable({ caption, groups }: { caption: string; groups: DataGroup[] }) {
  return (
    <div className="-mx-5 sm:-mx-7">
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className="w-[42%] sm:w-[34%]" />
          <col />
        </colgroup>
        {groups.map((group, groupIndex) => (
          <tbody key={group.title ?? groupIndex}>
            {group.title ? (
              <tr>
                <th
                  className={`${micro} border-b border-[#111820] px-5 pb-2.5 text-[#0879b8] sm:px-7 ${groupIndex === 0 ? "pt-0" : "pt-8"}`}
                  colSpan={2}
                  scope="colgroup"
                >
                  {group.title}
                </th>
              </tr>
            ) : null}
            {group.rows.map((row, index) => (
              <tr className={`border-b border-[#e9eef1] ${index % 2 ? "bg-[#f4f7f9]" : "bg-white"}`} key={row.label}>
                <th className={`${micro} py-3.5 pl-5 pr-3 align-top leading-[1.6] text-[#69757e] sm:pl-7`} scope="row">
                  {row.label}
                </th>
                <td className="py-3 pr-5 align-top sm:pr-7">
                  {row.value ? (
                    <span className="block text-[15px] font-semibold leading-snug text-[#111820] [overflow-wrap:anywhere]">{row.value}</span>
                  ) : (
                    <span className="block text-[15px] leading-snug text-[#8a959d]">{PENDING}</span>
                  )}
                  {row.note ? <span className="mt-0.5 block text-[13px] leading-relaxed text-[#69757e]">{row.note}</span> : null}
                  {row.value && row.tag ? (
                    <span className="mt-2 block">
                      <Tag>{row.tag}</Tag>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function Field({
  children,
  error,
  hint,
  hintTone = "quiet",
  htmlFor,
  label,
  tag,
}: {
  children: React.ReactNode;
  error?: string;
  hint?: string;
  hintTone?: "quiet" | "confirm";
  htmlFor: string;
  label: string;
  tag?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <label className={`${micro} block text-[#111820]`} htmlFor={htmlFor}>
          {label}
        </label>
        {tag ? <Tag>{tag}</Tag> : null}
      </div>
      <div className="mt-2">{children}</div>
      {error ? (
        <p className="mt-2 flex items-start gap-2 text-[13px] leading-snug text-[#b91c1c]" id={`${htmlFor}-message`} role="alert">
          <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 bg-[#b91c1c]" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : hint ? (
        <p
          className={`mt-2 flex items-start gap-2 text-[13px] leading-snug ${hintTone === "confirm" ? "text-[#06628f]" : "text-[#69757e]"}`}
          id={`${htmlFor}-message`}
        >
          {hintTone === "confirm" ? <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 bg-[#0879b8]" /> : null}
          <span className="min-w-0">{hint}</span>
        </p>
      ) : null}
    </div>
  );
}

function controlClass(invalid: boolean, extra = ""): string {
  return [
    "block h-12 w-full appearance-none rounded-none border bg-white px-4 text-[15px] text-[#111820] outline-none",
    "placeholder:text-[#8a959d] transition-[border-color,box-shadow] duration-200",
    "focus:border-[#0879b8] focus:shadow-[inset_0_0_0_1px_#0879b8]",
    invalid ? "border-[#b91c1c]" : "border-[#cdd6dc] hover:border-[#8a959d]",
    extra,
  ].join(" ");
}

const selectStyle: React.CSSProperties = {
  backgroundImage: CARET,
  backgroundPosition: "right 16px center",
  backgroundRepeat: "no-repeat",
  backgroundSize: "10px 6px",
};

/** The fields Submit needs, in page order — what the progress rail counts. */
function requiredFields(answers: JoiningFormAnswers, hasAreaList: boolean): JoiningFormField[] {
  const fields: JoiningFormField[] = ["fullName", "nationalId", "gender", "birthDate", "mobileNumber", "personalEmail", "education"];
  if (answers.education === "Other") fields.push("educationOther");
  fields.push("residenceArea");
  if (hasAreaList && answers.residenceArea === JOINING_FORM_OTHER_AREA) fields.push("residenceAreaOther");
  fields.push("residenceCity", "residenceAddress");
  return fields;
}

type RailStep = { index: string; state: "done" | "active" | "waiting"; status: string; title: string };

/** The desktop step rail: where the candidate is, held beside the form while it scrolls. */
function StepRail({ steps }: { steps: RailStep[] }) {
  return (
    <nav aria-label="Joining form steps" className="sticky top-20">
      <Eyebrow>Your joining form</Eyebrow>
      <ol className="mt-5 border-t border-[#dde4e8]">
        {steps.map((step) => (
          <li className="border-b border-[#dde4e8]" key={step.index}>
            <a
              className={`group flex gap-4 border-l-[3px] py-3.5 pl-4 pr-2 transition-colors hover:bg-white ${
                step.state === "done" ? "border-[#0879b8]" : step.state === "active" ? "border-[#111820]" : "border-transparent"
              }`}
              href={`#jf-step-${step.index}`}
            >
              <span className={`${micro} mt-[3px] shrink-0 tabular-nums ${step.state === "waiting" ? "text-[#8a959d]" : "text-[#0879b8]"}`}>{step.index}</span>
              <span className="min-w-0">
                <span className="block text-[14px] font-bold leading-snug text-[#111820] group-hover:text-[#0879b8]">{step.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-[#69757e]">{step.status}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
      <p className="mt-5 text-[12.5px] leading-relaxed text-[#69757e]">
        Pressing Submit is your acceptance of the offer. To decline, reply to the offer email.
      </p>
    </nav>
  );
}

/** A closed or invalid link: the same hero and footer, the reason, and what to do. */
export function SatoNotice({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#f2f5f7] text-[#45515a]" style={{ fontFamily: SATO_FONT }}>
      <SatoStyles />
      <SatoBand eyebrow="Offer of employment" tag="Closed" title={title} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-8 lg:py-14">
        <section className="jf-rise relative max-w-3xl border border-[#111820] bg-white px-5 py-7 sm:px-7" style={delay(200)}>
          <FrameTicks />
          <Eyebrow>What to do</Eyebrow>
          <p className="mt-4 text-[17px] leading-relaxed text-[#45515a]">{body}</p>
        </section>
      </main>
      <SatoFooter />
    </div>
  );
}

function JoiningFormDone({ done, view }: { done: Done; view: OpenView }) {
  const { job, offer } = view;
  const steps = [
    `Our HR team will contact you before your first day on ${letterDate(job.hireDate)}.`,
    done.satoEmail
      ? `Your Sato email, ${done.satoEmail}, is being set up for your first day.`
      : `HR will send you your Sato email${done.satoEmailReason ? ` — ${done.satoEmailReason}` : "."}`,
    "If anything in your details needs changing, reply to the offer email.",
  ];
  return (
    <div className="flex min-h-screen flex-col bg-[#f2f5f7] text-[#45515a]" style={{ fontFamily: SATO_FONT }}>
      <SatoStyles />
      <SatoBand
        card={{
          meta: offer.reference,
          rows: [
            { label: "HR ID", value: done.hrId },
            { label: "Position", value: job.jobTitle || PENDING },
            { label: "Start date", value: letterDate(job.hireDate, "short") },
          ],
          title: "Your record",
        }}
        eyebrow="Offer accepted"
        subtitle="Your acceptance is recorded and your employee record is ready. Here is everything you need before your first day."
        tag="Received"
        title={`Welcome to Sato Pharma, ${offer.salutationName}`}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-8 lg:py-14">
        <div className="mx-auto max-w-3xl space-y-8">
          <section className="jf-rise relative border border-[#111820] bg-white" style={delay(200)}>
            <FrameTicks />
            <div className="flex items-start gap-5 border-b border-[#dde4e8] px-5 py-7 sm:px-7">
              <SealCheck />
              <div className="min-w-0">
                <Eyebrow>Acceptance recorded</Eyebrow>
                <h2 className="mt-3 text-[24px] font-bold leading-[1.1] tracking-[-0.015em] text-[#111820] sm:text-[30px]">
                  Thank you — you have accepted the offer.
                </h2>
              </div>
            </div>
            <div className="px-5 pb-0 pt-6 sm:px-7">
              <DataTable
                caption="Your employee record"
                groups={[
                  {
                    rows: [
                      { label: "Your HR ID", value: <span className="text-[24px] font-bold tabular-nums">{done.hrId}</span> },
                      { label: "Your Sato email", value: done.satoEmail ?? "HR will send it to you" },
                      { label: "Position", value: job.jobTitle },
                      { label: "Start date", value: job.hireDate ? letterDate(job.hireDate) : null },
                      { label: "Manager", value: job.managerName ?? job.managerHrId },
                    ],
                    title: "Your record",
                  },
                ]}
              />
            </div>
          </section>

          <section className="jf-rise border border-[#dde4e8] bg-white" style={delay(320)}>
            <div className="border-b border-[#dde4e8] px-5 pb-5 pt-6 sm:px-7">
              <Eyebrow>What happens next</Eyebrow>
            </div>
            <table className="w-full table-fixed border-collapse text-left">
              <caption className="sr-only">What happens next</caption>
              <colgroup>
                <col className="w-16 sm:w-20" />
                <col />
              </colgroup>
              <tbody>
                {steps.map((step, index) => (
                  <tr className={`border-b border-[#e9eef1] last:border-b-0 ${index % 2 ? "bg-[#f4f7f9]" : "bg-white"}`} key={step}>
                    <th className={`${micro} py-4 pl-5 align-top leading-[1.9] tabular-nums text-[#0879b8] sm:pl-7`} scope="row">
                      {String(index + 1).padStart(2, "0")}
                    </th>
                    <td className="py-4 pr-5 align-top text-[15px] leading-relaxed sm:pr-7">{step}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>
      <SatoFooter />
    </div>
  );
}

export function JoiningFormPage({ token, view }: { token: string; view: OpenView }) {
  const { job, offer, pay, residence } = view;
  const hasAreaList = residence.areaOptions.length > 0;

  const [answers, setAnswers] = useState<JoiningFormAnswers>({
    birthDate: "",
    education: "",
    educationOther: "",
    fullName: offer.candidateName,
    gender: "",
    mobileNumber: "",
    nationalId: "",
    personalEmail: offer.candidateEmail,
    residenceAddress: "",
    residenceArea: "",
    residenceAreaOther: "",
    residenceCity: residence.defaultCity ?? "",
  });
  const [serverErrors, setServerErrors] = useState<Partial<Record<JoiningFormField, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<JoiningFormField, boolean>>>({});
  const [fromId, setFromId] = useState<{ birthDate: boolean; gender: boolean }>({ birthDate: false, gender: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // The page's own check, run on every keystroke — shown for a field once it has been left, and for
  // every field once Submit is pressed. The server runs the same function and has the last word.
  const live = useMemo(
    () => validateJoiningForm(answers, { residenceAreaOptions: residence.areaOptions, todayIso: today }).errors,
    [answers, residence.areaOptions, today],
  );
  const required = requiredFields(answers, hasAreaList);
  const complete = required.filter((field) => String(answers[field] ?? "").trim() && !live[field]).length;
  const percent = Math.round((complete / required.length) * 100);
  const recognised = readEgyptianNationalId(answers.nationalId);

  function errorFor(field: JoiningFormField): string | undefined {
    return serverErrors[field] ?? (touched[field] ? live[field] : undefined);
  }

  function leave(field: JoiningFormField) {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  function set<K extends JoiningFormField>(key: K, value: string) {
    setAnswers((current) => ({ ...current, [key]: value }));
    setServerErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
    if (key === "birthDate" || key === "gender") setFromId((current) => ({ ...current, [key]: false }));
  }

  // The national ID already states the date of birth and the gender — fill both the moment it is
  // complete, so the candidate only confirms them. Either can still be changed; the check then says
  // they differ from the ID.
  function setNationalId(raw: string) {
    set("nationalId", raw);
    const read = readEgyptianNationalId(raw);
    if (!read) return;
    const fills = { birthDate: !answers.birthDate, gender: !answers.gender };
    setFromId((current) => ({ birthDate: current.birthDate || fills.birthDate, gender: current.gender || fills.gender }));
    setAnswers((current) => ({
      ...current,
      birthDate: current.birthDate || read.birthDate,
      gender: current.gender || read.gender,
      nationalId: raw,
    }));
  }

  // The cascade: the area chosen picks its governorate when that is recognisable.
  function setResidenceArea(value: string) {
    set("residenceArea", value);
    const city = residence.cityByArea[value];
    if (city) setAnswers((current) => ({ ...current, residenceArea: value, residenceCity: city }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    const checked = validateJoiningForm(answers, { residenceAreaOptions: residence.areaOptions, todayIso: today });
    if (!checked.value) {
      setTouched(Object.fromEntries(required.map((field) => [field, true])));
      const first = required.find((field) => checked.errors[field]) ?? Object.keys(checked.errors)[0];
      if (first) document.getElementById(`jf-${first}`)?.focus();
      setFailure("A few details still need your attention — they are marked in red above.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/public/offer-acceptance/${encodeURIComponent(token)}`, {
        body: JSON.stringify(answers),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        errors?: Partial<Record<JoiningFormField, string>>;
        hrId?: string;
        message?: string;
        ok?: boolean;
        satoEmail?: string | null;
        satoEmailReason?: string | null;
      };
      if (response.ok && payload.ok && payload.hrId) {
        setDone({ hrId: payload.hrId, satoEmail: payload.satoEmail ?? null, satoEmailReason: payload.satoEmailReason ?? null });
        window.scrollTo({ behavior: "smooth", top: 0 });
        return;
      }
      if (payload.errors) setServerErrors(payload.errors);
      setFailure(payload.message ?? "Please check the highlighted fields and try again.");
    } catch {
      setFailure("We could not reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <JoiningFormDone done={done} view={view} />;

  const ref = (field: JoiningFormField) => `jf-${field}`;
  const aria = (field: JoiningFormField, hasMessage: boolean) => ({
    "aria-describedby": hasMessage ? `${ref(field)}-message` : undefined,
    "aria-invalid": errorFor(field) ? true : undefined,
    id: ref(field),
    onBlur: () => leave(field),
  });

  const sato = job.satoEmail
    ? { tag: "Created when you submit", value: job.satoEmail }
    : { tag: undefined, value: `HR will send it to you${job.satoEmailReason ? ` — ${job.satoEmailReason}` : ""}` };
  const offerRows: BandRow[] = [
    { label: "Position", value: job.jobTitle || PENDING },
    { label: "Start date", value: letterDate(job.hireDate, "short") },
    ...(pay ? [{ label: "Net monthly", value: money(pay.netSalary) }] : []),
    { label: "Contract", value: job.contractType || PENDING },
  ];
  const detailsIndex = pay ? "03" : "02";
  const acceptIndex = pay ? "04" : "03";
  const detailsDone = complete === required.length;
  const steps: RailStep[] = [
    { index: "01", state: "done", status: "Set by your offer", title: "Your position" },
    ...(pay ? [{ index: "02", state: "done" as const, status: "Set by your offer", title: "Your package" }] : []),
    {
      index: detailsIndex,
      state: detailsDone ? "done" : "active",
      status: `${complete} of ${required.length} complete`,
      title: "Your details",
    },
    {
      index: acceptIndex,
      state: detailsDone ? "active" : "waiting",
      status: detailsDone ? "Ready to submit" : "After your details",
      title: "Accept your offer",
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-[#f2f5f7] text-[#45515a]" style={{ fontFamily: SATO_FONT }}>
      <SatoStyles />
      <SatoBand
        card={{ meta: offer.reference, rows: offerRows, title: "Your offer" }}
        eyebrow="Offer of employment"
        subtitle="Check your position and package, complete your personal details, and press Submit to accept the offer."
        title={`Welcome to Sato Pharma, ${offer.salutationName}`}
      />

      {/* The progress rail: how much of the form is done, held at the top while scrolling. */}
      <div className="jf-no-print sticky top-0 z-30 border-b border-[#dde4e8] bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-2.5 sm:px-8">
          <p className={`${micro} text-[#111820]`}>
            Your details <span className="text-[#8a959d]">·</span>{" "}
            <span className="tabular-nums text-[#0879b8]">
              {complete} of {required.length}
            </span>
          </p>
          <p className={`${micro} hidden text-[#8a959d] sm:block`}>Submit is your acceptance</p>
        </div>
        <div aria-hidden className="h-[3px] bg-[#e1e7eb]">
          <div className="jf-fill h-full bg-[#0879b8]" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-8 lg:py-14">
        <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-12">
          <aside className="jf-no-print hidden lg:block">
            <StepRail steps={steps} />
          </aside>

          <div className="min-w-0 space-y-8">
            <div className="jf-rise border-l-[3px] border-[#0879b8] bg-white px-5 py-4 sm:px-6" style={delay(180)}>
              <p className="text-[15px] leading-relaxed">
                Please check your position and package, then complete your personal details.{" "}
                <strong className="font-semibold text-[#111820]">Pressing Submit is your acceptance of the offer.</strong> If you
                wish to decline, simply reply to the offer email.
              </p>
            </div>

            <Section delay={240} flush index="01" note="Set by your offer and your seat in the organisation." title="Your position">
              <DataTable
                caption="Your position"
                groups={[
                  {
                    rows: [
                      { label: "Job position", value: job.jobTitle },
                      { label: "Department", value: job.departmentName },
                      { label: "Line", value: job.lineName },
                      { label: "Contract type", value: job.contractType },
                    ],
                    title: "Role",
                  },
                  {
                    rows: [
                      { label: "Area", value: job.areaName },
                      { label: "Region", value: job.regionName },
                      {
                        label: "Manager",
                        note: job.managerName && job.managerHrId ? `HR ID ${job.managerHrId}` : null,
                        value: job.managerName ?? job.managerHrId,
                      },
                      { label: "Hiring date", value: job.hireDate ? letterDate(job.hireDate) : null },
                    ],
                    title: "Where you work",
                  },
                  {
                    rows: [
                      { label: "HR ID", tag: job.hrIdPreview ? "Confirmed when you submit" : undefined, value: job.hrIdPreview },
                      { label: "Sato email", tag: sato.tag, value: sato.value },
                    ],
                    title: "Your accounts",
                  },
                ]}
              />
            </Section>

            {pay ? (
              <Section delay={300} flush index="02" note="Monthly, in Egyptian pounds." title="Your package">
                <div className="-mx-5 sm:-mx-7">
                  <table className="w-full table-fixed border-collapse text-left">
                    <caption className="sr-only">Your monthly package</caption>
                    <colgroup>
                      <col />
                      <col className="w-[48%] sm:w-[40%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-[#111820]">
                        <th className={`${micro} pb-2.5 pl-5 text-[#0879b8] sm:pl-7`} scope="col">
                          Component
                        </th>
                        <th className={`${micro} pb-2.5 pr-5 text-right text-[#0879b8] sm:pr-7`} scope="col">
                          Monthly
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ["Base salary", pay.baseSalary],
                          ["Basic salary", pay.basicSalary],
                          ["Fuel allowance", pay.fuelAllowance],
                          ["Extra cost of living", pay.extraCostOfLiving],
                          ["Gross salary", pay.grossSalary],
                        ] as const
                      ).map(([label, amount], index) => (
                        <tr className={`border-b border-[#e9eef1] ${index % 2 ? "bg-[#f4f7f9]" : "bg-white"}`} key={label}>
                          <th className="py-3.5 pl-5 pr-3 text-[15px] font-normal leading-snug sm:pl-7" scope="row">
                            {label}
                          </th>
                          <td className="py-3.5 pr-5 text-right text-[15px] font-semibold leading-snug tabular-nums text-[#111820] sm:pr-7">
                            {money(amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-[#111820] text-white">
                        <th className="py-5 pl-5 pr-3 align-middle sm:pl-7" scope="row">
                          <span className={`${micro} block text-[#5db7e8]`}>Net salary</span>
                          <span className="mt-1 block text-[12.5px] leading-snug text-[#9aa6af]">Paid to you each month</span>
                        </th>
                        <td className="py-5 pr-5 text-right align-middle text-[22px] font-bold leading-none tabular-nums sm:pr-7 sm:text-[30px]">
                          {money(pay.netSalary)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Section>
            ) : null}

            <form noValidate onSubmit={submit}>
              <div className="space-y-8">
                <Section delay={360} index={detailsIndex} note="For your employee record — only you can fill these in." title="Your details">
                  <div className="space-y-8">
                    <div className="space-y-5">
                      <GroupLabel>Identity</GroupLabel>
                      <Field error={errorFor("fullName")} hint="In English, as written on your national ID card." htmlFor={ref("fullName")} label="Full name">
                        <input autoComplete="name" className={controlClass(Boolean(errorFor("fullName")))} onChange={(e) => set("fullName", e.target.value)} value={answers.fullName} {...aria("fullName", true)} />
                      </Field>
                      <Field
                        error={errorFor("nationalId")}
                        hint={
                          recognised
                            ? `Recognised — born ${letterDate(recognised.birthDate)}, ${genderLabel(recognised.gender).toLowerCase()}.`
                            : "14 digits. Your date of birth and gender are filled in from it."
                        }
                        hintTone={recognised ? "confirm" : "quiet"}
                        htmlFor={ref("nationalId")}
                        label="National ID number"
                      >
                        <input
                          autoComplete="off"
                          className={controlClass(Boolean(errorFor("nationalId")), "tabular-nums tracking-[0.08em]")}
                          inputMode="numeric"
                          maxLength={20}
                          onChange={(e) => setNationalId(e.target.value)}
                          placeholder="14 digits"
                          value={answers.nationalId}
                          {...aria("nationalId", true)}
                        />
                      </Field>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("gender")} htmlFor={ref("gender")} label="Gender" tag={fromId.gender && answers.gender ? "From your ID" : undefined}>
                          <select className={controlClass(Boolean(errorFor("gender")), "pr-10")} onChange={(e) => set("gender", e.target.value)} style={selectStyle} value={answers.gender} {...aria("gender", Boolean(errorFor("gender")))}>
                            <option value="">Choose</option>
                            {JOINING_FORM_GENDER_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field error={errorFor("birthDate")} htmlFor={ref("birthDate")} label="Date of birth" tag={fromId.birthDate && answers.birthDate ? "From your ID" : undefined}>
                          <input className={controlClass(Boolean(errorFor("birthDate")))} max={today} onChange={(e) => set("birthDate", e.target.value)} type="date" value={answers.birthDate} {...aria("birthDate", Boolean(errorFor("birthDate")))} />
                        </Field>
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>Contact</GroupLabel>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("mobileNumber")} htmlFor={ref("mobileNumber")} label="Mobile number">
                          <input autoComplete="tel" className={controlClass(Boolean(errorFor("mobileNumber")), "tabular-nums")} inputMode="tel" onChange={(e) => set("mobileNumber", e.target.value)} placeholder="01XXXXXXXXX" type="tel" value={answers.mobileNumber} {...aria("mobileNumber", Boolean(errorFor("mobileNumber")))} />
                        </Field>
                        <Field error={errorFor("personalEmail")} htmlFor={ref("personalEmail")} label="Private email">
                          <input autoComplete="email" className={controlClass(Boolean(errorFor("personalEmail")))} inputMode="email" onChange={(e) => set("personalEmail", e.target.value)} type="email" value={answers.personalEmail} {...aria("personalEmail", Boolean(errorFor("personalEmail")))} />
                        </Field>
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>Education</GroupLabel>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("education")} htmlFor={ref("education")} label="Faculty">
                          <select className={controlClass(Boolean(errorFor("education")), "pr-10")} onChange={(e) => set("education", e.target.value)} style={selectStyle} value={answers.education} {...aria("education", Boolean(errorFor("education")))}>
                            <option value="">Choose your faculty</option>
                            {JOINING_FORM_EDUCATION_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {answers.education === "Other" ? (
                          <Field error={errorFor("educationOther")} htmlFor={ref("educationOther")} label="Your faculty or degree">
                            <input className={controlClass(Boolean(errorFor("educationOther")))} onChange={(e) => set("educationOther", e.target.value)} value={answers.educationOther} {...aria("educationOther", Boolean(errorFor("educationOther")))} />
                          </Field>
                        ) : null}
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>Residence</GroupLabel>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("residenceArea")} htmlFor={ref("residenceArea")} label="Residence area">
                          {hasAreaList ? (
                            <select className={controlClass(Boolean(errorFor("residenceArea")), "pr-10")} onChange={(e) => setResidenceArea(e.target.value)} style={selectStyle} value={answers.residenceArea} {...aria("residenceArea", Boolean(errorFor("residenceArea")))}>
                              <option value="">Choose your area</option>
                              {residence.areaOptions.map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                              <option value={JOINING_FORM_OTHER_AREA}>My area is not listed</option>
                            </select>
                          ) : (
                            <input className={controlClass(Boolean(errorFor("residenceArea")))} onChange={(e) => set("residenceArea", e.target.value)} placeholder="District or neighbourhood" value={answers.residenceArea} {...aria("residenceArea", Boolean(errorFor("residenceArea")))} />
                          )}
                        </Field>
                        <Field error={errorFor("residenceCity")} htmlFor={ref("residenceCity")} label="Residence city">
                          <select className={controlClass(Boolean(errorFor("residenceCity")), "pr-10")} onChange={(e) => set("residenceCity", e.target.value)} style={selectStyle} value={answers.residenceCity} {...aria("residenceCity", Boolean(errorFor("residenceCity")))}>
                            <option value="">Choose your city</option>
                            {JOINING_FORM_GOVERNORATES.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      {hasAreaList && answers.residenceArea === JOINING_FORM_OTHER_AREA ? (
                        <Field error={errorFor("residenceAreaOther")} htmlFor={ref("residenceAreaOther")} label="Your area">
                          <input className={controlClass(Boolean(errorFor("residenceAreaOther")))} onChange={(e) => set("residenceAreaOther", e.target.value)} placeholder="District or neighbourhood" value={answers.residenceAreaOther} {...aria("residenceAreaOther", Boolean(errorFor("residenceAreaOther")))} />
                        </Field>
                      ) : null}
                      <Field error={errorFor("residenceAddress")} htmlFor={ref("residenceAddress")} label="Residence address">
                        <textarea
                          className={controlClass(Boolean(errorFor("residenceAddress")), "h-auto min-h-[96px] py-3 leading-relaxed")}
                          onChange={(e) => set("residenceAddress", e.target.value)}
                          placeholder="Building, street, landmark"
                          rows={3}
                          value={answers.residenceAddress}
                          {...aria("residenceAddress", Boolean(errorFor("residenceAddress")))}
                        />
                      </Field>
                    </div>
                  </div>
                </Section>

                <Section delay={420} framed index={acceptIndex} title="Accept your offer">
                  <DataTable caption="Sato Pharma's offer to you" groups={[{ rows: offerRows, title: "Sato Pharma's offer to you" }]} />
                  <p className="mt-6 text-[15px] leading-relaxed">
                    By pressing Submit you accept this offer of employment and confirm that the details above are correct.
                  </p>

                  {failure ? (
                    <p className="mt-5 flex items-start gap-3 border border-[#b91c1c] bg-white px-4 py-3 text-sm leading-relaxed text-[#b91c1c]" role="alert">
                      <span aria-hidden className="mt-[6px] h-1.5 w-1.5 shrink-0 bg-[#b91c1c]" />
                      <span className="min-w-0">{failure}</span>
                    </p>
                  ) : null}

                  {/* The website's button: uppercase micro type, and a white wipe on hover. */}
                  <button
                    className="jf-no-print group relative mt-6 flex h-14 w-full items-center justify-between gap-4 overflow-hidden rounded-none border border-[#0879b8] bg-[#0879b8] px-6 text-left text-[11.5px] font-bold uppercase tracking-[0.2em] text-white transition-colors duration-500 before:absolute before:inset-0 before:origin-left before:scale-x-0 before:bg-white before:transition-transform before:duration-500 before:ease-[cubic-bezier(.16,1,.3,1)] hover:text-[#0879b8] hover:before:scale-x-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111820] disabled:cursor-wait disabled:border-[#111820] disabled:bg-[#111820] disabled:text-white disabled:before:hidden"
                    disabled={busy}
                    type="submit"
                  >
                    <span className="relative min-w-0">{busy ? "Submitting your acceptance" : "Submit and accept the offer"}</span>
                    <span aria-hidden className="relative shrink-0 text-lg transition-transform duration-300 group-hover:translate-x-1 group-disabled:translate-x-0">
                      →
                    </span>
                    {busy ? (
                      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-white/15">
                        <span className="jf-run block h-full w-1/4 bg-[#5db7e8]" />
                      </span>
                    ) : null}
                  </button>
                  <p className="mt-3 text-[13px] leading-relaxed text-[#69757e]">
                    {complete < required.length
                      ? `${required.length - complete} of your details still to complete. To decline instead, reply to the offer email.`
                      : "Everything is filled in. To decline instead, reply to the offer email."}
                  </p>
                </Section>
              </div>
            </form>
          </div>
        </div>
      </main>
      <SatoFooter />
    </div>
  );
}
