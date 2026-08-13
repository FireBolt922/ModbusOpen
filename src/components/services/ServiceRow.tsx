import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  TONE_DOT,
  TONE_TEXT,
  exists,
  formatClock,
  formatRemaining,
  isBusy,
  isOperatorHeld,
  isRunning,
  serviceLabel,
  serviceTone,
} from "@/lib/serviceState";
import type { ServiceStatus } from "@/lib/types";

type Props = {
  service: ServiceStatus;
  busy: boolean;
  /** Ticking clock, owned by the list — one interval for the whole screen
   *  rather than one per row. */
  now: number;
  onStart: () => void;
  onStop: () => void;
  onLogs: () => void;
  onKeepStopped: () => void;
};

export function ServiceRow({
  service,
  busy,
  now,
  onStart,
  onStop,
  onLogs,
  onKeepStopped,
}: Props) {
  const tone = serviceTone(service);
  const running = isRunning(service);
  const installed = exists(service);
  const held = isOperatorHeld(service);
  const transitioning = isBusy(service);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
      <span
        className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])}
        aria-hidden="true"
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="break-all font-mono text-sm" title={service.unit}>
          {service.unit}
        </span>
        {service.description && (
          <span className="text-xs text-muted-foreground">
            {service.description}
          </span>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end">
        <span className={cn("text-xs font-medium", TONE_TEXT[tone])}>
          {serviceLabel(service)}
        </span>

        {service.autoStartAt && !held && (
          <span className="text-[0.7rem] text-amber-500 tabular-nums">
            Starts again at {formatClock(service.autoStartAt)} ·{" "}
            {formatRemaining(service.autoStartAt, now)}
          </span>
        )}
        {held && (
          <span className="text-[0.7rem] text-muted-foreground">
            Disabled — stays down
          </span>
        )}
      </div>

      <div className="flex shrink-0 gap-1">
        {!installed ? (
          <span className="px-2 text-xs text-muted-foreground">
            Check the name on Configure
          </span>
        ) : running ? (
          <Button
            variant="outline"
            size="xs"
            onClick={onStop}
            disabled={busy || transitioning}
          >
            Stop
          </Button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            onClick={onStart}
            disabled={busy || transitioning}
          >
            Start
          </Button>
        )}

        {installed && !running && (
          <Button variant="ghost" size="xs" onClick={onKeepStopped}>
            {held ? "Re-enable" : "Keep stopped"}
          </Button>
        )}

        <Button
          variant="ghost"
          size="xs"
          onClick={onLogs}
          disabled={!installed}
        >
          Logs
        </Button>
      </div>
    </div>
  );
}
