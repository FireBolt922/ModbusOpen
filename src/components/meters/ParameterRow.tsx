import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { FormatPicker } from "@/components/FormatPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fromWire, toWire, type AddressBase } from "@/lib/addressing";
import type {
  FunctionCode,
  MeterPoint,
  MeterPointGroup,
  TagBehavior,
} from "@/lib/types";
import {
  applyValueKind,
  matchValueKind,
  registerSpan,
  VALUE_KINDS,
} from "@/lib/valueKinds";

const GROUPS: { value: MeterPointGroup; label: string }[] = [
  { value: "instantaneous", label: "Live reading" },
  { value: "energy", label: "Energy / totaliser" },
  { value: "harmonics", label: "Harmonics" },
  { value: "diagnostics", label: "Diagnostics" },
  { value: "other", label: "Other" },
];

const BEHAVIORS: { value: TagBehavior["kind"] | "none"; label: string }[] = [
  { value: "none", label: "Not simulated" },
  { value: "random", label: "Random in a range" },
  { value: "static", label: "Fixed value" },
  { value: "ramp", label: "Ramp up and down" },
  { value: "sine", label: "Sine wave" },
  { value: "counter", label: "Counts up" },
];

function defaultBehaviorFor(kind: TagBehavior["kind"]): TagBehavior {
  switch (kind) {
    case "static":
      return { kind: "static" };
    case "random":
      return { kind: "random", min: 0, max: 100 };
    case "ramp":
      return { kind: "ramp", min: 0, max: 100, step: 1 };
    case "sine":
      return { kind: "sine", min: 0, max: 100, periodS: 10 };
    case "counter":
      return { kind: "counter", step: 1 };
  }
}

type Props = {
  point: MeterPoint;
  base: AddressBase;
  defaultFunction: FunctionCode;
  /** "address" is the parameters step; "simulation" is the last step. */
  mode?: "address" | "simulation";
  onChange: (patch: Partial<MeterPoint>) => void;
  onRemove: () => void;
};

/**
 * One parameter, as a compact row that expands.
 *
 * The row carries only what someone with a datasheet needs — what it is, where
 * it lives, how it reads. Word order, scale, key and per-parameter function
 * code are real and occasionally essential, so they stay one disclosure away
 * rather than gone.
 */
