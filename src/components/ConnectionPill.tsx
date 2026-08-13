import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Props = {
  connected: boolean;
  summary: string | null;
  /**
   * The session is still set up but the transport dropped. Distinct from
   * disconnected: the settings are intact and one click brings it back.
   */
  linkDown?: boolean;
  /** Mid-reconnect — shown so the pill isn't red while we're fixing it. */
  reconnecting?: boolean;
  className?: string;
};

export function ConnectionPill({
  connected,
  summary,
  linkDown = false,
  reconnecting = false,
  className,
}: Props) {
  const state = reconnecting
    ? { label: "Reconnecting…", dot: "bg-amber-400", variant: "outline" as const }
    : linkDown
      ? { label: "Link down", dot: "bg-destructive", variant: "outline" as const }
      : connected
        ? { label: "Connected", dot: "bg-emerald-400", variant: "default" as const }
        : {
            label: "Disconnected",
            dot: "bg-muted-foreground",
            variant: "outline" as const,
          };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Badge variant={state.variant}>
        <span
          className={cn(
            "mr-1.5 inline-block size-1.5 rounded-full",
            state.dot,
            reconnecting && "animate-pulse",
          )}
        />
        {state.label}
      </Badge>
      {summary && (
        <span className="font-mono text-sm text-muted-foreground">{summary}</span>
      )}
    </div>
  );
}
