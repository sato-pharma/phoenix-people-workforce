/**
 * The size an alarm badge's glow grows from (owner, 2026-10-03: "make the pulsing badges cheap to
 * draw, same look").
 *
 * The glow is the badge's `::after` in app/globals.css: a block 7px (8px overdue) larger than the
 * badge on every side, animated with transform + opacity only, so the browser hands it to the
 * graphics card instead of repainting the page every frame as the old animated box-shadow did.
 * To grow EXACTLY like that box-shadow — the same number of pixels on every side at every instant —
 * each axis starts from its own scale, width / (width + 14) and height / (height + 14). CSS cannot
 * read a badge's width, and a "27" or "99+" badge is wider than it is tall, so one shared scale
 * makes the glow show above and below before it shows at the sides. This writes the badge's own
 * size into `--glow-w` / `--glow-h` and keeps it current when the count changes width.
 *
 * Use it as the badge's `ref`. It is a plain function, not a hook, so a badge rendered inside a
 * `.map()` can take it too. One ResizeObserver serves every badge on the page.
 */
let observer: ResizeObserver | null = null;

function measure(badge: HTMLElement) {
  // Layout size, which the pump's transform does not change.
  badge.style.setProperty("--glow-w", String(badge.offsetWidth));
  badge.style.setProperty("--glow-h", String(badge.offsetHeight));
}

export function alarmGlowRef(badge: HTMLElement | null): (() => void) | undefined {
  if (!badge || typeof ResizeObserver === "undefined") return undefined;
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) measure(entry.target as HTMLElement);
  });
  measure(badge);
  observer.observe(badge);
  return () => {
    observer?.unobserve(badge);
  };
}
