import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import {
  errorMessage,
  getMeterProfile,
  listMeterProfiles,
  saveMeterProfile,
} from "@/lib/ipc";
import type {
  DataFormat,
  FunctionCode,
  MeterPoint,
  MeterPointGroup,
  MeterProfile,
  MeterSource,
  TagBehavior,
} from "@/lib/types";
import { useMeterStore } from "@/store/meterStore";
import { useScannerStore } from "@/store/scannerStore";

const GROUPS: { value: MeterPointGroup; label: string }[] = [
  { value: "instantaneous", label: "Instantaneous" },
  { value: "energy", label: "Energy" },
  { value: "harmonics", label: "Harmonics" },
  { value: "diagnostics", label: "Diagnostics" },
  { value: "other", label: "Other" },
];

const DEFAULT_FORMAT: DataFormat = {
  dataType: "float32",
  wordOrder: "cdab",
  scale: 1,
  offset: 0,
};

const BEHAVIORS: { value: TagBehavior["kind"] | "none"; label: string }[] = [
  { value: "none", label: "Not simulated" },
  { value: "static", label: "Static" },
  { value: "random", label: "Random" },
  { value: "ramp", label: "Ramp" },
  { value: "sine", label: "Sine" },
  { value: "counter", label: "Counter" },
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

/**
 * A new parameter animates by default.
 *
 * A point with no `simBehavior` produces no simulator tag, so "Load in
 * simulator" would serve a legitimate zero for it — indistinguishable on
 * screen from a simulator that failed to start.
 */
function emptyPoint(): MeterPoint {
  return {
    key: "",
    label: "",
    address: 0,
    format: { ...DEFAULT_FORMAT },
    unit: "",
    group: "instantaneous",
    unverified: true,
    simBehavior: { kind: "random", min: 0, max: 100 },
    simInitial: 0,
  };
}

function emptyProfile(): MeterProfile {
  return {
    id: "",
    brand: "",
    model: "",
    description: "",
    source: { kind: "user" },
    function: "read_holding_registers",
    blockStart: 0,
    blockCount: 10,
    defaultUnitId: 1,
    points: [emptyPoint()],
  };
}

function clientValidate(p: MeterProfile): string | null {
  if (!p.id.trim()) return "Id can't be empty (use a slug like my-meter).";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id))
    return "Id must be lowercase letters, digits, and hyphens.";
  if (!p.brand.trim()) return "Brand can't be empty.";
  if (!p.model.trim()) return "Model can't be empty.";
  if (p.blockCount < 1 || p.blockCount > 125)
    return "Block count must be 1–125 for holding-register reads.";
  if (p.points.length === 0) return "Add at least one parameter.";
  const keys = new Set<string>();
  const end = p.blockStart + p.blockCount;
  for (const pt of p.points) {
    if (!pt.key.trim()) return "Every parameter needs a key.";
    if (keys.has(pt.key)) return `Duplicate parameter key '${pt.key}'.`;
    keys.add(pt.key);
    if (!pt.label.trim()) return `Parameter '${pt.key}' needs a label.`;
    const span =
      pt.format.dataType.includes("64")
        ? 4
        : pt.format.dataType.includes("32") || pt.format.dataType === "float32"
          ? 2
          : 1;
    if (pt.address < p.blockStart || pt.address + span > end) {
      return `Parameter '${pt.key}' at wire ${pt.address} falls outside the block [${p.blockStart}, ${end}).`;
    }
  }
  return null;
}

/**
 * Per-parameter simulator animation.
 *
 * Values here are in engineering units (231.4 V, 0.7 A) — Rust undoes the
 * parameter's own scale before writing the register, so a 0.1-scaled uint16
 * asked for 0.7 stores 7 and reads back as 0.7.
 */
function SimulationFields({
  point,
  onChange,
}: {
  point: MeterPoint;
  onChange: (patch: Partial<MeterPoint>) => void;
}) {
  const b = point.simBehavior;
  const kind = b?.kind ?? "none";

  return (
    <div className="grid items-end gap-2 border-t border-border/60 pt-2 sm:grid-cols-4">
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Simulate as</Label>
        <Select
          value={kind}
          onValueChange={(v) =>
            onChange(
              v === "none"
                ? { simBehavior: undefined }
                : {
                    simBehavior: defaultBehaviorFor(v as TagBehavior["kind"]),
                  },
            )
          }
        >
          <SelectTrigger className="h-8" aria-label="Simulation behavior">
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

      {b?.kind === "static" && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Value</Label>
          <NumberInput
            allowDecimal
            value={point.simInitial ?? 0}
            onChange={(v) => onChange({ simInitial: v })}
          />
        </div>
      )}

      {(b?.kind === "random" || b?.kind === "ramp" || b?.kind === "sine") && (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Min</Label>
            <NumberInput
              allowDecimal
              value={b.min}
              onChange={(v) => onChange({ simBehavior: { ...b, min: v } })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Max</Label>
            <NumberInput
              allowDecimal
              value={b.max}
              onChange={(v) => onChange({ simBehavior: { ...b, max: v } })}
            />
          </div>
        </>
      )}

      {(b?.kind === "ramp" || b?.kind === "counter") && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Step</Label>
          <NumberInput
            allowDecimal
            value={b.step}
            onChange={(v) => onChange({ simBehavior: { ...b, step: v } })}
          />
        </div>
      )}

      {b?.kind === "sine" && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Period (s)</Label>
          <NumberInput
            min={0}
            allowDecimal
            value={b.periodS}
            onChange={(v) => onChange({ simBehavior: { ...b, periodS: v } })}
          />
        </div>
      )}

      {b?.kind === "counter" && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Start at</Label>
          <NumberInput
            allowDecimal
            value={point.simInitial ?? 0}
            onChange={(v) => onChange({ simInitial: v })}
          />
        </div>
      )}
    </div>
  );
}

