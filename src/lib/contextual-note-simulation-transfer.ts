import { z } from "zod";

export const CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY =
  "continuity:contextual-note:simulation-transfer:v1";

const simulationTransferSchema = z
  .object({
    version: z.literal(1),
    transferId: z.string().uuid(),
    content: z.string().trim().min(1).max(2_000),
    simulationId: z.string().min(1).max(200),
    sourceLabel: z.string().trim().min(1).max(200),
    capturedAtISO: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ContextualNoteSimulationTransfer = z.infer<
  typeof simulationTransferSchema
>;

export function createContextualNoteSimulationTransfer(input: {
  content: string;
  simulationId: string;
  sourceLabel: string;
  capturedAtISO: string;
  transferId?: string;
}): ContextualNoteSimulationTransfer {
  return simulationTransferSchema.parse({
    version: 1,
    transferId: input.transferId ?? crypto.randomUUID(),
    content: input.content,
    simulationId: input.simulationId,
    sourceLabel: input.sourceLabel,
    capturedAtISO: input.capturedAtISO,
  });
}

export function writeContextualNoteSimulationTransfer(
  storage: Storage,
  transfer: ContextualNoteSimulationTransfer,
) {
  storage.setItem(
    CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY,
    JSON.stringify(simulationTransferSchema.parse(transfer)),
  );
}

export function readContextualNoteSimulationTransfer(
  storage: Storage,
): ContextualNoteSimulationTransfer | null {
  const raw = storage.getItem(CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY);
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = simulationTransferSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

export function discardContextualNoteSimulationTransfer(storage: Storage) {
  storage.removeItem(CONTEXTUAL_NOTE_SIMULATION_TRANSFER_KEY);
}
