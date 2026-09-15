import type { ComponentType, ReactNode } from 'react';
import Image from 'next/image';
import { DrawLine, SplitTitle } from '@/components/ui/premium';
import { cn } from '@/lib/utils';

/*
 * The pieces the certificate verification page is built from, shared so every
 * page on the site speaks the same way: micro labels, hairline eyebrows,
 * numbered section heads, square icon tiles and corner ticks.
 */

type Tone = 'faint' | 'ink' | 'brand' | 'on-ink' | 'on-ink-brand' | 'on-ink-muted';

const TONE: Record<Tone, string> = {
  faint: 'text-muted',
  ink: 'text-ink',
  brand: 'text-primary',
  'on-ink': 'text-ink-label',
  'on-ink-brand': 'text-primary-light',
  'on-ink-muted': 'text-ink-muted',
};

/** The micro label: 10.5px, bold, uppercase, letterspaced. */
export function Micro({
  children,
  tone = 'faint',
  className,
  as: Tag = 'span',
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  as?: 'span' | 'p' | 'div' | 'dt' | 'h2' | 'h3' | 'h4' | 'label';
}) {
  return <Tag className={cn('micro block', TONE[tone], className)}>{children}</Tag>;
}

/** A hairline that draws itself in, and a micro label: how every section on the site is introduced. */
export function Eyebrow({ children, onInk = false, className }: { children: ReactNode; onInk?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-3', className)}>
      <DrawLine className={cn('h-px w-10 shrink-0', onInk ? 'bg-primary-light' : 'bg-primary')} />
      <Micro tone={onInk ? 'on-ink-brand' : 'brand'}>{children}</Micro>
    </span>
  );
}

/** A numbered section head on a hairline, the way the portal's documents run their sections. */
export function SectionHead({
  index,
  title,
  action,
  onInk = false,
  className,
}: {
  index: string;
  title: ReactNode;
  action?: ReactNode;
  onInk?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('relative mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-3', className)}>
      <div className="flex items-center gap-3">
        <span className={cn('text-[11px] font-bold tabular-nums tracking-[0.2em]', onInk ? 'text-primary-light' : 'text-primary')}>
          {index}
        </span>
        <span aria-hidden className={cn('h-px w-6', onInk ? 'bg-white' : 'bg-ink')} />
        <Micro tone={onInk ? 'on-ink-muted' : 'ink'}>{title}</Micro>
      </div>
      {action}
      <span aria-hidden className={cn('absolute inset-x-0 bottom-0 h-px', onInk ? 'bg-ink-rule' : 'bg-line')} />
      <DrawLine className={cn('absolute bottom-0 start-0 h-px w-full', onInk ? 'bg-ink-edge' : 'bg-ink/30')} />
    </div>
  );
}

const TITLE_SIZE = 'text-[32px] sm:text-[44px] lg:text-[54px]';

