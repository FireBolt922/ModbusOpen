import type { PollStats } from "@/lib/types";
import { formatLatency, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Props = {
  stats: PollStats;
  /** Failures since the last good response. */
  consecutiveErrors?: number;
  className?: string;
};

/**
 * One bad cycle happens on any real bus. Three in a row means the device
 * stopped answering, and the whole counter row goes red so it's visible from
 * across the room.
 */
const ALARM_AFTER_ERRORS = 3;

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
export function StatsBar({ stats, consecutiveErrors = 0, className }: Props) {
  const errors = stats.errorCount + stats.timeoutCount;
  const alarming = consecutiveErrors >= ALARM_AFTER_ERRORS;

  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1",
        // The per-stat spans set their own muted colors; override them all so
        // the row reads as one alarm rather than a half-red patchwork.
        alarming &&
          "animate-pulse border-destructive/70 bg-destructive/15 [&_span]:text-destructive",
        className,
      )}
      role="status"
      aria-live="off"
      title={
        alarming
          ? `${consecutiveErrors} consecutive failures — no response from the device`
          : undefined
      }
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
