"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  AR_EDUCATION,
  AR_GENDER,
  JOINING_COPY,
  JOINING_LANG_STORAGE_KEY,
  translateMessage,
  type JoiningCopy,
  type JoiningLang,
} from "@/components/offers/joining-form-copy";
import {
  JOINING_FORM_EDUCATION_OPTIONS,
  JOINING_FORM_FACE_PHOTO_FIELD,
  JOINING_FORM_GENDER_OPTIONS,
  JOINING_FORM_GOVERNORATES,
  JOINING_FORM_OTHER_AREA,
  JOINING_FORM_PHOTO_FIELDS,
  JOINING_FORM_PHOTO_TYPES,
  JOINING_FORM_PHOTO_UNREADABLE,
  readEgyptianNationalId,
  validateJoiningFacePhoto,
  validateJoiningForm,
  validateJoiningIdPhotos,
  type JoiningFormAnswers,
  type JoiningFormField,
  type JoiningFormUploadField,
} from "@/lib/offers/joining-form";
import type { JoiningFormView } from "@/lib/offers/joining-form-service";

/**
 * The candidate's joining form — 100% Sato Pharma (owner, 2026-10-08), never Phoenix.
 *
 * Built in satopharma.com's own language, from the `sato-pharma-identity` skill: a navy hero with a
 * header bar and the Arabic calligraphy as its watermark, an eyebrow led by a light-blue rule, a 48px
 * headline, a framed card with white corner ticks beside a vertical tick rule, the 14px tick rule and
 * the 3px brand-blue seam closing the band, and the site's numbered footer with its "Success is
 * Acquired by Talented Operators" line. Every piece of data the candidate reads sits in a zebra
 * table. Micro labels (10.5px bold uppercase, 0.2em tracking), 1px hairlines, one brand blue, and
 * every corner 90°. No soft shadows, no gradient washes, no circles. Exempt from the Phoenix form kit
 * for the same reason `offers/` is — this page is the company's.
 *
 * ENGLISH AND ARABIC (owner, 2026-10-08). A switch in the header bar turns the whole page — every
 * label, hint, message and the layout direction — into Arabic, right to left, set in Cairo, and the
 * choice is remembered on that phone. Every direction in the layout is logical (start/end), so one
 * set of classes serves both. The words live in ./joining-form-copy.ts; the values never change.
 *
 * THE NATIONAL ID PHOTOS (owner, 2026-10-08). Front and back are both required; each is shrunk in the
 * browser before it is sent, and Submit files them on Hiring Documents for the new record.
 *
 * THE PHOTO (owner, 2026-10-08) — optional, labelled just "Photo". Shrunk the same way; Submit makes it
 * the new record's profile photo and files it beside "(6) personal photos" without ticking that slot.
 *
 * Mobile first: the candidate opens it from a phone's mail app. One column at 375px, the step rail
 * only from 1024px, nothing that scrolls sideways, and nothing cut with an ellipsis.
 */

type OpenView = Extract<JoiningFormView, { kind: "open" }>;
type Done = { hrId: string; satoEmail: string | null; satoEmailReason: string | null };
type FieldKey = JoiningFormField | JoiningFormUploadField;
type Photo = { file: File; url: string };

const LATIN_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const ARABIC_FONT = 'Cairo, "Segoe UI", Tahoma, sans-serif';
const micro = "jf-micro text-[10.5px] font-bold uppercase tracking-[0.2em]";

// A square caret for the selects — the platform's own arrow is rounded on iOS and differs per browser.
const CARET =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M0 0h10L5 6z' fill='%23111820'/%3E%3C/svg%3E\")";

/**
 * The page's motion and engraving, scoped by the `jf-` prefix: the ink grid, the website's tick
 * rules, the Arabic watermark's white ink, outline numerals, a rise and a mask reveal on entry, the
 * check drawing in its seal, the footer's marquee, and the bar that runs while Submit is working.
 * In Arabic the micro label drops its letter-spacing and capitals — tracking pulls joined letters
 * apart — and the drawn rules grow from the right. Reduced motion and print get no motion.
 */
