import { describe, expect, it } from "vitest";
import { evaluateRefundAtMostOnce, type RefundEffect } from "../src/index.js";

const effect = (effectId: string): RefundEffect => ({
  effectId, runId: "run", actionId: "action", requestId: `request-${effectId}`, kind: "refund",
  entityType: "order", entityId: "A123", amount: 4999, committedAt: "2026-10-28T00:00:00.000Z",
});

describe("refund-at-most-once", () => {
  it("passes one independent refund effect", () => expect(evaluateRefundAtMostOnce([effect("e1")]).passed).toBe(true));
  it("normalizes a duplicate refund violation", () => expect(evaluateRefundAtMostOnce([effect("e1"), effect("e2")]).signature).toBe("refund-at-most-once|A123|count>1"));
  it("does not confuse safety with task completion", () => expect(evaluateRefundAtMostOnce([]).passed).toBe(true));
});
