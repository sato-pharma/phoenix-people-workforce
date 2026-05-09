import { LoadingSpinner } from "@/components/ui/loading-state";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f7fb]">
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner className="h-10 w-10 text-orange-500" />
        <p className="text-sm font-medium text-slate-500 animate-pulse">
          Loading Phoenix Workforce...
        </p>
      </div>
    </div>
  );
}
