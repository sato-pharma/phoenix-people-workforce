import Image from "next/image";

import { cn } from "@/lib/utils";

type PhoenixLogoProps = {
  compact?: boolean;
  className?: string;
};

export function PhoenixLogo({ compact = false, className }: PhoenixLogoProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-primary/10 ring-1 ring-primary/15">
        <Image
          alt="Phoenix Workforce logo"
          className="h-8 w-8 object-contain"
          height={32}
          priority
          src="/brand/phoenix-logo-reference.png"
          width={32}
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
