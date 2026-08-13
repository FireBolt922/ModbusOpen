import { useEffect, useState } from "react";

/**
 * A clock that ticks, for live countdowns (the auto-restart timer, the unlock
 * expiry). Returns `Date.now()`.
 *
 * This is a display clock only — it never drives a fetch. Backend state
 * arrives on `service-status` events, per the no-polling-from-the-UI rule.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
