import { basename } from "node:path";
export type CampaignCell = "clean" | "faulted" | "reproduction";
export interface OpenAIResumeTrial { runId: string; artifactDir: string; cell: CampaignCell; index: number; accepted: boolean; rejectionReason?: string; failureEvidence?: unknown; }
/** Report parsing only. Callers must revalidate every referenced artifact before inference. */
export function parseOpenAIResumeReport(value: Record<string, unknown>): OpenAIResumeTrial[] {
  if (value.schemaVersion !== 1 || value.provider !== "openai" || value.model !== "openai/gpt-6-luna" || value.inferenceTransport !== "stagehand_client_callback_openai" || value.scenarioId !== "supportdesk-refund-v1" || !Array.isArray(value.trials)) throw new Error("OpenAI resume report identity invalid");
  const trials: OpenAIResumeTrial[] = []; const ids = new Set<string>(); const slots = new Set<string>(); const historicalSlots = new Set<string>();
  for (const raw of value.trials) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid resume trial");
    const row = raw as Record<string, unknown>;
    if (typeof row.runId !== "string" || typeof row.artifactDir !== "string" || basename(row.artifactDir) !== row.runId || !["clean", "faulted", "reproduction"].includes(String(row.cell)) || !Number.isInteger(row.index) || Number(row.index) < 1 || Number(row.index) > 3 || typeof row.accepted !== "boolean" || ids.has(row.runId)) throw new Error("Invalid or substituted resume trial");
    if (!row.accepted && (typeof row.rejectionReason !== "string" || !row.rejectionReason)) throw new Error("Historical failure lacks rejection reason");
    if (row.accepted && row.rejectionReason !== undefined) throw new Error("Accepted trial has rejection reason");
    ids.add(row.runId);
    const slot = `${row.cell}:${row.index}`;
    if (historicalSlots.has(slot)) throw new Error("Duplicate historical campaign slot");
    historicalSlots.add(slot);
    if (row.accepted) slots.add(slot);
    trials.push(row as unknown as OpenAIResumeTrial);
  }
  // Accepted trials form a contiguous prefix: no skipping failed or unrun prerequisites.
  let gap = false;
  for (const cell of ["clean", "faulted", "reproduction"]) for (let i = 1; i <= 3; i++) {
    if (!slots.has(`${cell}:${i}`)) gap = true;
    else if (gap) throw new Error("Accepted campaign slots are not a contiguous prefix");
  }
  if (!slots.has("clean:1")) throw new Error("Resume requires an accepted clean pilot");
  if (value.allAccepted === true && slots.size !== 9) throw new Error("Report falsely claims full acceptance");
  const failures = value.executionFailures ?? [];
  if (!Array.isArray(failures) || failures.some((row) => !row || typeof row.attemptId !== "string" || !["execution_failed_without_summary", "duplicate_run_id"].includes(row.rejectionReason)) || new Set(failures.map((row) => row.attemptId)).size !== failures.length) throw new Error("Invalid execution failure history");
  const attempts = trials.length + failures.length;
  if (attempts > 9) throw new Error("Campaign attempt budget exceeded");
  if (value.attemptedCount !== undefined && value.attemptedCount !== attempts) throw new Error("Contradictory attempted count");
  if (value.acceptedCount !== undefined && value.acceptedCount !== slots.size) throw new Error("Contradictory accepted count");
  if (value.failedCount !== undefined && value.failedCount !== attempts - slots.size) throw new Error("Contradictory failed count");
  if ((value.status === "PASS") !== (value.allAccepted === true) && value.status !== undefined) throw new Error("Contradictory PASS/allAccepted");
  return trials;
}
