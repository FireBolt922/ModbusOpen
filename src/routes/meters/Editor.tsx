import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ParameterRow } from "@/components/meters/ParameterRow";
import { PresetPicker } from "@/components/meters/PresetPicker";
import { ReadPlanSummary } from "@/components/meters/ReadPlanSummary";
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
  ADDRESS_BASES,
  functionForBase,
  type AddressBase,
} from "@/lib/addressing";
import {
  errorMessage,
  getMeterProfile,
  listMeterProfiles,
  saveMeterProfile,
} from "@/lib/ipc";
import { customPoint, pointFromPreset, type ParameterPreset } from "@/lib/meterPresets";
import type { FunctionCode, MeterPoint, MeterProfile, MeterSource } from "@/lib/types";
import { registerSpan } from "@/lib/valueKinds";
import { useMeterStore } from "@/store/meterStore";
import { useScannerStore } from "@/store/scannerStore";
import { cn } from "@/lib/utils";

const STEPS = ["Meter", "Parameters", "Read plan", "Simulation"] as const;
type Step = 0 | 1 | 2 | 3;

/** Brand + model -> a filename-safe id, so nobody has to invent a slug. */
function slugify(brand: string, model: string): string {
  const raw = `${brand} ${model}`.trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "my-meter";
}

function emptyProfile(): MeterProfile {
  return {
    id: "",
    brand: "",
    model: "",
    description: "",
    source: { kind: "user" },
    function: "read_holding_registers",
    defaultUnitId: 1,
    points: [],
  };
}

/**
 * Client-side checks, phrased for someone who has a datasheet in front of them
 * rather than a protocol spec. Rust validates all of this again on save — this
 * copy exists so the message arrives while the field is still on screen.
 */
function problemsFor(p: MeterProfile): { step: Step; message: string }[] {
  const out: { step: Step; message: string }[] = [];
  if (!p.brand.trim()) out.push({ step: 0, message: "Give the meter a brand." });
  if (!p.model.trim()) out.push({ step: 0, message: "Give the meter a model." });
  if (p.points.length === 0) {
    out.push({ step: 1, message: "Add at least one parameter." });
  }

  const keys = new Set<string>();
  // Which parameter owns each register, per function code.
  const owner = new Map<string, string>();
  for (const pt of p.points) {
    const name = pt.label.trim() || pt.key || "a parameter";
    if (!pt.label.trim()) {
      out.push({ step: 1, message: `A parameter at address ${pt.address} needs a name.` });
    }
    if (keys.has(pt.key)) {
      out.push({ step: 1, message: `Two parameters share the key "${pt.key}".` });
    }
    keys.add(pt.key);

    const span = registerSpan(pt.format);
    if (pt.address + span > 0x10000) {
      out.push({
        step: 1,
        message: `${name} runs past the last register — check its address.`,
      });
    }
    const fc = pt.function ?? p.function;
    for (let i = 0; i < span; i += 1) {
      const slot = `${fc}:${pt.address + i}`;
      const prev = owner.get(slot);
      if (prev && prev !== name) {
        out.push({
          step: 1,
          message: `${prev} and ${name} both use register ${pt.address + i}. A ${span}-register value needs ${span} free registers.`,
        });
      }
      owner.set(slot, name);
    }
  }
  return out;
}

