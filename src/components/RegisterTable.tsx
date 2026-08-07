import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DecodedRegister } from "@/lib/types";
import {
  formatAddressSpan,
  formatHoldingSpan,
  formatRawHex,
  formatRegisterValue,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const ROW_HEIGHT = 36;

type Props = {
  rows: DecodedRegister[];
  stale?: boolean;
};

export function RegisterTable({ rows, stale = false }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        No registers yet — start polling or hit Read once.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div className="grid grid-cols-[7rem_7rem_1fr_10rem] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <div>Address</div>
        <div>4x</div>
        <div>Raw (hex)</div>
        <div>Value</div>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={row.address}
                className={cn(
                  "absolute top-0 left-0 grid w-full grid-cols-[7rem_7rem_1fr_10rem] gap-2 border-b border-border/60 px-3 font-mono text-sm",
                  stale && "opacity-50",
                  row.decodeError && "text-destructive",
                )}
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                  alignItems: "center",
                }}
              >
                <div>{formatAddressSpan(row.address, row.span)}</div>
                <div className="text-muted-foreground">
                  {formatHoldingSpan(row.address, row.span)}
                </div>
                <div className="truncate text-muted-foreground">
                  {formatRawHex(row.raw)}
                </div>
                <div className="font-sans font-medium tabular-nums">
                  {formatRegisterValue(row)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
