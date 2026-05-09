"use client";

import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";

type ClickBurst = {
  id: number;
  x: number;
  y: number;
};

export function EmployeePortalEffects({ children }: { children: ReactNode }) {
  const [bursts, setBursts] = useState<ClickBurst[]>([]);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    const clickable = target?.closest("a, button, [role='button'], input[type='submit']");
    if (!clickable) return;
    if (clickable instanceof HTMLButtonElement && clickable.disabled) return;

    const id = Date.now() + Math.round(Math.random() * 1000);
    setBursts((current) => [...current.slice(-7), { id, x: event.clientX, y: event.clientY }]);
    window.setTimeout(() => {
      setBursts((current) => current.filter((burst) => burst.id !== id));
    }, 900);
  }

  return (
    <div className="employee-portal-motion-root" onClick={handleClick}>
      {children}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[80] overflow-hidden">
        {bursts.map((burst) => (
          <span
            className="employee-click-burst"
            key={burst.id}
            style={{
              left: burst.x,
              top: burst.y,
            }}
          >
            <span className="employee-click-spark employee-click-spark-1" />
            <span className="employee-click-spark employee-click-spark-2" />
            <span className="employee-click-spark employee-click-spark-3" />
            <span className="employee-click-spark employee-click-spark-4" />
            <span className="employee-click-spark employee-click-spark-5" />
            <span className="employee-click-spark employee-click-spark-6" />
          </span>
        ))}
      </div>
    </div>
  );
}
