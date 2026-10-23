"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { preloadPhoenixCrmTab } from "@/components/phoenix-crm/tab-preload";
import type { PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";

/**
 * A chooser card's link: the one piece of the chooser that runs in the browser.
 *
 * At the TOUCH (or the hover, or the keyboard's focus) it starts downloading the module's screen,
 * through `preloadPhoenixCrmTab` — browser code only, nothing the server has to build — so the tap
 * finds it already on its way (owner, 2026-10-01: "slow to transfer between page and page", Phoenix
 * CRM first). It deliberately does NOT prefetch the module PAGE on touch (`unstable_dynamicOnHover`):
 * that built the whole page on the server for every card a finger or a mouse crossed, and the card
 * actually tapped queued behind them (next.config.ts, beside `staleTimes`).
 *
 * The chooser stays a server component around it: it renders these links and nothing else ships.
 */
export function PhoenixCrmModuleLink({
  children,
  className,
  href,
  moduleKey,
}: {
  children: ReactNode;
  className: string;
  href: string;
  moduleKey: PhoenixCrmModuleKey;
}) {
  const warm = () => preloadPhoenixCrmTab(moduleKey);
  return (
    <Link className={className} href={href} onFocus={warm} onPointerDown={warm} onPointerEnter={warm}>
      {children}
    </Link>
  );
}
