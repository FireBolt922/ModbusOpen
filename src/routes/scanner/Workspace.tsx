import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectionPill } from "@/components/ConnectionPill";
import { FormatPicker } from "@/components/FormatPicker";
import { FrameLog, MAX_FRAMES } from "@/components/FrameLog";
import { MeterSelector } from "@/components/MeterSelector";
import { ParameterTable } from "@/components/ParameterTable";
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
  decodeMeterPoints,
  disconnect,
  meterReadPlan,
  errorMessage,
  onConnectionLost,
  onFrame,
  onPollError,
  onPollResult,
  readOnce,
  reconnect,
  resetPollStats,
  setPollConfig,
  startPoll,
  stopPoll,
} from "@/lib/ipc";
import type {
  AddressedWord,
  DataFormat,
  DecodedRegister,
  FrameLogEntry,
  FunctionCode,
  MeterProfile,
  PollConfig,
  ReadBlock,
} from "@/lib/types";
import { useMeterStore } from "@/store/meterStore";
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
  const linkDown = useScannerStore((s) => s.linkDown);
  const reconnecting = useScannerStore((s) => s.reconnecting);
  const rows = useScannerStore((s) => s.rows);
  const rowsStale = useScannerStore((s) => s.rowsStale);
  const stats = useScannerStore((s) => s.stats);
  const lastError = useScannerStore((s) => s.lastError);
  const consecutiveErrors = useScannerStore((s) => s.consecutiveErrors);
  const clearStats = useScannerStore((s) => s.clearStats);
  const applyPollResult = useScannerStore((s) => s.applyPollResult);
  const applyPollError = useScannerStore((s) => s.applyPollError);
  const applyConnectionLost = useScannerStore((s) => s.applyConnectionLost);
  const setReconnecting = useScannerStore((s) => s.setReconnecting);
  const applyReconnected = useScannerStore((s) => s.applyReconnected);
  const applyReconnectFailed = useScannerStore((s) => s.applyReconnectFailed);
  const resetSession = useScannerStore((s) => s.resetSession);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showWrite, setShowWrite] = useState(false);
  const [showFrames, setShowFrames] = useState(false);
  const [frames, setFrames] = useState<FrameLogEntry[]>([]);
  const [framesPaused, setFramesPaused] = useState(false);
  const framesPausedRef = useRef(false);
  framesPausedRef.current = framesPaused;

  const activeProfileId = useMeterStore((s) => s.activeProfileId);
  const setActiveProfileId = useMeterStore((s) => s.setActiveProfileId);
  const parameterView = useMeterStore((s) => s.parameterView);
  const setParameterView = useMeterStore((s) => s.setParameterView);
  const profiles = useMeterStore((s) => s.profiles);
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? null;

  const [pointRows, setPointRows] = useState<(DecodedRegister | null)[]>([]);

  const retuneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollConfigRef = useRef(pollConfig);
  pollConfigRef.current = pollConfig;
  const sessionIdRef = useRef<number | null>(null);
  sessionIdRef.current = connection?.sessionId ?? null;

  // Only sends you to setup when there is no session at all — a cold load of
  // this route. A session whose link dropped stays here; see the banner below.
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
      // No navigation here. Losing the link is not a reason to throw away the
      // meter, the read plan and the poll settings the user just entered.
      onConnectionLost((e) => applyConnectionLost(e.sessionId, e.message)),
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
  }, [applyPollResult, applyPollError, applyConnectionLost]);


  // Re-decode the last poll with each parameter's own format (Rust codec —
  // never in TS). The rows can come from several requests with gaps between
  // them, so they're flattened to address/word pairs rather than an array.
  useEffect(() => {
    if (!activeProfile || !parameterView || rows.length === 0) {
      setPointRows([]);
      return;
    }
    const words: AddressedWord[] = [];
    for (const row of rows) {
      for (let i = 0; i < row.raw.length; i++) {
        words.push({ address: row.address + i, value: row.raw[i]! });
      }
    }
    let cancelled = false;
    void decodeMeterPoints(activeProfile, words)
      .then((decoded) => {
        if (cancelled) return;
        // Decoded rows come back in profile order, one per parameter.
        setPointRows(decoded);
      })
      .catch((err) => {
        if (!cancelled) setActionError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rows, activeProfile, parameterView]);

  /**
   * Point the poll at a meter: its unit id, its formats, and every request in
   * its read plan. The plan comes from Rust so the scanner issues exactly the
   * requests the meter editor showed.
   */
  async function applyMeterProfile(profile: MeterProfile | null) {
    setActiveProfileId(profile?.id ?? null);
    if (!profile) {
      setParameterView(false);
      return;
    }
    setParameterView(true);
    try {
      const blocks = await meterReadPlan(profile);
      if (blocks.length === 0) {
        setActionError(
          `“${profile.brand} ${profile.model}” has no parameters to read.`,
        );
        return;
      }
      // The raw table needs one format; prefer a float32 point since that's
      // what most meters use, falling back to the first parameter's.
      const floatPt = profile.points.find(
        (p) => p.format.dataType === "float32",
      );
      const format: DataFormat = floatPt?.format ??
        profile.points[0]?.format ?? {
          dataType: "float32",
          wordOrder: "cdab",
          scale: 1,
          offset: 0,
        };
      const next: PollConfig = {
        ...pollConfigRef.current,
        unitId: profile.defaultUnitId,
        blocks,
        format,
      };
      setPollConfigLocal(next);
      pollConfigRef.current = next;
      scheduleRetune(next);
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

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
    pollConfigRef.current = next;
    scheduleRetune(next);
  }

  /**
   * Edit the raw-mode request. The poll bar drives one request; a meter's
   * multi-request plan is set by `applyMeterProfile` instead, and touching
   * these controls replaces it with a single block on purpose — that's what
   * dropping back to raw addresses means.
   */
  function updateBlock(patch: Partial<ReadBlock>) {
    const current = pollConfigRef.current.blocks[0] ?? {
      function: "read_holding_registers" as FunctionCode,
      startAddress: 0,
      quantity: 8,
    };
    const block: ReadBlock = { ...current, ...patch };
    const next: PollConfig = { ...pollConfigRef.current, blocks: [block] };
    // Coils and discrete inputs come back as bits, so the raw table has to
    // read them as bools or every row shows a meaningless number.
    if (patch.function && isBitFc(patch.function)) {
      next.format = { ...next.format, dataType: "bool" };
    }
    setPollConfigLocal(next);
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

  /**
   * Zero the counters on both sides. Rust owns the running totals, so clearing
   * only the UI copy would be undone by the very next poll event.
   */
  async function handleClearStats() {
    clearStats();
    setActionError(null);
    try {
      await resetPollStats();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  /**
   * Reopen the same transport, same settings, same session. Everything on
   * screen — meter, read plan, format, counters — is still valid, so this is
   * one click rather than a walk back through the connection form.
   */
  async function handleReconnect() {
    setReconnecting(true);
    setActionError(null);
    try {
      const result = await reconnect();
      applyReconnected(result.polling);
    } catch (err) {
      applyReconnectFailed(errorMessage(err));
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

  // The poll bar edits one request. With a meter selected the plan may have
  // several; the bar shows the first and editing it drops back to raw mode.
  const block: ReadBlock = pollConfig.blocks[0] ?? {
    function: "read_holding_registers",
    startAddress: 0,
    quantity: 8,
  };
  const bitMode = isBitFc(block.function);
  const maxQty = bitMode ? 2000 : 125;
  // Anything that puts bytes on the wire is off while the link is down —
  // Reconnect in the banner is the one action that can help.
  const offline = linkDown !== null;

  if (!connection) {
    return null;
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <ConnectionPill
          connected
          linkDown={linkDown !== null}
          reconnecting={reconnecting}
          summary={connection.summary}
        />
        {/* Counters ride in the top bar — they're the first thing you check
            when a device goes quiet, so they sit beside the connection, not
            in a footer three screens below the controls that caused them. */}
        <StatsBar stats={stats} consecutiveErrors={consecutiveErrors} />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleClearStats()}
            title="Reset TX/RX/error counters and latency for this session"
          >
            Clear
          </Button>
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

      {/* The link dropped. Everything the user set up is still here and still
          valid, so this offers the two moves that actually help — try the same
          settings again, or go change them — instead of deciding for them. */}
      {linkDown && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/40 bg-destructive/10 px-4 py-3"
          role="alert"
        >
          <div className="flex-1 min-w-64">
            <p className="text-sm font-medium text-destructive">
              Link down — polling paused
            </p>
            <p className="text-sm text-muted-foreground">{linkDown}</p>
            <p className="pt-0.5 text-xs text-muted-foreground">
              Your settings, meter and counters are kept. The port has been
              released, so another program can take it — or you can take it
              back with Reconnect.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={reconnecting}
              onClick={() => void handleReconnect()}
            >
              {reconnecting ? "Reconnecting…" : "↻ Reconnect"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={reconnecting}
              onClick={() => navigate("/scan")}
            >
              Change settings
            </Button>
          </div>
        </div>
      )}

      <section className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
        <MeterSelector onSelect={(p) => void applyMeterProfile(p)} />

        {activeProfile && pollConfig.blocks.length > 1 && (
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Reads</Label>
            <span
              className="text-sm"
              title="This meter's parameters are too far apart to fetch in one request"
            >
              {pollConfig.blocks.length} requests per poll
            </span>
          </div>
        )}

        {activeProfile && (
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">View</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Going back to the parameter view re-applies the meter's full
                // read plan: raw mode may have replaced it with the single
                // block the poll bar edits, which wouldn't reach every
                // parameter of a multi-request meter.
                if (!parameterView) void applyMeterProfile(activeProfile);
                else setParameterView(false);
              }}
            >
              {parameterView ? "Raw addresses" : "Parameters"}
            </Button>
          </div>
        )}

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
            value={block.function}
            onValueChange={(v) => updateBlock({ function: v as FunctionCode })}
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
            value={block.startAddress}
            onChange={(v) => updateBlock({ startAddress: v })}
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
            value={block.quantity}
            onChange={(v) => updateBlock({ quantity: v })}
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
              disabled={busy || offline}
              title={offline ? "Reconnect first — the link is down" : undefined}
              onClick={() => void handleStart()}
            >
              ▶ Start
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || offline}
            title={offline ? "Reconnect first — the link is down" : undefined}
            onClick={() => void handleReadOnce()}
          >
            ↻ Read once
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offline}
            title={offline ? "Reconnect first — the link is down" : undefined}
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
          footer and action failures up here, which meant two places to look.
          It follows the *current* state only: a good response clears it, so a
          single timeout doesn't leave a red line over live data. While the link
          is down the banner above already says why, so this doesn't repeat it. */}
      {(actionError ?? (offline ? null : lastError)) && (
        <div
          className="flex items-start gap-2 border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="flex-1">
            {actionError ?? (offline ? null : lastError)}
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
        {activeProfile && parameterView ? (
          <ParameterTable
            profile={activeProfile}
            pointRows={pointRows}
            stale={rowsStale}
          />
        ) : (
          <RegisterTable
            rows={rows}
            stale={rowsStale}
            unitId={pollConfig.unitId}
            format={pollConfig.format}
            writable={!bitMode}
            onWriteError={(msg) => setActionError(msg)}
            onWritten={() => void handleReadOnce()}
          />
        )}
      </main>

      <WritePanel
        open={showWrite && !offline}
        onClose={() => setShowWrite(false)}
        unitId={pollConfig.unitId}
        defaultAddress={block.startAddress}
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
