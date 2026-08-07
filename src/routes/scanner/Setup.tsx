import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { errorMessage, listSerialPorts, rtuConnect, tcpConnect } from "@/lib/ipc";
import type { Parity, SerialPortInfo, Transport } from "@/lib/types";
import { useScannerStore } from "@/store/scannerStore";

const BAUD_PRESETS = [1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200];

type FramePreset = "8N1" | "8E1" | "8O1" | "8N2" | "custom";

function framePresetOf(
  dataBits: number,
  parity: Parity,
  stopBits: number,
): FramePreset {
  if (dataBits === 8 && parity === "none" && stopBits === 1) return "8N1";
  if (dataBits === 8 && parity === "even" && stopBits === 1) return "8E1";
  if (dataBits === 8 && parity === "odd" && stopBits === 1) return "8O1";
  if (dataBits === 8 && parity === "none" && stopBits === 2) return "8N2";
  return "custom";
}

function applyFramePreset(preset: FramePreset): {
  dataBits: number;
  parity: Parity;
  stopBits: number;
} | null {
  switch (preset) {
    case "8N1":
      return { dataBits: 8, parity: "none", stopBits: 1 };
    case "8E1":
      return { dataBits: 8, parity: "even", stopBits: 1 };
    case "8O1":
      return { dataBits: 8, parity: "odd", stopBits: 1 };
    case "8N2":
      return { dataBits: 8, parity: "none", stopBits: 2 };
    case "custom":
      return null;
  }
}

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background text-foreground px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function TransportPicker({
  portCount,
  onPick,
}: {
  portCount: number | null;
  onPick: (t: Transport) => void;
}) {
  return (
    <div className="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
      <Card
        className="cursor-pointer transition-colors hover:bg-muted/50"
        onClick={() => onPick("tcp")}
      >
        <CardHeader>
          <CardTitle>TCP</CardTitle>
          <CardDescription>
            Ethernet / Wi-Fi. Device has an IP address.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card
        className="cursor-pointer transition-colors hover:bg-muted/50"
        onClick={() => onPick("rtu")}
      >
        <CardHeader>
          <CardTitle>RTU</CardTitle>
          <CardDescription>
            Serial — RS-485 / RS-232. USB adapter or COM port.
          </CardDescription>
          <p className="pt-2 text-xs text-muted-foreground">
            {portCount === null
              ? "Detecting ports…"
              : portCount === 0
                ? "0 ports detected"
                : `${portCount} port${portCount === 1 ? "" : "s"} detected`}
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}

function TcpForm() {
  const navigate = useNavigate();
  const tcpConfig = useScannerStore((s) => s.tcpConfig);
  const setTcpConfig = useScannerStore((s) => s.setTcpConfig);
  const setConnecting = useScannerStore((s) => s.setConnecting);
  const setConnection = useScannerStore((s) => s.setConnection);
  const connecting = useScannerStore((s) => s.connecting);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      const info = await tcpConnect(tcpConfig);
      setConnection(info, tcpConfig.unitId);
      navigate("/scan/workspace");
    } catch (err) {
      setConnecting(false);
      setError(errorMessage(err));
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>TCP connection</CardTitle>
        <CardDescription>
          Port 502 is the Modbus TCP default; the local test rig uses 5020.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleConnect}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="host">Host or IP</Label>
            <Input
              id="host"
              autoComplete="off"
              spellCheck={false}
              value={tcpConfig.host}
              onChange={(e) => setTcpConfig({ host: e.target.value })}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                min={1}
                max={65535}
                value={tcpConfig.port}
                onChange={(e) =>
                  setTcpConfig({ port: Number(e.target.value) || 0 })
                }
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tcp-unit">Unit / Slave ID</Label>
              <Input
                id="tcp-unit"
                type="number"
                min={1}
                max={247}
                value={tcpConfig.unitId}
                onChange={(e) =>
                  setTcpConfig({ unitId: Number(e.target.value) || 1 })
                }
                required
              />
              <p className="text-xs text-muted-foreground">
                1–247, changeable later
              </p>
            </div>
          </div>

          <button
            type="button"
            className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tcp-timeout">Timeout (ms)</Label>
                <Input
                  id="tcp-timeout"
                  type="number"
                  min={50}
                  max={60000}
                  value={tcpConfig.timeoutMs}
                  onChange={(e) =>
                    setTcpConfig({ timeoutMs: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tcp-retries">Retries</Label>
                <Input
                  id="tcp-retries"
                  type="number"
                  min={0}
                  max={10}
                  value={tcpConfig.retries}
                  onChange={(e) =>
                    setTcpConfig({ retries: Number(e.target.value) || 0 })
                  }
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={connecting} className="self-end">
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RtuForm() {
  const navigate = useNavigate();
  const rtuConfig = useScannerStore((s) => s.rtuConfig);
  const setRtuConfig = useScannerStore((s) => s.setRtuConfig);
  const setConnecting = useScannerStore((s) => s.setConnecting);
  const setConnection = useScannerStore((s) => s.setConnection);
  const connecting = useScannerStore((s) => s.connecting);

  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
  const [portsError, setPortsError] = useState<string | null>(null);
  const [portsLoading, setPortsLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPort, setManualPort] = useState(false);

  const refreshPorts = useCallback(async () => {
    setPortsLoading(true);
    setPortsError(null);
    try {
      const list = await listSerialPorts();
      setPorts(list);
      // Auto-select first port if none chosen or previous vanished.
      if (
        list.length > 0 &&
        (!rtuConfig.port || !list.some((p) => p.portName === rtuConfig.port))
      ) {
        setRtuConfig({ port: list[0].portName });
      }
    } catch (err) {
      setPortsError(errorMessage(err));
    } finally {
      setPortsLoading(false);
    }
  }, [rtuConfig.port, setRtuConfig]);

  useEffect(() => {
    void refreshPorts();
    // Only on mount — refreshPorts identity changes with port selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const framePreset = framePresetOf(
    rtuConfig.dataBits,
    rtuConfig.parity,
    rtuConfig.stopBits,
  );

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!rtuConfig.port.trim()) {
      setError("Pick a serial port (or type a path under Advanced).");
      return;
    }
    setConnecting(true);
    try {
      const info = await rtuConnect(rtuConfig);
      setConnection(info, rtuConfig.unitId);
      navigate("/scan/workspace");
    } catch (err) {
      setConnecting(false);
      setError(errorMessage(err));
    }
  }

  const selectedPort = ports?.find((p) => p.portName === rtuConfig.port);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>RTU connection</CardTitle>
        <CardDescription>
          USB–RS485 adapters and virtual serial pairs. Defaults are 9600 8-N-1.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleConnect}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="serial-port">Serial port</Label>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={portsLoading}
                onClick={() => void refreshPorts()}
              >
                {portsLoading ? "…" : "Refresh"}
              </Button>
            </div>

            {manualPort ? (
              <Input
                id="serial-port"
                autoComplete="off"
                spellCheck={false}
                placeholder="/dev/tty.usbserial-… or COM3"
                value={rtuConfig.port}
                onChange={(e) => setRtuConfig({ port: e.target.value })}
                required
              />
            ) : (
              <select
                id="serial-port"
                className={selectClass}
                value={rtuConfig.port}
                onChange={(e) => setRtuConfig({ port: e.target.value })}
                required
              >
                {(!ports || ports.length === 0) && (
                  <option value="">
                    {portsLoading ? "Scanning…" : "No ports found"}
                  </option>
                )}
                {ports?.map((p) => (
                  <option key={p.portName} value={p.portName}>
                    {p.portName}
                    {p.product ? ` — ${p.product}` : ""}
                  </option>
                ))}
              </select>
            )}

            {selectedPort && (selectedPort.product || selectedPort.manufacturer) && (
              <p className="text-xs text-muted-foreground">
                {selectedPort.product ?? selectedPort.manufacturer}
                {selectedPort.portType ? ` · ${selectedPort.portType}` : ""}
              </p>
            )}

            {portsError && (
              <p className="text-xs text-destructive">{portsError}</p>
            )}
            {!portsError && ports && ports.length === 0 && !manualPort && (
              <p className="text-xs text-muted-foreground">
                No serial ports detected. Plug in your USB-RS485 adapter and
                click Refresh. On Linux you may need to be in the{" "}
                <code className="font-mono">dialout</code> group. You can also
                type a path manually.
              </p>
            )}

            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setManualPort((v) => !v)}
            >
              {manualPort ? "Pick from list" : "Type port path"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="baud">Baud rate</Label>
              <select
                id="baud"
                className={selectClass}
                value={rtuConfig.baudRate}
                onChange={(e) =>
                  setRtuConfig({ baudRate: Number(e.target.value) })
                }
              >
                {BAUD_PRESETS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rtu-unit">Unit / Slave ID</Label>
              <Input
                id="rtu-unit"
                type="number"
                min={1}
                max={247}
                value={rtuConfig.unitId}
                onChange={(e) =>
                  setRtuConfig({ unitId: Number(e.target.value) || 1 })
                }
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frame">Format</Label>
            <select
              id="frame"
              className={selectClass}
              value={framePreset}
              onChange={(e) => {
                const applied = applyFramePreset(e.target.value as FramePreset);
                if (applied) setRtuConfig(applied);
              }}
            >
              <option value="8N1">8-N-1 (most common)</option>
              <option value="8E1">8-E-1 (spec default)</option>
              <option value="8O1">8-O-1</option>
              <option value="8N2">8-N-2</option>
              {framePreset === "custom" && (
                <option value="custom">Custom (see Advanced)</option>
              )}
            </select>
            <p className="text-xs text-muted-foreground">
              data bits · parity · stop bits
            </p>
          </div>

          <button
            type="button"
            className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="data-bits">Data bits</Label>
                <select
                  id="data-bits"
                  className={selectClass}
                  value={rtuConfig.dataBits}
                  onChange={(e) =>
                    setRtuConfig({ dataBits: Number(e.target.value) })
                  }
                >
                  <option value={8}>8</option>
                  <option value={7}>7</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="parity">Parity</Label>
                <select
                  id="parity"
                  className={selectClass}
                  value={rtuConfig.parity}
                  onChange={(e) =>
                    setRtuConfig({ parity: e.target.value as Parity })
                  }
                >
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stop-bits">Stop bits</Label>
                <select
                  id="stop-bits"
                  className={selectClass}
                  value={rtuConfig.stopBits}
                  onChange={(e) =>
                    setRtuConfig({ stopBits: Number(e.target.value) })
                  }
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rtu-timeout">Timeout (ms)</Label>
                <Input
                  id="rtu-timeout"
                  type="number"
                  min={50}
                  max={60000}
                  value={rtuConfig.timeoutMs}
                  onChange={(e) =>
                    setRtuConfig({ timeoutMs: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="col-span-2 flex flex-col gap-1.5">
                <Label htmlFor="ifd">Inter-frame delay (µs)</Label>
                <Input
                  id="ifd"
                  type="number"
                  min={0}
                  placeholder="auto (3.5 char times)"
                  value={rtuConfig.interFrameDelayUs ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setRtuConfig({
                      interFrameDelayUs: v === "" ? null : Number(v) || 0,
                    });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty for auto (spec: 3.5 character times; 1750 µs above
                  19200 baud).
                </p>
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={connecting} className="self-end">
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ScannerSetup() {
  const navigate = useNavigate();
  const preferred = useScannerStore((s) => s.preferredTransport);
  const setPreferred = useScannerStore((s) => s.setPreferredTransport);
  const [portCount, setPortCount] = useState<number | null>(null);

  useEffect(() => {
    void listSerialPorts()
      .then((ports) => setPortCount(ports.length))
      .catch(() => setPortCount(0));
  }, []);

  const title =
    preferred === "tcp"
      ? "Scan over TCP"
      : preferred === "rtu"
        ? "Scan over RTU (serial)"
        : "Scan — choose a connection";

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-6 py-12">
      <div className="flex w-full max-w-2xl items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (preferred) setPreferred(null);
            else navigate("/");
          }}
        >
          ← Back
        </Button>
        <h1 className="text-lg font-heading font-semibold">{title}</h1>
        <div className="w-16" />
      </div>

      {!preferred && (
        <TransportPicker
          portCount={portCount}
          onPick={(t) => setPreferred(t)}
        />
      )}
      {preferred === "tcp" && <TcpForm />}
      {preferred === "rtu" && <RtuForm />}
    </main>
  );
}
