import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, servicesUnlock } from "@/lib/ipc";
import { useServicesStore } from "@/store/servicesStore";

type Props = {
  /** Shown above the field, so each entry point can say why it's asking. */
  blurb: string;
  onUnlocked: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
};

/**
 * The one place the configuration password is entered. The check itself lives
 * in Rust — this only reports the result — so the 30-minute window can't drift
 * between screens.
 */
export function UnlockForm({ blurb, onUnlocked, onCancel, autoFocus }: Props) {
  const setUnlock = useServicesStore((s) => s.setUnlock);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setUnlock(await servicesUnlock(password));
      setPassword("");
      onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">{blurb}</p>

      <div className="flex flex-col gap-1">
        <Label htmlFor="services-password" className="text-xs text-muted-foreground">
          Configuration password
        </Label>
        <Input
          id="services-password"
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Unlocks for 30 minutes, then locks itself again.
      </p>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || password.length === 0}>
          {busy ? "Checking…" : "Unlock"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
