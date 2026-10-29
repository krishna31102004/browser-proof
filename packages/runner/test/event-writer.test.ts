import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventWriter } from "../src/event-writer.js";

describe("serialized event writer", () => {
  it("persists concurrent callbacks in assigned sequence order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "browserproof-events-"));
    const path = join(directory, "events.jsonl");
    try {
      const writer = new EventWriter(path, "event-run", "event-scenario");
      await Promise.all(Array.from({ length: 64 }, (_, index) => writer.record("browser", "event", { index })));
      await writer.flush();
      const events = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; payload: { index: number } });
      expect(events.map(({ sequence }) => sequence)).toEqual(Array.from({ length: 64 }, (_, index) => index + 1));
      expect(events.map(({ payload }) => payload.index)).toEqual(Array.from({ length: 64 }, (_, index) => index));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