const SATO_CSS = `
.jf-ink-grid{background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:56px 56px}
.jf-tick-x{background-image:linear-gradient(to right,currentColor 1px,transparent 1px),linear-gradient(to right,currentColor 1px,transparent 1px);background-size:8px 6px,40px 14px;background-repeat:repeat-x;background-position:left bottom,left bottom}
.jf-tick-y{background-image:linear-gradient(to bottom,currentColor 1px,transparent 1px),linear-gradient(to bottom,currentColor 1px,transparent 1px);background-size:6px 8px,14px 40px;background-repeat:repeat-y}
.jf-arabic{filter:brightness(0) invert(1);opacity:.13}
.jf-outline-marquee{color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.22)}
.jf-ghost{color:transparent;-webkit-text-stroke:1px #d3dce1;font-weight:700;line-height:.8;letter-spacing:-.04em;font-variant-numeric:tabular-nums;transition:-webkit-text-stroke-color .5s}
.jf-section:focus-within .jf-ghost{-webkit-text-stroke-color:#0879b8}
[dir=rtl] .jf-micro{letter-spacing:0!important;text-transform:none!important;font-size:12px!important}
@keyframes jf-rise{from{opacity:0;transform:translateY(14px)}}
.jf-rise{animation:jf-rise .9s cubic-bezier(.16,1,.3,1) var(--jf-delay,0ms) backwards}
@keyframes jf-mask{from{clip-path:inset(0 0 100% 0);transform:translateY(.35em)}to{clip-path:inset(0 0 -10% 0);transform:none}}
.jf-mask{animation:jf-mask 1.1s cubic-bezier(.16,1,.3,1) var(--jf-delay,0ms) backwards}
@keyframes jf-draw-x{from{transform:scaleX(0)}}
.jf-draw{transform-origin:left;animation:jf-draw-x 1.1s cubic-bezier(.16,1,.3,1) .35s backwards}
[dir=rtl] .jf-draw{transform-origin:right}
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

// Cairo, the identity's Arabic face — loaded only once a reader switches to Arabic. The site's CSP
// already allows Google Fonts (style-src and font-src).
const CAIRO_CSS = '@import url("https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap");';

// ── The language: remembered on the phone, read without a hydration mismatch ─────────────────────
// The server always renders English; the browser then reads the stored choice (or an Arabic phone's
// own language) through useSyncExternalStore. A choice made while storage is blocked still holds for
// the visit, from memory.

const langListeners = new Set<() => void>();
let chosenLang: JoiningLang | null = null;

function readLang(): JoiningLang {
  if (chosenLang) return chosenLang;
  try {
    const stored = window.localStorage.getItem(JOINING_LANG_STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    // Storage blocked — fall through to the phone's language.
  }
  return /^ar\b/i.test(window.navigator.language || "") ? "ar" : "en";
}

function subscribeLang(listener: () => void) {
  langListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    langListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function chooseLang(next: JoiningLang) {
  chosenLang = next;
  try {
    window.localStorage.setItem(JOINING_LANG_STORAGE_KEY, next);
  } catch {
    // Remembered for this visit only.
  }
  langListeners.forEach((listener) => listener());
}

type CopyContextValue = { lang: JoiningLang; t: JoiningCopy };
const CopyContext = createContext<CopyContextValue>({ lang: "en", t: JOINING_COPY.en });

function useCopy(): CopyContextValue {
  return useContext(CopyContext);
}

/** The page's root: direction, language, face and ground, and the words every child reads. */
function SatoShell({ children }: { children: React.ReactNode }) {
  const lang = useSyncExternalStore(subscribeLang, readLang, () => "en" as const);
  const value = useMemo(() => ({ lang, t: JOINING_COPY[lang] }), [lang]);
  return (
    <CopyContext.Provider value={value}>
      <div
        className="flex min-h-screen flex-col bg-[#f2f5f7] text-[#45515a]"
        dir={lang === "ar" ? "rtl" : "ltr"}
        lang={lang}
        style={{ fontFamily: lang === "ar" ? ARABIC_FONT : LATIN_FONT }}
      >
        <style href="sato-joining-form" precedence="default">
          {SATO_CSS}
        </style>
        {lang === "ar" ? (
          <style href="sato-joining-form-cairo" precedence="default">
            {CAIRO_CSS}
          </style>
        ) : null}
        {children}
      </div>
    </CopyContext.Provider>
  );
}

function delay(ms: number): React.CSSProperties {
  return { "--jf-delay": `${ms}ms` } as React.CSSProperties;
}

function money(value: number, lang: JoiningLang): string {
  const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
  return lang === "ar" ? `${amount} ج.م` : `EGP ${amount}`;
}

function letterDate(iso: string, lang: JoiningLang, month: "long" | "short" = "long"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || JOINING_COPY[lang].pending;
  const date = new Date(`${iso}T00:00:00Z`);
  // Latin digits in Arabic too, so a date reads the same as the ID, the mobile and the pay beside it.
  const locale = lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
  return date.toLocaleDateString(locale, { day: "2-digit", month, timeZone: "UTC", year: "numeric" });
}

function genderLabel(value: string, lang: JoiningLang): string {
  if (lang === "ar") return AR_GENDER[value] ?? value;
  return JOINING_FORM_GENDER_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/** Corner ticks on a frame, as the website draws them. The frame needs `relative`. */
function FrameTicks({ inset = false, tone = "ink" }: { inset?: boolean; tone?: "brand" | "ink" | "white" }) {
  const colour = tone === "white" ? "border-white" : tone === "brand" ? "border-[#0879b8]" : "border-[#111820]";
  const size = inset ? "h-4 w-4" : "h-5 w-5";
  const at = inset
    ? ["left-2.5 top-2.5", "right-2.5 top-2.5", "bottom-2.5 left-2.5", "bottom-2.5 right-2.5"]
    : ["-left-px -top-px", "-right-px -top-px", "-bottom-px -left-px", "-bottom-px -right-px"];
  const tick = `pointer-events-none absolute z-10 ${size} ${colour}`;
  return (
    <>
      <span aria-hidden className={`${tick} ${at[0]} border-l-2 border-t-2`} />
      <span aria-hidden className={`${tick} ${at[1]} border-r-2 border-t-2`} />
      <span aria-hidden className={`${tick} ${at[2]} border-b-2 border-l-2`} />
      <span aria-hidden className={`${tick} ${at[3]} border-b-2 border-r-2`} />
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

/** The header bar's switch between English and Arabic — the label names the OTHER language. */
function LanguageSwitch() {
  const { lang, t } = useCopy();
  const next: JoiningLang = lang === "ar" ? "en" : "ar";
  return (
    <button
      aria-label={t.language.switchTo}
      className="jf-no-print border border-[#3a4652] px-3 py-1.5 text-[13px] font-bold leading-none text-white transition-colors hover:border-[#5db7e8] hover:text-[#5db7e8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5db7e8]"
      lang={next}
      onClick={() => chooseLang(next)}
      style={{ fontFamily: next === "ar" ? ARABIC_FONT : LATIN_FONT }}
      type="button"
    >
      {t.language.label}
    </button>
  );
}

type BandRow = { label: string; value: string };
type BandCard = { meta?: string | null; rows: BandRow[]; title: string };

/** The hero's framed card — the website frames a photograph here; this page frames the offer. */
function HeroCard({ card }: { card: BandCard }) {
  return (
    <div className="jf-rise relative ps-6 sm:ps-7" style={delay(260)}>
      <div aria-hidden className="jf-tick-y absolute inset-y-2 start-0 w-4 text-white/50" />
      <div className="relative border border-white/20 bg-[#111820]/35">
        <FrameTicks tone="white" />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-white/15 px-5 py-3.5">
          <p className={`${micro} text-[#5db7e8]`}>{card.title}</p>
          {card.meta ? (
            <p className={`${micro} text-[#6f7c86] [overflow-wrap:anywhere]`} dir="ltr">
              {card.meta}
            </p>
          ) : null}
        </div>
        <table className="w-full table-fixed border-collapse text-start">
          <caption className="sr-only">{card.title}</caption>
          <colgroup>
            <col className="w-[44%]" />
            <col />
          </colgroup>
          <tbody>
            {card.rows.map((row, index) => (
              <tr className={`border-b border-white/[0.08] last:border-b-0 ${index % 2 ? "bg-white/[0.045]" : ""}`} key={row.label}>
                <th className={`${micro} py-3.5 pe-3 ps-5 text-start align-top leading-[1.6] text-[#8d9aa4]`} scope="row">
                  {row.label}
                </th>
                <td className="py-3 pe-5 text-end align-top text-[15px] font-bold leading-snug tabular-nums text-white [overflow-wrap:anywhere] sm:text-base">
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
  tag,
  title,
}: {
  card?: BandCard;
  eyebrow: string;
  subtitle?: string;
  tag?: string;
  title: string;
}) {
  const { t } = useCopy();
  return (
    <header className="relative overflow-hidden bg-[#111820] text-white">
      <div aria-hidden className="jf-ink-grid pointer-events-none absolute inset-0" />
      {/* The company's own Arabic calligraphy (ساتو فارما) as the band's watermark, drawn in white
          behind everything else — on the right (the left in Arabic), its ink laid to the trim and
          never past it, because the right edge is where both words begin (owner, 2026-10-08: the
          Arabic mark, not the English one). The official file Phoenix's documents already use,
          recoloured by a filter, and sized to the band so no stroke is ever clipped. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden
        className="jf-arabic pointer-events-none absolute end-0 top-[92px] max-h-[calc(100%-126px)] w-[86%] max-w-[520px] select-none object-contain object-right sm:top-[100px] sm:w-[60%] lg:bottom-[22px] lg:top-auto lg:h-[min(380px,calc(100%-96px))] lg:max-h-none lg:w-auto lg:max-w-none rtl:object-left"
        src="/brand/sato-pharma-arabic-on-light.png"
      />

      {/* The header bar, as the website opens: the reverse mark, then the page's place. */}
      <div className="relative border-b border-[#26313b]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          {/* The reverse mark: SATO is drawn in white, so this file belongs on navy only. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Sato Pharma" className="h-8 w-auto sm:h-9" src="/brand/sato-pharma-logo.png" />
          <div className="flex items-center gap-3 sm:gap-5">
            <span className={`${micro} hidden text-[#9aa6af] md:inline`}>{t.band.humanResources}</span>
            <span aria-hidden className="hidden h-4 w-px bg-[#3a4652] md:inline-block" />
            <span className={`${micro} hidden border border-[#3a4652] px-2.5 py-1.5 text-white sm:inline-block`}>{tag ?? t.band.joiningForm}</span>
            <LanguageSwitch />
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
          <h1 className="jf-mask mt-5 break-words text-[32px] font-bold leading-[1.15] tracking-[-0.02em] sm:text-[48px] sm:leading-[1.05] rtl:leading-[1.35] rtl:tracking-normal sm:rtl:leading-[1.3]" style={delay(80)}>
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

const MARQUEE = ["Success is Acquired by Talented Operators", "Sato Pharma", "Success is Acquired by Talented Operators", "Sato Pharma"];

export function SatoFooter() {
  const { t } = useCopy();
  return (
    <footer className="relative mt-16 overflow-hidden bg-[#111820] text-white lg:mt-24">
      <div aria-hidden className="relative h-[3px] bg-[#0879b8]" />
      <div aria-hidden className="jf-ink-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto grid max-w-6xl gap-10 px-5 pt-12 sm:px-8 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] lg:gap-12 lg:pt-16">
        <div className="min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="Sato Pharma" className="h-9 w-auto" src="/brand/sato-pharma-logo.png" />
          {/* The company's motto stays in English in both languages — it spells the name. */}
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-[#9aa6af]" dir="ltr" lang="en" style={{ fontFamily: LATIN_FONT }}>
            <span className="font-bold text-white">SATO</span> — Success is Acquired by Talented Operators.
          </p>
        </div>
        {t.footer.columns.map((column, index) => (
          <div className="min-w-0 border-t border-[#26313b] pt-5 lg:border-t-0 lg:pt-0" key={column.title}>
            <p className={`${micro} text-[#6f7c86]`}>
              <span className="text-[#5db7e8]">{String(index + 1).padStart(2, "0")}</span> — {column.title}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#8d9aa4]">{column.body}</p>
          </div>
        ))}
      </div>

      {/* The website's marquee of outlined lettering — two copies, so the loop never shows a seam. */}
      <div aria-hidden className="relative mt-12 overflow-hidden border-y border-[#26313b] py-5 lg:mt-16 lg:py-7" dir="ltr">
        <div className="jf-marquee flex whitespace-nowrap">
          {[0, 1].map((copy) => (
            <div className="flex shrink-0" key={copy}>
              {MARQUEE.map((word, index) => (
                <span className="flex items-center" key={`${copy}-${index}`}>
                  <span className="jf-outline-marquee px-6 text-[40px] font-bold leading-none tracking-[-0.02em] sm:text-[64px]" style={{ fontFamily: LATIN_FONT }}>
                    {word}
                  </span>
                  <span className="h-2 w-2 shrink-0 bg-[#0879b8]" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col gap-2 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className={`${micro} text-[#6f7c86]`}>{t.footer.rights(new Date().getFullYear())}</p>
        <a className={`${micro} text-[#9aa6af] transition-colors hover:text-white`} dir="ltr" href="https://satopharma.com" rel="noreferrer" target="_blank">
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
  const { t } = useCopy();
  return (
    <section
      className={`jf-section jf-rise relative scroll-mt-20 bg-white ${framed ? "border border-[#111820]" : "border border-[#dde4e8]"}`}
      id={`jf-step-${index}`}
      style={delay(ms)}
    >
      {framed ? <FrameTicks /> : null}
      <header className="flex items-end justify-between gap-4 border-b border-[#dde4e8] px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
        <div className="min-w-0">
          <Eyebrow>{t.step(index)}</Eyebrow>
          <h2 className="mt-3 text-[24px] font-bold leading-[1.15] tracking-[-0.015em] text-[#111820] sm:text-[30px] rtl:leading-[1.35] rtl:tracking-normal">{title}</h2>
          {note ? <p className="mt-2 text-[14px] leading-relaxed text-[#69757e]">{note}</p> : null}
        </div>
        <span aria-hidden className="jf-ghost shrink-0 text-[52px] sm:text-[84px]" style={{ fontFamily: LATIN_FONT }}>
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

type DataRow = { label: string; ltr?: boolean; note?: string | null; tag?: string; value: React.ReactNode | null };
type DataGroup = { rows: DataRow[]; title?: string };

/**
 * Every fact the candidate reads, as one zebra table: a micro-labelled head row per group ruled in
 * ink, then white and canvas rows in turn, edge to edge across the section. Fixed columns, so it fits
 * a 375px phone by wrapping, never by scrolling sideways.
 */
function DataTable({ caption, groups }: { caption: string; groups: DataGroup[] }) {
  const { t } = useCopy();
  return (
    <div className="-mx-5 sm:-mx-7">
      <table className="w-full table-fixed border-collapse text-start">
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
                  className={`${micro} border-b border-[#111820] px-5 pb-2.5 text-start text-[#0879b8] sm:px-7 ${groupIndex === 0 ? "pt-0" : "pt-8"}`}
                  colSpan={2}
                  scope="colgroup"
                >
                  {group.title}
                </th>
              </tr>
            ) : null}
            {group.rows.map((row, index) => (
              <tr className={`border-b border-[#e9eef1] ${index % 2 ? "bg-[#f4f7f9]" : "bg-white"}`} key={row.label}>
                <th className={`${micro} py-3.5 pe-3 ps-5 text-start align-top leading-[1.6] text-[#69757e] sm:ps-7`} scope="row">
                  {row.label}
                </th>
                <td className="py-3 pe-5 align-top sm:pe-7">
                  {row.value ? (
                    <span className="block text-[15px] font-semibold leading-snug text-[#111820] [overflow-wrap:anywhere]" dir={row.ltr ? "ltr" : undefined}>
                      {row.value}
                    </span>
                  ) : (
                    <span className="block text-[15px] leading-snug text-[#8a959d]">{t.pending}</span>
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

function Message({ error, hint, hintTone = "quiet", id }: { error?: string; hint?: string; hintTone?: "quiet" | "confirm"; id: string }) {
  if (error) {
    return (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-snug text-[#b91c1c]" id={`${id}-message`} role="alert">
        <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 bg-[#b91c1c]" />
        <span className="min-w-0">{error}</span>
      </p>
    );
  }
  if (!hint) return null;
  return (
    <p className={`mt-2 flex items-start gap-2 text-[13px] leading-snug ${hintTone === "confirm" ? "text-[#06628f]" : "text-[#69757e]"}`} id={`${id}-message`}>
      {hintTone === "confirm" ? <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 bg-[#0879b8]" /> : null}
      <span className="min-w-0">{hint}</span>
    </p>
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
      <Message error={error} hint={hint} hintTone={hintTone} id={htmlFor} />
    </div>
  );
}

/**
 * One side of the national ID card: a framed tile at the card's own proportions, with camera corner
 * ticks while empty and the photo itself once chosen. The whole tile is the file input's label, so a
 * tap anywhere opens the phone's camera or gallery. `portrait` draws the optional photo's tile instead:
 * a 3:4 frame with a head-and-shoulders mark, and a tag beside its label.
 *
 * When the phone's chooser closes with nothing chosen, the tile says so and offers the camera on its
 * own input. Chrome on Android refuses the gallery when it has no Photos permission and only flashes
 * "Unable to select media because permissions were denied" for a few seconds — a candidate who then
 * sees an empty tile has no way forward, and the national ID photos are required.
 */
function IdPhotoTile({
  busy,
  error,
  field,
  label,
  onPick,
  photo,
  portrait = false,
  tag,
}: {
  busy: boolean;
  error?: string;
  field: JoiningFormUploadField;
  label: string;
  onPick: (file: File) => void;
  photo: Photo | null;
  portrait?: boolean;
  tag?: string;
}) {
  const { t } = useCopy();
  const id = `jf-${field}`;
  const chooser = useRef<HTMLInputElement>(null);
  const [stalled, setStalled] = useState(false);
  // Chrome fires `cancel` on a file input whenever its chooser closes with nothing chosen — the
  // candidate backing out, or the phone refusing the gallery. React does not bind it on an input.
  useEffect(() => {
    const input = chooser.current;
    if (!input) return;
    const onCancel = () => setStalled(true);
    input.addEventListener("cancel", onCancel);
    return () => input.removeEventListener("cancel", onCancel);
  }, []);
  const take = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    setStalled(false);
    if (file) onPick(file);
  };
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <p className={`${micro} text-[#111820]`}>{label}</p>
        {tag ? <Tag>{tag}</Tag> : null}
      </div>
      <label
        className={`group relative mt-2 flex ${portrait ? "aspect-[3/4] max-w-[220px]" : "aspect-[1.585]"} w-full cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden border bg-[#f7f9fa] px-4 text-center transition-colors focus-within:border-[#0879b8] focus-within:shadow-[inset_0_0_0_1px_#0879b8] ${
          error ? "border-[#b91c1c]" : photo ? "border-[#111820]" : "border-[#cdd6dc] hover:border-[#0879b8]"
        }`}
        htmlFor={id}
      >
        {photo ? (
          <>
            {/* A local preview of the photo just chosen — an object URL, never a served image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt={label} className="absolute inset-0 h-full w-full object-cover" src={photo.url} />
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-[#111820]/85 px-3 py-2 text-white">
              <span className={`${micro} flex min-w-0 items-center gap-2`}>
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-[#5db7e8]" />
                <span className="min-w-0">{label}</span>
              </span>
              <span className={`${micro} shrink-0 text-[#5db7e8] group-hover:text-white`}>{t.photos.replace}</span>
            </span>
          </>
        ) : (
          <>
            <FrameTicks inset tone={error ? "ink" : "brand"} />
            {portrait ? (
              <svg aria-hidden className="h-12 w-10 text-[#0879b8]" fill="none" viewBox="0 0 40 48">
                <rect height="46" stroke="currentColor" strokeWidth="2" width="38" x="1" y="1" />
                <rect height="13" stroke="currentColor" strokeWidth="2" width="12" x="14" y="10" />
                <path d="M7 43v-6l6-6h14l6 6v6" stroke="currentColor" strokeWidth="2" />
              </svg>
            ) : (
              <svg aria-hidden className="h-9 w-12 text-[#0879b8]" fill="none" viewBox="0 0 48 36">
                <rect height="34" stroke="currentColor" strokeWidth="2" width="46" x="1" y="1" />
                <rect height="14" stroke="currentColor" strokeWidth="2" width="11" x="7" y="9" />
                <path d="M24 11h17M24 17h17M24 23h11" stroke="currentColor" strokeWidth="2" />
              </svg>
            )}
            <span className="text-[13px] font-semibold leading-snug text-[#111820]">{busy ? t.photos.preparing : t.photos.choose}</span>
          </>
        )}
        <input
          accept="image/*"
          aria-describedby={error ? `${id}-message` : undefined}
          aria-invalid={error ? true : undefined}
          aria-label={label}
          className="sr-only"
          id={id}
          onChange={take}
          ref={chooser}
          type="file"
        />
      </label>
      <Message error={error} id={id} />
      {stalled && !photo && !busy ? (
        <div className="jf-no-print mt-2 space-y-3 border border-[#cdd6dc] bg-white p-3" role="status">
          <p className="text-[13px] leading-snug text-[#69757e]">{t.photos.blocked}</p>
          <label
            className="inline-flex min-h-[44px] cursor-pointer items-center border border-[#0879b8] px-4 text-[13px] font-bold leading-none text-[#0879b8] transition-colors hover:bg-[#0879b8] hover:text-white focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#111820]"
            htmlFor={`${id}-camera`}
          >
            {t.photos.camera}
            <input accept="image/*" capture={portrait ? "user" : "environment"} className="sr-only" id={`${id}-camera`} onChange={take} type="file" />
          </label>
        </div>
      ) : null}
    </div>
  );
}

/**
 * HEIC/HEIF by its first bytes, its type or its name. A phone set to save "high efficiency" pictures
 * (Samsung's own setting, an iPhone's default) puts HEIC files in the gallery, and Chrome on Android
 * cannot open one — so the page decodes it itself (6 Nov 2026: the back of a candidate's card arrived
 * as a broken tile and was refused).
 */
async function looksLikeHeic(file: File): Promise<boolean> {
  if (/^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const text = String.fromCharCode(...head.subarray(4, 12));
    return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(text);
  } catch {
    return false;
  }
}

/**
 * The photo as a picture the page can draw: the browser's own decoder first, then — only for a HEIC
 * file — `heic-to`, loaded on that first HEIC alone (it is about 3 MB). Its `csp` build, because the
 * page policy has no 'unsafe-eval'. Null when neither can open it.
 */
async function decodePhoto(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Not a picture this browser opens — try HEIC below.
  }
  if (!(await looksLikeHeic(file))) return null;
  try {
    const { heicTo } = await import("heic-to/csp");
    return await heicTo({ blob: file, type: "bitmap" });
  } catch {
    return null;
  }
}

/**
 * Shrink a phone photo before it is sent: the long side to 2,000px, re-encoded as JPEG. A 12MP photo
 * becomes well under a megabyte, the two fit the proxy's 10 MB body limit with room to spare, the
 * upload survives mobile data — and re-encoding drops the photo's location metadata. A HEIC photo is
 * decoded on the phone and leaves as the same JPEG. A file that is not a picture (a PDF) is kept as it
 * is, and the check names it; a picture nothing can open is `unreadable`, and the page keeps nothing.
 */
async function preparePhoto(file: File, name: string): Promise<{ file: File } | { unreadable: true }> {
  if (file.type && !file.type.startsWith("image/") && !(await looksLikeHeic(file))) return { file };
  const bitmap = await decodePhoto(file);
  if (!bitmap) return { unreadable: true };
  // The shrink failed on a picture that did open: send it as it is when the check takes its type.
  const asItIs = () => (JOINING_FORM_PHOTO_TYPES.includes(file.type) ? { file } : { unreadable: true as const });
  try {
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return asItIs();
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? { file: new File([blob], `${name}.jpg`, { type: "image/jpeg" }) } : asItIs();
  } catch {
    return asItIs();
  } finally {
    bitmap.close();
  }
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

// An input whose content is always left to right — a number, an email, an English name — keeps
// that direction in Arabic, and lines up with the start of the Arabic labels above it.
const LTR_INPUT = "rtl:text-right";

function selectStyle(lang: JoiningLang): React.CSSProperties {
  return {
    backgroundImage: CARET,
    backgroundPosition: lang === "ar" ? "left 16px center" : "right 16px center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "10px 6px",
  };
}

/** The fields Submit needs, in page order — what the progress rail counts and Submit focuses. */
function requiredFields(answers: JoiningFormAnswers, hasAreaList: boolean): FieldKey[] {
  const fields: FieldKey[] = ["fullName", "nationalId", "gender", "birthDate", ...JOINING_FORM_PHOTO_FIELDS, "mobileNumber", "personalEmail", "education"];
  if (answers.education === "Other") fields.push("educationOther");
  fields.push("residenceArea");
  if (hasAreaList && answers.residenceArea === JOINING_FORM_OTHER_AREA) fields.push("residenceAreaOther");
  fields.push("residenceCity", "residenceAddress");
  return fields;
}

type RailStep = { index: string; state: "done" | "active" | "waiting"; status: string; title: string };

/** The desktop step rail: where the candidate is, held beside the form while it scrolls. */
function StepRail({ steps }: { steps: RailStep[] }) {
  const { t } = useCopy();
  return (
    <nav aria-label={t.rail.heading} className="sticky top-20">
      <Eyebrow>{t.rail.heading}</Eyebrow>
      <ol className="mt-5 border-t border-[#dde4e8]">
        {steps.map((step) => (
          <li className="border-b border-[#dde4e8]" key={step.index}>
            <a
              className={`group flex gap-4 border-s-[3px] py-3.5 pe-2 ps-4 transition-colors hover:bg-white ${
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
      <p className="mt-5 text-[12.5px] leading-relaxed text-[#69757e]">{t.rail.note}</p>
    </nav>
  );
}

function NoticeBody({ body, title }: { body: string; title: string }) {
  const { lang, t } = useCopy();
  return (
    <>
      <SatoBand eyebrow={t.band.eyebrow} tag={t.band.closed} title={translateMessage(lang, title)} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-8 lg:py-14">
        <section className="jf-rise relative max-w-3xl border border-[#111820] bg-white px-5 py-7 sm:px-7" style={delay(200)}>
          <FrameTicks />
          <Eyebrow>{t.notice.whatToDo}</Eyebrow>
          <p className="mt-4 text-[17px] leading-relaxed text-[#45515a]">{translateMessage(lang, body)}</p>
        </section>
      </main>
      <SatoFooter />
    </>
  );
}

/** A closed or invalid link: the same hero and footer, the reason, and what to do. */
export function SatoNotice({ body, title }: { body: string; title: string }) {
  return (
    <SatoShell>
      <NoticeBody body={body} title={title} />
    </SatoShell>
  );
}

function JoiningFormDone({ done, view }: { done: Done; view: OpenView }) {
  const { lang, t } = useCopy();
  const { job, offer } = view;
  // The reason the Sato email could not be made is written for HR in English — in Arabic the page
  // says only that HR will send it.
  const reason = lang === "ar" ? null : done.satoEmailReason;
  const steps = [
    t.done.nextContact(letterDate(job.hireDate, lang)),
    done.satoEmail ? t.done.nextEmail(done.satoEmail) : t.done.nextEmailPending(reason),
    t.done.nextEdit,
  ];
  return (
    <>
      <SatoBand
        card={{
          meta: offer.reference,
          rows: [
            { label: t.card.hrId, value: done.hrId },
            { label: t.card.position, value: job.jobTitle || t.pending },
            { label: t.card.startDate, value: letterDate(job.hireDate, lang, "short") },
          ],
          title: t.card.record,
        }}
        eyebrow={t.done.eyebrow}
        subtitle={t.done.subtitle}
        tag={t.band.received}
        title={t.band.welcome(offer.salutationName)}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-8 lg:py-14">
        <div className="mx-auto max-w-3xl space-y-8">
          <section className="jf-rise relative border border-[#111820] bg-white" style={delay(200)}>
            <FrameTicks />
            <div className="flex items-start gap-5 border-b border-[#dde4e8] px-5 py-7 sm:px-7">
              <SealCheck />
              <div className="min-w-0">
                <Eyebrow>{t.done.recorded}</Eyebrow>
                <h2 className="mt-3 text-[24px] font-bold leading-[1.15] tracking-[-0.015em] text-[#111820] sm:text-[30px] rtl:leading-[1.35] rtl:tracking-normal">{t.done.heading}</h2>
              </div>
            </div>
            <div className="px-5 pb-0 pt-6 sm:px-7">
              <DataTable
                caption={t.done.yourRecord}
                groups={[
                  {
                    rows: [
                      { label: t.done.yourHrId, value: <span className="text-[24px] font-bold tabular-nums">{done.hrId}</span> },
                      { label: t.done.yourSatoEmail, ltr: Boolean(done.satoEmail), value: done.satoEmail ?? t.position.satoEmailPending(null) },
                      { label: t.position.jobPosition, value: job.jobTitle },
                      { label: t.card.startDate, value: job.hireDate ? letterDate(job.hireDate, lang) : null },
                      { label: t.position.manager, value: job.managerName ?? job.managerHrId },
                    ],
                    title: t.done.yourRecord,
                  },
                ]}
              />
            </div>
          </section>

          <section className="jf-rise border border-[#dde4e8] bg-white" style={delay(320)}>
            <div className="border-b border-[#dde4e8] px-5 pb-5 pt-6 sm:px-7">
              <Eyebrow>{t.done.next}</Eyebrow>
            </div>
            <table className="w-full table-fixed border-collapse text-start">
              <caption className="sr-only">{t.done.next}</caption>
              <colgroup>
                <col className="w-16 sm:w-20" />
                <col />
              </colgroup>
              <tbody>
                {steps.map((step, index) => (
                  <tr className={`border-b border-[#e9eef1] last:border-b-0 ${index % 2 ? "bg-[#f4f7f9]" : "bg-white"}`} key={step}>
                    <th className={`${micro} py-4 ps-5 text-start align-top leading-[1.9] tabular-nums text-[#0879b8] sm:ps-7`} scope="row">
                      {String(index + 1).padStart(2, "0")}
                    </th>
                    <td className="py-4 pe-5 align-top text-[15px] leading-relaxed sm:pe-7">{step}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>
      <SatoFooter />
    </>
  );
}

export function JoiningFormPage({ token, view }: { token: string; view: OpenView }) {
  return (
    <SatoShell>
      <JoiningForm token={token} view={view} />
    </SatoShell>
  );
}

function JoiningForm({ token, view }: { token: string; view: OpenView }) {
  const { lang, t } = useCopy();
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
  const [photos, setPhotos] = useState<Record<JoiningFormUploadField, Photo | null>>({ idBack: null, idFront: null, photo: null });
  const [preparing, setPreparing] = useState<Partial<Record<JoiningFormUploadField, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [fromId, setFromId] = useState<{ birthDate: boolean; gender: boolean }>({ birthDate: false, gender: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // The page's own check, run on every keystroke — shown for a field once it has been left, and for
  // every field once Submit is pressed. The server runs the same functions and has the last word.
  const live = useMemo(() => {
    const answerErrors = validateJoiningForm(answers, { residenceAreaOptions: residence.areaOptions, todayIso: today }).errors;
    const photoErrors = validateJoiningIdPhotos({
      idBack: photos.idBack ? { contentType: photos.idBack.file.type, size: photos.idBack.file.size } : null,
      idFront: photos.idFront ? { contentType: photos.idFront.file.type, size: photos.idFront.file.size } : null,
    });
    const facePhotoError = validateJoiningFacePhoto(photos.photo ? { contentType: photos.photo.file.type, size: photos.photo.file.size } : null);
    return { ...answerErrors, ...photoErrors, ...(facePhotoError ? { photo: facePhotoError } : {}) } as Partial<Record<FieldKey, string>>;
  }, [answers, photos, residence.areaOptions, today]);
  const required = requiredFields(answers, hasAreaList);
  const filled = (field: FieldKey) =>
    field === "idFront" || field === "idBack" || field === JOINING_FORM_FACE_PHOTO_FIELD
      ? Boolean(photos[field])
      : Boolean(String(answers[field] ?? "").trim());
  const complete = required.filter((field) => filled(field) && !live[field]).length;
  const percent = Math.round((complete / required.length) * 100);
  const recognised = readEgyptianNationalId(answers.nationalId);

  function errorFor(field: FieldKey): string | undefined {
    const message = serverErrors[field] ?? (touched[field] ? live[field] : undefined);
    return message ? translateMessage(lang, message) : undefined;
  }

  function leave(field: FieldKey) {
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

  async function pickPhoto(field: JoiningFormUploadField, file: File) {
    setPreparing((current) => ({ ...current, [field]: true }));
    const prepared = await preparePhoto(file, field === "idFront" ? "national-id-front" : field === "idBack" ? "national-id-back" : "photo");
    // A photo nothing could open is never kept: no broken tile, and the message names the camera.
    const kept = "file" in prepared ? { file: prepared.file, url: URL.createObjectURL(prepared.file) } : null;
    setPhotos((current) => {
      const previous = current[field];
      if (previous) URL.revokeObjectURL(previous.url);
      return { ...current, [field]: kept };
    });
    setPreparing((current) => ({ ...current, [field]: false }));
    setServerErrors((current) => ({ ...current, [field]: kept ? undefined : JOINING_FORM_PHOTO_UNREADABLE }));
    leave(field);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    // The optional photo never blocks by being absent — only by being the wrong kind of file.
    const checked: FieldKey[] = live.photo ? [JOINING_FORM_FACE_PHOTO_FIELD, ...required] : required;
    if (checked.some((field) => live[field] || (field !== JOINING_FORM_FACE_PHOTO_FIELD && !filled(field)))) {
      setTouched(Object.fromEntries(checked.map((field) => [field, true])));
      const first = checked.find((field) => live[field] || (field !== JOINING_FORM_FACE_PHOTO_FIELD && !filled(field)));
      if (first) document.getElementById(`jf-${first}`)?.focus();
      setFailure(t.failure.attention);
      return;
    }
    setBusy(true);
    try {
      // Multipart: the answers as one JSON field, and the photos beside them. No content-type
      // header — the browser writes the multipart boundary itself.
      const body = new FormData();
      body.append("answers", JSON.stringify(answers));
      if (photos.idFront) body.append("idFront", photos.idFront.file);
      if (photos.idBack) body.append("idBack", photos.idBack.file);
      if (photos.photo) body.append("photo", photos.photo.file);
      const response = await fetch(`/api/public/offer-acceptance/${encodeURIComponent(token)}`, { body, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        errors?: Partial<Record<FieldKey, string>>;
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
      setFailure(payload.message ? translateMessage(lang, payload.message) : t.failure.server);
    } catch {
      setFailure(t.failure.network);
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
    ? { ltr: true, tag: t.position.createdOnSubmit, value: job.satoEmail }
    : { ltr: false, tag: undefined, value: t.position.satoEmailPending(lang === "ar" ? null : job.satoEmailReason) };
  const offerRows: BandRow[] = [
    { label: t.card.position, value: job.jobTitle || t.pending },
    { label: t.card.startDate, value: letterDate(job.hireDate, lang, "short") },
    ...(pay ? [{ label: t.card.netMonthly, value: money(pay.netSalary, lang) }] : []),
    { label: t.card.contract, value: job.contractType || t.pending },
  ];
  const detailsIndex = pay ? "03" : "02";
  const acceptIndex = pay ? "04" : "03";
  const detailsDone = complete === required.length;
  const steps: RailStep[] = [
    { index: "01", state: "done", status: t.rail.setByOffer, title: t.position.title },
    ...(pay ? [{ index: "02", state: "done" as const, status: t.rail.setByOffer, title: t.package.title }] : []),
    {
      index: detailsIndex,
      state: detailsDone ? "done" : "active",
      status: t.rail.complete(complete, required.length),
      title: t.details.title,
    },
    {
      index: acceptIndex,
      state: detailsDone ? "active" : "waiting",
      status: detailsDone ? t.rail.ready : t.rail.afterDetails,
      title: t.accept.title,
    },
  ];
  const optionLabel = (option: string) => (lang === "ar" ? AR_EDUCATION[option] ?? option : option);

  return (
    <>
      <SatoBand
        card={{ meta: offer.reference, rows: offerRows, title: t.card.yourOffer }}
        eyebrow={t.band.eyebrow}
        subtitle={t.band.subtitle}
        title={t.band.welcome(offer.salutationName)}
      />

      {/* The progress rail: how much of the form is done, held at the top while scrolling. */}
      <div className="jf-no-print sticky top-0 z-30 border-b border-[#dde4e8] bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-2.5 sm:px-8">
          <p className={`${micro} text-[#111820]`}>
            {t.rail.yourDetails} <span className="text-[#8a959d]">·</span>{" "}
            <span className="tabular-nums text-[#0879b8]">{t.rail.count(complete, required.length)}</span>
          </p>
          <p className={`${micro} hidden text-[#8a959d] sm:block`}>{t.rail.acceptance}</p>
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
            <div className="jf-rise border-s-[3px] border-[#0879b8] bg-white px-5 py-4 sm:px-6" style={delay(180)}>
              <p className="text-[15px] leading-relaxed">
                {t.intro.lead} <strong className="font-semibold text-[#111820]">{t.intro.accept}</strong> {t.intro.tail}
              </p>
            </div>

            <Section delay={240} flush index="01" note={t.position.note} title={t.position.title}>
              <DataTable
                caption={t.position.title}
                groups={[
                  {
                    rows: [
                      { label: t.position.jobPosition, value: job.jobTitle },
                      { label: t.position.department, value: job.departmentName },
                      { label: t.position.line, value: job.lineName },
                      { label: t.position.contractType, value: job.contractType },
                    ],
                    title: t.position.role,
                  },
                  {
                    rows: [
                      { label: t.position.area, value: job.areaName },
                      { label: t.position.region, value: job.regionName },
                      {
                        label: t.position.manager,
                        note: job.managerName && job.managerHrId ? t.position.managerHrId(job.managerHrId) : null,
                        value: job.managerName ?? job.managerHrId,
                      },
                      { label: t.position.hireDate, value: job.hireDate ? letterDate(job.hireDate, lang) : null },
                    ],
                    title: t.position.whereYouWork,
                  },
                  {
                    rows: [
                      { label: t.position.hrId, tag: job.hrIdPreview ? t.position.confirmedOnSubmit : undefined, value: job.hrIdPreview },
                      { label: t.position.satoEmail, ltr: sato.ltr, tag: sato.tag, value: sato.value },
                    ],
                    title: t.position.accounts,
                  },
                ]}
              />
            </Section>

            {pay ? (
              <Section delay={300} flush index="02" note={t.package.note} title={t.package.title}>
                <div className="-mx-5 sm:-mx-7">
                  <table className="w-full table-fixed border-collapse text-start">
                    <caption className="sr-only">{t.package.title}</caption>
                    <colgroup>
                      <col />
                      <col className="w-[48%] sm:w-[40%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-[#111820]">
                        <th className={`${micro} pb-2.5 ps-5 text-start text-[#0879b8] sm:ps-7`} scope="col">
                          {t.package.component}
                        </th>
                        <th className={`${micro} pb-2.5 pe-5 text-end text-[#0879b8] sm:pe-7`} scope="col">
                          {t.package.monthly}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          [t.package.base, pay.baseSalary],
                          [t.package.basic, pay.basicSalary],
                          [t.package.fuel, pay.fuelAllowance],
                          [t.package.extraCostOfLiving, pay.extraCostOfLiving],
                          [t.package.gross, pay.grossSalary],
                        ] as const
                      ).map(([label, amount], index) => (
                        <tr className={`border-b border-[#e9eef1] ${index % 2 ? "bg-[#f4f7f9]" : "bg-white"}`} key={label}>
                          <th className="py-3.5 pe-3 ps-5 text-start text-[15px] font-normal leading-snug sm:ps-7" scope="row">
                            {label}
                          </th>
                          <td className="py-3.5 pe-5 text-end text-[15px] font-semibold leading-snug tabular-nums text-[#111820] sm:pe-7">
                            {money(amount, lang)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-[#111820] text-white">
                        <th className="py-5 pe-3 ps-5 text-start align-middle sm:ps-7" scope="row">
                          <span className={`${micro} block text-[#5db7e8]`}>{t.package.net}</span>
                          <span className="mt-1 block text-[12.5px] font-normal leading-snug text-[#9aa6af]">{t.package.netNote}</span>
                        </th>
                        <td className="py-5 pe-5 text-end align-middle text-[22px] font-bold leading-none tabular-nums sm:pe-7 sm:text-[30px]">
                          {money(pay.netSalary, lang)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Section>
            ) : null}

            <form noValidate onSubmit={submit}>
              <div className="space-y-8">
                <Section delay={360} index={detailsIndex} note={t.details.note} title={t.details.title}>
                  <div className="space-y-8">
                    <div className="space-y-5">
                      <GroupLabel>{t.details.groups.identity}</GroupLabel>
                      <Field error={errorFor("fullName")} hint={t.details.fullNameHint} htmlFor={ref("fullName")} label={t.details.fullName}>
                        <input autoComplete="name" className={controlClass(Boolean(errorFor("fullName")), LTR_INPUT)} dir="ltr" onChange={(e) => set("fullName", e.target.value)} value={answers.fullName} {...aria("fullName", true)} />
                      </Field>
                      <Field
                        error={errorFor("nationalId")}
                        hint={
                          recognised
                            ? t.details.recognised(letterDate(recognised.birthDate, lang), genderLabel(recognised.gender, lang).toLowerCase())
                            : t.details.nationalIdHint
                        }
                        hintTone={recognised ? "confirm" : "quiet"}
                        htmlFor={ref("nationalId")}
                        label={t.details.nationalId}
                      >
                        <input
                          autoComplete="off"
                          className={controlClass(Boolean(errorFor("nationalId")), `tabular-nums tracking-[0.08em] ${LTR_INPUT}`)}
                          dir="ltr"
                          inputMode="numeric"
                          maxLength={20}
                          onChange={(e) => setNationalId(e.target.value)}
                          placeholder={t.details.nationalIdPlaceholder}
                          value={answers.nationalId}
                          {...aria("nationalId", true)}
                        />
                      </Field>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("gender")} htmlFor={ref("gender")} label={t.details.gender} tag={fromId.gender && answers.gender ? t.details.fromId : undefined}>
                          <select className={controlClass(Boolean(errorFor("gender")), "pe-10")} onChange={(e) => set("gender", e.target.value)} style={selectStyle(lang)} value={answers.gender} {...aria("gender", Boolean(errorFor("gender")))}>
                            <option value="">{t.details.choose}</option>
                            {JOINING_FORM_GENDER_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {genderLabel(option.value, lang)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field error={errorFor("birthDate")} htmlFor={ref("birthDate")} label={t.details.birthDate} tag={fromId.birthDate && answers.birthDate ? t.details.fromId : undefined}>
                          <input className={controlClass(Boolean(errorFor("birthDate")), LTR_INPUT)} dir="ltr" max={today} onChange={(e) => set("birthDate", e.target.value)} type="date" value={answers.birthDate} {...aria("birthDate", Boolean(errorFor("birthDate")))} />
                        </Field>
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>{t.details.groups.photo}</GroupLabel>
                      <p className="-mt-1 text-[13px] leading-relaxed text-[#69757e]">{t.facePhoto.hint}</p>
                      <IdPhotoTile
                        busy={Boolean(preparing[JOINING_FORM_FACE_PHOTO_FIELD])}
                        error={errorFor(JOINING_FORM_FACE_PHOTO_FIELD)}
                        field={JOINING_FORM_FACE_PHOTO_FIELD}
                        label={t.facePhoto.label}
                        onPick={(file) => void pickPhoto(JOINING_FORM_FACE_PHOTO_FIELD, file)}
                        photo={photos[JOINING_FORM_FACE_PHOTO_FIELD]}
                        portrait
                        tag={t.facePhoto.optional}
                      />
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>{t.details.groups.photos}</GroupLabel>
                      <p className="-mt-1 text-[13px] leading-relaxed text-[#69757e]">{t.photos.hint}</p>
                      <div className="grid gap-5 sm:grid-cols-2">
                        {JOINING_FORM_PHOTO_FIELDS.map((field) => (
                          <IdPhotoTile
                            busy={Boolean(preparing[field])}
                            error={errorFor(field)}
                            field={field}
                            key={field}
                            label={field === "idFront" ? t.photos.front : t.photos.back}
                            onPick={(file) => void pickPhoto(field, file)}
                            photo={photos[field]}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>{t.details.groups.contact}</GroupLabel>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("mobileNumber")} htmlFor={ref("mobileNumber")} label={t.details.mobile}>
                          <input autoComplete="tel" className={controlClass(Boolean(errorFor("mobileNumber")), `tabular-nums ${LTR_INPUT}`)} dir="ltr" inputMode="tel" onChange={(e) => set("mobileNumber", e.target.value)} placeholder="01XXXXXXXXX" type="tel" value={answers.mobileNumber} {...aria("mobileNumber", Boolean(errorFor("mobileNumber")))} />
                        </Field>
                        <Field error={errorFor("personalEmail")} htmlFor={ref("personalEmail")} label={t.details.personalEmail}>
                          <input autoComplete="email" className={controlClass(Boolean(errorFor("personalEmail")), LTR_INPUT)} dir="ltr" inputMode="email" onChange={(e) => set("personalEmail", e.target.value)} type="email" value={answers.personalEmail} {...aria("personalEmail", Boolean(errorFor("personalEmail")))} />
                        </Field>
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>{t.details.groups.education}</GroupLabel>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("education")} htmlFor={ref("education")} label={t.details.education}>
                          <select className={controlClass(Boolean(errorFor("education")), "pe-10")} onChange={(e) => set("education", e.target.value)} style={selectStyle(lang)} value={answers.education} {...aria("education", Boolean(errorFor("education")))}>
                            <option value="">{t.details.educationChoose}</option>
                            {JOINING_FORM_EDUCATION_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {optionLabel(option)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {answers.education === "Other" ? (
                          <Field error={errorFor("educationOther")} htmlFor={ref("educationOther")} label={t.details.educationOther}>
                            <input className={controlClass(Boolean(errorFor("educationOther")))} dir="auto" onChange={(e) => set("educationOther", e.target.value)} value={answers.educationOther} {...aria("educationOther", Boolean(errorFor("educationOther")))} />
                          </Field>
                        ) : null}
                      </div>
                    </div>

                    <div className="space-y-5">
                      <GroupLabel>{t.details.groups.residence}</GroupLabel>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <Field error={errorFor("residenceArea")} htmlFor={ref("residenceArea")} label={t.details.area}>
                          {hasAreaList ? (
                            <select className={controlClass(Boolean(errorFor("residenceArea")), "pe-10")} onChange={(e) => setResidenceArea(e.target.value)} style={selectStyle(lang)} value={answers.residenceArea} {...aria("residenceArea", Boolean(errorFor("residenceArea")))}>
                              <option value="">{t.details.areaChoose}</option>
                              {residence.areaOptions.map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                              <option value={JOINING_FORM_OTHER_AREA}>{t.details.areaNotListed}</option>
                            </select>
                          ) : (
                            <input className={controlClass(Boolean(errorFor("residenceArea")))} dir="auto" onChange={(e) => set("residenceArea", e.target.value)} placeholder={t.details.areaPlaceholder} value={answers.residenceArea} {...aria("residenceArea", Boolean(errorFor("residenceArea")))} />
                          )}
                        </Field>
                        <Field error={errorFor("residenceCity")} htmlFor={ref("residenceCity")} label={t.details.city}>
                          <select className={controlClass(Boolean(errorFor("residenceCity")), "pe-10")} onChange={(e) => set("residenceCity", e.target.value)} style={selectStyle(lang)} value={answers.residenceCity} {...aria("residenceCity", Boolean(errorFor("residenceCity")))}>
                            <option value="">{t.details.cityChoose}</option>
                            {JOINING_FORM_GOVERNORATES.map((option) => (
                              <option key={option.value} value={option.value}>
                                {lang === "ar" ? option.value : option.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      {hasAreaList && answers.residenceArea === JOINING_FORM_OTHER_AREA ? (
                        <Field error={errorFor("residenceAreaOther")} htmlFor={ref("residenceAreaOther")} label={t.details.areaOther}>
                          <input className={controlClass(Boolean(errorFor("residenceAreaOther")))} dir="auto" onChange={(e) => set("residenceAreaOther", e.target.value)} placeholder={t.details.areaPlaceholder} value={answers.residenceAreaOther} {...aria("residenceAreaOther", Boolean(errorFor("residenceAreaOther")))} />
                        </Field>
                      ) : null}
                      <Field error={errorFor("residenceAddress")} htmlFor={ref("residenceAddress")} label={t.details.address}>
                        <textarea
                          className={controlClass(Boolean(errorFor("residenceAddress")), "h-auto min-h-[96px] py-3 leading-relaxed")}
                          dir="auto"
                          onChange={(e) => set("residenceAddress", e.target.value)}
                          placeholder={t.details.addressPlaceholder}
                          rows={3}
                          value={answers.residenceAddress}
                          {...aria("residenceAddress", Boolean(errorFor("residenceAddress")))}
                        />
                      </Field>
                    </div>
                  </div>
                </Section>

                <Section delay={420} framed index={acceptIndex} title={t.accept.title}>
                  <DataTable caption={t.accept.caption} groups={[{ rows: offerRows, title: t.accept.caption }]} />
                  <p className="mt-6 text-[15px] leading-relaxed">{t.accept.confirm}</p>

                  {failure ? (
                    <p className="mt-5 flex items-start gap-3 border border-[#b91c1c] bg-white px-4 py-3 text-sm leading-relaxed text-[#b91c1c]" role="alert">
                      <span aria-hidden className="mt-[6px] h-1.5 w-1.5 shrink-0 bg-[#b91c1c]" />
                      <span className="min-w-0">{failure}</span>
                    </p>
                  ) : null}

                  {/* The website's button: micro type, and a white wipe on hover from the reading start. */}
                  <button
                    className="jf-no-print group relative mt-6 flex h-14 w-full items-center justify-between gap-4 overflow-hidden rounded-none border border-[#0879b8] bg-[#0879b8] px-6 text-start text-[11.5px] font-bold uppercase tracking-[0.2em] text-white transition-colors duration-500 before:absolute before:inset-0 before:origin-left before:scale-x-0 before:bg-white before:transition-transform before:duration-500 before:ease-[cubic-bezier(.16,1,.3,1)] hover:text-[#0879b8] hover:before:scale-x-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111820] disabled:cursor-wait disabled:border-[#111820] disabled:bg-[#111820] disabled:text-white disabled:before:hidden rtl:text-[15px] rtl:normal-case rtl:tracking-normal rtl:before:origin-right"
                    disabled={busy}
                    type="submit"
                  >
                    <span className="relative min-w-0">{busy ? t.accept.busy : t.accept.button}</span>
                    <span aria-hidden className="relative shrink-0 text-lg transition-transform duration-300 group-hover:translate-x-1 group-disabled:translate-x-0 rtl:group-hover:-translate-x-1">
                      {lang === "ar" ? "←" : "→"}
                    </span>
                    {busy ? (
                      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-white/15">
                        <span className="jf-run block h-full w-1/4 bg-[#5db7e8]" />
                      </span>
                    ) : null}
                  </button>
                  <p className="mt-3 text-[13px] leading-relaxed text-[#69757e]">
                    {complete < required.length ? t.accept.remaining(required.length - complete) : t.accept.done}
                  </p>
                </Section>
              </div>
            </form>
          </div>
        </div>
      </main>
      <SatoFooter />
    </>
  );
}
