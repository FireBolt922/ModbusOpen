import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { useServicesStore } from "@/store/servicesStore";

const ROW_HEIGHT = 18;

type Props = {
  onClose: () => void;
};

/**
 * Live journal for one unit — 200 lines of history, then following.
 *
 * Virtualized like `components/FrameLog.tsx`: a service that logs every reading
 * will produce thousands of rows, and the table rules in AGENTS.md apply here
 * too.
 */
export function LogViewer({ onClose }: Props) {
  const unit = useServicesStore((s) => s.logUnit);
  const lines = useServicesStore((s) => s.logLines);
  const paused = useServicesStore((s) => s.logPaused);
  const setLogPaused = useServicesStore((s) => s.setLogPaused);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Follow the tail. Paused freezes the view; the backend keeps reading, so
  // resuming shows what happened rather than a gap.
  //
  // Scrolls the container directly rather than calling virtualizer.scrollToIndex:
  // the virtualizer instance is a new object every render, so depending on it
  // here would re-run this effect on every render it causes.
  useEffect(() => {
    if (paused || lines.length === 0) return;
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, paused]);

  async function copyAll() {
    await navigator.clipboard.writeText(lines.join("\n"));
  }

  return (
    <div className="flex max-h-80 min-h-48 flex-col border-t border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">
          Logs <span className="font-mono text-muted-foreground">{unit}</span>
        </h2>
        <span className="text-xs text-muted-foreground">
          {lines.length.toLocaleString()} lines
          {paused && " · paused"}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="xs"
            onClick={() => setLogPaused(!paused)}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </Button>
          <Button variant="outline" size="xs" onClick={copyAll}>
            Copy
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close logs">
            ✕
          </Button>
        </div>
      </div>

      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs"
      >
        {lines.length === 0 ? (
          <p className="p-3 text-muted-foreground">
            Waiting for log lines. If this service has never written to the
            journal there may be nothing to show.
          </p>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                className="absolute left-0 flex w-full items-start px-3 whitespace-pre-wrap"
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {lines[item.index]}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
