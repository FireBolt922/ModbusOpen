import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DisableInstructions } from "@/components/services/DisableInstructions";
import { UnlockForm } from "@/components/services/UnlockForm";
import {
  errorMessage,
  getServicesConfig,
  listMonitoredServices,
  saveServicesConfig,
  validateServiceUnits,
} from "@/lib/ipc";
import { categoryOf } from "@/lib/serviceState";
import { cn } from "@/lib/utils";
import type {
  ServiceEntry,
  ServiceStatus,
  ServiceSubcategory,
  ServicesConfig,
} from "@/lib/types";
import { useServicesStore } from "@/store/servicesStore";

const SUBCATEGORIES: { id: ServiceSubcategory; label: string }[] = [
  { id: "capture", label: "Capture" },
  { id: "sync", label: "Sync" },
];

/** One checked name waiting to be added. */
type Draft = {
  unit: string;
  valid: boolean;
  description: string;
  message: string;
  /** Already in the monitored list — reported rather than silently merged. */
  duplicate: boolean;
};

function SubcategoryToggle({
  value,
  onChange,
  size = "sm",
}: {
  value: ServiceSubcategory;
  onChange: (v: ServiceSubcategory) => void;
  size?: "sm" | "xs";
}) {
  return (
    <div className="flex gap-1 rounded-md border border-border p-0.5">
      {SUBCATEGORIES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          className={cn(
            "rounded transition-colors",
            size === "xs" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
            value === option.id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default function ServicesConfigure() {
  const unlock = useServicesStore((s) => s.unlock);
  const config = useServicesStore((s) => s.config);
  const setConfig = useServicesStore((s) => s.setConfig);

  const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [names, setNames] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState<ServiceSubcategory>("capture");
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disableFor, setDisableFor] = useState<string | null>(null);

  // Load once the tab is unlocked. `reload` is deliberately not a dependency:
  // it closes over setState only, and re-running this on every render would
  // refetch the whole config on every keystroke.
  useEffect(() => {
    if (!unlock.unlocked) return;
    void reload();
  }, [unlock.unlocked]);

  async function reload() {
    try {
      const [loaded, live] = await Promise.all([
        getServicesConfig(),
        listMonitoredServices(),
      ]);
      setConfig(loaded);
      setStatuses(live);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const knownCategories = useMemo(() => {
    const names = new Set(
      config.services.map((s) => s.category.trim()).filter(Boolean),
    );
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [config.services]);

  async function persist(services: ServiceEntry[], note: string) {
    setSaving(true);
    setError(null);
    try {
      const next: ServicesConfig = { version: config.version || 1, services };
      setConfig(await saveServicesConfig(next));
      setMessage(note);
      const live = await listMonitoredServices();
      setStatuses(live);
    } catch (err) {
      setError(errorMessage(err));
      // The write failed, so what's on screen may be ahead of what's saved.
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function validate() {
    setValidating(true);
    setError(null);
    setMessage(null);
    try {
      const results = await validateServiceUnits(names);
      const existing = new Set(config.services.map((s) => s.unit));
      setDrafts(
        results.map((r) => ({
          unit: r.unit,
          valid: r.valid && !existing.has(r.unit),
          description: r.description ?? "",
          message: existing.has(r.unit)
            ? "Already in the list — remove it below first to re-add it."
            : r.message,
          duplicate: existing.has(r.unit),
        })),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setValidating(false);
    }
  }

  async function addValidated() {
    if (!drafts) return;
    const additions: ServiceEntry[] = drafts
      .filter((d) => d.valid)
      .map((d) => ({
        unit: d.unit,
        description: d.description.trim(),
        category: category.trim(),
        subcategory,
      }));
    if (additions.length === 0) return;

    await persist(
      [...config.services, ...additions],
      `Added ${additions.length} service${additions.length === 1 ? "" : "s"}.`,
    );
    setNames("");
    setDrafts(null);
  }

  async function updateEntry(unit: string, patch: Partial<ServiceEntry>) {
    await persist(
      config.services.map((s) => (s.unit === unit ? { ...s, ...patch } : s)),
      "Saved.",
    );
  }

  async function removeEntry(unit: string) {
    await persist(
      config.services.filter((s) => s.unit !== unit),
      `Removed ${unit}. The service itself was left exactly as it is.`,
    );
    setDisableFor((current) => (current === unit ? null : current));
  }

  if (!unlock.unlocked) {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center px-4 py-16">
        <div className="w-full max-w-sm rounded-lg border border-border p-5">
          <h2 className="font-heading text-base font-semibold">
            Configure services
          </h2>
          <div className="mt-3">
            <UnlockForm
              autoFocus
              blurb="Changing which services are monitored is password protected."
              onUnlocked={reload}
            />
          </div>
        </div>
      </div>
    );
  }

  const grouped = [
    ...config.services
      .reduce((map, entry) => {
        const key = categoryOf(entry);
        map.set(key, [...(map.get(key) ?? []), entry]);
        return map;
      }, new Map<string, ServiceEntry[]>())
      .entries(),
  ].sort(([a], [b]) => a.localeCompare(b));

  const addable = drafts?.filter((d) => d.valid).length ?? 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error && (
        <div
          className="flex items-start gap-3 border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6">
        {/* ---- Step 1: name the services --------------------------------- */}
        <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="font-heading text-base font-semibold">
              Add services
            </h2>
            <p className="text-sm text-muted-foreground">
              Type one service name, or several separated by commas. The
              <span className="font-mono"> .service</span> ending is added for
              you.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="service-names"
              className="text-xs text-muted-foreground"
            >
              Service names
            </Label>
            <textarea
              id="service-names"
              rows={2}
              value={names}
              onChange={(e) => {
                setNames(e.target.value);
                setDrafts(null);
              }}
              placeholder="meter-poll, mqtt-bridge, data-sync"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={validate}
              disabled={validating || names.trim().length === 0}
            >
              {validating ? "Checking…" : "Validate"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Checks each name against this machine before it can be added.
            </span>
          </div>

          {/* ---- Step 2: confirm what was found -------------------------- */}
          {drafts && drafts.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <div>
                <h3 className="text-sm font-medium">
                  Description for each service
                </h3>
                <p className="text-xs text-muted-foreground">
                  Every service gets its own description. The system&apos;s
                  wording is filled in — change it if you want something
                  clearer.
                </p>
              </div>
              {drafts.map((draft, index) => (
                <div
                  key={draft.unit}
                  className="flex flex-wrap items-start gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span
                    className={cn(
                      "mt-1 shrink-0 text-sm",
                      draft.valid ? "text-emerald-500" : "text-destructive",
                    )}
                    aria-hidden="true"
                  >
                    {draft.valid ? "✓" : "✕"}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-mono text-sm">{draft.unit}</span>
                    <span
                      className={cn(
                        "text-xs",
                        draft.valid
                          ? "text-muted-foreground"
                          : "text-destructive",
                      )}
                    >
                      {draft.message}
                    </span>
                    {draft.valid && (
                      <div className="mt-1 flex flex-col gap-1">
                        <Label
                          htmlFor={`draft-description-${index}`}
                          className="text-xs text-muted-foreground"
                        >
                          Description
                        </Label>
                        <Input
                          id={`draft-description-${index}`}
                          aria-label={`Description for ${draft.unit}`}
                          className="h-8"
                          placeholder="What this service does"
                          value={draft.description}
                          onChange={(e) => {
                            const value = e.target.value;
                            setDrafts((current) =>
                              current
                                ? current.map((d, i) =>
                                    i === index
                                      ? { ...d, description: value }
                                      : d,
                                  )
                                : current,
                            );
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* ---- Step 3: file them ----------------------------------- */}
              {addable > 0 && (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                  <div className="flex flex-col gap-1">
                    <Label
                      htmlFor="service-category"
                      className="text-xs text-muted-foreground"
                    >
                      Category
                    </Label>
                    <Input
                      id="service-category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      placeholder="Meters, Gateway, Reporting…"
                    />
                    {knownCategories.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {knownCategories.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
                            onClick={() => setCategory(name)}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Group</span>
                    <SubcategoryToggle
                      value={subcategory}
                      onChange={setSubcategory}
                    />
                  </div>

                  <div>
                    <Button size="sm" onClick={addValidated} disabled={saving}>
                      Add {addable} service{addable === 1 ? "" : "s"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {drafts && drafts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing to check — type at least one service name.
            </p>
          )}
        </section>

        {/* ---- The monitored list ---------------------------------------- */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-base font-semibold">
              Monitored services
            </h2>
            <span className="text-sm text-muted-foreground">
              {config.services.length}
            </span>
            {message && (
              <span className="ml-auto text-sm text-muted-foreground" role="status">
                {message}
              </span>
            )}
          </div>

          {config.services.length === 0 ? (
            <p className="rounded-md border border-border p-6 text-sm text-muted-foreground">
              Nothing is being monitored yet. Add a service above and it will
              appear on the View tab.
            </p>
          ) : (
            grouped.map(([groupName, entries]) => (
              <div key={groupName} className="flex flex-col gap-2">
                <h3 className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
                  {groupName}
                </h3>
                {entries.map((entry) => {
                  const status =
                    statuses.find((s) => s.unit === entry.unit) ?? null;
                  return (
                    <div key={entry.unit} className="flex flex-col gap-2">
                      <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <span
                            className="min-w-0 break-all font-mono text-sm"
                            title={entry.unit}
                          >
                            {entry.unit}
                          </span>
                          <div className="flex shrink-0 gap-1">
                            {status && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() =>
                                  setDisableFor(
                                    disableFor === entry.unit
                                      ? null
                                      : entry.unit,
                                  )
                                }
                              >
                                Disable…
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => void removeEntry(entry.unit)}
                              disabled={saving}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Input
                            aria-label={`Description for ${entry.unit}`}
                            className="h-8 min-w-0 flex-1"
                            defaultValue={entry.description}
                            placeholder="Description"
                            onBlur={(e) => {
                              if (e.target.value !== entry.description) {
                                void updateEntry(entry.unit, {
                                  description: e.target.value,
                                });
                              }
                            }}
                          />
                          <Input
                            aria-label={`Category for ${entry.unit}`}
                            className="h-8 w-full sm:w-36"
                            defaultValue={entry.category}
                            placeholder="Category"
                            onBlur={(e) => {
                              if (e.target.value !== entry.category) {
                                void updateEntry(entry.unit, {
                                  category: e.target.value,
                                });
                              }
                            }}
                          />
                          <SubcategoryToggle
                            size="xs"
                            value={entry.subcategory}
                            onChange={(value) =>
                              void updateEntry(entry.unit, {
                                subcategory: value,
                              })
                            }
                          />
                        </div>
                      </div>

                      {disableFor === entry.unit && status && (
                        <DisableInstructions
                          service={status}
                          onRecheck={reload}
                          onClose={() => setDisableFor(null)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}

          <p className="text-xs text-muted-foreground">
            Removing a service here only stops ModbusOpen watching it. The
            service itself keeps running exactly as it was.
          </p>
        </section>
      </div>
    </div>
  );
}
