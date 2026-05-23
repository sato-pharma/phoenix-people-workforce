"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect } from "react";

import { documentTitleForPathname } from "@/lib/page-title";

export function PageTitleSync() {
  const pathname = usePathname();

  useLayoutEffect(() => {
    const expectedTitle = documentTitleForPathname(pathname);

    function syncTitle() {
      if (document.title !== expectedTitle) {
        document.title = expectedTitle;
      }
    }

    syncTitle();

    const observer = new MutationObserver(syncTitle);
    observer.observe(document.head, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    const frame = window.requestAnimationFrame(syncTitle);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
