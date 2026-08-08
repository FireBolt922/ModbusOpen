import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { aboutInfo, errorMessage } from "@/lib/ipc";
import type { AboutInfo } from "@/lib/types";
import { useMeterStore } from "@/store/meterStore";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function AboutDialog({ open, onClose }: Props) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const activeProfileId = useMeterStore((s) => s.activeProfileId);
  const profiles = useMeterStore((s) => s.profiles);
  const active = profiles.find((p) => p.id === activeProfileId) ?? null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    void aboutInfo()
      .then(setInfo)
      .catch((err) => setError(errorMessage(err)));
  }, [open]);

  if (!open) return null;

  function diagnosticsBlock(): string {
    const lines = [
      "## ModbusOpen diagnostics",
      "",
      `- App version: ${info?.appVersion ?? "?"}`,
      `- Rust crate: ${info?.appVersion ?? "?"}`,
      `- Tauri: ${info?.tauriVersion ?? "?"}`,
      `- OS: ${info?.os ?? "?"} (${info?.arch ?? "?"})`,
      `- Active meter: ${
        active
          ? `${active.id} (${active.source.kind}) — ${active.brand} ${active.model}`
          : "none (raw addresses)"
      }`,
      `- User agent: ${
        typeof navigator !== "undefined" ? navigator.userAgent : "?"
      }`,
    ];
    return lines.join("\n");
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagnosticsBlock());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader>
          <CardTitle id="about-title">About ModbusOpen</CardTitle>
          <CardDescription>
            Version and environment details for bug reports.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {error && <p className="text-destructive">{error}</p>}
          {info && (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">
                v{info.appVersion}{" "}
                <Badge variant="outline" className="ml-1">
                  {info.os}/{info.arch}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">Tauri</dt>
              <dd className="font-mono">{info.tauriVersion}</dd>
              <dt className="text-muted-foreground">Meter</dt>
              <dd>
                {active
                  ? `${active.brand} ${active.model}`
                  : "None selected"}
              </dd>
            </dl>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => void copyDiagnostics()}>
              {copied ? "Copied" : "Copy diagnostics"}
            </Button>
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
