'use client';

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useLocale } from 'next-intl';
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { cn } from '@/lib/utils';

/*
 * The motion half of the SHARP kit. Everything here moves the way the
 * certificate page moves: once, on entry, on the one ease the site owns, and
 * never at all for a reader who has asked for less motion. Nothing bounces,
 * nothing glows, nothing is rounded.
 */

export const EASE = [0.16, 1, 0.3, 1] as const;

function useRtl() {
  return useLocale() === 'ar';
}

/*
 * Nothing on this site is hidden by script. Every entrance is a CSS animation laid over content whose resting state is
 * SHOWN, and script only decides when to start it — as the element scrolls onto the screen. Motion's `initial` state
 * hid content until a script-driven animation finished, and in a background tab, a throttled frame loop or a crawler
 * it never finished: photos and text stayed invisible. Anything already on screen as the page first arrives is left
 * shown; after that, anything mounting on screen (a client navigation, a re-filtered grid) plays straight away.
 */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
let pageSettled = false;
if (typeof window !== 'undefined') {
  const settle = () => window.setTimeout(() => (pageSettled = true), 800);
  if (document.readyState === 'complete') settle();
  else window.addEventListener('load', settle, { once: true });
}

/** Calls `start` once, when the element scrolls onto the screen. */
export function useOnEnter<T extends Element>(ref: RefObject<T | null>, start: (el: T) => void, enabled = true) {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    if (pageSettled) {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0 && r.height > 0) {
        start(el);
        return;
      }
    }
    let first = true;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        if (!first) start(el);
        io.disconnect();
      }
      first = false;
    });
    io.observe(el);
    return () => io.disconnect();
    // `start` is a fresh closure every render and only ever adds a class; the element is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

const delayVar = (delay: number) => (delay ? ({ '--rv-delay': `${delay}s` } as CSSProperties) : undefined);

type HeadingTag = 'h1' | 'h2' | 'h3' | 'p' | 'span';

/**
 * A heading whose words rise out of their own line, one after another. The
 * words stay ordinary text separated by ordinary spaces, so the heading reads
 * and indexes as the sentence it is.
 */
