import { Button } from "@/components/ui/button";
import type { ServiceStatus } from "@/lib/types";

type Props = {
  /** The service about to be stopped, or null when the dialog is closed. */
  service: ServiceStatus | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Confirmation before stopping a service.
 *
 * View is open — no password. A stop can't silently become permanent, because
 * the service returns by itself in 30 minutes. What the operator needs is to
 * know what they're about to do and how to undo it from this same tab.
 *
 * Hand-rolled modal, following `components/meters/PresetPicker.tsx`.
 */
export function StopServiceDialog({
  service,
  busy,
  onCancel,
  onConfirm,
}: Props) {
  if (!service) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[18vh]"
      role="dialog"
      aria-modal="true"
      aria-label={`Stop ${service.unit}`}
      onClick={() => {
        if (!busy) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-heading text-base font-semibold">Stop this service?</h2>
        <p className="mt-1 font-mono text-sm">{service.unit}</p>
        {service.description && (
          <p className="text-sm text-muted-foreground">{service.description}</p>
        )}

        <div className="mt-4 flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <p>
            It will stop now and stay down for{" "}
            <span className="font-medium">30 minutes</span>, then start again
            by itself so nothing stays down by accident.
          </p>
          <p className="text-muted-foreground">
            You can start it again yourself at any time from this View tab —
            the Start button appears on this row as soon as it stops.
          </p>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          To keep it stopped for good, use{" "}
          <span className="font-medium">Keep stopped</span> on the row
          afterwards.
        </p>

        <div className="mt-4 flex gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Stopping…" : "Stop service"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
