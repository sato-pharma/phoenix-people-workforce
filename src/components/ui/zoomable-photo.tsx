"use client";

import { Maximize2, Minus, Plus, RotateCcw, RotateCcwSquare, RotateCwSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  turnedFillStyle,
  turnedFitLimits,
  TURNABLE_FRAME_STYLE,
  turnPhoto,
  type QuarterTurns,
} from "@/components/ui/photo-rotation";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Tap a photo → it opens full screen, fitted to the window, and zooms.
//
// WHY THIS EXISTS. Every evidence photo in Phoenix was rendered at a fixed tile size — `h-28
// object-cover` on a trip receipt, `h-64 object-contain` on a marketing capture. On a phone that
// is a thumbnail of a pharmacy storefront or a handwritten receipt, and the one thing the viewer
// actually needs to do with it — read the shop sign, read the amount — was impossible. The photo
// was on file, it was on screen, and it still could not be checked.
//
// WHY IT IS ONE COMPONENT. The photos live in nine different modules that share no layout. Wiring
// a viewer into each would have produced nine slightly different behaviours, and the rule here is
// that a screen must match its siblings. `ZoomablePhoto` is a drop-in for a plain `<img>`: same
// `src`, same `alt`, same `className` on the thumbnail. Only the overlay is new.
//
// WHY IT IS NOT next/image. Almost every photo it wraps is a short-lived SIGNED URL into a private
// Supabase bucket, or an in-memory blob/data URL from a live capture. The Next image optimizer
// cannot fetch either on the viewer's behalf, which is why each call site already carried a plain
// `<img>` and an eslint-disable. That reasoning is unchanged — it just lives in one place now.
// ─────────────────────────────────────────────────────────────────────────────

/** Below 1 the photo would be smaller than its own fitted size, which is never useful. */
const MIN_SCALE = 1;
/** 8x is enough to read a hand-written receipt total on a 12MP phone capture. */
const MAX_SCALE = 8;
/** One notch of the +/− buttons. Multiplicative so each press feels the same at any zoom. */
const BUTTON_STEP = 1.5;
/** A double-tap lands here — close enough to read text, far enough to still see context. */
const DOUBLE_TAP_SCALE = 2.5;
/** Pointer travel (px) below which a press still counts as a tap, not a drag. */
const TAP_SLOP = 6;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

type Offset = { x: number; y: number };

const NO_OFFSET: Offset = { x: 0, y: 0 };

/**
 * The overlay itself. Split out so all of its state — scale, pan, live pointers — is created when
 * the photo is opened and thrown away when it closes. A photo that was zoomed, closed and reopened
 * must come back fitted, not still zoomed into the corner someone left it in.
 */
