import { useRef, useState } from "react";
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

const ROW_HEIGHT = 36;

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

export function RegisterTable({
  rows,
  stale = false,
  unitId,
  format,
  writable = true,
  onWriteError,
  onWritten,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [editAddr, setEditAddr] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

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
      <div className="grid grid-cols-[7rem_7rem_1fr_10rem] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <div>Address</div>
        <div>4x</div>
        <div>Raw (hex)</div>
        <div>Value{writable ? " (dbl-click)" : ""}</div>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const editing = editAddr === row.address;
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
                  {editing ? (
                    <input
                      className="h-7 w-full rounded border border-ring bg-background px-1 text-sm"
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
                        "w-full text-left",
                        writable && "hover:underline",
                      )}
                      disabled={!writable}
                      title={writable ? "Double-click to write" : undefined}
                      onDoubleClick={() => {
                        if (!writable) return;
                        setEditAddr(row.address);
                        setEditText(valueToEditText(row));
                      }}
                    >
                      {formatRegisterValue(row)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
