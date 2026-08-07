import { useEffect, useLayoutEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DataFormat, DecodedRegister, TypedValue } from "@/lib/types";
import {
  formatAddressSpan,
  formatHoldingSpan,
  formatRawHex,
  formatRegisterValue,
} from "@/lib/format";
import { errorMessage, writeTyped } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/*
 * Layout: registers flow down a column, then into the next column to the right,
 * like newspaper text — so a wide window fills with data instead of leaving a
 * screen-width of black to the right of the value column, and you scroll
 * sideways rather than down. A 100-register float32 poll that used to need two
 * screens of vertical scrolling now sits in three columns you can see at once.
 *
 * Everything below is measured in px, not rem: the virtualizer needs concrete
 * pixel sizes for the column track, and mixing units in the two places that
 * have to agree (the estimator and the rendered width) is how columns drift
 * out of alignment.
 */
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 29;
/** gap-x-4 between the four cells of a column. */
const CELL_GAP = 16;
/** px-3 on each side of a column. */
const COLUMN_PADDING = 24;
const W_ADDRESS = 96;
const W_HOLDING = 116;
const W_VALUE = 140;
/** Monospace advance at the 0.8rem row size — 0.6em x 12.8px. */
const HEX_CHAR_PX = 7.7;
/** Enough for the "Raw (hex)" heading to stay on one line. */
const MIN_HEX_PX = 78;

/** Width of the raw-hex cell for the span currently on screen. */
function hexWidth(rows: DecodedRegister[]): number {
  const words = rows[0]?.raw.length ?? 1;
  // formatRawHex: 5 chars per word ("43 67"), joined by two spaces.
  const chars = Math.max(words * 7 - 2, 5);
  return Math.min(Math.max(Math.ceil(chars * HEX_CHAR_PX), MIN_HEX_PX), 420);
}

type Props = {
  rows: DecodedRegister[];
  stale?: boolean;
  unitId: number;
  format: DataFormat;
  /** When true, value cells are double-click editable (holding/input regs). */
  writable?: boolean;
  onWriteError?: (msg: string) => void;
  onWritten?: () => void;
};

function valueToEditText(row: DecodedRegister): string {
  if (row.decodeError) return "";
  switch (row.value.kind) {
    case "bool":
      return row.value.value ? "true" : "false";
    case "int":
    case "uint":
    case "float":
      return String(row.value.value);
    case "text":
      return row.value.value;
    case "invalid":
      return "";
  }
}

function parseEdit(
  text: string,
  format: DataFormat,
): TypedValue | string {
  const t = text.trim();
  if (!t) return "Empty value";
  switch (format.dataType) {
    case "bool":
      if (["1", "true", "on"].includes(t.toLowerCase()))
        return { kind: "bool", value: true };
      if (["0", "false", "off"].includes(t.toLowerCase()))
        return { kind: "bool", value: false };
      return "true/false";
    case "int16":
    case "int32":
    case "int64": {
      const n = Number(t);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return "integer required";
      return { kind: "int", value: n };
    }
    case "uint16":
    case "uint32":
    case "uint64":
    case "hex16":
    case "binary16": {
      const n = t.startsWith("0x") ? parseInt(t, 16) : Number(t);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
        return "non-negative integer";
      return { kind: "uint", value: n };
    }
    case "float32":
    case "float64": {
      const n = Number(t);
      if (!Number.isFinite(n)) return "number required";
      return { kind: "float", value: n };
    }
    case "string":
      return { kind: "text", value: t };
  }
}

/**
 * Height of the scroll viewport, tracked so we know how many rows fit a column.
 *
 * Takes the node itself rather than a ref: the table renders an empty state
 * before the first poll lands, so the scroll element doesn't exist on the mount
 * that would have read `ref.current`. Keying off the node in state re-runs this
 * the moment it appears.
 */
