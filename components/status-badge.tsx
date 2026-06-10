import { cn } from "@/lib/utils";
import type { RowState, RunStatus } from "@/lib/types";

type AnyStatus = RunStatus | RowState | string | null | undefined;

const STYLES: Record<string, { dot: string; chip: string; label: string }> = {
  // Row outcomes (CLAUDE.md §3)
  PAID: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "Paid",
  },
  PARTIAL: {
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    label: "Partial",
  },
  UNPAID: {
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-800 border-amber-200",
    label: "Unpaid",
  },
  DELINQUENT: {
    dot: "bg-red-500",
    chip: "bg-red-50 text-red-700 border-red-200",
    label: "Delinquent",
  },
  NEEDS_REVIEW: {
    dot: "bg-violet-500",
    chip: "bg-violet-50 text-violet-700 border-violet-200",
    label: "Needs review",
  },
  UNREACHABLE: {
    dot: "bg-neutral-400",
    chip: "bg-neutral-100 text-neutral-600 border-neutral-200",
    label: "Unreachable",
  },
  // Row processing states
  pending: {
    dot: "bg-neutral-300",
    chip: "bg-neutral-50 text-neutral-500 border-neutral-200",
    label: "Pending",
  },
  in_progress: {
    dot: "bg-blue-600 animate-pulse",
    chip: "bg-blue-50 text-blue-700 border-blue-200",
    label: "Checking…",
  },
  // Run statuses
  queued: {
    dot: "bg-neutral-400",
    chip: "bg-neutral-100 text-neutral-600 border-neutral-200",
    label: "Queued",
  },
  running: {
    dot: "bg-blue-600 animate-pulse",
    chip: "bg-blue-50 text-blue-700 border-blue-200",
    label: "Running",
  },
  writing_back: {
    dot: "bg-blue-600 animate-pulse",
    chip: "bg-blue-50 text-blue-700 border-blue-200",
    label: "Writing back",
  },
  done: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "Done",
  },
  done_with_errors: {
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 border-amber-200",
    label: "Done (review)",
  },
  failed: {
    dot: "bg-red-500",
    chip: "bg-red-50 text-red-700 border-red-200",
    label: "Failed",
  },
  canceled: {
    dot: "bg-neutral-400",
    chip: "bg-neutral-100 text-neutral-600 border-neutral-200",
    label: "Canceled",
  },
};

const FALLBACK = {
  dot: "bg-neutral-300",
  chip: "bg-neutral-50 text-neutral-500 border-neutral-200",
  label: "—",
};

export function StatusBadge({
  status,
  className,
}: {
  status: AnyStatus;
  className?: string;
}) {
  const s = (status && STYLES[status]) || {
    ...FALLBACK,
    label: status ?? "—",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        s.chip,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}
