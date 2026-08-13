import type { ServiceStatus } from "./types";

/**
 * How a service reads on screen. Colour carries state and nothing else, per
 * `docs/04-ux-flows.md` — green running, amber in transition, red failed,
 * muted stopped.
 */
export type ServiceTone =
  | "running"
  | "stopped"
  | "failed"
  | "transitional"
  | "missing";

export function serviceTone(service: ServiceStatus): ServiceTone {
  if (!service.loadState || service.loadState === "not-found") return "missing";
  switch (service.activeState) {
    case "active":
      return "running";
    case "failed":
      return "failed";
    case "activating":
    case "deactivating":
      return "transitional";
    default:
      return "stopped";
  }
}

export function serviceLabel(service: ServiceStatus): string {
  switch (serviceTone(service)) {
    case "missing":
      return "Not installed";
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    case "transitional":
      return service.activeState === "activating" ? "Starting…" : "Stopping…";
    default:
      return "Stopped";
  }
}

/** Tailwind classes for the state dot, keyed by tone. */
export const TONE_DOT: Record<ServiceTone, string> = {
  running: "bg-emerald-500",
  stopped: "bg-muted-foreground/50",
  failed: "bg-destructive",
  transitional: "bg-amber-500",
  missing: "bg-destructive/40",
};

/** Tailwind classes for the state text, keyed by tone. */
export const TONE_TEXT: Record<ServiceTone, string> = {
  running: "text-emerald-500",
  stopped: "text-muted-foreground",
  failed: "text-destructive",
  transitional: "text-amber-500",
  missing: "text-destructive",
};

export function isRunning(service: ServiceStatus): boolean {
  return service.activeState === "active";
}

export function isBusy(service: ServiceStatus): boolean {
  return (
    service.activeState === "activating" ||
    service.activeState === "deactivating"
  );
}

export function exists(service: ServiceStatus): boolean {
  return Boolean(service.loadState) && service.loadState !== "not-found";
}

/**
 * True when the operator has taken this unit out of service at the OS level.
 * The backend won't auto-restart these, and the UI says so rather than
 * promising a return that will never come.
 */
export function isOperatorHeld(service: ServiceStatus): boolean {
  return (
    service.unitFileState === "disabled" ||
    service.unitFileState === "masked" ||
    service.loadState === "masked"
  );
}

/** "Uncategorised" is a real bucket, not a blank heading. */
export function categoryOf(service: { category: string }): string {
  return service.category.trim() || "Uncategorised";
}

/**
 * Time left as a short human phrase: "29 min", "45 sec", "now".
 * `deadline` is RFC3339 from the backend; `now` is a millisecond timestamp.
 */
export function formatRemaining(deadline: string, now: number): string {
  const ms = new Date(deadline).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** Clock time a hold expires, e.g. "14:32". */
export function formatClock(deadline: string): string {
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
