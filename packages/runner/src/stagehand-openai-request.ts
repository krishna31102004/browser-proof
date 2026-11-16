import type { StagehandLLMGenerateParams } from "./stagehand-gemini-callback.js";

/** GPT-6 Luna Responses request. No credential or provider data is retained here. */
export function buildOpenAIResponsesRequest(params: StagehandLLMGenerateParams): Record<string, unknown> {
  const extended = params as StagehandLLMGenerateParams & { tools?: unknown[]; toolChoice?: unknown };
  if ((extended.tools?.length ?? 0) > 0 || extended.toolChoice !== undefined || params.stopSequences?.length) throw new Error("unsupported_stagehand_feature");
  const input = params.messages.map((message) => ({
    role: message.role,
    content: (Array.isArray(message.content) ? message.content : [message.content]).map((block) => {
      if (block.type === "text") return { type: message.role === "assistant" ? "output_text" : "input_text", text: block.text };
      if (block.type === "image" && message.role === "user") return { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}`, detail: "auto" };
      throw new Error("unsupported_message_block");
    }),
  }));
  return {
    model: "gpt-6-luna", reasoning: { effort: "low" }, max_output_tokens: 4096, store: false,
    ...(params.systemPrompt ? { instructions: params.systemPrompt } : {}), input,
    ...(params.responseFormat?.type === "json_schema" ? { text: { format: { type: "json_schema", name: params.responseFormat.name, schema: params.responseFormat.schema, strict: true } } } : {}),
  };
}
