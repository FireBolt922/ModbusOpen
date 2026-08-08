import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorMessage, listMeterProfiles } from "@/lib/ipc";
import type { MeterProfile } from "@/lib/types";
import { useMeterStore } from "@/store/meterStore";
import { cn } from "@/lib/utils";

type Props = {
  onSelect: (profile: MeterProfile | null) => void;
};

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

function isUnverified(p: MeterProfile): boolean {
  return p.points.some((pt) => pt.unverified);
}

export function MeterSelector({ onSelect }: Props) {
  const navigate = useNavigate();
  const profiles = useMeterStore((s) => s.profiles);
  const setProfiles = useMeterStore((s) => s.setProfiles);
  const activeProfileId = useMeterStore((s) => s.activeProfileId);
  const loaded = useMeterStore((s) => s.loaded);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) return;
    void listMeterProfiles()
      .then(setProfiles)
      .catch((err) => setLoadError(errorMessage(err)));
  }, [loaded, setProfiles]);

  const active = profiles.find((p) => p.id === activeProfileId) ?? null;

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = profiles.filter((p) => {
      if (!q) return true;
      return (
        p.brand.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
      );
    });
    const map = new Map<string, MeterProfile[]>();
    for (const p of filtered) {
      const list = map.get(p.brand) ?? [];
      list.push(p);
      map.set(p.brand, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [profiles, query]);

  function choose(profile: MeterProfile | null) {
    onSelect(profile);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">Meter</Label>
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="min-w-[12rem] justify-between font-normal"
              aria-label="Select meter profile"
            >
              <span className="truncate">
                {active
                  ? `${active.brand} ${active.model}`
                  : "No meter (raw addresses)"}
              </span>
              {active && isUnverified(active) && (
                <Badge variant="outline" className="ml-2 shrink-0 text-[0.65rem]">
                  Unverified
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-2" align="start">
            <Input
              autoFocus
              placeholder="Search brand or model…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mb-2 h-8"
            />
            {loadError && (
              <p className="px-1 text-xs text-destructive">{loadError}</p>
            )}
            <div className="max-h-72 overflow-y-auto">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  !active && "bg-muted",
                )}
                onClick={() => choose(null)}
              >
                No meter (raw addresses)
              </button>
              {grouped.map(([brand, list]) => (
                <div key={brand} className="mt-2">
                  <div className="px-2 py-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
                    {brand}
                  </div>
                  {list.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                        active?.id === p.id && "bg-muted",
                      )}
                      onClick={() => choose(p)}
                    >
                      <span className="truncate">{p.model}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {isUnverified(p) && (
                          <Badge
                            variant="outline"
                            className="text-[0.6rem]"
                            title="Data type/scale not confirmed against meter_codes — values may be wrong"
                          >
                            Unverified
                          </Badge>
                        )}
                        <span className="text-[0.65rem] text-muted-foreground">
                          {sourceLabel(p)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {grouped.length === 0 && !loadError && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No meters match.
                </p>
              )}
            </div>
            <div className="mt-2 border-t border-border pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setOpen(false);
                  navigate("/meters");
                }}
              >
                Manage meters…
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
