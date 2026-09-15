import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CSSProperties, ReactNode } from 'react';
import Image from 'next/image';
import { Pinyon_Script } from 'next/font/google';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, ArrowRight, Check, Lock, LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { Reveal } from '@/components/animate/reveal';
import { StaggerGroup, StaggerItem } from '@/components/animate/stagger';
import { RecordActions } from '@/components/ftp/record-actions';
import { CertificateStage } from '@/components/ftp/certificate-stage';
import { CertificateDownload, DownloadsProvider, JourneyUnlock, StickyDownloadBar } from '@/components/ftp/record-downloads';
import type { FtpCertificate, FtpCertificateText, FtpFigures } from '@/data/ftp-certificates';

/*
 * The 2026 verification page, in the Future Talents portal's identity rather
 * than the website's: every corner square, hierarchy from rules and weight
 * instead of shadows, a navy band closed by a brand seam, letterspaced micro
 * labels. The 2025 records are scans; a 2026 certificate is generated per
 * intern, so the page draws the certificate itself — the same page geometry as
 * the portal's PDF (842 x 595pt), scaled to its container.
 *
 * The figures strip carries the certificate's own key cards — AM visits, PM
 * visits, the Pharmacy Campaign, session attendance, and approved orders only
 * for somebody who has one — exactly as the portal's keyCards() prints them.
 * What it leaves off is the rank chip: a standing is the portal's to announce.
 * The QR code's place in the foot says the record was verified online instead —
 * the reader has already scanned it.
 */

const pinyon = Pinyon_Script({ subsets: ['latin'], weight: '400', display: 'swap' });

const INK = '#111820';
const BRAND = '#0879b8';
const NAVY = '#17304d';
const BODY = '#45515a';
const FAINT = '#8a959d';
const LINE = '#dde4e8';
const HAIR = '#e1e7eb';
const CANVAS = '#f2f5f7';
const STRAP = '#aab3bb';
const SEAL_LINE = '#4f5962';
const SEAL_LABEL = '#c3cad0';

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** The certificate's page, in PDF points. */
const W = 842;
const H = 595;
const LEFT = 54;
const BOX = 734;

/** A length on the certificate, in points of an 842pt-wide page. */
const pt = (n: number) => `calc(var(--pt) * ${n})`;

/** Where the top of a line box sits for a baseline, in a sans at line-height 1. */
const top = (baseline: number, size: number) => pt(baseline - size * 0.85);

type TextProps = {
  baseline: number;
  size: number;
  children: ReactNode;
  color?: string;
  bold?: boolean;
  tracking?: number;
  align?: 'left' | 'center' | 'right';
  /** Left edge for left-aligned runs, right edge for right-aligned ones. */
  x?: number;
  style?: CSSProperties;
};