export default function MeterEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setProfiles = useMeterStore((s) => s.setProfiles);
  const rows = useScannerStore((s) => s.rows);
  const pollConfig = useScannerStore((s) => s.pollConfig);

  const [profile, setProfile] = useState<MeterProfile>(emptyProfile);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = !id || id === "new";

  useEffect(() => {
    if (isNew) {
      setProfile(emptyProfile());
      return;
    }
    void getMeterProfile(id)
      .then(setProfile)
      .catch((err) => setError(errorMessage(err)));
  }, [id, isNew]);

  function patch(p: Partial<MeterProfile>) {
    setProfile((prev) => ({ ...prev, ...p }));
  }

  function patchPoint(index: number, p: Partial<MeterPoint>) {
    setProfile((prev) => {
      const points = prev.points.map((pt, i) =>
        i === index ? { ...pt, ...p } : pt,
      );
      return { ...prev, points };
    });
  }

  function addPoint() {
    setProfile((prev) => ({
      ...prev,
      points: [...prev.points, emptyPoint()],
    }));
  }

  function removePoint(index: number) {
    setProfile((prev) => ({
      ...prev,
      points: prev.points.filter((_, i) => i !== index),
    }));
  }

  function captureFromPoll() {
    if (rows.length === 0) {
      setError("No poll data yet — connect the scanner and read once first.");
      return;
    }
    const points: MeterPoint[] = rows.map((r) => ({
      key: `reg_${r.address}`,
      label: `Register ${r.address}`,
      address: r.address,
      format: { ...pollConfig.format },
      unit: "",
      group: "other" as MeterPointGroup,
      unverified: true,
      simBehavior: { kind: "random" as const, min: 0, max: 100 },
      simInitial: 0,
    }));
    // Only keep first of each address for multi-span already split rows
    const seen = new Set<number>();
    const unique = points.filter((p) => {
      if (seen.has(p.address)) return false;
      seen.add(p.address);
      return true;
    });
    patch({
      blockStart: pollConfig.startAddress,
      blockCount: pollConfig.quantity,
      function: pollConfig.function as FunctionCode,
      defaultUnitId: pollConfig.unitId,
      points: unique.length ? unique : [emptyPoint()],
    });
    setError(null);
  }

  async function handleSave() {
    const msg = clientValidate(profile);
    if (msg) {
      setError(msg);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const source: MeterSource =
        profile.source.kind === "imported"
          ? profile.source
          : { kind: "user" };
      const saved = await saveMeterProfile({ ...profile, source });
      setProfiles(await listMeterProfiles());
      navigate("/meters");
      void saved;
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-heading font-semibold">
            {isNew ? "New meter" : "Edit meter"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Addresses are 0-based wire. Decoding stays in Rust — pick type and
            word order carefully. Each parameter's simulation setting is what
            the simulator animates when you load this meter.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/meters")}>
          Back
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label>Id (slug)</Label>
          <Input
            value={profile.id}
            disabled={!isNew}
            onChange={(e) =>
              patch({ id: e.target.value.toLowerCase().replace(/\s+/g, "-") })
            }
            placeholder="my-custom-meter"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Default unit ID</Label>
          <NumberInput
            min={1}
            max={247}
            value={profile.defaultUnitId}
            onChange={(v) => patch({ defaultUnitId: v })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Brand</Label>
          <Input
            value={profile.brand}
            onChange={(e) => patch({ brand: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Model</Label>
          <Input
            value={profile.model}
            onChange={(e) => patch({ model: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label>Description</Label>
          <Input
            value={profile.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Block start (wire)</Label>
          <NumberInput
            min={0}
            max={65535}
            value={profile.blockStart}
            onChange={(v) => patch({ blockStart: v })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Block count</Label>
          <NumberInput
            min={1}
            max={125}
            value={profile.blockCount}
            onChange={(v) => patch({ blockCount: v })}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={captureFromPoll}>
          Capture from current poll
        </Button>
        <Button variant="outline" size="sm" onClick={addPoint}>
          Add parameter
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {profile.points.map((pt, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Key</Label>
                <Input
                  className="h-8"
                  value={pt.key}
                  onChange={(e) =>
                    patchPoint(i, {
                      key: e.target.value
                        .toLowerCase()
                        .replace(/\s+/g, "_"),
                    })
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Label</Label>
                <Input
                  className="h-8"
                  value={pt.label}
                  onChange={(e) => patchPoint(i, { label: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Unit</Label>
                <Input
                  className="h-8"
                  value={pt.unit}
                  onChange={(e) => patchPoint(i, { unit: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Wire address</Label>
                <NumberInput
                  min={0}
                  max={65535}
                  value={pt.address}
                  onChange={(v) => patchPoint(i, { address: v })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Group</Label>
                <Select
                  value={pt.group}
                  onValueChange={(v) =>
                    patchPoint(i, { group: v as MeterPointGroup })
                  }
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
              <div className="flex items-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => removePoint(i)}
                >
                  Remove
                </Button>
              </div>
            </div>
            <FormatPicker
              format={pt.format}
              onChange={(format) => patchPoint(i, { format })}
            />
            <SimulationFields
              point={pt}
              onChange={(p) => patchPoint(i, p)}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate("/meters")}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void handleSave()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </main>
  );
}