export function SplitTitle({
  text,
  as: Tag = 'h2',
  className,
  delay = 0,
  stagger = 0.045,
  immediate = false,
}: {
  text: string;
  as?: HeadingTag;
  className?: string;
  delay?: number;
  stagger?: number;
  /** Animate on mount (for a hero) rather than on scroll into view. */
  immediate?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const words = text.split(/\s+/).filter(Boolean);
  useOnEnter(ref, (el) => el.classList.add('rv-words-run'), !immediate);
  return (
    <Tag ref={ref as never} className={cn(className, immediate && 'rv-words-run')}>
      {words.map((word, i) => (
        <span key={i}>
          {/* Arabic's descenders and dots sit far lower than Latin's, so its window is deeper. */}
          <span className="-mb-[0.16em] inline-block overflow-hidden pb-[0.16em] align-bottom rtl:-mb-[0.4em] rtl:pb-[0.4em]">
            <span className="rv-word inline-block" style={{ '--rv-delay': `${delay + i * stagger}s` } as CSSProperties}>
              {word}
            </span>
          </span>
          {i < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </Tag>
  );
}

/** A hairline that draws itself from the start side. */
export function DrawLine({
  className,
  delay = 0,
  immediate = false,
}: {
  className?: string;
  delay?: number;
  immediate?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useOnEnter(ref, (el) => el.classList.add('rv-draw-run'), !immediate);
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn('block origin-left rtl:origin-right', immediate && 'rv-draw-run', className)}
      style={delayVar(delay)}
    />
  );
}

/**
 * A photograph uncovered by a straight wipe from the start side while it
 * settles from a slight enlargement — a print sliding out of a sleeve. The
 * box is `relative overflow-hidden`; give it a size or an aspect ratio.
 */
export function MaskReveal({
  children,
  className,
  delay = 0,
  immediate = false,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  immediate?: boolean;
}) {
  /*
   * The photograph's resting state is SHOWN. The wipe is a CSS animation laid over it and started only as the photo
   * scrolls onto the screen, so a stalled script, a background tab or a crawler can never leave a photo hidden — which
   * is exactly what the script-driven version did. A photo already on screen when the page arrives is simply shown.
   */
  const ref = useRef<HTMLDivElement>(null);
  useOnEnter(ref, (el) => el.classList.add('mask-reveal-run'), !immediate);
  return (
    <div
      ref={ref}
      className={cn('relative overflow-hidden', immediate && 'mask-reveal-run', className)}
      style={delay ? ({ '--mask-delay': `${delay}s` } as CSSProperties) : undefined}
    >
      <div className="mask-reveal-inner absolute inset-0">{children}</div>
    </div>
  );
}

/** Drifts its content against the scroll by a few pixels: depth without a shadow. */
export function Parallax({ children, className, distance = 40 }: { children: ReactNode; className?: string; distance?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [-distance, distance]);
  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      <motion.div style={{ y }} className="absolute inset-x-0 -inset-y-12">
        {children}
      </motion.div>
    </div>
  );
}

/**
 * One brand hairline that sweeps its parent once when it comes into view —
 * the certificate page reading its register. Place inside a `relative
 * overflow-hidden` parent.
 */
export function ScanLine({ className, delay = 0.3, onInk = true }: { className?: string; delay?: number; onInk?: boolean }) {
  const reduce = useReducedMotion();
  const rtl = useRtl();
  if (reduce) return null;
  return (
    <motion.span
      aria-hidden
      className={cn('pointer-events-none absolute inset-y-0 z-10 w-[2px] print:hidden', onInk ? 'bg-primary-light' : 'bg-primary', className)}
      initial={rtl ? { right: '0%', opacity: 0 } : { left: '0%', opacity: 0 }}
      whileInView={rtl ? { right: '100%', opacity: [0, 1, 1, 0] } : { left: '100%', opacity: [0, 1, 1, 0] }}
      viewport={{ once: true }}
      transition={{ duration: 1.6, delay, ease: [0.65, 0, 0.35, 1] }}
    />
  );
}

/** Children enter one after another as the group scrolls into view. */
export function StaggerGroup({
  children,
  className,
  delay = 0,
  step = 0.08,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  step?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOnEnter(ref, (el) => {
    // Only this group's own items: a nested group staggers its items when it arrives itself.
    const items = [...el.querySelectorAll<HTMLElement>('[data-rv-item]')].filter(
      (item) => item.parentElement?.closest('[data-rv-group]') === el,
    );
    items.forEach((item, i) => {
      item.style.setProperty('--rv-delay', `${delay + i * step}s`);
      item.classList.add('rv-rise-run');
    });
  });
  return (
    <div ref={ref} data-rv-group="" className={className}>
      {children}
    </div>
  );
}

/** One child of a StaggerGroup. */
export function StaggerItem({
  children,
  className,
  y = 26,
  duration = 0.85,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
  duration?: number;
}) {
  return (
    <div data-rv-item="" className={className} style={{ '--rv-y': `${y}px`, '--rv-dur': `${duration}s` } as CSSProperties}>
      {children}
    </div>
  );
}

/**
 * A slow, endless ribbon that stops when a pointer rests on it. It always runs
 * in Latin order; `reverse` sends it the other way for an Arabic page.
 */
export function Marquee({
  children,
  className,
  seconds = 42,
  reverse = false,
}: {
  children: ReactNode;
  className?: string;
  seconds?: number;
  reverse?: boolean;
}) {
  return (
    <div dir="ltr" className={cn('group relative flex overflow-hidden', className)}>
      {[0, 1].map((copy) => (
        <div
          key={copy}
          aria-hidden={copy === 1}
          className="marquee-track flex shrink-0 items-center group-hover:[animation-play-state:paused]"
          style={{ animationDuration: `${seconds}s`, animationName: reverse ? 'marquee-reverse' : 'marquee' }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}

/** The brand hairline under the bar that fills as the page is read. */
export function ReadingProgress({ className }: { className?: string }) {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.3 });
  return (
    <motion.div
      aria-hidden
      style={{ scaleX }}
      className={cn('pointer-events-none absolute inset-x-0 -bottom-px h-[2px] origin-left bg-primary rtl:origin-right', className)}
    />
  );
}
