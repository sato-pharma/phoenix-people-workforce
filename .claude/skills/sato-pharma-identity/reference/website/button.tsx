import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'ink' | 'secondary' | 'outline-ink' | 'on-ink' | 'on-ink-quiet' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/*
 * The verification page's buttons, as the site's only buttons: square,
 * uppercase and letterspaced. A hover never lifts them: a second colour slides
 * across from the start side, the way a rule is drawn.
 */
const BASE =
  'group relative isolate inline-flex items-center justify-center gap-3 overflow-hidden whitespace-nowrap font-bold uppercase ' +
  'transition-[color,border-color] duration-500 ease-[cubic-bezier(.16,1,.3,1)] rtl:tracking-normal ' +
  'before:absolute before:inset-0 before:-z-10 before:origin-left before:scale-x-0 before:transition-transform before:duration-500 ' +
  'before:ease-[cubic-bezier(.16,1,.3,1)] hover:before:scale-x-100 rtl:before:origin-right ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ' +
  'disabled:pointer-events-none disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white before:bg-ink',
  ink: 'bg-ink text-white before:bg-primary',
  secondary: 'border border-primary text-primary before:bg-primary hover:text-white',
  'outline-ink': 'border-2 border-ink bg-white text-ink before:bg-ink hover:text-white',
  'on-ink': 'bg-primary text-white before:bg-white hover:text-ink focus-visible:outline-primary-light',
  'on-ink-quiet': 'border border-ink-edge text-white before:bg-white hover:border-white hover:text-ink focus-visible:outline-primary-light',
  ghost: 'text-primary before:hidden hover:text-ink',
  danger: 'bg-danger text-white before:bg-ink',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-10 px-4 text-[10.5px] tracking-[0.16em] rtl:text-[12px]',
  md: 'h-12 px-6 text-[11px] tracking-[0.18em] rtl:text-[13px]',
  lg: 'h-14 px-8 text-[11.5px] tracking-[0.2em] rtl:text-[14px]',
};

/** The class string for a button, for a <Link> or <a> that should look like one. */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'primary', size = 'md', className, children, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={buttonStyles({ variant, size, className })} {...props}>
      {children}
    </button>
  );
}
