import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FormatPicker } from "@/components/FormatPicker";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { errorMessage, simStart } from "@/lib/ipc";
import type { TagBehavior } from "@/lib/types";
import {
  useSimulatorStore,
  DEFAULT_SLAVE_CONFIG,
} from "@/store/simulatorStore";

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

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  allowDecimal,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  allowDecimal?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <NumberInput
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        allowDecimal={allowDecimal}
      />
    </div>
  );
}

function TagRow({ unitId, index }: { unitId: number; index: number }) {
  const tag = useSimulatorStore((s) =>
    s.config.slaves.find((sl) => sl.unitId === unitId)?.tags[index],
  );
  const updateTag = useSimulatorStore((s) => s.updateTag);
  const removeTag = useSimulatorStore((s) => s.removeTag);
  if (!tag) return null;

  const patch = (p: Partial<typeof tag>) => updateTag(unitId, index, p);
  const b = tag.behavior;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Name</Label>
          <Input
            className="h-8"
            value={tag.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        <NumberField
          label="Address"
          value={tag.address}
          min={0}
          max={65535}
          onChange={(v) => patch({ address: v })}
        />
        <div className="col-span-2">
          <FormatPicker
            format={tag.format}
            onChange={(format) => patch({ format })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Behavior</Label>
          <Select
            value={b.kind}
            onValueChange={(v) =>
              patch({
                behavior: defaultBehaviorFor(v as TagBehavior["kind"]),
              })
            }
          >
            <SelectTrigger aria-label="Tag behavior">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="static">Static</SelectItem>
              <SelectItem value="random">Random</SelectItem>
              <SelectItem value="ramp">Ramp</SelectItem>
              <SelectItem value="sine">Sine</SelectItem>
              <SelectItem value="counter">Counter</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {b.kind === "static" && (
          <NumberField
            label="Value"
            value={tag.initialValue}
            allowDecimal
            onChange={(v) => patch({ initialValue: v })}
          />
        )}

        {(b.kind === "random" || b.kind === "ramp" || b.kind === "sine") && (
          <>
            <NumberField
              label="Min"
              value={b.min}
              allowDecimal
              onChange={(v) => patch({ behavior: { ...b, min: v } })}
            />
            <NumberField
              label="Max"
              value={b.max}
              allowDecimal
              onChange={(v) => patch({ behavior: { ...b, max: v } })}
            />
          </>
        )}
        {b.kind === "ramp" && (
          <NumberField
            label="Step"
            value={b.step}
            allowDecimal
            onChange={(v) => patch({ behavior: { ...b, step: v } })}
          />
        )}
        {b.kind === "sine" && (
          <NumberField
            label="Period (s)"
            value={b.periodS}
            min={0}
            allowDecimal
            onChange={(v) => patch({ behavior: { ...b, periodS: v } })}
          />
        )}
        {b.kind === "counter" && (
          <NumberField
            label="Step"
            value={b.step}
            allowDecimal
            onChange={(v) => patch({ behavior: { ...b, step: v } })}
          />
        )}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="self-end text-destructive"
        onClick={() => removeTag(unitId, index)}
      >
        Remove tag
      </Button>
    </div>
  );
}

function SlaveRow({
  unitId,
  onChange,
  onRemove,
  removable,
}: {
  unitId: number;
  onChange: (patch: Partial<typeof DEFAULT_SLAVE_CONFIG>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const slave = useSimulatorStore((s) =>
    s.config.slaves.find((sl) => sl.unitId === unitId),
  );
  const addTag = useSimulatorStore((s) => s.addTag);
  if (!slave) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="flex flex-col gap-1.5">
          <Label>Unit ID</Label>
          <NumberInput
            min={1}
            max={247}
            value={slave.unitId}
            onChange={(unitId) => onChange({ unitId })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Coils</Label>
          <NumberInput
            min={0}
            max={2000}
            value={slave.coilCount}
            onChange={(coilCount) => onChange({ coilCount })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Discretes</Label>
          <NumberInput
            min={0}
            max={2000}
            value={slave.discreteCount}
            onChange={(discreteCount) => onChange({ discreteCount })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Input regs</Label>
          <NumberInput
            min={0}
            max={125}
            value={slave.inputRegisterCount}
            onChange={(inputRegisterCount) => onChange({ inputRegisterCount })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Holding regs</Label>
          <NumberInput
            min={0}
            max={125}
            value={slave.holdingRegisterCount}
            onChange={(holdingRegisterCount) =>
              onChange({ holdingRegisterCount })
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">
            Animated tags (holding registers only)
          </Label>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => addTag(slave.unitId)}
          >
            + Add tag
          </Button>
        </div>
        {slave.tags.map((_, i) => (
          <TagRow key={i} unitId={slave.unitId} index={i} />
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="xs"
        className="self-end"
        disabled={!removable}
        onClick={onRemove}
      >
        Remove slave
      </Button>
    </div>
  );
}

export default function SimulatorSetup() {
  const navigate = useNavigate();
  const config = useSimulatorStore((s) => s.config);
  const setConfig = useSimulatorStore((s) => s.setConfig);
  const addSlave = useSimulatorStore((s) => s.addSlave);
  const removeSlave = useSimulatorStore((s) => s.removeSlave);
  const updateSlave = useSimulatorStore((s) => s.updateSlave);
  const starting = useSimulatorStore((s) => s.starting);
  const setStarting = useSimulatorStore((s) => s.setStarting);
  const setInfo = useSimulatorStore((s) => s.setInfo);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStarting(true);
    try {
      const info = await simStart(config);
      setInfo(info);
      navigate("/simulate/workspace");
    } catch (err) {
      setStarting(false);
      setError(errorMessage(err));
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-6 py-12">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          ← Back
        </Button>
        <h1 className="text-lg font-heading font-semibold">
          Simulate — TCP slave
        </h1>
        <div className="w-16" />
      </div>

      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Simulator setup</CardTitle>
          <CardDescription>
            Stand in as a Modbus TCP slave. RTU server mode isn't built yet —
            TCP only for now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleStart}>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sim-port">TCP port</Label>
                <NumberInput
                  id="sim-port"
                  min={1}
                  max={65535}
                  value={config.tcpPort}
                  onChange={(tcpPort) => setConfig({ tcpPort })}
                />
                <p className="text-xs text-muted-foreground">
                  5021 avoids clashing with the local test-rig slave on 5020.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sim-tick">Tag animation tick (ms)</Label>
                <NumberInput
                  id="sim-tick"
                  min={1}
                  max={60000}
                  step={50}
                  value={config.tickMs}
                  onChange={(tickMs) => setConfig({ tickMs })}
                />
                <p className="text-xs text-muted-foreground">
                  Ignored if no slave has any tags.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Label>Slaves</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={addSlave}
                >
                  + Add slave
                </Button>
              </div>
              {config.slaves.map((slave) => (
                <SlaveRow
                  key={slave.unitId}
                  unitId={slave.unitId}
                  onChange={(patch) => updateSlave(slave.unitId, patch)}
                  onRemove={() => removeSlave(slave.unitId)}
                  removable={config.slaves.length > 1}
                />
              ))}
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={starting} className="self-end">
              {starting ? "Starting…" : "Start simulator"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
