import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DisableInstructions } from "@/components/services/DisableInstructions";
import { LogViewer } from "@/components/services/LogViewer";
import { ServiceRow } from "@/components/services/ServiceRow";
import { StopServiceDialog } from "@/components/services/StopServiceDialog";
import { useNow } from "@/hooks/useNow";
import {
  errorMessage,
  listMonitoredServices,
  onServiceLog,
  onServiceStatus,
  serviceLogsClose,
  serviceLogsOpen,
  servicesWatchStart,
  servicesWatchStop,
  startService,
  stopService,
} from "@/lib/ipc";
import { categoryOf } from "@/lib/serviceState";
import { cn } from "@/lib/utils";
import type { ServiceStatus, ServiceSubcategory } from "@/lib/types";
import { useServicesStore } from "@/store/servicesStore";

const SUBCATEGORIES: { id: ServiceSubcategory; label: string }[] = [
  { id: "capture", label: "Capture" },
  { id: "sync", label: "Sync" },
];

export default function ServicesView() {
  const navigate = useNavigate();
  // One clock for every countdown on the screen.
  const now = useNow();

  const services = useServicesStore((s) => s.services);
  const servicesLoaded = useServicesStore((s) => s.servicesLoaded);
  const subcategory = useServicesStore((s) => s.subcategory);
  const setSubcategory = useServicesStore((s) => s.setSubcategory);
  const categoryFilter = useServicesStore((s) => s.categoryFilter);
  const toggleCategory = useServicesStore((s) => s.toggleCategory);
  const clearCategoryFilter = useServicesStore((s) => s.clearCategoryFilter);
  const search = useServicesStore((s) => s.search);
  const setSearch = useServicesStore((s) => s.setSearch);
  const setServices = useServicesStore((s) => s.setServices);
  const setWatchSessionId = useServicesStore((s) => s.setWatchSessionId);
  const applyStatus = useServicesStore((s) => s.applyStatus);
  const applyLog = useServicesStore((s) => s.applyLog);
  const logSessionId = useServicesStore((s) => s.logSessionId);
  const openLog = useServicesStore((s) => s.openLog);
  const closeLog = useServicesStore((s) => s.closeLog);

  const [error, setError] = useState<string | null>(null);
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState<ServiceStatus | null>(null);
  const [disableFor, setDisableFor] = useState<string | null>(null);

  // The open log session, mirrored in a ref so unmount cleanup can close it
  // without making the watcher effect depend on it (which would tear down and
  // restart the status watcher every time a log panel opened).
  const logSessionRef = useRef<number | null>(null);
  useEffect(() => {
    logSessionRef.current = logSessionId;
  }, [logSessionId]);

  // The backend owns the cadence: it pushes `service-status` every 3 s while
  // this screen is mounted. The UI never polls a command on a timer.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Promise<() => void>[] = [];

    (async () => {
      try {
        const initial = await listMonitoredServices();
        if (!cancelled) setServices(initial);

        const sessionId = await servicesWatchStart();
        if (cancelled) {
          await servicesWatchStop();
          return;
        }
        setWatchSessionId(sessionId);

        unlisteners.push(
          onServiceStatus((e) => applyStatus(e.sessionId, e.services)),
          onServiceLog((e) => applyLog(e.sessionId, e.lines)),
        );
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();

    return () => {
      cancelled = true;
      void servicesWatchStop();
      setWatchSessionId(null);
      const open = logSessionRef.current;
      if (open != null) void serviceLogsClose(open);
      for (const pending of unlisteners) {
        void pending.then((un) => un());
      }
    };
  }, [setServices, setWatchSessionId, applyStatus, applyLog]);

  async function refresh() {
    try {
      setServices(await listMonitoredServices());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const visible = useMemo(
    () => services.filter((s) => s.subcategory === subcategory),
    [services, subcategory],
  );

  const categories = useMemo(() => {
    const names = new Set(visible.map(categoryOf));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [visible]);

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const active = visible.filter(
      (s) =>
        (categoryFilter.length === 0 || categoryFilter.includes(categoryOf(s))) &&
        (query === "" ||
          s.unit.toLowerCase().includes(query) ||
          s.description.toLowerCase().includes(query)),
    );
    const map = new Map<string, ServiceStatus[]>();
    for (const service of active) {
      const key = categoryOf(service);
      map.set(key, [...(map.get(key) ?? []), service]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible, categoryFilter, search]);

  async function doStart(unit: string) {
    setBusyUnit(unit);
    setError(null);
    try {
      await startService(unit);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyUnit(null);
    }
  }

  async function confirmStop() {
    if (!pendingStop) return;
    const unit = pendingStop.unit;
    setBusyUnit(unit);
    setError(null);
    try {
      await stopService(unit);
      await refresh();
      setPendingStop(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyUnit(null);
    }
  }

  async function doLogs(unit: string) {
    setError(null);
    try {
      const open = logSessionRef.current;
      if (open != null) await serviceLogsClose(open);
      const sessionId = await serviceLogsOpen(unit);
      openLog(sessionId, unit);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function doCloseLogs() {
    const open = logSessionRef.current;
    if (open != null) await serviceLogsClose(open);
    closeLog();
  }

  const disableTarget = services.find((s) => s.unit === disableFor) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <nav
          aria-label="Service group"
          className="flex gap-1 rounded-md border border-border p-0.5"
        >
          {SUBCATEGORIES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={subcategory === option.id}
              className={cn(
                "rounded px-3 py-1 text-sm transition-colors",
                subcategory === option.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setSubcategory(option.id)}
            >
              {option.label}
            </button>
          ))}
        </nav>

        {categories.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[0.65rem] tracking-wide text-muted-foreground uppercase">
              Category
            </span>
            <button
              type="button"
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors",
                categoryFilter.length === 0
                  ? "bg-muted"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={clearCategoryFilter}
            >
              All
            </button>
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                className={cn(
                  "rounded-md px-2 py-1 text-xs transition-colors",
                  categoryFilter.includes(category)
                    ? "bg-muted"
                    : "text-muted-foreground hover:bg-muted",
                )}
                onClick={() => toggleCategory(category)}
              >
                {category}
              </button>
            ))}
          </div>
        )}

        <div className="relative ml-auto w-56">
          <Input
            type="search"
            value={search}
            aria-label="Search services by name or description"
            placeholder="Search name or description…"
            className="h-7 pr-7 text-xs"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search !== "" && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute inset-y-0 right-2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearch("")}
            >
              ×
            </button>
          )}
        </div>

        <Button
          variant="outline"
          size="xs"
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!servicesLoaded ? (
          <p className="text-sm text-muted-foreground">Reading service states…</p>
        ) : services.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-border p-6">
            <p className="text-sm text-muted-foreground">
              No services are being monitored yet. Open Configure to add the
              first one.
            </p>
            <Button size="sm" onClick={() => navigate("/services/configure")}>
              Open Configure
            </Button>
          </div>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing in {subcategory === "capture" ? "Capture" : "Sync"} matches
            {search.trim() !== "" ? ` “${search.trim()}”` : " this filter"}. Try
            another {search.trim() !== "" ? "search term" : "category"}, or
            switch groups above.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(([category, list]) => (
              <section key={category} className="flex flex-col gap-2">
                <h2 className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
                  {category}
                </h2>
                {list.map((service) => (
                  <div key={service.unit} className="flex flex-col gap-2">
                    <ServiceRow
                      service={service}
                      busy={busyUnit === service.unit}
                      now={now}
                      onStart={() => doStart(service.unit)}
                      onStop={() => setPendingStop(service)}
                      onLogs={() => doLogs(service.unit)}
                      onKeepStopped={() =>
                        setDisableFor(
                          disableFor === service.unit ? null : service.unit,
                        )
                      }
                    />
                    {disableFor === service.unit && disableTarget && (
                      <DisableInstructions
                        service={disableTarget}
                        onRecheck={refresh}
                        onClose={() => setDisableFor(null)}
                      />
                    )}
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      {logSessionId != null && <LogViewer onClose={doCloseLogs} />}

      <StopServiceDialog
        service={pendingStop}
        busy={pendingStop != null && busyUnit === pendingStop.unit}
        onCancel={() => setPendingStop(null)}
        onConfirm={() => void confirmStop()}
      />
    </div>
  );
}
