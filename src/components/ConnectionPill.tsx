import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Props = {
  connected: boolean;
  summary: string | null;
  className?: string;
};

export function ConnectionPill({ connected, summary, className }: Props) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Badge variant={connected ? "default" : "outline"}>
        <span
          className={cn(
            "mr-1.5 inline-block size-1.5 rounded-full",
            connected ? "bg-emerald-400" : "bg-muted-foreground",
          )}
        />
        {connected ? "Connected" : "Disconnected"}
      </Badge>
      {summary && (
        <span className="font-mono text-sm text-muted-foreground">{summary}</span>
      )}
    </div>
  );
}
