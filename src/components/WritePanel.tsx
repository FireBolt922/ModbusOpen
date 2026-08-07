import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormatPicker } from "@/components/FormatPicker";
import { errorMessage, writeSingleCoil, writeTyped } from "@/lib/ipc";
import type { DataFormat, TypedValue } from "@/lib/types";

type WriteMode = "typed" | "coil";

type Props = {
  unitId: number;
  defaultAddress: number;
  defaultFormat: DataFormat;
  open: boolean;
  onClose: () => void;
  onWritten?: () => void;
};

function parseTypedValue(
  text: string,
  format: DataFormat,
): TypedValue | string {
  const t = text.trim();
  if (t === "") return "Enter a value";
  switch (format.dataType) {
    case "bool":
      if (t === "1" || t.toLowerCase() === "true" || t.toLowerCase() === "on")
        return { kind: "bool", value: true };
      if (t === "0" || t.toLowerCase() === "false" || t.toLowerCase() === "off")
        return { kind: "bool", value: false };
      return "Use true/false or 1/0";
    case "int16":
    case "int32":
    case "int64": {
      const n = Number(t);
      if (!Number.isFinite(n) || !Number.isInteger(n))
        return "Need an integer";
      return { kind: "int", value: n };
    }
    case "uint16":
    case "uint32":
    case "uint64":
    case "hex16":
    case "binary16": {
      let n: number;
      if (t.startsWith("0x") || t.startsWith("0X")) n = parseInt(t, 16);
      else n = Number(t);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
        return "Need a non-negative integer";
      return { kind: "uint", value: n };
    }
    case "float32":
    case "float64": {
      const n = Number(t);
      if (!Number.isFinite(n)) return "Need a number";
      return { kind: "float", value: n };
    }
    case "string":
      return { kind: "text", value: t };
  }
}

function previewHint(
  mode: WriteMode,
  address: number,
  valueText: string,
  format: DataFormat,
): string {
  if (mode === "coil") {
    const on =
      valueText === "1" ||
      valueText.toLowerCase() === "true" ||
      valueText.toLowerCase() === "on";
    return on
      ? `FC05 → addr ${address} ON (FF 00)`
      : `FC05 → addr ${address} OFF (00 00)`;
  }
  const parsed = parseTypedValue(valueText, format);
  if (typeof parsed === "string") return parsed;
  const span =
    format.dataType === "float32" ||
    format.dataType === "uint32" ||
    format.dataType === "int32"
      ? 2
      : format.dataType === "float64" ||
          format.dataType === "uint64" ||
          format.dataType === "int64"
        ? 4
        : 1;
  const fc = span === 1 ? "FC06" : "FC16";
  return `${fc} · ${format.dataType} ${format.wordOrder.toUpperCase()} · addr ${address} · span ${span}`;
}

export function WritePanel({
  unitId,
  defaultAddress,
  defaultFormat,
  open,
  onClose,
  onWritten,
}: Props) {
  const [mode, setMode] = useState<WriteMode>("typed");
  const [address, setAddress] = useState(defaultAddress);
  const [valueText, setValueText] = useState("");
  const [format, setFormat] = useState<DataFormat>(defaultFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const hint = useMemo(
    () => previewHint(mode, address, valueText, format),
    [mode, address, valueText, format],
  );

  if (!open) return null;

  async function handleWrite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      if (mode === "coil") {
        const on =
          valueText === "1" ||
          valueText.toLowerCase() === "true" ||
          valueText.toLowerCase() === "on";
        await writeSingleCoil(unitId, address, on);
        setOk(`Wrote coil ${address} = ${on ? "ON" : "OFF"}`);
      } else {
        const parsed = parseTypedValue(valueText, format);
        if (typeof parsed === "string") {
          setError(parsed);
          setBusy(false);
          return;
        }
        const result = await writeTyped(unitId, address, parsed, format);
        setOk(
          `Wrote ${result.quantity} register(s) at ${address} (${result.latencyMs.toFixed(1)} ms)`,
        );
      }
      onWritten?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">Write</h2>
        <Button variant="ghost" size="xs" type="button" onClick={onClose}>
          ✕
        </Button>
      </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={handleWrite}>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Mode</Label>
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as WriteMode)}
          >
            <SelectTrigger className="w-48" aria-label="Write mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="typed">Register (FC06/FC16)</SelectItem>
              <SelectItem value="coil">Coil (FC05)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Address</Label>
          <NumberInput
            min={0}
            max={65535}
            className="w-28"
            value={address}
            onChange={setAddress}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Value</Label>
          <Input
            className="w-36"
            placeholder={mode === "coil" ? "true / false" : "e.g. 231.0"}
            value={valueText}
            onChange={(e) => setValueText(e.target.value)}
            required
          />
        </div>
        {mode === "typed" && (
          <FormatPicker format={format} onChange={setFormat} />
        )}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Writing…" : "Write"}
        </Button>
      </form>
      <p className="mt-2 font-mono text-xs text-muted-foreground">{hint}</p>
      {error && (
        <p className="mt-1 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {ok && (
        <p className="mt-1 text-sm text-emerald-400" role="status">
          {ok}
        </p>
      )}
    </div>
  );
}