function Run({ baseline, size, children, color = INK, bold, tracking = 0, align = 'left', x = 0, style }: TextProps) {
  const box: CSSProperties =
    align === 'center'
      ? { left: 0, width: pt(W), textAlign: 'center', paddingLeft: pt(tracking) }
      : align === 'right'
        ? { right: pt(W - x), textAlign: 'right', marginRight: pt(-tracking) }
        : { left: pt(x) };
  return (
    <span
      style={{
        position: 'absolute',
        top: top(baseline, size),
        fontSize: pt(size),
        lineHeight: 1,
        letterSpacing: pt(tracking),
        fontWeight: bold ? 700 : 400,
        color,
        whiteSpace: 'nowrap',
        ...box,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Rect({ x, y, w, h, color, style }: { x: number; y: number; w: number; h: number; color?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      style={{ position: 'absolute', left: pt(x), top: pt(y), width: pt(w), height: pt(h), background: color, ...style }}
    />
  );
}

/** A 1pt keyline, drawn as a border so it stays one rectangle. */
function Keyline({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  return <Rect x={x} y={y} w={w} h={h} style={{ border: `${pt(1)} solid ${color}` }} />;
}

/** The eight corner ticks that finish the double keyline. */
function Corners({ x, y, w, h, arm = 16, t = 2 }: { x: number; y: number; w: number; h: number; arm?: number; t?: number }) {
  const r = x + w;
  const b = y + h;
  return (
    <>
      <Rect x={x} y={y} w={arm} h={t} color={INK} />
      <Rect x={x} y={y} w={t} h={arm} color={INK} />
      <Rect x={r - arm} y={y} w={arm} h={t} color={INK} />
      <Rect x={r - t} y={y} w={t} h={arm} color={INK} />
      <Rect x={x} y={b - t} w={arm} h={t} color={INK} />
      <Rect x={x} y={b - arm} w={t} h={arm} color={INK} />
      <Rect x={r - arm} y={b - t} w={arm} h={t} color={INK} />
      <Rect x={r - t} y={b - arm} w={t} h={arm} color={INK} />
    </>
  );
}

/** Pinyon Script's average advance per character, in ems — enough to size a name to its column. */
const SCRIPT_EM = 0.457;

/**
 * The key cards, in the portal's order and wording (keyCards() in journey.ts).
 * A zero call count prints as a zero; approved orders are left off at zero.
 */
function keyCards(figures: FtpFigures | undefined): [string, string][] {
  if (!figures) return [];
  const cards: [string, string][] = [
    [String(figures.amVisits), 'AM visits'],
    [String(figures.pmVisits), 'PM visits'],
    [String(figures.pharmacyCampaign), 'Pharmacy campaign'],
    [`${figures.attendancePct}%`, 'Session attendance'],
  ];
  if (figures.approvedOrders > 0) {
    cards.push([String(figures.approvedOrders), figures.approvedOrders === 1 ? 'Approved order' : 'Approved orders']);
  }
  return cards;
}

function Certificate({
  name,
  line,
  issuedOn,
  figures,
}: {
  name: string;
  line: string;
  issuedOn: string;
  figures?: FtpFigures;
}) {
  /* The certificate steps a long name down rather than cutting it; so does this. */
  const nameSize = Math.max(28, Math.min(68, Math.floor((BOX - 40) / (name.length * SCRIPT_EM))));
  const nameBase = 268;
  const ruleW = Math.max(220, Math.min(BOX, name.length * SCRIPT_EM * nameSize + 56));
  const ruleY = nameBase + nameSize * 0.38 + 8;
  const citeTop = ruleY + 30 - 13 * 0.85 - (18.5 - 13) / 2;

  const arabicH = 285;
  const arabicW = (arabicH * 1136) / 842;

  const sigY = 492;
  const provRight = LEFT + BOX - 64 - 28;
  const sigRule = 174;
  /* Measured the portal's way, max(150, widest row + 48): the date is the wider row now. */
  const provRule = 150;
  const sealX = LEFT + BOX - 64;
  const sealY = 470;

  return (
    <div style={{ containerType: 'inline-size' }} dir="ltr">
      <div
        role="img"
        aria-label={`Certificate of completion awarded to ${name}, Future Talents 2026, ${line} line, issued ${issuedOn}`}
        className="relative w-full overflow-hidden bg-white"
        style={{ ['--pt' as string]: `calc(100cqw / ${W})`, aspectRatio: `${W} / ${H}`, fontFamily: SANS }}
      >
        {/* The Arabic wordmark behind everything, laid to the trim on the right. */}
        <span aria-hidden style={{ position: 'absolute', right: 0, top: pt(111), width: pt(arabicW), height: pt(arabicH) }}>
          <Image
            src="/ftp/2026/sato-pharma-arabic.png"
            alt=""
            fill
            sizes="(min-width: 1280px) 520px, 46vw"
            style={{ objectFit: 'contain', filter: 'brightness(0)', opacity: 0.1 }}
          />
        </span>

        {/* Head: navy band, brand seam, the mark reversed out. */}
        <Rect x={0} y={0} w={W} h={104} color={INK} />
        <Rect x={0} y={104} w={W} h={3} color={BRAND} />
        <span style={{ position: 'absolute', left: pt((W - 132.5) / 2), top: pt(27), width: pt(132.5), height: pt(50) }}>
          <Image src="/ftp/2026/sato-pharma-reverse.png" alt="Sato Pharma" fill sizes="220px" style={{ objectFit: 'contain' }} />
        </span>

        {/* Foot: seam and base, held the way the head is. */}
        <Rect x={0} y={H - 23} w={W} h={3} color={BRAND} />
        <Rect x={0} y={H - 20} w={W} h={20} color={INK} />
        <Run baseline={H - 7} size={6.6} bold tracking={1.3} color={STRAP} align="center">
          SATO PHARMA · FUTURE TALENTS PROGRAM 2026
        </Run>

        {/* Double keyline with corner ticks. */}
        <Keyline x={20} y={120} w={W - 40} h={424} color={LINE} />
        <Keyline x={27} y={127} w={W - 54} h={410} color={HAIR} />
        <Corners x={20} y={120} w={W - 40} h={424} />

        {/* The award. */}
        <Run baseline={152} size={10} bold tracking={4.8} color={BRAND} align="center">
          CERTIFICATE OF COMPLETION
        </Run>
        <Rect x={(W - 46) / 2} y={166} w={46} h={2} color={INK} />
        <Run baseline={192} size={7.5} bold tracking={2.4} color={FAINT} align="center">
          THIS IS TO CERTIFY THAT
        </Run>

        <span
          className={pinyon.className}
          style={{
            position: 'absolute',
            left: 0,
            width: pt(W),
            top: pt(nameBase - nameSize * 0.95 + 8),
            fontSize: pt(nameSize),
            lineHeight: 1.2,
            textAlign: 'center',
            whiteSpace: 'nowrap',
            color: NAVY,
            WebkitTextStroke: `${pt(0.3)} ${NAVY}`,
          }}
        >
          {name}
        </span>
        <Rect x={(W - ruleW) / 2} y={ruleY} w={ruleW} h={1.2} color={NAVY} />

        <p
          style={{
            position: 'absolute',
            left: pt((W - (BOX - 160)) / 2),
            width: pt(BOX - 160),
            top: pt(citeTop),
            fontSize: pt(13),
            lineHeight: 18.5 / 13,
            textAlign: 'center',
            textWrap: 'balance',
            color: BODY,
            margin: 0,
          }}
        >
          completed Sato Pharma&apos;s <b style={{ color: INK, whiteSpace: 'nowrap' }}>Future Talents 2026</b> field
          programme on the {line} line, from 16 August to 12 September 2026, with a training focus on{' '}
          <b style={{ color: INK, whiteSpace: 'nowrap' }}>medical sales promotion,</b> and is thereby eligible for the
          role of <b style={{ color: BRAND, whiteSpace: 'nowrap' }}>Medical Representative.</b>
        </p>

        {/* The key cards on the tinted strip: four, or five with an approved order. */}
        <Rect x={LEFT + 20} y={400} w={BOX - 40} h={44} color={CANVAS} />
        <Rect x={LEFT + 20} y={400} w={BOX - 40} h={1.2} color={INK} />
        <Rect x={LEFT + 20} y={444} w={BOX - 40} h={1} color={LINE} />
        {keyCards(figures).map(([value, label], index, all) => {
          const slot = (BOX - 40) / all.length;
          const x = LEFT + 20 + slot * index;
          const cell = { left: pt(x), width: pt(slot), paddingLeft: 0 };
          return (
            <span key={label}>
              {index > 0 ? <Rect x={x} y={409} w={1} h={26} color={LINE} /> : null}
              <Run baseline={427} size={22} bold align="center" style={cell}>
                {value}
              </Run>
              <Run baseline={439} size={6.8} bold tracking={1.3} color="#69757e" align="center" style={{ ...cell, paddingLeft: pt(1.3) }}>
                {label.toUpperCase()}
              </Run>
            </span>
          );
        })}

        {/* Foot of the certificate: signature, verification, record, seal. */}
        <Run baseline={sigY - 8} size={6.6} bold tracking={1.3} color={FAINT} x={LEFT}>
          SIGNED
        </Run>
        <Run baseline={sigY - 8} size={6.6} bold tracking={1.3} color={FAINT} align="right" x={provRight}>
          RECORD
        </Run>
        <Rect x={LEFT} y={sigY} w={sigRule} h={1} color={INK} />
        <Rect x={provRight - provRule} y={sigY} w={provRule} h={1} color={FAINT} />
        <Run baseline={sigY + 17} size={11.5} bold x={LEFT}>
          Omar Anwar Gawish
        </Run>
        <Run baseline={sigY + 17} size={9.5} bold color={BODY} align="right" x={provRight}>
          {issuedOn}
        </Run>
        <Run baseline={sigY + 31} size={8.6} color={FAINT} x={LEFT}>
          HR Section Head · Sato Pharma
        </Run>
        <Run baseline={sigY + 31} size={8.6} color={FAINT} align="right" x={provRight}>
          Date of issue
        </Run>

        <Run baseline={sigY - 8} size={6.6} bold tracking={1.3} color={FAINT} align="center">
          VERIFIED ONLINE
        </Run>
        <span
          aria-hidden
          style={{ position: 'absolute', left: pt(W / 2 - 15), top: pt(sigY), width: pt(30), height: pt(30), background: BRAND }}
        >
          <svg viewBox="0 0 30 30" width="100%" height="100%">
            <path d="M8.5 15.5 L13 20 L21.5 10.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="square" />
          </svg>
        </span>

        <Rect x={sealX} y={sealY} w={64} h={64} color={INK} />
        <Keyline x={sealX + 6} y={sealY + 6} w={52} h={52} color={SEAL_LINE} />
        <Rect x={sealX} y={sealY + 61} w={64} h={3} color={BRAND} />
        <Run baseline={sealY + 22} size={7} bold tracking={2.4} color={SEAL_LABEL} align="center" style={{ left: pt(sealX), width: pt(64) }}>
          FTP
        </Run>
        <Run baseline={sealY + 43} size={16} bold color="#ffffff" align="center" style={{ left: pt(sealX), width: pt(64), paddingLeft: 0 }}>
          2026
        </Run>
      </div>
    </div>
  );
}

function Micro({ children, color = FAINT, className = '' }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span className={`block text-[10.5px] font-bold uppercase tracking-[0.2em] ${className}`} style={{ color }}>
      {children}
    </span>
  );
}

/* ──────────────────────────────────────────────────────── the journey cover ──
   A thumbnail of the journey's first page, drawn rather than rendered from the
   file. The name and the line are on this page already; the score and the ranks
   are the portal's to announce, so on the cover they are redacted blocks. */

const JW = 595;
const JH = 842;

/** A length on the journey's page, in points of a 595pt-wide page. */
const u = (n: number) => `calc(var(--u) * ${n})`;

function Block({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  return <span style={{ position: 'absolute', left: u(x), top: u(y), width: u(w), height: u(h), background: color }} />;
}

function Label({
  x,
  y,
  size,
  color,
  children,
  align = 'left',
  bold = true,
  tracking,
}: {
  x: number;
  y: number;
  size: number;
  color: string;
  children: ReactNode;
  align?: 'left' | 'right';
  bold?: boolean;
  tracking?: number;
}) {
  return (
    <span
      style={{
        position: 'absolute',
        top: u(y),
        ...(align === 'right' ? { right: u(JW - x) } : { left: u(x) }),
        fontSize: u(size),
        letterSpacing: u(tracking ?? size * 0.2),
        fontWeight: bold ? 700 : 400,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        color,
      }}
    >
      {children}
    </span>
  );
}

/** Milestone rows: the label, the detail (0 for none) and the date, as bar widths. */
const MILESTONE_BARS = [
  [64, 150, 38],
  [92, 70, 42],
  [52, 0, 40],
  [78, 96, 44],
  [60, 0, 38],
  [84, 118, 42],
  [70, 0, 40],
  [88, 104, 44],
] as const;

function JourneyCover({ name, line }: { name: string; line: string }) {
  const nameSize = Math.max(16, Math.min(34, Math.floor(515 / (name.length * 0.6))));
  const redactOnInk = '#27323d';
  const redact = '#dfe5e9';
  const redactDeep = '#c5ced5';
  const cellW = 515 / 4;
  return (
    <div style={{ containerType: 'inline-size' }} dir="ltr">
      <div
        aria-hidden
        className="relative w-full overflow-hidden bg-white"
        style={{ ['--u' as string]: `calc(100cqw / ${JW})`, aspectRatio: `${JW} / ${JH}`, fontFamily: SANS }}
      >
        <Block x={0} y={0} w={JW} h={284} color={INK} />
        <Block x={0} y={0} w={JW} h={5} color={BRAND} />
        <span style={{ position: 'absolute', left: u(40), top: u(30), width: u(68), height: u(26) }}>
          <Image src="/ftp/2026/sato-pharma-reverse.png" alt="" fill sizes="96px" style={{ objectFit: 'contain', objectPosition: 'left center' }} />
        </span>
        <Label x={555} y={33} size={5.6} color={STRAP} align="right">
          FUTURE TALENTS 2026 · FIELD JOURNEY
        </Label>
        <Block x={40} y={72} w={515} h={0.8} color={ON_INK_RULE} />
        <Label x={40} y={94} size={nameSize} color="#ffffff" tracking={-0.3}>
          {name}
        </Label>
        <Label x={40} y={94 + nameSize + 14} size={9.5} color={ON_INK_MUTED} bold={false} tracking={0}>
          {line} line
        </Label>
        <Block x={40} y={94 + nameSize + 32} w={150} h={6} color={redactOnInk} />
        <Block x={40} y={176} w={515} h={0.8} color={ON_INK_RULE} />
        <Label x={40} y={194} size={5.8} color={STRAP}>
          FINAL SCORE
        </Label>
        <Block x={40} y={208} w={150} h={44} color={redactOnInk} />
        <Block x={40} y={262} w={212} h={5} color={BRAND} />
        <Block x={298} y={190} w={0.8} h={80} color={ON_INK_RULE} />
        <Label x={322} y={194} size={5.8} color={STRAP}>
          {`IN THE ${line.toUpperCase()} LINE`}
        </Label>
        <Block x={322} y={208} w={84} h={32} color={redactOnInk} />
        <Block x={322} y={250} w={140} h={6} color={redactOnInk} />

        <Block x={0} y={284} w={JW} h={62} color={CANVAS} />
        <Block x={40} y={300} w={3} h={30} color={BRAND} />
        <Block x={54} y={304} w={440} h={6} color={redact} />
        <Block x={54} y={319} w={290} h={6} color={redact} />
        <Block x={0} y={346} w={JW} h={0.8} color={LINE} />

        <Block x={40} y={374} w={515} h={1.4} color={INK} />
        <Label x={40} y={384} size={5.6} color={INK}>
          THE FOUR WEEKS, IN NUMBERS
        </Label>
        <span style={{ position: 'absolute', left: u(40), top: u(402), width: u(515), height: u(116), border: `${u(0.8)} solid ${LINE}` }} />
        {[1, 2, 3].map((i) => (
          <Block key={`v${i}`} x={40 + cellW * i} y={402} w={0.8} h={116} color={LINE} />
        ))}
        <Block x={40} y={460} w={515} h={0.8} color={LINE} />
        {[0, 1].flatMap((row) =>
          [0, 1, 2, 3].map((col) => {
            const x = 40 + cellW * col + 11;
            const y = 402 + 58 * row;
            return (
              <span key={`c${row}${col}`}>
                <Block x={x} y={y + 12} w={42} h={4} color={redactDeep} />
                <Block x={x} y={y + 24} w={34 + ((row + col) % 3) * 8} h={16} color={redact} />
                <Block x={x} y={y + 46} w={56} h={3.5} color={redact} />
              </span>
            );
          }),
        )}

        <Block x={40} y={548} w={515} h={1.4} color={INK} />
        <Label x={40} y={558} size={5.6} color={INK}>
          MILESTONES
        </Label>
        {MILESTONE_BARS.map(([label, detail, date], i) => {
          const y = 578 + i * 26;
          return (
            <span key={`m${i}`}>
              <Block x={40} y={y + 3} w={3} h={11} color={BRAND} />
              <Block x={50} y={y + 6} w={label} h={5} color={redactDeep} />
              {detail ? <Block x={190} y={y + 6} w={detail} h={5} color={redact} /> : null}
              <Block x={555 - date} y={y + 6} w={date} h={5} color={redact} />
              <Block x={40} y={y + 20} w={515} h={0.6} color={LINE} />
            </span>
          );
        })}

        <Block x={40} y={806} w={515} h={0.8} color={LINE} />
        <Block x={40} y={816} w={90} h={4} color={redact} />
        <Block x={527} y={816} w={28} h={4} color={redact} />
      </div>
    </div>
  );
}

/** The journey as a stack of pages with a lock on it; the stack fans a little on hover. */
function JourneyStack({ name, line }: { name: string; line: string }) {
  return (
    <div aria-hidden className="relative -translate-x-1.5 -translate-y-1.5 h-[84%]" style={{ aspectRatio: `${JW} / ${JH}` }}>
      <span
        className="absolute inset-0 translate-x-3 translate-y-3 border bg-white transition-transform duration-500 ease-out group-hover:translate-x-[22px] group-hover:translate-y-[18px]"
        style={{ borderColor: LINE }}
      />
      <span
        className="absolute inset-0 translate-x-1.5 translate-y-1.5 border bg-white transition-transform duration-500 ease-out group-hover:translate-x-[11px] group-hover:translate-y-[9px]"
        style={{ borderColor: LINE }}
      />
      <div
        className="relative h-full border transition-transform duration-500 ease-out group-hover:-translate-y-1.5 group-hover:-rotate-1"
        style={{ borderColor: LINE }}
      >
        <JourneyCover name={name} line={line} />
        <span
          className="absolute left-1/2 top-[57%] flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center sm:h-16 sm:w-16"
          style={{ background: INK }}
        >
          <span className="absolute inset-[5px] border" style={{ borderColor: SEAL_LINE }} />
          <LockKeyhole size={22} strokeWidth={2.2} className="relative text-white transition-opacity duration-300 group-hover:opacity-0" />
          <LockKeyholeOpen
            size={22}
            strokeWidth={2.2}
            className="absolute text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          />
          <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: BRAND }} />
        </span>
      </div>
    </div>
  );
}

/** Size and page count of a built PDF, or null while it is not on the server. */
function pdfFacts(file: string): { kb: number; pages: number } | null {
  try {
    const bytes = readFileSync(file);
    const pages = bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 1;
    return { kb: Math.max(1, Math.round(bytes.length / 1024)), pages: Math.max(1, pages) };
  } catch {
    return null;
  }
}

const PAPER_GRID: CSSProperties = {
  backgroundImage:
    'linear-gradient(rgba(17,24,32,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(17,24,32,0.045) 1px, transparent 1px)',
  backgroundSize: '28px 28px',
};

/** A document you can take away: the object on its desk, what it is, and the one control that gets it. */
function DocumentTile({
  index,
  title,
  body,
  tag,
  locked = false,
  meta,
  visual,
  action,
}: {
  index: string;
  title: string;
  body: string;
  tag: string;
  locked?: boolean;
  meta: string[];
  visual: ReactNode;
  action: ReactNode;
}) {
  return (
    <article
      className="group relative flex w-full flex-col border bg-white transition-colors duration-300 hover:border-[#111820]"
      style={{ borderColor: LINE }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 -top-px z-10 h-[3px] origin-left scale-x-0 transition-transform duration-500 group-hover:scale-x-100 rtl:origin-right"
        style={{ background: BRAND }}
      />
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden border-b" style={{ background: CANVAS, borderColor: LINE }}>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={PAPER_GRID} />
        <span
          className="absolute start-4 top-4 z-10 inline-flex items-center gap-2 border bg-white px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em]"
          style={{ borderColor: LINE, color: locked ? INK : BRAND }}
        >
          {locked ? <LockKeyhole size={12} strokeWidth={2.4} /> : <Check size={12} strokeWidth={2.8} />}
          {tag}
        </span>
        {visual}
      </div>
      <div className="flex flex-1 flex-col p-6 sm:p-8">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-bold tabular-nums tracking-[0.2em]" style={{ color: BRAND }}>
            {index}
          </span>
          <h3 className="text-2xl font-bold tracking-tight sm:text-[28px]" style={{ color: INK }}>
            {title}
          </h3>
        </div>
        <p className="mt-3 max-w-[54ch] text-[15px] leading-relaxed" style={{ color: BODY }}>
          {body}
        </p>
        <ul
          className="mt-5 flex flex-wrap items-center border-y text-[10.5px] font-bold uppercase tracking-[0.18em]"
          style={{ borderColor: HAIR, color: FAINT }}
        >
          {meta.map((item, i) => (
            <li key={item} className="flex items-center">
              {i > 0 ? <span aria-hidden className="mx-3 h-3 w-px" style={{ background: LINE }} /> : null}
              <span className="py-2.5">{item}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-6">{action}</div>
      </div>
    </article>
  );
}

/* The page's own motion: the check drawing itself, one scan across the status
   strip, the password caret and the unlocking bar. Paper gets the end state. */
const PAGE_CSS = `
@keyframes ftp-draw{to{stroke-dashoffset:0}}
.ftp-draw path{stroke-dasharray:44;stroke-dashoffset:44;animation:ftp-draw .8s cubic-bezier(.65,0,.35,1) .55s forwards}
@keyframes ftp-scan{0%{left:0;opacity:0}10%{opacity:1}85%{opacity:1}100%{left:100%;opacity:0}}
.ftp-scan{left:0;opacity:0;animation:ftp-scan 1.6s cubic-bezier(.65,0,.35,1) 1s forwards}
@keyframes ftp-caret{50%{opacity:0}}
.ftp-caret{animation:ftp-caret 1s steps(1) infinite}
@keyframes ftp-progress{from{left:-34%}to{left:100%}}
.ftp-progress{animation:ftp-progress .9s cubic-bezier(.65,0,.35,1) infinite}
@media (prefers-reduced-motion:reduce){.ftp-caret,.ftp-progress{animation:none}}
@media print{.ftp-draw path{stroke-dashoffset:0!important;animation:none!important}.ftp-scan{display:none}}
`;

/* ─────────────────────────────────────────────────────────────── the page ──
   Everything below this line is the page around the certificate. The
   certificate above is a replica of the portal's PDF and is not restyled here. */

/** On the navy grounds: the hairline, the quiet label, and a brand blue light enough to read. */
const ON_INK_RULE = '#26313b';
const ON_INK_MUTED = '#9aa6af';
const ON_INK_LABEL = '#6f7c86';
const ON_INK_BRAND = '#5db7e8';

/** The engraved grid the navy bands carry — hairlines, never a gradient wash. */
const GRID: CSSProperties = {
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
  backgroundSize: '56px 56px',
};

/** Success is Acquired by Talented Operators — the company's name, spelled out. */
const SATO: ReadonlyArray<readonly [letter: string, word: string]> = [
  ['S', 'Success'],
  ['A', 'Acquired'],
  ['T', 'Talented'],
  ['O', 'Operators'],
];

/** A square tile holding a check: the page's one mark for "this was confirmed". */
function SealCheck({ className = '', tone = 'brand', draw = false }: { className?: string; tone?: 'brand' | 'ink'; draw?: boolean }) {
  return (
    <span aria-hidden className={`relative inline-block shrink-0 ${className}`} style={{ background: tone === 'brand' ? BRAND : INK }}>
      <span
        className="absolute inset-[12%] border"
        style={{ borderColor: tone === 'brand' ? 'rgba(255,255,255,0.38)' : SEAL_LINE }}
      />
      <svg viewBox="0 0 72 72" className={`absolute inset-0 h-full w-full ${draw ? 'ftp-draw' : ''}`}>
        <path d="M22 37 L32 47 L51 25" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="square" />
      </svg>
      {tone === 'ink' ? <span className="absolute inset-x-0 bottom-0 h-[6%]" style={{ background: BRAND }} /> : null}
    </span>
  );
}

/** A numbered section head on a hairline, the way the portal's documents run their sections. */
function SectionHead({ index, title, action }: { index: string; title: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b pb-3" style={{ borderColor: LINE }}>
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-bold tabular-nums tracking-[0.2em]" style={{ color: BRAND }}>
          {index}
        </span>
        <span aria-hidden className="h-px w-6" style={{ background: INK }} />
        <Micro color={INK}>{title}</Micro>
      </div>
      {action}
    </div>
  );
}

/** Corner ticks on a frame, answering the ones the certificate carries. */
function FrameTicks() {
  const tick = 'pointer-events-none absolute h-5 w-5';
  const ink = { borderColor: INK };
  return (
    <>
      <span aria-hidden className={`${tick} -left-px -top-px border-l-2 border-t-2`} style={ink} />
      <span aria-hidden className={`${tick} -right-px -top-px border-r-2 border-t-2`} style={ink} />
      <span aria-hidden className={`${tick} -bottom-px -left-px border-b-2 border-l-2`} style={ink} />
      <span aria-hidden className={`${tick} -bottom-px -right-px border-b-2 border-r-2`} style={ink} />
    </>
  );
}

type ArticleSection = { title: string; paragraphs: string[] };

/* An entrance waits to be scrolled into view, and paper never scrolls: a print
   taken from the top would carry every section below the fold at opacity 0. */
const SHOW_IN_PRINT = 'print:!translate-y-0 print:!opacity-100 print:![transform:none]';

export async function Record2026({
  id,
  record,
  cert,
  locale,
}: {
  id: string;
  record: FtpCertificate;
  cert: FtpCertificateText;
  locale: string;
}) {
  const t = await getTranslations('ftp');
  const tAbout = await getTranslations('about');
  const rtl = locale === 'ar';
  /* The page never prints the FTP number (owner, 13 Sep 2026): the record is
     addressed by its registry key, and that key is all that reaches the browser. */
  const recordKey = record.key ?? id;
  const issuedOn = record.issuedOn ?? cert.issued;
  const issuedLabel = rtl ? cert.issued : issuedOn;
  const line = record.line ?? '';
  /* The two downloads appear only once their file is on the server. Both live
     in private/ and both routes ask the portal whether the record is still
     certified: the certificate behind /api/ftp/certificate, the journey behind
     /api/ftp/journey. Reading the files also gives each tile its true page
     count and size. */
  const certificatePath = `/api/ftp/certificate/${recordKey}`;
  const certificateFacts = pdfFacts(path.join(process.cwd(), 'private', 'ftp', '2026', 'certificates', `${recordKey}.pdf`));
  const journeyFacts = pdfFacts(path.join(process.cwd(), 'private', 'ftp', '2026', 'journeys', `${recordKey}.pdf`));
  const hasDownloads = Boolean(certificateFacts || journeyFacts);
  const pillars = [t('pillar1'), t('pillar2'), t('pillar3'), t('pillar4'), t('pillar5')];
  const font: CSSProperties = rtl ? {} : { fontFamily: SANS };

  /* The page carries no figures section of its own (owner, 13 Sep 2026): the
     figures a reader needs are on the certificate, which prints them unchanged. */
  const section = (n: number) => `0${n}`;

  const status: { key: string; label: string; value: ReactNode; className?: string }[] = [
    { key: 'holder', label: t('awardedTo'), value: <span dir="ltr">{record.name}</span>, className: 'col-span-2 lg:col-span-1' },
    {
      key: 'status',
      label: t('statusLabel'),
      value: (
        <span className="inline-flex items-center gap-2.5">
          <SealCheck draw className="h-[18px] w-[18px]" />
          {t('statusValue')}
        </span>
      ),
      className: 'lg:order-first',
    },
    { key: 'line', label: t('labelLine'), value: <span dir="ltr">{line}</span> },
    { key: 'issued', label: t('labelIssued'), value: issuedLabel },
    { key: 'cohort', label: t('labelProgram'), value: <span dir="ltr">Future Talents 2026</span> },
  ];

  const checks = [t('check1'), t('check2'), t('check3')];

  const downloadLabels = {
    downloadCertificate: t('downloadCertificate'),
    unlockJourney: t('unlockJourney'),
    certificateShort: t('certificatePdf'),
    journeyShort: t('journeyPdf'),
    barTitle: t('stickyDownloads'),
    journeyTitle: t('journeyTitle'),
    journeyBody: t('journeyBody', { name: record.name }),
    enterCode: t('journeyEnterCode'),
    unlocking: t('journeyUnlocking'),
    close: t('journeyCancel'),
    wrong: t('journeyWrong'),
    error: t('journeyError'),
    success: t('journeySuccess'),
  };

  /* The article is copy, so it lives in the messages as structured lists and
     both languages carry the same sections in the same order. */
  const articleMeta = t.raw('article.meta') as string[];
  const articleSections = t.raw('article.sections') as ArticleSection[];
  const articleGlance = t.raw('article.glance') as { label: string; value: string }[];

  const ledger = [
    { label: t('awardedTo'), value: record.name, ltr: true, wide: true },
    { label: t('labelLine'), value: line, ltr: true },
    { label: t('labelProgram'), value: cert.program },
    { label: t('labelDuration'), value: cert.duration },
    { label: t('labelIssued'), value: issuedLabel },
    { label: t('labelSigned'), value: 'Omar Anwar Gawish · HR Section Head', ltr: true },
  ];
  /* The wide row stands alone; the rest fill a grid that must close square. */
  const cells = ledger.length - 1;
  const lgFill = (3 - (cells % 3)) % 3;
  const smFill = cells % 2;

  return (
    <DownloadsProvider
      id={recordKey}
      name={record.name}
      certificate={certificateFacts ? { href: certificatePath, filename: `${record.name} - Future Talents 2026 - Certificate.pdf` } : null}
      journey={journeyFacts !== null}
      labels={downloadLabels}
      fontFamily={font.fontFamily}
    >
    <style>{PAGE_CSS}</style>
    <div className="print:bg-white" style={{ background: CANVAS, color: INK, ...font }}>
      {/* ── Hero: the verdict, on navy ────────────────────────────────── */}
      <section id="ftp-hero" className="relative overflow-hidden" style={{ background: INK }}>
        <div aria-hidden className="pointer-events-none absolute inset-0" style={GRID} />
        <div className="container-x relative pb-10 pt-8 sm:pb-12 sm:pt-10">
          {/* The Arabic wordmark lives in the part of the hero above the status
              strip (owner, 13 Sep 2026): hung off the section it sat behind the
              strip's solid cells and lost its foot. It still runs to the edge of
              the screen on its own side. */}
          <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-8 -top-10 hidden md:block"
            style={{ width: '50vw', insetInlineEnd: 'calc((100% - 100vw) / 2)' }}
          >
            <Image
              src="/ftp/2026/sato-pharma-arabic.png"
              alt=""
              fill
              sizes="50vw"
              style={{
                objectFit: 'contain',
                objectPosition: rtl ? 'left center' : 'right center',
                filter: 'brightness(0) invert(1)',
                opacity: 0.045,
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Reveal>
              <Image
                src="/ftp/2026/sato-pharma-reverse.png"
                alt="Sato Pharma"
                width={355}
                height={134}
                priority
                className="h-9 w-auto sm:h-11"
              />
            </Reveal>
          </div>

          <div className="mt-12 max-w-4xl sm:mt-16">
            <Reveal delay={0.08}>
              <span className="flex items-center gap-3">
                <span aria-hidden className="h-px w-8" style={{ background: ON_INK_BRAND }} />
                <Micro color={ON_INK_BRAND}>{t('eyebrow')}</Micro>
              </span>
            </Reveal>
            <Reveal delay={0.12}>
              <h1 className="mt-5 flex items-center gap-4 text-[34px] font-bold leading-[1.02] tracking-tight text-white sm:gap-6 sm:text-[52px] lg:text-[64px]">
                <SealCheck draw className="h-11 w-11 sm:h-[60px] sm:w-[60px] lg:h-[72px] lg:w-[72px]" />
                <span>{t('verifiedTitle')}</span>
              </h1>
            </Reveal>
            <Reveal delay={0.16}>
              <p className="mt-6 max-w-2xl text-base leading-relaxed sm:text-lg" style={{ color: ON_INK_MUTED }}>
                {t.rich('authenticBody', {
                  holder: record.name,
                  issued: issuedOn,
                  name: (chunks) => (
                    <b dir="ltr" className="text-white">
                      {chunks}
                    </b>
                  ),
                  date: (chunks) => <span dir="ltr">{chunks}</span>,
                })}
              </p>
            </Reveal>
            {hasDownloads ? (
              <Reveal delay={0.2} className="print:hidden">
                <div className="mt-8 flex flex-col gap-3 min-[520px]:flex-row min-[520px]:flex-wrap">
                  <CertificateDownload variant="hero" />
                  <JourneyUnlock variant="hero-quiet" />
                </div>
              </Reveal>
            ) : null}
          </div>
          </div>

          <Reveal delay={0.24} className="relative mt-10 overflow-hidden sm:mt-12">
            {/* One brand hairline sweeps the strip once: the page reading the register. */}
            <span aria-hidden className="ftp-scan pointer-events-none absolute inset-y-0 z-10 w-[2px]" style={{ background: ON_INK_BRAND }} />
            <dl
              className="grid grid-cols-2 gap-px border lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.9fr)_minmax(0,0.75fr)_minmax(0,1fr)_minmax(0,1.05fr)]"
              style={{ background: ON_INK_RULE, borderColor: ON_INK_RULE }}
            >
              {status.map((cell) => (
                <div key={cell.key} className={`px-4 py-4 sm:px-5 sm:py-5 ${cell.className ?? ''}`} style={{ background: INK }}>
                  <dt>
                    <Micro color={ON_INK_LABEL}>{cell.label}</Micro>
                  </dt>
                  <dd className="mt-2 text-[15px] font-bold leading-snug text-white sm:text-base">{cell.value}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
        <div aria-hidden className="relative h-[3px]" style={{ background: BRAND }} />
      </section>

      {/* ── What was checked ──────────────────────────────────────────── */}
      <section className="container-x pt-8 sm:pt-12">
        <Reveal className={SHOW_IN_PRINT}>
          <div className="grid border bg-white lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" style={{ borderColor: LINE }}>
            <div className="relative flex items-start gap-5 p-6 sm:gap-7 sm:p-8">
              <span aria-hidden className="absolute inset-y-0 start-0 w-[3px]" style={{ background: BRAND }} />
              <SealCheck tone="ink" className="h-14 w-14 sm:h-[72px] sm:w-[72px]" />
              <div className="min-w-0">
                <Micro color={BRAND}>{t('checksTitle')}</Micro>
                <h2 className="mt-2 text-2xl font-bold leading-tight tracking-tight sm:text-[30px]" style={{ color: INK }}>
                  {t('authenticTitle')}
                </h2>
                <p className="mt-3 inline-flex items-center gap-2 text-xs font-semibold" style={{ color: BODY }}>
                  <Lock size={13} style={{ color: BRAND }} />
                  {t('checkedAgainst')}
                </p>
              </div>
            </div>
            <ol className="border-t lg:border-s lg:border-t-0" style={{ borderColor: LINE }}>
              {checks.map((check, index) => (
                <li
                  key={check}
                  className="flex items-start gap-4 border-b px-6 py-4 last:border-b-0 sm:px-8 sm:py-5"
                  style={{ borderColor: HAIR }}
                >
                  <span className="mt-[3px] w-6 shrink-0 text-[11px] font-bold tabular-nums tracking-[0.16em]" style={{ color: FAINT }}>
                    {`0${index + 1}`}
                  </span>
                  <p className="flex-1 text-[15px] leading-relaxed" style={{ color: INK }}>
                    {check}
                  </p>
                  <SealCheck className="mt-[3px] h-5 w-5" />
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </section>

      {/* ── The certificate as issued ─────────────────────────────────── */}
      <section className="container-x pt-10 sm:pt-14">
        <Reveal className={SHOW_IN_PRINT}>
          <SectionHead
            index={section(1)}
            title={t('asIssued')}
            action={<RecordActions labels={{ copy: t('copyLink'), copied: t('copied'), print: t('print') }} />}
          />
        </Reveal>
        <Reveal delay={0.06} className={SHOW_IN_PRINT}>
          <CertificateStage
            note={t('asIssuedNote')}
            title={record.name}
            enlargeLabel={t('enlarge')}
            closeLabel={t('closeViewer')}
            fontFamily={font.fontFamily}
          >
            <div className="relative border bg-white p-2 sm:p-4" style={{ borderColor: LINE }}>
              <FrameTicks />
              <Certificate name={record.name} line={line} issuedOn={issuedOn} figures={record.figures} />
            </div>
          </CertificateStage>
        </Reveal>
      </section>

      {/* ── Take the record with you ──────────────────────────────────── */}
      {hasDownloads ? (
        <section id="ftp-downloads" className="container-x scroll-mt-28 pt-12 sm:pt-16 print:hidden">
          <Reveal>
            <SectionHead index={section(2)} title={t('downloadsTitle')} />
          </Reveal>
          <Reveal delay={0.04}>
            <div className="mb-6 grid gap-3 sm:mb-8 lg:grid-cols-2 lg:items-end lg:gap-16">
              <h2 className="text-[30px] font-bold leading-[1.05] tracking-tight sm:text-[40px] lg:text-[46px]" style={{ color: INK }}>
                {t('downloadsHeading')}
              </h2>
              <p className="max-w-xl text-base leading-relaxed lg:justify-self-end" style={{ color: BODY }}>
                {t('downloadsBody')}
              </p>
            </div>
          </Reveal>
          <StaggerGroup className={`grid gap-4 sm:gap-6 ${certificateFacts && journeyFacts ? 'lg:grid-cols-2' : ''}`}>
            {certificateFacts ? (
              <StaggerItem className="flex">
                <DocumentTile
                  index="01"
                  title={t('certificateTileTitle')}
                  body={t('certificateTileBody')}
                  tag={t('tagOpen')}
                  meta={['PDF', t('metaPages', { count: certificateFacts.pages }), t('metaLandscape'), t('metaSize', { kb: certificateFacts.kb })]}
                  visual={
                    <div
                      aria-hidden
                      className="relative w-[84%] border transition-transform duration-500 ease-out group-hover:-translate-y-1.5"
                      style={{ borderColor: LINE }}
                    >
                      <Certificate name={record.name} line={line} issuedOn={issuedOn} figures={record.figures} />
                    </div>
                  }
                  action={<CertificateDownload variant="tile" />}
                />
              </StaggerItem>
            ) : null}
            {journeyFacts ? (
              <StaggerItem className="flex">
                <DocumentTile
                  index={certificateFacts ? '02' : '01'}
                  title={t('journeyTileTitle')}
                  body={t('journeyTileBody')}
                  tag={t('tagLocked')}
                  locked
                  meta={['PDF', t('metaPages', { count: journeyFacts.pages }), t('metaPortrait'), t('metaSize', { kb: journeyFacts.kb })]}
                  visual={<JourneyStack name={record.name} line={line} />}
                  action={<JourneyUnlock variant="tile-quiet" />}
                />
              </StaggerItem>
            ) : null}
          </StaggerGroup>
        </section>
      ) : null}

      {/* ── Record details ────────────────────────────────────────────── */}
      <section className="container-x pb-16 pt-10 sm:pt-14 lg:pb-24">
        <Reveal className={SHOW_IN_PRINT}>
          <SectionHead index={section(hasDownloads ? 3 : 2)} title={t('detailsTitle')} />
        </Reveal>
        <Reveal delay={0.06} className={SHOW_IN_PRINT}>
          <div className="border-t-2 bg-white" style={{ borderTopColor: INK }}>
            <dl className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3" style={{ background: HAIR }}>
              {ledger.map(({ label, value, ltr, wide }) => (
                <div key={label} className={`bg-white px-5 py-4 sm:px-6 sm:py-5 ${wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
                  <dt>
                    <Micro>{label}</Micro>
                  </dt>
                  <dd
                    dir={ltr ? 'ltr' : undefined}
                    className={`mt-1.5 break-words font-bold leading-snug ${wide ? 'text-2xl sm:text-3xl' : 'text-[15px]'} ${ltr && rtl ? 'text-right' : ''}`}
                    style={{ color: INK }}
                  >
                    {value}
                  </dd>
                </div>
              ))}
              {Array.from({ length: lgFill }, (_, i) => (
                <div key={`lg-${i}`} aria-hidden className="hidden bg-white lg:block" />
              ))}
              {Array.from({ length: smFill }, (_, i) => (
                <div key={`sm-${i}`} aria-hidden className="hidden bg-white sm:block lg:hidden" />
              ))}
            </dl>
          </div>

          <div className="mt-6 flex flex-col gap-4 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between print:hidden">
            <span className="inline-flex items-center gap-2 text-xs font-semibold" style={{ color: BODY }}>
              <Lock size={13} style={{ color: BRAND }} />
              {t('checkedAgainst')}
            </span>
            <Link
              href="/"
              className="group inline-flex h-12 items-center justify-center gap-3 px-7 text-xs font-bold uppercase tracking-[0.2em] text-white transition-colors duration-200 hover:bg-[#0879b8]"
              style={{ background: INK }}
            >
              {rtl ? (
                <ArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-1" />
              ) : (
                <ArrowLeft size={15} className="transition-transform duration-200 group-hover:-translate-x-1" />
              )}
              {t('backHome')}
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ── S · A · T · O ─────────────────────────────────────────────── */}
      <section id="ftp-tail" className="relative overflow-hidden print:hidden" style={{ background: INK }}>
        <div aria-hidden className="h-[3px]" style={{ background: BRAND }} />
        <div aria-hidden className="pointer-events-none absolute inset-0" style={GRID} />
        <div className="container-x relative py-14 sm:py-16 lg:py-20">
          <Reveal>
            <span className="flex items-center gap-3">
              <span aria-hidden className="h-px w-8" style={{ background: ON_INK_BRAND }} />
              <Micro color={ON_INK_BRAND}>{t('mottoEyebrow')}</Micro>
            </span>
          </Reveal>
          <div dir="ltr" className="mt-8 border" style={{ background: ON_INK_RULE, borderColor: ON_INK_RULE }}>
            <StaggerGroup className="grid grid-cols-2 gap-px sm:grid-cols-4">
              {SATO.map(([letter, word]) => (
                <StaggerItem key={word} className="group relative" >
                  <div className="relative h-full p-5 sm:p-7" style={{ background: INK }}>
                    <span className="block text-[72px] font-bold leading-none tracking-tight text-white sm:text-[96px] lg:text-[120px]">
                      {letter}
                    </span>
                    <span className="mt-4 block text-[11px] font-bold uppercase tracking-[0.24em]" style={{ color: ON_INK_MUTED }}>
                      <span style={{ color: ON_INK_BRAND }}>{word.charAt(0)}</span>
                      {word.slice(1)}
                    </span>
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-0 h-[3px] w-0 transition-[width] duration-500 group-hover:w-full"
                      style={{ background: BRAND }}
                    />
                  </div>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </div>
          <Reveal delay={0.1}>
            <p className="mt-6 text-lg font-semibold text-white sm:text-xl">{tAbout('sato')}</p>
          </Reveal>
        </div>
      </section>

      {/* ── About the programme ───────────────────────────────────────── */}
      <section className="bg-white print:hidden">
        <div className="container-x py-14 lg:py-20">
          {/* The head of the article runs the full measure; the body and its
              sidebar split beneath it. */}
          <Reveal>
            <header className="max-w-4xl">
              <div className="flex items-center gap-3">
                <span aria-hidden className="h-px w-6" style={{ background: BRAND }} />
                <Micro color={BRAND}>{t('article.eyebrow')}</Micro>
              </div>
              <h2
                className="mt-5 text-[32px] font-bold leading-[1.08] tracking-tight sm:text-[44px] lg:text-[56px]"
                style={{ color: INK }}
              >
                {t('article.title')}
              </h2>
              <p className="mt-6 text-lg leading-relaxed sm:text-xl" style={{ color: BODY }}>
                {t('article.standfirst')}
              </p>
            </header>
          </Reveal>
          <Reveal delay={0.06}>
            <ul
              className="mt-8 flex flex-wrap items-stretch border-y text-[10.5px] font-bold uppercase tracking-[0.2em]"
              style={{ borderColor: LINE, color: FAINT }}
            >
              {articleMeta.map((item, index) => (
                <li key={item} className="flex items-center">
                  {index > 0 ? <span aria-hidden className="mx-4 h-3 w-px" style={{ background: LINE }} /> : null}
                  <span className="py-3" style={index === 0 ? { color: INK } : undefined}>
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>

          <div className="mt-10 grid gap-10 lg:mt-14 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-16">
            <article className="min-w-0">
              {articleSections.map((section, sectionIndex) => (
                <Reveal key={section.title} className={sectionIndex > 0 ? 'mt-12' : ''}>
                  <section>
                    <h3 className="flex items-baseline gap-4 text-xl font-bold tracking-tight sm:text-2xl" style={{ color: INK }}>
                      <span className="text-[11px] font-bold tabular-nums tracking-[0.2em]" style={{ color: BRAND }}>
                        {`0${sectionIndex + 1}`}
                      </span>
                      {section.title}
                    </h3>
                    <div className="mt-4 max-w-[68ch] space-y-5 border-s ps-6 sm:ps-8" style={{ borderColor: HAIR }}>
                      {section.paragraphs.map((paragraph, paragraphIndex) => (
                        <p
                          key={paragraphIndex}
                          className={`text-[16.5px] leading-[1.85] ${
                            sectionIndex === 0 && paragraphIndex === 0 && !rtl
                              ? 'first-letter:float-left first-letter:me-3 first-letter:mt-1 first-letter:text-[58px] first-letter:font-bold first-letter:leading-[0.8] first-letter:text-[#111820]'
                              : ''
                          }`}
                          style={{ color: BODY }}
                        >
                          {paragraph}
                        </p>
                      ))}
                    </div>
                    {sectionIndex === 1 ? (
                      <blockquote className="relative my-10 border-s-[3px] py-2 ps-6 sm:ps-8" style={{ borderColor: BRAND }}>
                        <p className="text-2xl font-bold leading-snug tracking-tight sm:text-[30px]" style={{ color: INK }}>
                          {t('article.quote')}
                        </p>
                      </blockquote>
                    ) : null}
                  </section>
                </Reveal>
              ))}
            </article>

            <aside className="lg:sticky lg:top-28 lg:self-start">
              <Reveal delay={0.08}>
                <div className="border-t-2" style={{ borderTopColor: INK, background: CANVAS }}>
                  <div className="px-5 pb-2 pt-4">
                    <Micro color={INK}>{t('article.glanceTitle')}</Micro>
                  </div>
                  <dl>
                    {articleGlance.map(({ label, value }) => (
                      <div key={label} className="border-t px-5 py-3.5" style={{ borderColor: LINE }}>
                        <dt>
                          <Micro>{label}</Micro>
                        </dt>
                        <dd className="mt-1 text-[14px] font-bold leading-snug" style={{ color: INK }}>
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div aria-hidden className="h-[3px]" style={{ background: BRAND }} />
                </div>
              </Reveal>
            </aside>
          </div>

          <Reveal delay={0.1}>
            <Micro className="mb-4 mt-16" color={INK}>
              {t('pillarsTitle')}
            </Micro>
          </Reveal>
          <div className="border" style={{ background: HAIR, borderColor: LINE }}>
            <StaggerGroup className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-5">
              {pillars.map((pillar, index) => (
                <StaggerItem key={pillar} className={`group relative bg-white ${index === 4 ? 'sm:col-span-2 lg:col-span-1' : ''}`}>
                  <span
                    aria-hidden
                    className="absolute inset-x-0 top-0 h-[3px] origin-left scale-x-0 transition-transform duration-500 group-hover:scale-x-100"
                    style={{ background: BRAND }}
                  />
                  <div className="flex h-full min-h-[128px] flex-col justify-between gap-6 p-5 sm:p-6">
                    <span className="text-[11px] font-bold tabular-nums tracking-[0.2em]" style={{ color: BRAND }}>
                      {`0${index + 1}`}
                    </span>
                    <span className="text-[13px] font-bold uppercase leading-snug tracking-[0.12em]" style={{ color: INK }}>
                      {pillar}
                    </span>
                  </div>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </div>
        </div>
      </section>
    </div>
    <StickyDownloadBar heroId="ftp-hero" asideFor="ftp-downloads" endId="ftp-tail" />
    </DownloadsProvider>
  );
}
