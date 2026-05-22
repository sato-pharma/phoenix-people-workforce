"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { documentTitleForPathname } from "@/lib/page-title";

export function PageTitleSync() {
  const pathname = usePathname();

  useEffect(() => {
    document.title = documentTitleForPathname(pathname);
  }, [pathname]);

  return null;
}