function PhotoLightbox({
  alt,
  caption,
  onClose,
  onTurn,
  src,
  turns,
}: {
  alt: string;
  caption?: string | null;
  onClose: () => void;
  /** Present only on a turnable photo: the turn is the THUMBNAIL's, so it follows the photo in and out. */
  onTurn?: (direction: "left" | "right") => void;
  src: string;
  turns: QuarterTurns;
}) {
  const dialogRef = useDialogA11y<HTMLDivElement>({ onClose, open: true });
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>(NO_OFFSET);

  // Live pointer state is a ref, not state: it changes on every pointermove, and re-rendering the
  // photo on each move makes a pinch stutter on a mid-range Android.
  const pointers = useRef(new Map<number, Offset>());
  const dragOrigin = useRef<{ offset: Offset; point: Offset } | null>(null);
  const pinchOrigin = useRef<{ distance: number; scale: number } | null>(null);
  const movedDuringPress = useRef(false);

  const reset = useCallback(() => {
    setScale(1);
    setOffset(NO_OFFSET);
  }, []);

  /**
   * Zoom about a fixed point on screen — the pointer under a wheel, the midpoint of a pinch.
   *
   * Without this the photo zooms about its own centre, so the detail someone is pointing at slides
   * away from under their finger and they have to chase it with a pan. `anchor` is in stage
   * coordinates, measured from the stage centre.
   */
  const zoomAbout = useCallback((nextScaleRaw: number, anchor: Offset) => {
    setScale((currentScale) => {
      const nextScale = clampScale(nextScaleRaw);
      if (nextScale === currentScale) return currentScale;
      setOffset((currentOffset) => {
        if (nextScale === MIN_SCALE) return NO_OFFSET;
        const ratio = nextScale / currentScale;
        return {
          x: anchor.x - (anchor.x - currentOffset.x) * ratio,
          y: anchor.y - (anchor.y - currentOffset.y) * ratio,
        };
      });
      return nextScale;
    });
  }, []);

  /** Stage-centre-relative coordinates for a pointer/wheel event. */
  const anchorFor = useCallback((clientX: number, clientY: number): Offset => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return NO_OFFSET;
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
  }, []);

  const zoomByButton = useCallback(
    (direction: 1 | -1) => {
      // Buttons zoom about the centre — there is no pointer to anchor to.
      zoomAbout(direction === 1 ? scale * BUTTON_STEP : scale / BUTTON_STEP, NO_OFFSET);
    },
    [scale, zoomAbout],
  );

  // The wheel listener is attached by hand, NOT via onWheel, because React attaches its wheel
  // listener passively — preventDefault() inside it is ignored and the PAGE scrolls behind the
  // overlay while the photo zooms. A non-passive native listener is the only way to stop that.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      // deltaY is in lines on Firefox and pixels on Chrome; only the sign and rough size matter.
      const factor = Math.exp(-event.deltaY / 260);
      zoomAbout(scale * factor, anchorFor(event.clientX, event.clientY));
    }
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [anchorFor, scale, zoomAbout]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    movedDuringPress.current = false;

    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      pinchOrigin.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
      dragOrigin.current = null;
      return;
    }
    dragOrigin.current = { offset, point: { x: event.clientX, y: event.clientY } };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2 && pinchOrigin.current) {
      const [a, b] = Array.from(pointers.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchOrigin.current.distance > 0) {
        movedDuringPress.current = true;
        const midpoint = anchorFor((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAbout((pinchOrigin.current.scale * distance) / pinchOrigin.current.distance, midpoint);
      }
      return;
    }

    const origin = dragOrigin.current;
    if (!origin) return;
    const dx = event.clientX - origin.point.x;
    const dy = event.clientY - origin.point.y;
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) movedDuringPress.current = true;
    // Panning a photo that exactly fits the window would just slide it off into the dark.
    if (scale === MIN_SCALE) return;
    setOffset({ x: origin.offset.x + dx, y: origin.offset.y + dy });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchOrigin.current = null;
    if (pointers.current.size === 0) dragOrigin.current = null;
  }

  /**
   * A click on the dark area around the photo closes; a click on the photo does not.
   *
   * `movedDuringPress` is what stops a pan that happens to END over the backdrop from closing the
   * overlay — dragging a zoomed photo to the edge is exactly how someone inspects its corner, and
   * having that dismiss the photo would be maddening.
   */
  function handleStageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (movedDuringPress.current) return;
    if (event.target === event.currentTarget) onClose();
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLImageElement>) {
    if (scale > MIN_SCALE) {
      reset();
      return;
    }
    zoomAbout(DOUBLE_TAP_SCALE, anchorFor(event.clientX, event.clientY));
  }

  const zoomLabel = `${Math.round(scale * 100)}%`;

  return (
    <div
      aria-label={alt}
      aria-modal="true"
      className="fixed inset-0 z-[300] flex flex-col bg-[#020617]/92 backdrop-blur-sm"
      ref={dialogRef}
      role="dialog"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-5 sm:pb-3 sm:pt-3">
        {/* Never an ellipsis, and never clipped: beside a 200px toolbar a phone leaves the caption
            about 120px, so "Customer · Place · date" WRAPS (where the two rules collide, wrapping
            wins). The toolbar keeps its own width. */}
        <p className="min-w-0 flex-1 break-words py-2 text-phx-sm font-black leading-snug text-white/90 sm:text-sm" dir="auto">
          {caption ?? alt}
        </p>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {onTurn ? (
            <>
              <button
                aria-label="Turn the photo left"
                className="inline-flex h-10 w-10 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white"
                onClick={() => onTurn("left")}
                type="button"
              >
                <RotateCcwSquare className="h-4 w-4" />
              </button>
              <button
                aria-label="Turn the photo right"
                className="inline-flex h-10 w-10 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white"
                onClick={() => onTurn("right")}
                type="button"
              >
                <RotateCwSquare className="h-4 w-4" />
              </button>
            </>
          ) : null}
          <button
            aria-label="Zoom out"
            className="inline-flex h-10 w-10 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            disabled={scale <= MIN_SCALE}
            onClick={() => zoomByButton(-1)}
            type="button"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="hidden min-w-[3.5rem] text-center text-phx-sm font-black tabular-nums text-white/80 sm:inline">
            {zoomLabel}
          </span>
          <button
            aria-label="Zoom in"
            className="inline-flex h-10 w-10 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            disabled={scale >= MAX_SCALE}
            onClick={() => zoomByButton(1)}
            type="button"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            aria-label="Reset zoom"
            className="inline-flex h-10 w-10 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            disabled={scale === MIN_SCALE && offset.x === 0 && offset.y === 0}
            onClick={reset}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            aria-label="Close photo"
            className="inline-flex h-10 w-10 items-center justify-center text-white/70 transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* `touch-none` is load-bearing: without it the browser claims the pinch and the two-finger
          drag for its own page zoom and scroll, and neither gesture ever reaches this component. */}
      <div
        className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
        onClick={handleStageClick}
        onPointerCancel={handlePointerUp}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerUp}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        ref={stageRef}
        // The stage is what a turned photo is measured against (see photo-rotation.ts).
        style={onTurn ? TURNABLE_FRAME_STYLE : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed private-bucket URLs and in-memory blobs; see the file header */}
        <img
          alt={alt}
          className={cn(
            "max-h-full max-w-full object-contain",
            scale > MIN_SCALE ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
          )}
          draggable={false}
          onDoubleClick={handleDoubleClick}
          src={src}
          style={{
            ...turnedFitLimits(turns),
            // The turn comes LAST, so a pan still moves the photo the way the finger moves.
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})${turns === 0 ? "" : ` rotate(${turns * 90}deg)`}`,
            // No transition: a transform that animates lags a finger during a pinch.
            transformOrigin: "center center",
          }}
        />
      </div>

      <p className="shrink-0 border-t border-white/10 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 text-center text-phx-xs font-semibold text-white/50 sm:px-5 sm:pb-2">
        Pinch or scroll to zoom · drag to move · double-tap to fit
      </p>
    </div>
  );
}

/**
 * A photo that opens full screen and zooms when tapped.
 *
 * Drop-in for a plain `<img>`: `className` styles the THUMBNAIL exactly as before, so a call site
 * keeps its own layout (`h-28 w-full object-cover`, `h-64 object-contain`, a rounded avatar) and
 * gains only the tap-to-open behaviour.
 */
export function ZoomablePhoto({
  alt,
  ariaHidden,
  caption,
  className,
  lazy,
  onError,
  onLoad,
  rotatable,
  src,
}: {
  alt: string;
  /** For decorative thumbnails (an avatar beside a name that already reads it out). */
  ariaHidden?: boolean;
  /** Shown in the overlay's header instead of `alt` when the photo has a real caption. */
  caption?: string | null;
  className?: string;
  /**
   * Hold the thumbnail back until it nears the screen. For a LONG list only: a worklist of a hundred
   * photos would otherwise fetch every one on open — and twice, when a phone card and a desktop row
   * both carry it, because the hidden copy of an eager image still loads.
   */
  lazy?: boolean;
  onError?: () => void;
  /**
   * Fires on the THUMBNAIL once the browser has the pixels. Threaded through for the one caller
   * that measures the frame it just loaded (outstation evidence: is this photo black?), rather
   * than having that caller drop back to a bare <img> and lose the tap-to-zoom.
   */
  onLoad?: (event: { currentTarget: HTMLImageElement }) => void;
  /**
   * Draw ↺ ↻ on the photo and in the full-screen view, a quarter turn each (owner, 2026-10-17: some
   * timetables were photographed sideways). The photo then FILLS its positioned parent, whole, and
   * `className` no longer sizes it. View only: the stored photograph is never changed. Off by
   * default, so every screen that does not ask keeps its photo exactly as it was.
   */
  rotatable?: boolean;
  src: string;
}) {
  const [open, setOpen] = useState(false);
  // The turn belongs to the thumbnail, so a photo turned on the card opens turned and comes back turned.
  const [turns, setTurns] = useState<QuarterTurns>(0);
  // Portals need a DOM that exists. Rendering the overlay into document.body is what keeps it clear
  // of every `overflow-hidden` card and stacking context it would otherwise be trapped inside.
  // `useHydrated` rather than a setState-in-effect mount flag — the repo's own hook, and the effect
  // form is a lint error here.
  const mounted = useHydrated();
  const turn = (direction: "left" | "right") => setTurns((current) => turnPhoto(current, direction));

  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- signed private-bucket URLs and in-memory blobs; see the file header
    <img
      alt={alt}
      aria-hidden={ariaHidden ? "true" : undefined}
      className={cn(className, "cursor-zoom-in")}
      loading={lazy ? "lazy" : undefined}
      onClick={(event) => {
        // A photo often sits inside a clickable row or a link. Opening the viewer must not also
        // fire that row's own action.
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }}
      onError={onError}
      onLoad={onLoad}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }}
      role={ariaHidden ? undefined : "button"}
      src={src}
      style={rotatable ? turnedFillStyle(turns) : undefined}
      tabIndex={ariaHidden ? -1 : 0}
    />
  );

  return (
    <>
      {rotatable ? (
        // The frame fills the positioned box the caller drew, and is what a turned photo is measured against.
        <span className="absolute inset-0 block overflow-hidden" style={TURNABLE_FRAME_STYLE}>
          {image}
          <span className="absolute right-1 top-1 flex gap-0.5">
            {(["left", "right"] as const).map((direction) => (
              <button
                aria-label={direction === "left" ? "Turn the photo left" : "Turn the photo right"}
                className="inline-flex h-7 w-7 items-center justify-center bg-slate-900/70 text-white transition hover:bg-slate-900"
                key={direction}
                onClick={(event) => {
                  // The photo sits in a card and the button sits on the photo: turning opens nothing.
                  event.preventDefault();
                  event.stopPropagation();
                  turn(direction);
                }}
                type="button"
              >
                {direction === "left" ? <RotateCcwSquare aria-hidden className="h-3.5 w-3.5" /> : <RotateCwSquare aria-hidden className="h-3.5 w-3.5" />}
              </button>
            ))}
          </span>
        </span>
      ) : (
        image
      )}
      {open && mounted
        ? createPortal(
          <PhotoLightbox
            alt={alt}
            caption={caption}
            onClose={() => setOpen(false)}
            onTurn={rotatable ? turn : undefined}
            src={src}
            turns={rotatable ? turns : 0}
          />,
          document.body,
        )
        : null}
    </>
  );
}

/** The affordance to put beside a thumbnail so it is obvious the photo opens. */
export function ZoomHint({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none inline-flex items-center gap-1 bg-slate-900/70 px-1.5 py-0.5 text-phx-2xs font-black text-white",
        className,
      )}
    >
      <Maximize2 className="h-3 w-3" />
      Tap to zoom
    </span>
  );
}
