import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function ScannerWorkspace() {
  const navigate = useNavigate();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <h1 className="text-xl font-heading font-semibold">
        Scanner workspace
      </h1>
      <p className="text-sm text-muted-foreground">
        Poll bar, live register table, and stats footer land in M1.
      </p>
      <Button variant="outline" onClick={() => navigate("/")}>
        Back to Home
      </Button>
    </main>
  );
}
