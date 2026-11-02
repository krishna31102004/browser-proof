export type StagehandInferenceTransport = "native_google_extension" | "stagehand_client_callback_google";

/**
 * Keep the page offline from third-party origins while allowing only the pinned
 * Google generateContent endpoint from this run's Stagehand extension worker
 * when the explicitly selected transport is the native extension provider.
 */
export function isAllowedNativeGeminiWorkerRequest(input: {
  transport: StagehandInferenceTransport;
  method: string;
  requestUrl: string;
  serviceWorkerUrl?: string;
  expectedStagehandWorkerUrl?: string;
}): boolean {
  if (input.transport !== "native_google_extension" || input.method.toUpperCase() !== "POST" ||
    !input.serviceWorkerUrl || !input.expectedStagehandWorkerUrl || input.serviceWorkerUrl !== input.expectedStagehandWorkerUrl) return false;
  try {
    const url = new URL(input.requestUrl);
    return url.protocol === "https:" && url.hostname === "generativelanguage.googleapis.com" && url.port === "" &&
      url.pathname === "/v1beta/models/gemini-3.8-flash:generateContent" && url.search === "" && url.username === "" && url.password === "";
  } catch { return false; }
}