/** An eyebrow, a large tight heading whose words rise into place, and an optional standfirst. */
export function SectionTitle({
  eyebrow,
  title,
  body,
  onInk = false,
  split = false,
  className,
  as: Heading = 'h2',
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  onInk?: boolean;
  /** Heading on the start side, standfirst on the end side from lg up. */
  split?: boolean;
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
}) {
  const headingClass = cn(
    /* Balanced, so a two-line heading never leaves its last word alone. */
    'text-balance font-bold leading-[1.02] tracking-[-0.02em] rtl:leading-[1.3] rtl:tracking-normal',
    eyebrow ? 'mt-6' : '',
    TITLE_SIZE,
    onInk ? 'text-white' : 'text-ink',
  );
  return (
    <div className={cn(split ? 'grid gap-5 lg:grid-cols-2 lg:items-end lg:gap-16' : 'max-w-3xl', className)}>
      <div>
        {eyebrow ? <Eyebrow onInk={onInk}>{eyebrow}</Eyebrow> : null}
        {typeof title === 'string' ? (
          <SplitTitle as={Heading} text={title} className={headingClass} />
        ) : (
          <Heading className={headingClass}>{title}</Heading>
        )}
      </div>
      {body ? (
        <p
          className={cn(
            'text-base leading-relaxed sm:text-lg',
            split ? 'max-w-xl lg:justify-self-end' : 'mt-6 max-w-2xl',
            onInk ? 'text-ink-muted' : 'text-body',
          )}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}

/** A square tile holding an icon, with a keyline inset inside it — the site's replacement for every rounded icon bubble. */
export function IconTile({
  icon: Icon,
  tone = 'brand',
  size = 'md',
  className,
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  tone?: 'brand' | 'ink' | 'paper' | 'on-ink';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const box = { sm: 'h-10 w-10', md: 'h-12 w-12', lg: 'h-16 w-16' }[size];
  const glyph = { sm: 16, md: 20, lg: 26 }[size];
  const ground = {
    brand: 'bg-primary text-white',
    ink: 'bg-ink text-white',
    paper: 'bg-white text-primary border border-line',
    'on-ink': 'bg-ink-rule text-primary-light',
  }[tone];
  const keyline = {
    brand: 'border-white/35',
    ink: 'border-[#4f5962]',
    paper: 'border-hair',
    'on-ink': 'border-ink-edge',
  }[tone];
  return (
    <span aria-hidden className={cn('relative inline-flex shrink-0 items-center justify-center', box, ground, className)}>
      <span className={cn('pointer-events-none absolute inset-[12%] border', keyline)} />
      <Icon size={glyph} strokeWidth={1.75} className="relative" />
      {tone === 'ink' ? <span className="absolute inset-x-0 bottom-0 h-[6%] bg-primary" /> : null}
    </span>
  );
}

/** A square tile holding a check that draws itself: the site's one mark for "this was confirmed". */
export function SealCheck({ className, tone = 'brand', draw = false }: { className?: string; tone?: 'brand' | 'ink'; draw?: boolean }) {
  return (
    <span aria-hidden className={cn('relative inline-block shrink-0', tone === 'brand' ? 'bg-primary' : 'bg-ink', className)}>
      <span className={cn('absolute inset-[12%] border', tone === 'brand' ? 'border-white/40' : 'border-[#4f5962]')} />
      <svg viewBox="0 0 72 72" className={cn('absolute inset-0 h-full w-full', draw && 'sharp-draw')}>
        <path d="M22 37 L32 47 L51 25" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="square" />
      </svg>
      {tone === 'ink' ? <span className="absolute inset-x-0 bottom-0 h-[6%] bg-primary" /> : null}
    </span>
  );
}

/** Corner ticks on a frame, answering the ones the certificate carries. */
export function FrameTicks({ onInk = false }: { onInk?: boolean }) {
  const tick = cn('pointer-events-none absolute z-10 h-5 w-5', onInk ? 'border-white' : 'border-ink');
  return (
    <>
      <span aria-hidden className={cn(tick, '-left-px -top-px border-l-2 border-t-2')} />
      <span aria-hidden className={cn(tick, '-right-px -top-px border-r-2 border-t-2')} />
      <span aria-hidden className={cn(tick, '-bottom-px -left-px border-b-2 border-l-2')} />
      <span aria-hidden className={cn(tick, '-bottom-px -right-px border-b-2 border-r-2')} />
    </>
  );
}

/**
 * Corner ticks that close in on a card when it is hovered — crop marks
 * finding their edge. The card needs `group relative`.
 */
export function HoverTicks({ onInk = false }: { onInk?: boolean }) {
  const tick = cn(
    'pointer-events-none absolute z-20 h-4 w-4 opacity-0 transition-all duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:opacity-100',
    onInk ? 'border-primary-light' : 'border-primary',
  );
  return (
    <>
      <span aria-hidden className={cn(tick, 'left-4 top-4 border-l-2 border-t-2 group-hover:-left-px group-hover:-top-px')} />
      <span aria-hidden className={cn(tick, 'right-4 top-4 border-r-2 border-t-2 group-hover:-right-px group-hover:-top-px')} />
      <span aria-hidden className={cn(tick, 'bottom-4 left-4 border-b-2 border-l-2 group-hover:-bottom-px group-hover:-left-px')} />
      <span aria-hidden className={cn(tick, 'bottom-4 right-4 border-b-2 border-r-2 group-hover:-bottom-px group-hover:-right-px')} />
    </>
  );
}

/** The 3px brand seam that closes a navy band. */
export function Seam({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-[3px] bg-primary', className)} />;
}

/** The hairline grid a navy band carries. Place inside a `relative` parent. */
export function InkGrid({ className }: { className?: string }) {
  return <div aria-hidden className={cn('ink-grid pointer-events-none absolute inset-0', className)} />;
}

/**
 * Sato Pharma's Arabic wordmark set very large and very faint behind a band,
 * the way the certificate carries it: engraved stock, never a picture. Place
 * inside a `relative overflow-hidden` parent and size it with `className`.
 */
export function ArabicWatermark({
  onInk = true,
  position = 'end',
  className,
}: {
  onInk?: boolean;
  position?: 'start' | 'end' | 'center';
  className?: string;
}) {
  const place = {
    start: 'object-left rtl:object-right',
    end: 'object-right rtl:object-left',
    center: 'object-center',
  }[position];
  return (
    <div aria-hidden className={cn('pointer-events-none absolute select-none print:hidden', className)}>
      <Image
        src="/ftp/2026/sato-pharma-arabic.png"
        alt=""
        fill
        sizes="60vw"
        className={cn('object-contain', place)}
        style={{ filter: onInk ? 'brightness(0) invert(1)' : 'brightness(0)', opacity: onInk ? 0.05 : 0.035 }}
      />
    </div>
  );
}

/** A large numeral drawn as a hairline outline, which turns brand blue when its card is hovered. */
export function GhostNumeral({ children, onInk = false, className }: { children: ReactNode; onInk?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      dir="ltr"
      className={cn(
        'pointer-events-none select-none font-bold leading-[0.8] tracking-[-0.04em] tabular-nums',
        onInk ? 'text-outline-on-ink' : 'text-outline-ink',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A square status tag: a micro label in a 1px box. */
export function Tag({
  children,
  tone = 'ink',
  className,
}: {
  children: ReactNode;
  tone?: 'ink' | 'brand' | 'solid' | 'solid-ink' | 'success' | 'warning' | 'danger' | 'on-ink';
  className?: string;
}) {
  const tones = {
    ink: 'border-line bg-white text-ink',
    brand: 'border-primary/40 bg-primary/[0.06] text-primary',
    solid: 'border-primary bg-primary text-white',
    'solid-ink': 'border-ink bg-ink text-white',
    success: 'border-success/40 bg-success/[0.06] text-success',
    warning: 'border-warning/40 bg-warning/[0.06] text-warning',
    danger: 'border-danger/40 bg-danger/[0.06] text-danger',
    'on-ink': 'border-ink-edge text-white',
  }[tone];
  return (
    <span className={cn('inline-flex items-center gap-2 border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em]', tones, className)}>
      {children}
    </span>
  );
}

/** A grid of cells divided by hairlines: the page's tables of figures and facts. Children are the cells, each `bg-white`. */
export function RuledGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-px border border-line bg-hair', className)}>{children}</div>;
}
