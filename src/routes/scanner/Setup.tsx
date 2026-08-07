import { useState } from "react";
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
import { errorMessage, tcpConnect } from "@/lib/ipc";
import { useScannerStore } from "@/store/scannerStore";

export default function ScannerSetup() {
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
      setConnection(info);
      navigate("/scan/workspace");
    } catch (err) {
      setConnecting(false);
      setError(errorMessage(err));
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-6 py-12">
      <div className="flex w-full max-w-md items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          ← Back
        </Button>
        <h1 className="text-lg font-heading font-semibold">Scan over TCP</h1>
        <div className="w-16" />
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>TCP connection</CardTitle>
          <CardDescription>
            Device has an IP. Port 502 is the Modbus TCP default; the local
            test rig uses 5020.
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
                <Label htmlFor="unitId">Unit / Slave ID</Label>
                <Input
                  id="unitId"
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
                  <Label htmlFor="timeout">Timeout (ms)</Label>
                  <Input
                    id="timeout"
                    type="number"
                    min={50}
                    max={60000}
                    value={tcpConfig.timeoutMs}
                    onChange={(e) =>
                      setTcpConfig({
                        timeoutMs: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="retries">Retries</Label>
                  <Input
                    id="retries"
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

      <p className="max-w-md text-center text-xs text-muted-foreground">
        RTU (serial) connections land in M2. Local test slave:{" "}
        <code className="font-mono">python testrig/slave.py</code> on port 5020.
      </p>
    </main>
  );
}
