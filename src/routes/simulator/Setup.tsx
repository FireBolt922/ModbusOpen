import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function SimulatorSetup() {
  const navigate = useNavigate();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <h1 className="text-xl font-heading font-semibold">Simulator setup</h1>
      <p className="text-sm text-muted-foreground">
        Slave IDs, register blocks, and device profiles land in M4.
      </p>
      <Button variant="outline" onClick={() => navigate("/")}>
        Back to Home
      </Button>
    </main>
  );
}
