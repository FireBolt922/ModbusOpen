import { useEffect, useState } from "react";
import { getAppVersion } from "@/lib/ipc";

export default function AppVersion() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getAppVersion()
      .then((appVersion) => {
        if (!cancelled) setVersion(appVersion);
      })
      .catch(() => {
        // The frontend can also run in a browser during development, where
        // Tauri's app API is unavailable. Do not show a misleading fallback.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (version === null) return null;

  return (
    <div
      aria-label={`FireBolt version ${version}`}
      className="pointer-events-none fixed right-4 bottom-3 z-50 select-none rounded-md border border-border/60 bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
    >
      FireBolt — v{version}
    </div>
  );
}
