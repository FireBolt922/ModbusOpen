import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useNow } from "@/hooks/useNow";
import {
  errorMessage,
  servicesLock,
  servicesPlatform,
  servicesSupported,
  servicesUnlockState,
} from "@/lib/ipc";
import { formatRemaining } from "@/lib/serviceState";
import { cn } from "@/lib/utils";
import { LOCKED, useServicesStore } from "@/store/servicesStore";
import ServicesConfigure from "./Configure";
import ServicesView from "./View";

const PLATFORM_NAMES: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

function platformName(os: string): string {
  return PLATFORM_NAMES[os] ?? os;
}

export default function ServicesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const now = useNow();

  const supported = useServicesStore((s) => s.supported);
  const platform = useServicesStore((s) => s.platform);
  const setSupported = useServicesStore((s) => s.setSupported);
  const unlock = useServicesStore((s) => s.unlock);
  const setUnlock = useServicesStore((s) => s.setUnlock);
  const resetSession = useServicesStore((s) => s.resetSession);

  const [error, setError] = useState<string | null>(null);
  const configuring = location.pathname.endsWith("/configure");

  useEffect(() => {
    (async () => {
      try {
        const [ok, os] = await Promise.all([
          servicesSupported(),
          servicesPlatform(),
        ]);
        setSupported(ok, os);
        if (ok) setUnlock(await servicesUnlockState());
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
    return () => resetSession();
  }, [setSupported, setUnlock, resetSession]);

  // The 30 minutes is owned by Rust; this only keeps the screen honest about
  // it, so a lapsed unlock stops showing Configure the moment it expires.
  useEffect(() => {
    if (!unlock.unlocked || !unlock.expiresAt) return;
    const ms = new Date(unlock.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      setUnlock(LOCKED);
      return;
    }
    const id = setTimeout(() => setUnlock(LOCKED), ms);
    return () => clearTimeout(id);
  }, [unlock.unlocked, unlock.expiresAt, setUnlock]);

  async function lockNow() {
    try {
      await servicesLock();
    } catch {
      // Locking is best-effort: the window expires on its own regardless.
    }
    setUnlock(LOCKED);
  }

  if (supported === null) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (!supported) {
    return (
      <main className="flex min-h-screen flex-col items-center gap-6 px-6 py-16">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Linux only</CardTitle>
            <CardDescription>
              Service control talks to the Linux service manager, which{" "}
              {platformName(platform)} doesn&apos;t have. Open ModbusOpen on the
              Linux machine that runs your capture and sync services to use this
              screen.
            </CardDescription>
          </CardHeader>
        </Card>
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          Back to home
        </Button>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <h1 className="font-heading text-base font-semibold">Services</h1>

        {unlock.unlocked && unlock.expiresAt && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Unlocked · {formatRemaining(unlock.expiresAt, now)} left
            <button type="button" className="underline" onClick={lockNow}>
              Lock now
            </button>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <nav
            aria-label="Services section"
            className="flex gap-1 rounded-md border border-border p-0.5"
          >
            <button
              type="button"
              aria-current={!configuring ? "page" : undefined}
              className={cn(
                "rounded px-3 py-1 text-sm transition-colors",
                !configuring
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => navigate("/services")}
            >
              View
            </button>
            <button
              type="button"
              aria-current={configuring ? "page" : undefined}
              className={cn(
                "rounded px-3 py-1 text-sm transition-colors",
                configuring
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => navigate("/services/configure")}
            >
              Configure
            </button>
          </nav>

          <Button variant="outline" size="sm" onClick={() => navigate("/")}>
            Home
          </Button>
        </div>
      </header>

      {error && (
        <div
          className="border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {configuring ? <ServicesConfigure /> : <ServicesView />}
    </div>
  );
}
