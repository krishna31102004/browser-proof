import { describe, expect, it } from "vitest";
import { buildOpenAIResponsesRequest } from "../src/stagehand-openai-request.js";
import type { StagehandLLMGenerateParams } from "../src/stagehand-gemini-callback.js";

describe("OpenAI Responses request mapping (offline)", () => {
  it("preserves instructions, multimodal messages and schema with bounded low reasoning", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const params: StagehandLLMGenerateParams = { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", mimeType: "image/png", data: "YWJj" }] }], responseFormat: { type: "json_schema", name: "action", schema } };
    expect(buildOpenAIResponsesRequest(params)).toEqual({ model: "gpt-6-luna", reasoning: { effort: "low" }, max_output_tokens: 4096, store: false, instructions: "system", input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "auto" }] }], text: { format: { type: "json_schema", name: "action", schema, strict: true } } });
  });
  it("fails closed on stop sequences unsupported in the selected reasoning mode", () => {
    expect(() => buildOpenAIResponsesRequest({ messages: [], stopSequences: ["stop"] })).toThrow("unsupported_stagehand_feature");
  });
});
