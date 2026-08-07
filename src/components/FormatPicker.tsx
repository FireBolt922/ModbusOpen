import type { DataFormat, DataType, WordOrder } from "@/lib/types";
import { Label } from "@/components/ui/label";

const DATA_TYPES: { value: DataType; label: string }[] = [
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
];

const WORD_ORDERS: { value: WordOrder; label: string }[] = [
  { value: "abcd", label: "ABCD" },
  { value: "cdab", label: "CDAB" },
  { value: "badc", label: "BADC" },
  { value: "dcba", label: "DCBA" },
];

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

const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type Props = {
  format: DataFormat;
  onChange: (format: DataFormat) => void;
  disabled?: boolean;
};

export function FormatPicker({ format, onChange, disabled }: Props) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="data-type" className="text-xs text-muted-foreground">
          Type
        </Label>
        <select
          id="data-type"
          className={selectClass}
          value={format.dataType}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...format,
              dataType: e.target.value as DataType,
            })
          }
        >
          {DATA_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {isMultiRegister(format.dataType) && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="word-order" className="text-xs text-muted-foreground">
            Word order
          </Label>
          <select
            id="word-order"
            className={selectClass}
            value={format.wordOrder}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...format,
                wordOrder: e.target.value as WordOrder,
              })
            }
          >
            {WORD_ORDERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
