import { describe, expect, it } from "vitest";
import {
  discardContextualNoteSimulationTransfer,
  CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY,
  createContextualNoteSimulationTransfer,
  readContextualNoteSimulationTransfer,
  writeContextualNoteSimulationTransfer,
} from "@/lib/contextual-note-simulation-transfer";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("contextual-note Simulation transfer", () => {
  it("moves reviewed text once without treating it as a saved note", () => {
    const storage = new MemoryStorage();
    const transfer = createContextualNoteSimulationTransfer({
      transferId: "10000000-0000-4000-8000-000000000001",
      content: "My stance felt steadier in this rehearsal.",
      simulationId: "simulation-one",
      sourceLabel: "Day 1 · simulated set 2",
      capturedAtISO: "2026-07-22T18:00:00.000Z",
    });

    writeContextualNoteSimulationTransfer(storage, transfer);

    expect(readContextualNoteSimulationTransfer(storage)).toEqual(transfer);
    expect(readContextualNoteSimulationTransfer(storage)).toEqual(transfer);
    discardContextualNoteSimulationTransfer(storage);
    expect(readContextualNoteSimulationTransfer(storage)).toBeNull();
  });

  it("leaves malformed text visible to its owner instead of silently deleting it", () => {
    const storage = new MemoryStorage();
    storage.setItem(CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY, "not-json");

    expect(readContextualNoteSimulationTransfer(storage)).toBeNull();
    expect(storage.getItem(CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY)).toBe("not-json");
  });

  it("rejects audio-like or extra fields", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY,
      JSON.stringify({
        version: 1,
        transferId: "10000000-0000-4000-8000-000000000001",
        content: "Reviewed text",
        simulationId: "simulation-one",
        sourceLabel: "Simulation",
        capturedAtISO: "2026-07-22T18:00:00.000Z",
        audio: "should-not-exist",
      }),
    );

    expect(readContextualNoteSimulationTransfer(storage)).toBeNull();
    expect(storage.getItem(CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY)).not.toBeNull();
  });
});
