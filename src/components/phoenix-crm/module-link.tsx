"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { preloadPhoenixCrmTab } from "@/components/phoenix-crm/tab-preload";
import type { PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";

/**
 * A chooser card's link: the one piece of the chooser that runs in the browser.
 *
 * At the TOUCH (or the hover, or the keyboard's focus) it starts both halves of the module page —
 * the page itself, through `unstable_dynamicOnHover`, and the module's screen, through
 * `preloadPhoenixCrmTab` — so by the time the tap lands the two are already on their way, and they
 * travel side by side instead of one after the other (owner, 2026-10-01: "slow to transfer between
 * page and page", Phoenix CRM first).
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
    <Link className={className} href={href} onFocus={warm} onPointerDown={warm} onPointerEnter={warm} unstable_dynamicOnHover>
      {children}
    </Link>
  );
}