function useViewportHeight(el: HTMLDivElement | null): number {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (!el) return;
    setHeight(el.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      setHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return height;
}

export function RegisterTable({
  rows,
  stale = false,
  unitId,
  format,
  writable = true,
  onWriteError,
  onWritten,
}: Props) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [editAddr, setEditAddr] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  const viewportHeight = useViewportHeight(scrollEl);
  const hexPx = hexWidth(rows);
  const columnWidth =
    W_ADDRESS + W_HOLDING + hexPx + W_VALUE + CELL_GAP * 3 + COLUMN_PADDING;
  const gridTemplateColumns = `${W_ADDRESS}px ${W_HOLDING}px ${hexPx}px ${W_VALUE}px`;

  // One column holds as many rows as the viewport can show without scrolling
  // vertically. Until the ResizeObserver has measured (first paint), fall back
  // to a single tall column rather than guessing a row count and reflowing.
  const rowsPerColumn = Math.max(
    1,
    viewportHeight > 0
      ? Math.floor((viewportHeight - HEADER_HEIGHT) / ROW_HEIGHT)
      : rows.length,
  );
  const columnCount = Math.max(1, Math.ceil(rows.length / rowsPerColumn));

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: columnCount,
    getScrollElement: () => scrollEl,
    estimateSize: () => columnWidth,
    overscan: 2,
  });

  // A vertical wheel gesture has nothing to scroll here, so send it sideways —
  // otherwise a plain mouse wheel (no horizontal axis) can't reach column two
  // at all. Trackpad horizontal gestures fall through to the browser untouched.
  useEffect(() => {
    if (!scrollEl) return;
    function onWheel(e: WheelEvent) {
      if (!scrollEl) return;
      if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (scrollEl.scrollWidth <= scrollEl.clientWidth) return;
      e.preventDefault();
      scrollEl.scrollLeft += e.deltaY;
    }
    scrollEl.addEventListener("wheel", onWheel, { passive: false });
    return () => scrollEl.removeEventListener("wheel", onWheel);
  }, [scrollEl]);

  async function commitEdit(row: DecodedRegister) {
    const parsed = parseEdit(editText, format);
    if (typeof parsed === "string") {
      onWriteError?.(parsed);
      return;
    }
    setSaving(true);
    try {
      await writeTyped(unitId, row.address, parsed, format);
      setEditAddr(null);
      onWritten?.();
    } catch (err) {
      onWriteError?.(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        No registers yet — start polling or hit Read once.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div
        ref={setScrollEl}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        <div
          className="relative h-full"
          style={{ width: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((column) => {
            const start = column.index * rowsPerColumn;
            const slice = rows.slice(start, start + rowsPerColumn);
            return (
              <div
                key={column.index}
                className={cn(
                  "absolute top-0 left-0 h-full",
                  column.index > 0 && "border-l border-border",
                )}
                style={{
                  width: column.size,
                  transform: `translateX(${column.start}px)`,
                }}
              >
                {/* Each column carries its own header — you shouldn't have to
                    scroll back to column one to remember what a cell is. */}
                <div
                  className="grid gap-x-4 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.65rem] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase"
                  style={{ gridTemplateColumns }}
                >
                  <div>Address</div>
                  <div>4x</div>
                  <div>Raw (hex)</div>
                  <div>Value{writable ? " (dbl-click)" : ""}</div>
                </div>

                {slice.map((row, i) => {
                  const editing = editAddr === row.address;
                  const display = formatRegisterValue(row);
                  return (
                    <div
                      key={row.address}
                      className={cn(
                        "grid items-center gap-x-4 px-3 font-mono text-[0.8rem] tabular-nums",
                        // Zebra instead of a rule per row: at 28px the borders
                        // out-shouted the numbers they were separating. Striping
                        // by position-in-column keeps the bands lined up across
                        // columns.
                        i % 2 === 1 && "bg-muted/20",
                        stale && "opacity-50",
                        row.decodeError && "text-destructive",
                      )}
                      style={{ gridTemplateColumns, height: ROW_HEIGHT }}
                    >
                      <div>{formatAddressSpan(row.address, row.span)}</div>
                      <div className="text-muted-foreground">
                        {formatHoldingSpan(row.address, row.span)}
                      </div>
                      <div className="truncate text-muted-foreground">
                        {formatRawHex(row.raw)}
                      </div>
                      <div className="min-w-0 font-sans font-medium">
                        {editing ? (
                          <input
                            className="h-6 w-full rounded border border-ring bg-background px-1 text-[0.8rem]"
                            autoFocus
                            disabled={saving}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onBlur={() => {
                              if (!saving) setEditAddr(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitEdit(row);
                              if (e.key === "Escape") setEditAddr(null);
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className={cn(
                              "w-full truncate text-left",
                              writable && "hover:underline",
                            )}
                            disabled={!writable}
                            title={
                              row.decodeError
                                ? display
                                : writable
                                  ? "Double-click to write"
                                  : undefined
                            }
                            onDoubleClick={() => {
                              if (!writable) return;
                              setEditAddr(row.address);
                              setEditText(valueToEditText(row));
                            }}
                          >
                            {display}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
