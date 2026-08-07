import type { PollStats } from "@/lib/types";
import { formatLatency, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Props = {
  stats: PollStats;
  className?: string;
};

function Stat({
  label,
  children,
  className,
  title,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <span className="text-[0.65rem] tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className={cn("font-mono text-xs tabular-nums", className)}>
        {children}
      </span>
    </div>
  );
}

/**
 * Live counters for the current poll session. Lives in the top bar, not a
 * footer: TX/RX/Err is the first thing you look at when a device goes quiet,
 * and it shouldn't be the furthest thing from the controls that caused it.
 */
export function StatsBar({ stats, className }: Props) {
  const errors = stats.errorCount + stats.timeoutCount;

  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1",
        className,
      )}
      role="status"
      aria-live="off"
    >
      <Stat label="TX">{stats.txCount.toLocaleString()}</Stat>
      <Stat label="RX">{stats.rxCount.toLocaleString()}</Stat>
      <Stat
        label="Err"
        className={cn(errors > 0 ? "text-destructive" : "text-muted-foreground")}
        title={`${stats.errorCount} exception/protocol · ${stats.timeoutCount} timeout`}
      >
        {errors.toLocaleString()}
      </Stat>
      <Stat
        label="Latency"
        className="text-muted-foreground"
        title="min / avg / max round-trip"
      >
        {formatLatency(stats.latencyMinMs)} / {formatLatency(stats.latencyAvgMs)}{" "}
        / {formatLatency(stats.latencyMaxMs)}
      </Stat>
      <Stat label="Rate" className="text-muted-foreground">
        {formatRate(stats.actualRateHz)}
      </Stat>
    </div>
  );
}
