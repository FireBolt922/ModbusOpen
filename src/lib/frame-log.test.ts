import { describe, expect, test } from "vitest";

import { formatFrameLog, formatFrameLogEntry } from "./frame-log";
import type { FrameLogEntry } from "@/lib/types";

function frame(overrides: Partial<FrameLogEntry> = {}): FrameLogEntry {
  return {
    sessionId: 1,
    timestamp: "2026-10-13T06:19:31Z",
    direction: "tx",
    bytes: [1, 3, 0, 100],
    unitId: 1,
    function: 3,
    isException: false,
    exceptionCode: null,
    rttMs: 12.4,
    annotation: null,
    ...overrides,
  };
}

describe("frame-log export formatting", () => {
  test("formats the same timestamped lines used by Copy and Export", () => {
    expect(formatFrameLog([frame()])).toBe(
      "2026-10-13T06:19:31Z TX FC=3 rtt=12.4ms\n  01 03 00 64",
    );
  });

  test("marks exception frames and preserves multi-frame order", () => {
    const exception = frame({
      direction: "rx",
      bytes: [1, 131, 2],
      function: 131,
      isException: true,
      rttMs: null,
    });
    expect(formatFrameLog([frame(), exception])).toBe(
      "2026-10-13T06:19:31Z TX FC=3 rtt=12.4ms\n  01 03 00 64\n2026-10-13T06:19:31Z RX FC=83 EXCEPTION\n  01 83 02",
    );
  });

  test("exports a frame without RTT without adding a blank field", () => {
    expect(formatFrameLogEntry(frame({ rttMs: null }))).toBe(
      "2026-10-13T06:19:31Z TX FC=3\n  01 03 00 64",
    );
  });
});
