import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import {
  formatBytesHex,
  formatLatency,
  functionCodeLabel,
} from "@/lib/format";
import type { FrameLogEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 28;
const MAX_FRAMES = 10_000;

type Props = {
  frames: FrameLogEntry[];
  paused: boolean;
  onPauseToggle: () => void;
  onClear: () => void;
  open: boolean;
  onClose: () => void;
};

export function FrameLog({
  frames,
  paused,
  onPauseToggle,
  onClear,
  open,
  onClose,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [filterTx, setFilterTx] = useState(true);
  const [filterRx, setFilterRx] = useState(true);

  const visible = useMemo(
    () =>
      frames.filter(
        (f) =>
          (f.direction === "tx" && filterTx) ||
          (f.direction === "rx" && filterRx),
      ),
    [frames, filterTx, filterRx],
  );

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  if (!open) return null;

  function copyAll() {
    const text = visible
      .map((f) => {
        const dir = f.direction.toUpperCase();
        const t = f.timestamp;
        const hex = formatBytesHex(f.bytes);
        const rtt = f.rttMs != null ? ` rtt=${f.rttMs.toFixed(1)}ms` : "";
        const exc = f.isException ? " EXCEPTION" : "";
        return `${t} ${dir} FC=${f.function.toString(16)}${exc}${rtt}\n  ${hex}`;
      })
      .join("\n");
    void navigator.clipboard.writeText(text);
  }

  function exportTxt() {
    const text = visible
      .map((f) => `${f.direction}\t${formatBytesHex(f.bytes)}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `modbusopen-frames-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex max-h-64 min-h-40 flex-col border-t border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">
          Frame log{" "}
          <span className="text-muted-foreground">
            ({frames.length.toLocaleString()}
            {frames.length >= MAX_FRAMES ? " max" : ""})
          </span>
        </h2>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={filterTx}
            onChange={(e) => setFilterTx(e.target.checked)}
          />
          TX
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={filterRx}
            onChange={(e) => setFilterRx(e.target.checked)}
          />
          RX
        </label>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button variant="outline" size="xs" onClick={onPauseToggle}>
            {paused ? "▶ Resume" : "⏸ Pause"}
          </Button>
          <Button variant="outline" size="xs" onClick={onClear}>
            Clear
          </Button>
          <Button variant="outline" size="xs" onClick={copyAll}>
            Copy
          </Button>
          <Button variant="outline" size="xs" onClick={exportTxt}>
            Export
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose}>
            ✕
          </Button>
        </div>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        {visible.length === 0 ? (
          <p className="p-3 text-muted-foreground">
            No frames yet — start polling or write a register.
          </p>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const f = visible[item.index];
              return (
                <div
                  key={`${f.timestamp}-${item.index}`}
                  className={cn(
                    "absolute top-0 left-0 flex w-full gap-3 border-b border-border/40 px-3",
                    f.isException && "text-destructive",
                    f.direction === "tx"
                      ? "text-sky-300/90"
                      : "text-emerald-300/90",
                  )}
                  style={{
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                    alignItems: "center",
                  }}
                >
                  <span className="w-8 shrink-0 uppercase">{f.direction}</span>
                  <span className="w-36 shrink-0 truncate text-muted-foreground">
                    {functionCodeLabel(f.function)}
                    {f.isException ? " EXC" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {formatBytesHex(f.bytes)}
                  </span>
                  <span className="w-16 shrink-0 text-right text-muted-foreground">
                    {f.rttMs != null ? formatLatency(f.rttMs) : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export { MAX_FRAMES };
