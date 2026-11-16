const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** Reject supplied malformed details; omitted optional breakdowns mean zero. */
export function parseOpenAIUsage(value: unknown) {
  if (!object(value) || !count(value.input_tokens) || !count(value.output_tokens) || !count(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens) throw new Error("invalid_provider_usage");
  for (const key of ["input_tokens_details", "output_tokens_details"]) if (key in value && !object(value[key])) throw new Error("invalid_provider_usage");
  const input = value.input_tokens_details as Record<string, unknown> | undefined;
  const output = value.output_tokens_details as Record<string, unknown> | undefined;
  for (const detail of [input, output]) if (detail && Object.values(detail).some((v) => !count(v))) throw new Error("invalid_provider_usage");
  const cached = input?.cached_tokens ?? 0; const reasoning = output?.reasoning_tokens ?? 0;
  if (!count(cached) || !count(reasoning) || cached > value.input_tokens || reasoning > value.output_tokens) throw new Error("invalid_provider_usage");
  return { promptTokenCount: value.input_tokens, candidatesTokenCount: value.output_tokens, totalTokenCount: value.total_tokens, thoughtsTokenCount: reasoning, cachedContentTokenCount: cached };
}