export function ParameterRow({
  point,
  base,
  defaultFunction,
  mode = "address",
  onChange,
  onRemove,
}: Props) {
  const [open, setOpen] = useState(false);
  const kind = matchValueKind(point.format);
  const span = registerSpan(point.format);
  const b = point.simBehavior;

  return (
    <div className="rounded-lg border border-border">
      <div className="grid grid-cols-1 items-center gap-2 p-3 sm:grid-cols-[minmax(9rem,1.4fr)_8rem_minmax(10rem,1.2fr)_2.5rem] sm:gap-x-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs sm:hidden">Parameter</Label>
          <Input
            className="h-9"
            value={point.label}
            placeholder="Voltage L-N"
            onChange={(e) => {
              const label = e.target.value;
              // Keep the key in step with the name while it's still a
              // placeholder, so nobody has to think about keys at all.
              const autoKey =
                label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") ||
                "parameter";
              onChange({ label, key: autoKey });
            }}
          />
        </div>

        {mode === "address" ? (
          <div className="flex flex-col gap-1">
            <Label className="text-xs sm:hidden">Address</Label>
            <NumberInput
              min={0}
              max={65535 + 40001}
              value={fromWire(point.address, base)}
              onChange={(v) => onChange({ address: toWire(v, base) })}
            />
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            at {fromWire(point.address, base)}
          </div>
        )}

        {mode === "address" ? (
          <div className="flex flex-col gap-1">
            <Label className="text-xs sm:hidden">Reads as</Label>
            <Select
              value={kind?.id ?? "__custom"}
              onValueChange={(v) => {
                const next = VALUE_KINDS.find((k) => k.id === v);
                if (next) onChange({ format: applyValueKind(point.format, next) });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VALUE_KINDS.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.label}
                  </SelectItem>
                ))}
                {!kind && (
                  <SelectItem value="__custom">
                    {point.format.dataType} (advanced)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Select
              value={b?.kind ?? "none"}
              onValueChange={(v) =>
                onChange(
                  v === "none"
                    ? { simBehavior: undefined }
                    : { simBehavior: defaultBehaviorFor(v as TagBehavior["kind"]) },
                )
              }
            >
              <SelectTrigger className="h-9" aria-label="Simulation behaviour">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEHAVIORS.map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {mode === "address" && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {point.unit ? `${point.unit} · ` : ""}
          {span} register{span > 1 ? "s" : ""}
          {base !== "zeroBased" && ` · wire ${point.address}`}
          {kind ? "" : " · advanced format"}
        </p>
      )}

      {mode === "simulation" && b && (
        <div className="grid gap-2 px-3 pb-3 sm:grid-cols-3">
          {b.kind === "static" && (
            <Field
              label={`Value${point.unit ? ` (${point.unit})` : ""}`}
              value={point.simInitial ?? 0}
              onChange={(v) => onChange({ simInitial: v })}
            />
          )}
          {(b.kind === "random" || b.kind === "ramp" || b.kind === "sine") && (
            <>
              <Field
                label={`Min${point.unit ? ` (${point.unit})` : ""}`}
                value={b.min}
                onChange={(v) => onChange({ simBehavior: { ...b, min: v } })}
              />
              <Field
                label={`Max${point.unit ? ` (${point.unit})` : ""}`}
                value={b.max}
                onChange={(v) => onChange({ simBehavior: { ...b, max: v } })}
              />
            </>
          )}
          {(b.kind === "ramp" || b.kind === "counter") && (
            <Field
              label="Step per tick"
              value={b.step}
              onChange={(v) => onChange({ simBehavior: { ...b, step: v } })}
            />
          )}
          {b.kind === "sine" && (
            <Field
              label="Period (s)"
              value={b.periodS}
              min={0}
              onChange={(v) => onChange({ simBehavior: { ...b, periodS: v } })}
            />
          )}
          {b.kind === "counter" && (
            <Field
              label="Start at"
              value={point.simInitial ?? 0}
              onChange={(v) => onChange({ simInitial: v })}
            />
          )}
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Unit</Label>
              <Input
                className="h-8"
                value={point.unit}
                placeholder="V"
                onChange={(e) => onChange({ unit: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Category</Label>
              <Select
                value={point.group}
                onValueChange={(v) => onChange({ group: v as MeterPointGroup })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GROUPS.map((g) => (
                    <SelectItem key={g.value} value={g.value}>
                      {g.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Read with</Label>
              <Select
                value={point.function ?? "__default"}
                onValueChange={(v) =>
                  onChange({
                    function: v === "__default" ? undefined : (v as FunctionCode),
                  })
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default">
                    Same as the meter (
                    {defaultFunction === "read_input_registers" ? "FC04" : "FC03"})
                  </SelectItem>
                  <SelectItem value="read_holding_registers">
                    Holding registers (FC03)
                  </SelectItem>
                  <SelectItem value="read_input_registers">
                    Input registers (FC04)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <FormatPicker
            format={point.format}
            onChange={(format) => onChange({ format })}
          />

          <div className="flex items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Key (used in exports)</Label>
              <Input
                className="h-8 w-56 font-mono text-xs"
                value={point.key}
                onChange={(e) =>
                  onChange({
                    key: e.target.value.toLowerCase().replace(/\s+/g, "_"),
                  })
                }
              />
            </div>
            <Button variant="outline" size="sm" onClick={onRemove}>
              Remove parameter
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <NumberInput allowDecimal min={min} value={value} onChange={onChange} />
    </div>
  );
}
