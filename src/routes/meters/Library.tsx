import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  commitMeterImport,
  deleteMeterProfile,
  duplicateMeterProfile,
  errorMessage,
  exportMeterProfiles,
  listMeterProfiles,
  meterProfileToSimulator,
  pickOpenPath,
  pickSavePath,
  previewMeterImport,
} from "@/lib/ipc";
import type { MeterImportChoice, MeterProfile } from "@/lib/types";
import { useMeterStore } from "@/store/meterStore";
import { useSimulatorStore } from "@/store/simulatorStore";

function sourceLabel(p: MeterProfile): string {
  switch (p.source.kind) {
    case "built_in":
      return "Built-in";
    case "user":
      return "Mine";
    case "imported":
      return "Imported";
  }
}

function isEditable(p: MeterProfile): boolean {
  return p.source.kind !== "built_in";
}

export default function MeterLibraryPage() {
  const navigate = useNavigate();
  const profiles = useMeterStore((s) => s.profiles);
  const setProfiles = useMeterStore((s) => s.setProfiles);
  const setActiveProfileId = useMeterStore((s) => s.setActiveProfileId);
  const replaceConfig = useSimulatorStore((s) => s.replaceConfig);

  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    try {
      setProfiles(await listMeterProfiles());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = profiles.filter(
      (p) =>
        !q ||
        p.brand.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    );
    const map = new Map<string, MeterProfile[]>();
    for (const p of filtered) {
      const list = map.get(p.brand) ?? [];
      list.push(p);
      map.set(p.brand, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [profiles, query]);

  async function handleExport(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const path = await pickSavePath(`${id}.mbmeter.json`);
      if (!path) return;
      const written = await exportMeterProfiles([id], path);
      setMessage(`Exported to ${written}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    setBusy(true);
    setMessage(null);
    try {
      const path = await pickOpenPath();
      if (!path) return;
      const preview = await previewMeterImport(path);
      const resolutions: MeterImportChoice[] = preview.items
        .filter((i) => i.status === "duplicate_id")
        .map((i) => ({
          profileId: i.profile.id,
          resolution: "rename",
          newId: `${i.profile.id}-imported`,
        }));
      const invalid = preview.items.filter((i) => i.status === "invalid");
      if (invalid.length > 0 && preview.items.every((i) => i.status === "invalid")) {
        setError(
          invalid[0]?.message ??
            "Import file is invalid — nothing was written.",
        );
        return;
      }
      const saved = await commitMeterImport(path, resolutions);
      await refresh();
      setMessage(
        `Imported ${saved.length} meter(s)` +
          (invalid.length
            ? ` (${invalid.length} invalid skipped)`
            : ""),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDuplicate(p: MeterProfile) {
    setBusy(true);
    try {
      const newId = `${p.id}-copy`;
      await duplicateMeterProfile(p.id, newId);
      await refresh();
      navigate(`/meters/edit/${newId}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(p: MeterProfile) {
    if (!window.confirm(`Delete meter “${p.brand} ${p.model}”?`)) return;
    setBusy(true);
    try {
      await deleteMeterProfile(p.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function useInScanner(p: MeterProfile) {
    setActiveProfileId(p.id);
    navigate("/scan");
  }

  async function loadInSimulator(p: MeterProfile) {
    setBusy(true);
    try {
      const cfg = await meterProfileToSimulator(p.id, 5021, 1000);
      replaceConfig(cfg);
      setMessage(
        `Loaded “${p.brand} ${p.model}” into simulator setup — start it from Simulate.`,
      );
      navigate("/simulate");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-heading font-semibold">Meters</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Built-in brand maps, your custom meters, and shareable packs.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/")}>
            Home
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleImport()}
          >
            Import…
          </Button>
          <Button size="sm" onClick={() => navigate("/meters/edit/new")}>
            New meter
          </Button>
        </div>
      </div>

      <Input
        placeholder="Filter by brand or model…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-md"
      />

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      )}

      {grouped.map(([brand, list]) => (
        <section key={brand} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
            {brand}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((p) => (
              <Card key={p.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{p.model}</CardTitle>
                      <CardDescription className="font-mono text-xs">
                        {p.id}
                      </CardDescription>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="outline">{sourceLabel(p)}</Badge>
                      {p.points.some((pt) => pt.unverified) && (
                        <Badge variant="outline" className="text-[0.65rem]">
                          Unverified
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">
                    {p.points.length} parameters · wire {p.blockStart}×
                    {p.blockCount} · unit {p.defaultUnitId}
                  </p>
                  {p.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => useInScanner(p)}
                    >
                      Use in scanner
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void loadInSimulator(p)}
                    >
                      Load in simulator
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleDuplicate(p)}
                    >
                      Duplicate
                    </Button>
                    {isEditable(p) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/meters/edit/${p.id}`)}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleExport(p.id)}
                    >
                      Export
                    </Button>
                    {isEditable(p) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleDelete(p)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      {grouped.length === 0 && (
        <p className="text-sm text-muted-foreground">No meters match.</p>
      )}
    </main>
  );
}
