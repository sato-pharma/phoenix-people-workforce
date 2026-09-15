import type { Config } from 'tailwindcss';

/*
 * SHARP — the identity of the certificate verification page, carried across the
 * whole site: navy ink, one brand blue, 1px rules for hierarchy, micro labels,
 * and every corner at 90°. No rounded corners, no soft shadows, no glows.
 */
const SANS = ['"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'];

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Brand blue, and the lighter blue that reads on navy
        primary: { DEFAULT: '#0879b8', dark: '#06628f', mid: '#0879b8', light: '#5db7e8' },
        // Navy ink, and what sits on it
        ink: { DEFAULT: '#111820', rule: '#26313b', edge: '#3a4652', label: '#6f7c86', muted: '#9aa6af' },
        navy: '#17304d',
        body: '#45515a',
        muted: { DEFAULT: '#8a959d', dark: '#45515a' },
        // Hairlines and grounds
        line: '#dde4e8',
        hair: '#e1e7eb',
        canvas: '#f2f5f7',
        surface: { DEFAULT: '#ffffff', soft: '#f2f5f7', alt: '#e9eef1' },
        // Status
        success: '#15803d',
        warning: '#b45309',
        danger: '#b91c1c',
        info: '#0879b8',
      },
      fontFamily: {
        sans: SANS,
        display: SANS,
        title: SANS,
        eyebrow: SANS,
        nav: SANS,
        ar: ['var(--font-cairo)', 'Tahoma', 'sans-serif'],
      },
      maxWidth: { container: '1440px' },
      backgroundImage: {
        // "Kinetic Calm" brand artwork (text-free, WebP-optimized)
        'hero': "url('/images/hero-bg.webp')",
        'hero-ar': "url('/images/hero-ar-bg.webp')",
        'about': "url('/images/about-bg.webp')",
        'products': "url('/images/products-bg.webp')",
        'cta': "url('/images/cta-bg.webp')",
        'news': "url('/images/news-bg.webp')",
        'news-band': "url('/images/news-band.webp')",
        'pattern': "url('/images/pattern.webp')",
      },
      keyframes: {
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        'sharp-progress': { from: { left: '-34%' }, to: { left: '100%' } },
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        'sharp-progress': 'sharp-progress .9s cubic-bezier(.65,0,.35,1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
