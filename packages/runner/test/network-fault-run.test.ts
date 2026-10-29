import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetworkFaultSchedule, executeNetworkFaultRun, validateNetworkFaultArtifacts, validateNetworkFaultSchedule, type NetworkFaultType } from "../src/network-fault-run.js";

const faults: NetworkFaultType[] = ["response_delay", "request_abort", "stale_api_response"];

describe("typed network-fault schedules", () => {
  it.each(faults)("accepts an exact %s schedule and rejects target/seed mutations", (fault) => {
    const schedule = createNetworkFaultSchedule(fault, "unit-01");
    expect(validateNetworkFaultSchedule(schedule, fault)).toBe(true);
    expect(validateNetworkFaultSchedule({ ...schedule, seed: "other" }, fault)).toBe(false);
    expect(validateNetworkFaultSchedule({ ...schedule, target: { method: "POST", path: "/wrong" } }, fault)).toBe(false);
    expect(validateNetworkFaultSchedule({ ...schedule, occurrenceCount: 2 }, fault)).toBe(false);
    expect(validateNetworkFaultSchedule(schedule, faults.find((candidate) => candidate !== fault))).toBe(false);
  });
});

describe("real Chromium network fault runs", () => {
  it("delays but eventually delivers the first committed response, then observes the agent duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-response-delay-"));
    try {
      const { result, artifactDir } = await executeNetworkFaultRun({ fault: "response_delay", mode: "faulted", seed: "delay-test-01", artifactRoot: root });
      expect(result.fault.triggered).toBe(true);
      expect(result.fault.phase).toBe("after_upstream_commit");
      expect(result.taskCompleted).toBe(true);
      expect(result.status).toBe("contract_violation");
      expect(result.observedEffects).toHaveLength(2);
      expect(result.requests.find((request) => request.requestId === result.fault.requestId)?.responseDelivered).toBe(true);
      expect(result.requests.some((request) => request.requestId === result.fault.requestId && request.browserRequestFailed)).toBe(false);
      expect((await validateNetworkFaultArtifacts(artifactDir)).valid).toBe(true);
      const resultPath = join(artifactDir, "result.json");
      const resultDoc = JSON.parse(await readFile(resultPath, "utf8")) as { requests: Array<Record<string, unknown>>; fault: { requestId: string } };
      const delayedRequest = resultDoc.requests.find((request) => request.requestId === resultDoc.fault.requestId)!;
      delayedRequest.upstreamBodySha256 = null;
      await writeFile(resultPath, JSON.stringify(resultDoc));
      const missingDigest = await validateNetworkFaultArtifacts(artifactDir);
      expect(missingDigest.valid).toBe(false);
      expect(missingDigest.errors.join(" ")).toMatch(/digest/i);
      delayedRequest.upstreamBodySha256 = result.requests.find((request) => request.requestId === result.fault.requestId)?.upstreamBodySha256;
      delayedRequest.forwardedUpstream = false;
      await writeFile(resultPath, JSON.stringify(resultDoc));
      expect((await validateNetworkFaultArtifacts(artifactDir)).valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);

  it("aborts before forwarding and recovers with exactly one committed retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-request-abort-"));
    try {
      const { result, artifactDir } = await executeNetworkFaultRun({ fault: "request_abort", mode: "faulted", seed: "abort-test-01", artifactRoot: root });
      const aborted = result.requests.find((request) => request.requestId === result.fault.requestId);
      expect(result.fault.triggered).toBe(true);
      expect(result.fault.phase).toBe("before_upstream");
      expect(aborted?.forwardedUpstream).toBe(false);
      expect(aborted?.upstreamCommitted).toBe(false);
      expect(aborted?.browserRequestFailed).toBe(true);
      expect(result.observedEffects).toHaveLength(1);
      expect(result.observedEffects[0]?.requestId).not.toBe(aborted?.requestId);
      expect(result.taskCompleted).toBe(true);
      expect(result.status).toBe("passed");
      expect(result.contract?.passed).toBe(true);
      expect((await validateNetworkFaultArtifacts(artifactDir)).valid).toBe(true);
      const resultPath = join(artifactDir, "result.json");
      const resultDoc = JSON.parse(await readFile(resultPath, "utf8")) as { requests: Array<Record<string, unknown>>; fault: { requestId: string } };
      const abortedRequest = resultDoc.requests.find((request) => request.requestId === resultDoc.fault.requestId)!;
      abortedRequest.forwardedUpstream = true;
      abortedRequest.upstreamCommitted = true;
      await writeFile(resultPath, JSON.stringify(resultDoc));
      expect((await validateNetworkFaultArtifacts(artifactDir)).valid).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);

  it("delivers a verified old GET after commit and rejects a tampered snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-stale-api-"));
    try {
      const { result, artifactDir } = await executeNetworkFaultRun({ fault: "stale_api_response", mode: "faulted", seed: "stale-test-01", artifactRoot: root });
      expect(result.fault.triggered).toBe(true);
      expect(result.fault.phase).toBe("post_commit_get");
      expect(result.taskCompleted).toBe(true);
      expect(result.status).toBe("contract_violation");
      expect(result.observedEffects).toHaveLength(2);
      const pre = result.readSnapshots.find((snapshot) => snapshot.phase === "pre_commit");
      const post = result.readSnapshots.find((snapshot) => snapshot.phase === "post_commit");
      expect(pre?.body.refundEligible).toBe(true);
      expect(post?.body.refundEligible).toBe(true);
      expect(post?.groundTruthBody?.refundEligible).toBe(false);
      expect(post?.source).toBe("saved_pre_commit_injected");
      expect((await validateNetworkFaultArtifacts(artifactDir)).valid).toBe(true);
      const path = join(artifactDir, "read-snapshots.json");
      const doc = JSON.parse(await readFile(path, "utf8")) as { snapshots: Array<Record<string, unknown>> };
      doc.snapshots[1] = { ...doc.snapshots[1], body: { refundEligible: false } };
      await writeFile(path, JSON.stringify(doc));
      const tampered = await validateNetworkFaultArtifacts(artifactDir);
      expect(tampered.valid).toBe(false);
      expect(tampered.errors.join(" ")).toMatch(/snapshot/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20000);
});
