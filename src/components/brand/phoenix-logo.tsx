import Image from "next/image";

import { cn } from "@/lib/utils";

type PhoenixLogoProps = {
  compact?: boolean;
  className?: string;
};

export function PhoenixLogo({ compact = false, className }: PhoenixLogoProps) {
  const iconSize = compact ? "h-11 w-11" : "h-12 w-12";
  const imageSize = compact ? "h-9 w-9" : "h-10 w-10";

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border/80",
          "dark:bg-white dark:ring-white/20",
          iconSize,
        )}
      >
        <Image
          alt="Phoenix Workforce logo"
          className={cn("object-contain", imageSize)}
          height={40}
          priority
          src="/brand/phoenix-bird-icon.png"
          width={40}
        />
      </div>
      {!compact ? (
        <div>
          <div className="text-sm font-semibold tracking-[0.28em] text-text">
            PHOENIX
          </div>
          <div className="text-[10px] font-semibold tracking-[0.34em] text-primary">
            WORKFORCE
          </div>
        </div>
      ) : null}
    </div>
  );
}
