import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectionPill } from "@/components/ConnectionPill";
import { FormatPicker } from "@/components/FormatPicker";
import { FrameLog, MAX_FRAMES } from "@/components/FrameLog";
import { RegisterTable } from "@/components/RegisterTable";
import { StatsBar } from "@/components/StatsBar";
import { WritePanel } from "@/components/WritePanel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { tableToCsv } from "@/lib/format";
import {
  disconnect,
  errorMessage,
  onConnectionLost,
  onFrame,
  onPollError,
  onPollResult,
  readOnce,
  setPollConfig,
  startPoll,
  stopPoll,
} from "@/lib/ipc";
import type {
  DataFormat,
  FrameLogEntry,
  FunctionCode,
  PollConfig,
} from "@/lib/types";
import { useScannerStore } from "@/store/scannerStore";

const READ_FUNCTIONS: { value: FunctionCode; label: string }[] = [
  { value: "read_coils", label: "01 Read Coils" },
  { value: "read_discrete_inputs", label: "02 Read Discrete" },
  { value: "read_holding_registers", label: "03 Read Holding" },
  { value: "read_input_registers", label: "04 Read Input" },
];

function isBitFc(fc: FunctionCode): boolean {
  return fc === "read_coils" || fc === "read_discrete_inputs";
}

