import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  sub,
  className,
  valueClassName,
}: {
  label: string;
  value: string | number;
  sub?: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <Card className={cn("gap-1 rounded-lg p-4 shadow-none", className)}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          "font-mono text-2xl font-semibold tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </p>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </Card>
  );
}
