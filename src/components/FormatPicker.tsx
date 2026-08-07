import { InfoIcon } from "lucide-react";
import type { DataFormat, DataType, WordOrder } from "@/lib/types";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { openExternal } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const DATA_TYPES: { value: DataType; label: string }[] = [
  { value: "bool", label: "bool" },
  { value: "uint16", label: "uint16" },
  { value: "int16", label: "int16" },
  { value: "hex16", label: "hex16" },
  { value: "binary16", label: "binary16" },
  { value: "uint32", label: "uint32" },
  { value: "int32", label: "int32" },
  { value: "float32", label: "float32" },
  { value: "uint64", label: "uint64" },
  { value: "int64", label: "int64" },
  { value: "float64", label: "float64" },
  { value: "string", label: "string" },
];

/**
 * The worked example from docs/reference/data-types-word-order.md: 231.0 as
 * IEEE-754 float32 is 0x43670000, bytes A=43 B=67 C=00 D=00. Showing what each
 * order does to those exact bytes is the fastest way to explain the concept —
 * and it's the same trick the register table's raw-hex column exists for.
 */
const WORD_ORDERS: {
  value: WordOrder;
  label: string;
  wire: string;
  reads: string;
  note: string;
}[] = [
  {
    value: "abcd",
    label: "ABCD",
    wire: "43 67 00 00",
    reads: "231.0",
    note: "Big-endian. High word first — the “standard”.",
  },
  {
    value: "cdab",
    label: "CDAB",
    wire: "00 00 43 67",
    reads: "2.43e-41",
    note: "Word swap. Very common on real meters.",
  },
  {
    value: "badc",
    label: "BADC",
    wire: "67 43 00 00",
    reads: "8.99e+21",
    note: "Byte swap inside each register. Rare.",
  },
  {
    value: "dcba",
    label: "DCBA",
    wire: "00 00 67 43",
    reads: "3.71e-41",
    note: "Full reverse. True little-endian.",
  },
];

/** Vendor-neutral reference, kept out of the component body so it's easy to find. */
const WORD_ORDER_DOCS =
  "https://docs.chipkin.com/articles/modbus-data-types-byte-order-reference/";

function isMultiRegister(t: DataType): boolean {
  return (
    t === "uint32" ||
    t === "int32" ||
    t === "float32" ||
    t === "uint64" ||
    t === "int64" ||
    t === "float64"
  );
}

function WordOrderInfo({ current }: { current: WordOrder }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="What is word order?"
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <p className="text-sm font-medium">Word order</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Modbus never defined how values wider than 16 bits sit across
          registers, so vendors each picked their own. Guess wrong and you get a
          plausible-looking <em>number</em>, not an error.
        </p>
        <p className="mt-2.5 text-xs text-muted-foreground">
          Same bytes, four readings — <code className="font-mono">231.0</code>{" "}
          as float32 is <code className="font-mono">0x43670000</code>:
        </p>
        <div className="mt-1.5 overflow-hidden rounded-md border border-border">
          {WORD_ORDERS.map((o) => (
            <div
              key={o.value}
              className={cn(
                "grid grid-cols-[3.25rem_6.5rem_1fr] items-baseline gap-2 px-2 py-1.5 text-xs",
                o.value !== "dcba" && "border-b border-border/60",
                o.value === current && "bg-accent",
              )}
            >
              <span className="font-mono font-medium">{o.label}</span>
              <span className="font-mono text-muted-foreground">{o.wire}</span>
              <span className="font-mono tabular-nums">{o.reads}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {WORD_ORDERS.find((o) => o.value === current)?.note}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Check the raw hex column against your device's manual — that's what
          it's there for.
        </p>
        <button
          type="button"
          className="mt-2.5 text-xs text-foreground underline underline-offset-4 hover:no-underline"
          onClick={() => void openExternal(WORD_ORDER_DOCS)}
        >
          Full byte-order reference ↗
        </button>
      </PopoverContent>
    </Popover>
  );
}

type Props = {
  format: DataFormat;
  onChange: (format: DataFormat) => void;
  disabled?: boolean;
};

export function FormatPicker({ format, onChange, disabled }: Props) {
  const multi = isMultiRegister(format.dataType);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Type</Label>
        <Select
          value={format.dataType}
          disabled={disabled}
          onValueChange={(v) =>
            onChange({ ...format, dataType: v as DataType })
          }
        >
          <SelectTrigger className="w-28" aria-label="Data type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATA_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {multi && (
        <div className="flex flex-col gap-1">
          <Label className="gap-1.5 text-xs text-muted-foreground">
            Word order
            <WordOrderInfo current={format.wordOrder} />
          </Label>
          <Select
            value={format.wordOrder}
            disabled={disabled}
            onValueChange={(v) =>
              onChange({ ...format, wordOrder: v as WordOrder })
            }
          >
            <SelectTrigger className="w-28" aria-label="Word order">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORD_ORDERS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="font-mono">{o.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