export default function ScannerWorkspace() {
  const navigate = useNavigate();
  const connection = useScannerStore((s) => s.connection);
  const pollConfig = useScannerStore((s) => s.pollConfig);
  const setPollConfigLocal = useScannerStore((s) => s.setPollConfigLocal);
  const polling = useScannerStore((s) => s.polling);
  const setPolling = useScannerStore((s) => s.setPolling);
  const rows = useScannerStore((s) => s.rows);
  const rowsStale = useScannerStore((s) => s.rowsStale);
  const stats = useScannerStore((s) => s.stats);
  const lastError = useScannerStore((s) => s.lastError);
  const applyPollResult = useScannerStore((s) => s.applyPollResult);
  const applyPollError = useScannerStore((s) => s.applyPollError);
  const applyConnectionLost = useScannerStore((s) => s.applyConnectionLost);
  const resetSession = useScannerStore((s) => s.resetSession);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showWrite, setShowWrite] = useState(false);
  const [showFrames, setShowFrames] = useState(false);
  const [frames, setFrames] = useState<FrameLogEntry[]>([]);
  const [framesPaused, setFramesPaused] = useState(false);
  const framesPausedRef = useRef(false);
  framesPausedRef.current = framesPaused;

  const retuneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollConfigRef = useRef(pollConfig);
  pollConfigRef.current = pollConfig;
  const sessionIdRef = useRef<number | null>(null);
  sessionIdRef.current = connection?.sessionId ?? null;

  useEffect(() => {
    if (!connection) {
      navigate("/scan", { replace: true });
    }
  }, [connection, navigate]);

  useEffect(() => {
    const unsubs: Promise<() => void>[] = [
      onPollResult((r) =>
        applyPollResult(r.sessionId, r.registers, r.stats, r.sequence),
      ),
      onPollError((e) => applyPollError(e.sessionId, e.message, e.stats)),
      onConnectionLost((e) => {
        applyConnectionLost(e.sessionId, e.message);
        navigate("/scan", { replace: true });
      }),
      onFrame((entry) => {
        if (sessionIdRef.current !== entry.sessionId) return;
        if (framesPausedRef.current) return;
        setFrames((prev) => {
          const next = [...prev, entry];
          if (next.length > MAX_FRAMES) {
            return next.slice(next.length - MAX_FRAMES);
          }
          return next;
        });
      }),
    ];
    return () => {
      void Promise.all(unsubs).then((fns) => fns.forEach((fn) => fn()));
    };
  }, [applyPollResult, applyPollError, applyConnectionLost, navigate]);

  const pushConfig = useCallback(async (config: PollConfig) => {
    try {
      await setPollConfig(config);
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, []);

  const scheduleRetune = useCallback(
    (next: PollConfig) => {
      if (retuneTimer.current) clearTimeout(retuneTimer.current);
      retuneTimer.current = setTimeout(() => {
        void pushConfig(next);
      }, 250);
    },
    [pushConfig],
  );

  function updateField<K extends keyof PollConfig>(
    key: K,
    value: PollConfig[K],
  ) {
    setPollConfigLocal({ [key]: value } as Partial<PollConfig>);
    const next = { ...pollConfigRef.current, [key]: value };
    // Auto-switch format to bool for coil/discrete reads.
    if (key === "function" && isBitFc(value as FunctionCode)) {
      next.format = { ...next.format, dataType: "bool" };
      setPollConfigLocal({ format: next.format });
    }
    pollConfigRef.current = next;
    scheduleRetune(next);
  }

  function updateFormat(format: DataFormat) {
    setPollConfigLocal({ format });
    const next = { ...pollConfigRef.current, format };
    pollConfigRef.current = next;
    scheduleRetune(next);
  }

  async function handleStart() {
    setBusy(true);
    setActionError(null);
    try {
      await setPollConfig(pollConfig);
      await startPoll();
      setPolling(true);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    setActionError(null);
    try {
      await stopPoll();
      setPolling(false);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReadOnce() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await readOnce(pollConfig);
      applyPollResult(
        result.sessionId,
        result.registers,
        result.stats,
        result.sequence,
      );
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      if (polling) {
        try {
          await stopPoll();
        } catch {
          /* best-effort */
        }
      }
      await disconnect();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      resetSession();
      setBusy(false);
      navigate("/scan");
    }
  }

  function exportCsv() {
    const csv = tableToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `modbusopen-snapshot-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const bitMode = isBitFc(pollConfig.function);
  const maxQty = bitMode ? 2000 : 125;

  if (!connection) {
    return null;
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <ConnectionPill connected summary={connection.summary} />
        {/* Counters ride in the top bar — they're the first thing you check
            when a device goes quiet, so they sit beside the connection, not
            in a footer three screens below the controls that caused them. */}
        <StatsBar stats={stats} />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleDisconnect()}
          >
            Disconnect
          </Button>
        </div>
      </header>

      <section className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="unit" className="text-xs text-muted-foreground">
            Unit
          </Label>
          <NumberInput
            id="unit"
            min={1}
            max={247}
            className="w-20"
            value={pollConfig.unitId}
            onChange={(v) => updateField("unitId", v)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Function</Label>
          <Select
            value={pollConfig.function}
            onValueChange={(v) => updateField("function", v as FunctionCode)}
          >
            <SelectTrigger className="w-44" aria-label="Function code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {READ_FUNCTIONS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="start" className="text-xs text-muted-foreground">
            Start (0-based wire)
          </Label>
          <NumberInput
            id="start"
            min={0}
            max={65535}
            className="w-28"
            value={pollConfig.startAddress}
            onChange={(v) => updateField("startAddress", v)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="qty" className="text-xs text-muted-foreground">
            Qty
          </Label>
          <NumberInput
            id="qty"
            min={1}
            max={maxQty}
            className="w-20"
            value={pollConfig.quantity}
            onChange={(v) => updateField("quantity", v)}
            onClamp={(bounded, typed) =>
              setActionError(
                `${typed} exceeds the ${maxQty}-${bitMode ? "bit" : "register"} limit for a single request — clamped to ${bounded}.`,
              )
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="interval" className="text-xs text-muted-foreground">
            Interval (ms)
          </Label>
          <NumberInput
            id="interval"
            min={50}
            max={60000}
            step={50}
            className="w-24"
            value={pollConfig.intervalMs}
            onChange={(v) => updateField("intervalMs", v)}
          />
        </div>

        {!bitMode && (
          <FormatPicker format={pollConfig.format} onChange={updateFormat} />
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {polling ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void handleStop()}
            >
              ⏸ Pause
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void handleStart()}
            >
              ▶ Start
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleReadOnce()}
          >
            ↻ Read once
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowWrite((v) => !v)}
          >
            Write
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFrames((v) => !v)}
          >
            Frames ({frames.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length === 0}
            onClick={exportCsv}
          >
            CSV
          </Button>
        </div>
      </section>

      {/* One error line for the whole screen. Poll failures used to live in the
          footer and action failures up here, which meant two places to look. */}
      {(actionError ?? lastError ?? stats.lastError) && (
        <div
          className="flex items-start gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="flex-1">
            {actionError ?? lastError ?? stats.lastError}
          </span>
          {actionError && (
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-4 hover:no-underline"
              onClick={() => setActionError(null)}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col p-4">
        <RegisterTable
          rows={rows}
          stale={rowsStale}
          unitId={pollConfig.unitId}
          format={pollConfig.format}
          writable={!bitMode}
          onWriteError={(msg) => setActionError(msg)}
          onWritten={() => void handleReadOnce()}
        />
      </main>

      <WritePanel
        open={showWrite}
        onClose={() => setShowWrite(false)}
        unitId={pollConfig.unitId}
        defaultAddress={pollConfig.startAddress}
        defaultFormat={pollConfig.format}
        onWritten={() => void handleReadOnce()}
      />

      <FrameLog
        open={showFrames}
        frames={frames}
        paused={framesPaused}
        onPauseToggle={() => setFramesPaused((p) => !p)}
        onClear={() => setFrames([])}
        onClose={() => setShowFrames(false)}
      />
    </div>
  );
}
