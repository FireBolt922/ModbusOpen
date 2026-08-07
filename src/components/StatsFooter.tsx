import type { PollStats } from "@/lib/types";
import { formatLatency, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";

type Props = {
  stats: PollStats;
  lastError: string | null;
};

export function StatsFooter({ stats, lastError }: Props) {
  const error = lastError ?? stats.lastError;
  const hasError = Boolean(error);

  return (
    <footer className="flex flex-col gap-1 border-t border-border bg-muted/30 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-muted-foreground">
        <span>
          TX {stats.txCount.toLocaleString()} · RX{" "}
          {stats.rxCount.toLocaleString()} · Err{" "}
          <span className={cn(stats.errorCount + stats.timeoutCount > 0 && "text-destructive")}>
            {(stats.errorCount + stats.timeoutCount).toLocaleString()}
          </span>
        </span>
        <span>
          {formatLatency(stats.latencyMinMs)} / {formatLatency(stats.latencyAvgMs)}{" "}
          / {formatLatency(stats.latencyMaxMs)}
        </span>
        <span>{formatRate(stats.actualRateHz)}</span>
        {!hasError && <span className="text-muted-foreground">no errors</span>}
      </div>
      {hasError && (
        <p className="text-sm text-destructive" role="status">
          {error}
        </p>
      )}
    </footer>
  );
}
