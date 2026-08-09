import { useEffect, useState } from "react";
import { fromWire, type AddressBase } from "@/lib/addressing";
import { errorMessage, meterReadPlan } from "@/lib/ipc";
import type { MeterProfile, ReadBlock } from "@/lib/types";
import { registerSpan } from "@/lib/valueKinds";

function functionLabel(fc: ReadBlock["function"]): string {
  return fc === "read_input_registers"
    ? "Input registers (FC04)"
    : "Holding registers (FC03)";
}

/**
 * What reading this meter actually costs, in plain terms.
 *
 * Modbus can only fetch a contiguous run of registers per request, up to 125.
 * Rather than making the user satisfy that rule by hand — the old editor asked
 * for a block start and count, and silently couldn't express a meter whose
 * parameters were far apart — ModbusOpen works the requests out and shows them
 * here. The plan comes from the same Rust function the poll engine executes,
 * so this is the real thing, not an estimate.
 */
export function ReadPlanSummary({
  profile,
  base,
}: {
  profile: MeterProfile;
  base: AddressBase;
}) {
  const [plan, setPlan] = useState<ReadBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void meterReadPlan(profile)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((err) => {
        if (!cancelled) {
          setPlan(null);
          setError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  if (error) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Read plan</h2>
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      </section>
    );
  }

  if (!plan) {
    return (
      <p className="text-sm text-muted-foreground">Working out the read plan…</p>
    );
  }

  const used = profile.points.reduce(
    (sum, p) => sum + registerSpan(p.format),
    0,
  );
  const fetched = plan.reduce((sum, b) => sum + b.quantity, 0);
  const wasted = Math.max(0, fetched - used);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">
          {plan.length === 1
            ? "This meter reads in a single request"
            : `This meter reads in ${plan.length} requests`}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {plan.length === 1
            ? "All its parameters sit close enough together to fetch at once."
            : "Its parameters are too far apart to fetch at once, so each poll sends one request per group. Nothing is dropped."}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-[2rem_1fr_1fr_5rem] gap-x-3 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
          <div>#</div>
          <div>From</div>
          <div>Reads</div>
          <div>Registers</div>
        </div>
        {plan.map((block, i) => {
          const first = fromWire(block.startAddress, base);
          const last = fromWire(block.startAddress + block.quantity - 1, base);
          const covered = profile.points.filter(
            (p) =>
              (p.function ?? profile.function) === block.function &&
              p.address >= block.startAddress &&
              p.address < block.startAddress + block.quantity,
          );
          return (
            <div
              key={`${block.function}-${block.startAddress}`}
              className="grid grid-cols-[2rem_1fr_1fr_5rem] items-baseline gap-x-3 border-b border-border/40 px-3 py-2 text-sm last:border-b-0"
            >
              <div className="tabular-nums text-muted-foreground">{i + 1}</div>
              <div className="font-mono text-xs">
                {first} – {last}
                {base !== "zeroBased" && (
                  <span className="block text-muted-foreground">
                    wire {block.startAddress}–
                    {block.startAddress + block.quantity - 1}
                  </span>
                )}
              </div>
              <div className="text-xs">
                {covered.length} parameter{covered.length === 1 ? "" : "s"}
                <span className="block text-muted-foreground">
                  {functionLabel(block.function)}
                </span>
              </div>
              <div className="tabular-nums">{block.quantity}</div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {fetched} registers fetched per poll for {used} registers of data
        {wasted > 0 && ` — ${wasted} spare registers ride along inside the groups, which is cheaper than extra requests`}
        . The 125-register limit per request is a protocol rule, not a
        ModbusOpen one.
      </p>

      {plan.length === 0 && (
        <p className="text-sm text-destructive">
          No parameters yet, so there is nothing to read.
        </p>
      )}
    </section>
  );
}
