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
import { errorMessage, simStart } from "@/lib/ipc";
import {
  useSimulatorStore,
  DEFAULT_SLAVE_CONFIG,
} from "@/store/simulatorStore";

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
  if (!slave) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="flex flex-col gap-1.5">
          <Label>Unit ID</Label>
          <Input
            type="number"
            min={1}
            max={247}
            value={slave.unitId}
            onChange={(e) => onChange({ unitId: Number(e.target.value) || 1 })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Coils</Label>
          <Input
            type="number"
            min={0}
            max={2000}
            value={slave.coilCount}
            onChange={(e) =>
              onChange({ coilCount: Number(e.target.value) || 0 })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Discretes</Label>
          <Input
            type="number"
            min={0}
            max={2000}
            value={slave.discreteCount}
            onChange={(e) =>
              onChange({ discreteCount: Number(e.target.value) || 0 })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Input regs</Label>
          <Input
            type="number"
            min={0}
            max={125}
            value={slave.inputRegisterCount}
            onChange={(e) =>
              onChange({ inputRegisterCount: Number(e.target.value) || 0 })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Holding regs</Label>
          <Input
            type="number"
            min={0}
            max={125}
            value={slave.holdingRegisterCount}
            onChange={(e) =>
              onChange({ holdingRegisterCount: Number(e.target.value) || 0 })
            }
          />
        </div>
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sim-port">TCP port</Label>
              <Input
                id="sim-port"
                type="number"
                min={1}
                max={65535}
                value={config.tcpPort}
                onChange={(e) =>
                  setConfig({ tcpPort: Number(e.target.value) || 0 })
                }
                required
              />
              <p className="text-xs text-muted-foreground">
                5021 avoids clashing with the local test-rig slave on 5020.
              </p>
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
