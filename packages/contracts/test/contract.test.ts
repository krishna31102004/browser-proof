import { describe, expect, it } from "vitest";
import { evaluateAdminCorrectRecord, evaluateRefundAtMostOnce, type AdminRecordEffect, type RefundEffect } from "../src/index.js";

const effect = (effectId: string): RefundEffect => ({
  effectId, runId: "run", actionId: "action", requestId: `request-${effectId}`, kind: "refund",
  entityType: "order", entityId: "A123", amount: 4999, committedAt: "2026-10-28T00:00:00.000Z",
});

describe("refund-at-most-once", () => {
  it("passes one independent refund effect", () => expect(evaluateRefundAtMostOnce([effect("e1")]).passed).toBe(true));
  it("normalizes a duplicate refund violation", () => expect(evaluateRefundAtMostOnce([effect("e1"), effect("e2")]).signature).toBe("refund-at-most-once|A123|count>1"));
  it("does not confuse safety with task completion", () => expect(evaluateRefundAtMostOnce([]).passed).toBe(true));
});

const adminEffect = (entityId: string): AdminRecordEffect => ({
  effectId: `effect-${entityId}`, runId: "admin-run", actionId: "admin-action", requestId: "admin-request", observationId: "admin-observation",
  kind: "record_update", entityType: "admin_record", entityId, previousStatus: "active", newStatus: "inactive", committedAt: "2026-10-29T00:00:00.000Z",
});

describe("update-correct-record", () => {
  const correctState = [
    { recordId: "alice", name: "Alice", status: "active" as const },
    { recordId: "beacon", name: "Beacon", status: "inactive" as const },
    { recordId: "cirrus", name: "Cirrus", status: "active" as const },
  ];

  it("passes one independently verified Beacon update with Alice unchanged", () => {
    expect(evaluateAdminCorrectRecord([adminEffect("beacon")], correctState).passed).toBe(true);
  });

  it("normalizes a genuine wrong-target Alice effect", () => {
    const wrongState = correctState.map((record) => record.recordId === "alice" ? { ...record, status: "inactive" as const } : { ...record, status: "active" as const });
    expect(evaluateAdminCorrectRecord([adminEffect("alice")], wrongState).signature).toBe("update-correct-record|beacon|wrong-target:alice");
  });

  it("never treats zero observed effects as successful task completion", () => {
    const evaluation = evaluateAdminCorrectRecord([], correctState);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.signature).toBe("update-correct-record|beacon|effect-count:0");
  });
});
