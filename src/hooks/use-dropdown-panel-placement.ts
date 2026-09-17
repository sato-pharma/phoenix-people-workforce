"use client";

import { useCallback, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

import { useRepositionOnViewportChange } from "@/hooks/use-reposition-on-viewport-change";
import type { PanelPlacement } from "@/lib/navigation/panel-position";
import { measureDropdownPanel } from "@/lib/ui/dropdown-panel-placement";

/**
 * Keeps a `<details>` dropdown's panel inside the screen and inside `main`. The account, and the
 * arithmetic, are in src/lib/ui/dropdown-panel-placement.ts.
 *
 * Wire all four: `detailsRef` and `onToggle` on the `<details>`, `onSummaryClick` on its `<summary>`,
 * and `panelStyle` on the panel, which must be `absolute left-0`.
 *
 * The placement is measured in the summary's click handler, BEFORE the click opens the details, so
 * the panel is never painted in the wrong place first. `toggle` fires only after the details has
 * opened, and a frame can paint in between. `onToggle` measures again however the details was opened,
 * and a viewport change measures again while it stays open.
 *
 * Until the first measurement `panelStyle` is undefined, and the panel keeps its CSS fallback. Keep
 * that fallback `max-w-full`: no wider than the trigger, which is already on the screen.
 */
export function useDropdownPanelPlacement() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);

  const reposition = useCallback(() => {
    const details = detailsRef.current;
    if (!details) return;
    const next = measureDropdownPanel(
      details,
      document.documentElement.clientWidth,
      (box) => window.getComputedStyle(box as HTMLElement).overflowX,
    );
    setPlacement((current) =>
      current && next && current.offsetLeft === next.offsetLeft && current.width === next.width ? current : next,
    );
  }, []);

  useRepositionOnViewportChange(open, reposition);

  const onSummaryClick = useCallback(() => {
    if (detailsRef.current && !detailsRef.current.open) reposition();
  }, [reposition]);

  const onToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      const isOpen = event.currentTarget.open;
      setOpen(isOpen);
      if (isOpen) reposition();
    },
    [reposition],
  );

  const panelStyle: CSSProperties | undefined = placement
    ? { marginLeft: placement.offsetLeft, maxWidth: "none", width: placement.width }
    : undefined;

  return { detailsRef, onSummaryClick, onToggle, panelStyle };
}
