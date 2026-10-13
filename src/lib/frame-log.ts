import type { FrameLogEntry } from "@/lib/types";
import { formatBytesHex } from "@/lib/format";

export function formatFrameLogEntry(frame: FrameLogEntry): string {
  const direction = frame.direction.toUpperCase();
  const exception = frame.isException ? " EXCEPTION" : "";
  const rtt = frame.rttMs != null ? ` rtt=${frame.rttMs.toFixed(1)}ms` : "";
  return `${frame.timestamp} ${direction} FC=${frame.function.toString(16)}${exception}${rtt}\n  ${formatBytesHex(frame.bytes)}`;
}

export function formatFrameLog(frames: FrameLogEntry[]): string {
  return frames.map(formatFrameLogEntry).join("\n");
}
