import { useState } from "react";
import { Button } from "@/components/ui/button";
import { isOperatorHeld } from "@/lib/serviceState";
import type { ServiceStatus } from "@/lib/types";

type Props = {
  service: ServiceStatus;
  /** Re-read state from the system after the operator has run the command. */
  onRecheck: () => void;
  onClose?: () => void;
};

/**
 * Permanently disabling a service is the one thing this app deliberately does
 * *not* do for you.
 *
 * The app never edits a unit file or flips its boot-time state — it hands the
 * exact command over and reads the result back. That keeps every lasting
 * change to the machine a deliberate, logged act by a person with a terminal,
 * and it means nothing here can leave a site in a state its own admins can't
 * explain.
 */
export function DisableInstructions({ service, onRecheck, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const held = isOperatorHeld(service);
  const command = held
    ? `sudo systemctl enable --now ${service.unit}`
    : `sudo systemctl disable --now ${service.unit}`;

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <p className="text-sm">
          {held ? (
            <>
              <span className="font-medium">{service.unit}</span> is disabled, so
              it stays down across restarts and this app won't bring it back. To
              put it back in service, run this in a terminal:
            </>
          ) : (
            <>
              To keep <span className="font-medium">{service.unit}</span> stopped
              for good — past the 30-minute automatic restart and across reboots
              — run this in a terminal:
            </>
          )}
        </p>
        {onClose && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </Button>
        )}
      </div>

      <code className="overflow-x-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-xs whitespace-pre">
        {command}
      </code>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="xs" onClick={copy}>
          {copied ? "Copied" : "Copy command"}
        </Button>
        <Button variant="outline" size="xs" onClick={onRecheck}>
          Recheck
        </Button>
        <span className="text-xs text-muted-foreground">
          Then hit Recheck to update the status here.
        </span>
      </div>
    </div>
  );
}
