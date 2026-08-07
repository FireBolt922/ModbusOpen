import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage, listSerialPorts } from "@/lib/ipc";
import type { SerialPortInfo } from "@/lib/types";

function SerialPortPanel() {
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setPorts(await listSerialPorts());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Detected serial ports</CardTitle>
            <CardDescription>
              What the OS currently sees — used later for RTU connections.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && ports && ports.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No serial ports found. Plug in a USB-serial adapter and refresh.
          </p>
        )}
        {!error && ports && ports.length > 0 && (
          <ul className="flex flex-col gap-2">
            {ports.map((port) => (
              <li
                key={port.portName}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="font-mono">{port.portName}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {port.product ?? port.manufacturer ?? ""}
                  <Badge variant="outline">{port.portType}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function Home() {
  const navigate = useNavigate();

  return (
    <main className="flex min-h-screen flex-col items-center gap-10 px-6 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-heading font-semibold">ModbusOpen</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open a mode to get started.
        </p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
        <Card
          className="cursor-pointer transition-colors hover:bg-muted/50"
          onClick={() => navigate("/scan")}
        >
          <CardHeader>
            <CardTitle>Scan</CardTitle>
            <CardDescription>
              Be a Modbus master. Connect over TCP or RTU, poll registers, and
              watch them decode live.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card
          className="cursor-pointer transition-colors hover:bg-muted/50"
          onClick={() => navigate("/simulate")}
        >
          <CardHeader>
            <CardTitle>Simulate</CardTitle>
            <CardDescription>
              Be a Modbus slave. Stand in for a meter, VFD, or PLC so you can
              test a master without hardware.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <SerialPortPanel />
    </main>
  );
}
