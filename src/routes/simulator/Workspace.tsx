import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectionPill } from "@/components/ConnectionPill";
import { Button } from "@/components/ui/button";
import { errorMessage, onSimUpdate, simSnapshot, simStop, simWriteCoil, simWriteRegister } from "@/lib/ipc";
import type { SlaveSnapshot } from "@/lib/types";
import { useSimulatorStore } from "@/store/simulatorStore";

function CoilGrid({
  unitId,
  coils,
  onError,
}: {
  unitId: number;
  coils: boolean[];
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  if (coils.length === 0) return null;

  async function toggle(address: number, value: boolean) {
    setBusy(address);
    try {
      await simWriteCoil(unitId, address, value);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Coils
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {coils.map((value, address) => (
          <button
            key={address}
            type="button"
            title={`Coil ${address} — click to toggle`}
            disabled={busy === address}
            onClick={() => toggle(address, !value)}
            className={`flex h-8 w-10 items-center justify-center rounded-md border font-mono text-xs transition-colors ${
              value
                ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-400"
                : "border-border bg-background text-muted-foreground"
            }`}
          >
            {address}
          </button>
        ))}
      </div>
    </div>
  );
}

function HoldingRegisterTable({
  unitId,
  registers,
  onError,
}: {
  unitId: number;
  registers: number[];
  onError: (msg: string) => void;
}) {
  const [editAddr, setEditAddr] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  if (registers.length === 0) return null;

  async function commit(address: number) {
    const n = Number(editText);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 65535) {
      onError("value must be an integer 0–65535");
      return;
    }
    setSaving(true);
    try {
      await simWriteRegister(unitId, address, n);
      setEditAddr(null);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Holding registers (dbl-click a value to write)
      </h3>
      <div className="max-h-80 overflow-auto rounded-lg border border-border">
        <div className="grid grid-cols-[5rem_6rem_1fr] gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <div>Address</div>
          <div>Raw (hex)</div>
          <div>Value</div>
        </div>
        {registers.map((value, address) => {
          const editing = editAddr === address;
          return (
            <div
              key={address}
              className="grid grid-cols-[5rem_6rem_1fr] items-center gap-2 border-b border-border/60 px-3 py-1 font-mono text-sm"
            >
              <div>{address}</div>
              <div className="text-muted-foreground">
                {value.toString(16).toUpperCase().padStart(4, "0")}
              </div>
              {editing ? (
                <input
                  className="h-7 w-24 rounded border border-ring bg-background px-1 text-sm"
                  autoFocus
                  disabled={saving}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => !saving && setEditAddr(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commit(address);
                    if (e.key === "Escape") setEditAddr(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="w-fit text-left hover:underline"
                  onDoubleClick={() => {
                    setEditAddr(address);
                    setEditText(String(value));
                  }}
                >
                  {value}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReadOnlyBits({
  label,
  bits,
}: {
  label: string;
  bits: boolean[];
}) {
  if (bits.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label} <span className="normal-case">(device-side, not master-writable)</span>
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {bits.map((value, address) => (
          <span
            key={address}
            className={`flex h-7 w-9 items-center justify-center rounded-md border font-mono text-xs ${
              value
                ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-400"
                : "border-border text-muted-foreground"
            }`}
          >
            {address}
          </span>
        ))}
      </div>
    </div>
  );
}

function SlavePanel({
  slave,
  onError,
}: {
  slave: SlaveSnapshot;
  onError: (msg: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <h2 className="font-heading text-sm font-semibold">Unit {slave.unitId}</h2>
      <CoilGrid unitId={slave.unitId} coils={slave.coils} onError={onError} />
      <HoldingRegisterTable
        unitId={slave.unitId}
        registers={slave.holdingRegisters}
        onError={onError}
      />
      <ReadOnlyBits label="Discrete inputs" bits={slave.discreteInputs} />
      {slave.inputRegisters.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Input registers{" "}
            <span className="normal-case">(device-side, not master-writable)</span>
          </h3>
          <p className="font-mono text-sm text-muted-foreground">
            {slave.inputRegisters.join(" ")}
          </p>
        </div>
      )}
    </div>
  );
}

export default function SimulatorWorkspace() {
  const navigate = useNavigate();
  const info = useSimulatorStore((s) => s.info);
  const snapshot = useSimulatorStore((s) => s.snapshot);
  const applySnapshot = useSimulatorStore((s) => s.applySnapshot);
  const resetSession = useSimulatorStore((s) => s.resetSession);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const infoRef = useRef(info);
  infoRef.current = info;

  useEffect(() => {
    if (!info) {
      navigate("/simulate", { replace: true });
      return;
    }

    let unlisten: (() => void) | undefined;
    void simSnapshot()
      .then(applySnapshot)
      .catch((err) => setError(errorMessage(err)));
    void onSimUpdate((snap) => {
      if (infoRef.current && snap.sessionId === infoRef.current.sessionId) {
        applySnapshot(snap);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
    // Only re-run if the session itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.sessionId]);

  async function handleStop() {
    setStopping(true);
    try {
      await simStop();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      resetSession();
      navigate("/simulate");
    }
  }

  if (!info) return null;

  return (
    <main className="flex min-h-screen flex-col gap-4 px-6 py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ConnectionPill connected summary={`0.0.0.0:${info.tcpPort}`} />
          <span className="text-sm text-muted-foreground">
            {snapshot?.slaves.length ?? 0} slave
            {(snapshot?.slaves.length ?? 0) === 1 ? "" : "s"}
          </span>
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={stopping}
          onClick={() => void handleStop()}
        >
          {stopping ? "Stopping…" : "Stop simulator"}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {!snapshot && (
        <p className="text-sm text-muted-foreground">Loading snapshot…</p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {snapshot?.slaves.map((slave) => (
          <SlavePanel key={slave.unitId} slave={slave} onError={setError} />
        ))}
      </div>
    </main>
  );
}