export default function MeterEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setProfiles = useMeterStore((s) => s.setProfiles);
  const rows = useScannerStore((s) => s.rows);
  const pollConfig = useScannerStore((s) => s.pollConfig);

  const [profile, setProfile] = useState<MeterProfile>(emptyProfile);
  const [base, setBase] = useState<AddressBase>("holding4x");
  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idTouched, setIdTouched] = useState(false);
  const isNew = !id || id === "new";

  useEffect(() => {
    if (isNew) {
      setProfile(emptyProfile());
      return;
    }
    void getMeterProfile(id)
      .then((p) => {
        setProfile(p);
        setIdTouched(true);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [id, isNew]);

  const problems = useMemo(() => problemsFor(profile), [profile]);
  const blockingProblems = problems.filter((p) => p.step <= step);

  const patch = useCallback((p: Partial<MeterProfile>) => {
    setProfile((prev) => ({ ...prev, ...p }));
  }, []);

  // The id is derived from brand and model until someone edits it by hand.
  useEffect(() => {
    if (!isNew || idTouched) return;
    setProfile((prev) => ({ ...prev, id: slugify(prev.brand, prev.model) }));
  }, [profile.brand, profile.model, isNew, idTouched]);

  function patchPoint(index: number, p: Partial<MeterPoint>) {
    setProfile((prev) => ({
      ...prev,
      points: prev.points.map((pt, i) => (i === index ? { ...pt, ...p } : pt)),
    }));
  }

  function removePoint(index: number) {
    setProfile((prev) => ({
      ...prev,
      points: prev.points.filter((_, i) => i !== index),
    }));
  }

  /**
   * Put a new parameter after the last one, leaving room for its registers, so
   * the common case (a datasheet listing consecutive values) needs no typing
   * at all beyond picking what it is.
   */
  function nextFreeAddress(): number {
    if (profile.points.length === 0) return 0;
    return profile.points.reduce(
      (max, pt) => Math.max(max, pt.address + registerSpan(pt.format)),
      0,
    );
  }

  function addPreset(preset: ParameterPreset | null) {
    const keys = profile.points.map((p) => p.key);
    const address = nextFreeAddress();
    const point = preset
      ? pointFromPreset(preset, address, keys)
      : customPoint(address, keys);
    setProfile((prev) => ({ ...prev, points: [...prev.points, point] }));
    setPickerOpen(false);
  }

  function captureFromPoll() {
    if (rows.length === 0) {
      setError(
        "No poll data yet — connect the scanner and read once, then everything it read shows up here as parameters.",
      );
      return;
    }
    const seen = new Set<number>();
    const points: MeterPoint[] = [];
    for (const r of rows) {
      if (seen.has(r.address)) continue;
      seen.add(r.address);
      points.push({
        key: `reg_${r.address}`,
        label: `Register ${r.address}`,
        address: r.address,
        format: { ...pollConfig.format },
        unit: "",
        group: "other",
        unverified: true,
        simBehavior: { kind: "random", min: 0, max: 100 },
        simInitial: 50,
      });
    }
    const first = pollConfig.blocks[0];
    patch({
      function: (first?.function ?? "read_holding_registers") as FunctionCode,
      defaultUnitId: pollConfig.unitId,
      points,
    });
    setError(null);
    setNotice(`Added ${points.length} parameters from the last poll — rename the ones you care about.`);
  }

  async function handleSave() {
    if (problems.length > 0) {
      setStep(problems[0]!.step);
      setError(problems[0]!.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const source: MeterSource =
        profile.source.kind === "imported" ? profile.source : { kind: "user" };
      await saveMeterProfile({ ...profile, source });
      setProfiles(await listMeterProfiles());
      navigate("/meters");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const simulated = profile.points.filter((p) => p.simBehavior).length;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            {isNew ? "New meter" : `Edit ${profile.brand} ${profile.model}`}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell ModbusOpen what the meter measures and where. It works out how
            to read it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/meters")}>
          Back
        </Button>
      </div>

      <nav className="flex flex-wrap gap-1" aria-label="Steps">
        {STEPS.map((name, i) => {
          const active = i === step;
          const hasProblem = problems.some((p) => p.step === i);
          return (
            <button
              key={name}
              type="button"
              onClick={() => setStep(i as Step)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <span className="tabular-nums opacity-60">{i + 1}.</span> {name}
              {hasProblem && !active && (
                <span className="ml-1.5 text-destructive" aria-label="needs attention">
                  •
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      {step === 0 && (
        <section className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>Brand</Label>
              <Input
                autoFocus
                value={profile.brand}
                placeholder="Schneider"
                onChange={(e) => patch({ brand: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Model</Label>
              <Input
                value={profile.model}
                placeholder="PM 5320"
                onChange={(e) => patch({ model: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label>What is it for? (optional)</Label>
              <Input
                value={profile.description}
                placeholder="Main incomer, panel 3"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Slave / unit ID</Label>
              <NumberInput
                min={1}
                max={247}
                value={profile.defaultUnitId}
                onChange={(v) => patch({ defaultUnitId: v })}
              />
              <p className="text-xs text-muted-foreground">
                The device's address on the bus. Usually 1.
              </p>
            </div>
          </div>

          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label>Saved as (id)</Label>
                <Input
                  value={profile.id}
                  disabled={!isNew}
                  onChange={(e) => {
                    setIdTouched(true);
                    patch({
                      id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
                    });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Filename for this meter. Generated from brand and model.
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Read with</Label>
                <Select
                  value={profile.function}
                  onValueChange={(v) => patch({ function: v as FunctionCode })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read_holding_registers">
                      Holding registers (FC03)
                    </SelectItem>
                    <SelectItem value="read_input_registers">
                      Input registers (FC04)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Default for every parameter. Individual ones can differ.
                </p>
              </div>
            </div>
          </details>
        </section>
      )}

      {step === 1 && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">
                Addresses on your datasheet look like
              </Label>
              <Select
                value={base}
                onValueChange={(v) => {
                  const next = v as AddressBase;
                  setBase(next);
                  const implied = functionForBase(next);
                  if (implied) patch({ function: implied as FunctionCode });
                }}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADDRESS_BASES.map((b) => (
                    <SelectItem key={b.value} value={b.value}>
                      {b.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {ADDRESS_BASES.find((b) => b.value === base)?.hint}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={captureFromPoll}>
                Capture from last poll
              </Button>
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                Add parameter
              </Button>
            </div>
          </div>

          {profile.points.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <p className="text-sm font-medium">No parameters yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Add what the meter measures — voltage, current, energy — and
                type the address from its datasheet. Nothing else is required.
              </p>
              <Button className="mt-4" size="sm" onClick={() => setPickerOpen(true)}>
                Add the first parameter
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="hidden grid-cols-[minmax(9rem,1.4fr)_8rem_minmax(10rem,1.2fr)_2.5rem] gap-x-3 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase sm:grid">
                <div>Parameter</div>
                <div>Address</div>
                <div>Reads as</div>
                <div />
              </div>
              {profile.points.map((pt, i) => (
                <ParameterRow
                  key={i}
                  point={pt}
                  base={base}
                  defaultFunction={profile.function}
                  onChange={(p) => patchPoint(i, p)}
                  onRemove={() => removePoint(i)}
                />
              ))}
            </div>
          )}

          {problems.filter((p) => p.step === 1).length > 0 && (
            <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 p-3">
              {problems
                .filter((p) => p.step === 1)
                .map((p, i) => (
                  <li key={i} className="text-sm text-destructive">
                    {p.message}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      {step === 2 && <ReadPlanSummary profile={profile} base={base} />}

      {step === 3 && (
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-medium">Simulation</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These values are what the simulator serves when you run this meter
              as a device. {simulated} of {profile.points.length} parameters are
              simulated.
            </p>
          </div>
          {simulated === 0 && profile.points.length > 0 && (
            <p className="text-sm text-destructive">
              Nothing is simulated — running this meter would serve zeros for
              every parameter.
            </p>
          )}
          <div className="flex flex-col gap-2">
            {profile.points.map((pt, i) => (
              <ParameterRow
                key={i}
                point={pt}
                base={base}
                defaultFunction={profile.function}
                mode="simulation"
                onChange={(p) => patchPoint(i, p)}
                onRemove={() => removePoint(i)}
              />
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}
        >
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/meters")}>
            Cancel
          </Button>
          {step < 3 ? (
            <Button
              disabled={blockingProblems.length > 0}
              onClick={() => setStep((s) => Math.min(3, s + 1) as Step)}
            >
              Next
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void handleSave()}>
              {busy ? "Saving…" : "Save meter"}
            </Button>
          )}
        </div>
      </div>

      <PresetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={addPreset}
      />
    </main>
  );
}
