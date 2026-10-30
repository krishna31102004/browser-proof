export interface StagehandQuiescenceDependencies {
  /** Must terminate the process/session that owns the browser, not just detach Playwright. */
  closeOwnedBrowser(): Promise<void>;
  disconnectPlaywright(): Promise<void>;
  closeStagehandClient(): Promise<void>;
  browserPortIsClosed(): Promise<boolean>;
  waitForInflightBrowserRoutes(): Promise<boolean>;
  removeTemporaryProfile(): Promise<boolean>;
  timeoutMs?: number;
}

export interface StagehandQuiescenceResult {
  browserFenced: boolean;
  routesDrained: boolean;
  profileRemoved: boolean;
  quiescenceVerified: boolean;
  cleanupErrors: string[];
}

export interface StagehandReconciliationResult<T> {
  observerStatus: "complete" | "observer_inconclusive";
  effects: T[];
  eventWriteFailure: string | null;
  observerError: string | null;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<{ value?: T; error?: string; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attach both handlers immediately so a late rejection after the deadline is consumed.
  const handled = operation.then(
    (value) => ({ value, timedOut: false as const }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error), timedOut: false as const }),
  );
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([handled, timeout]);
  if (timer) clearTimeout(timer);
  if (result.timedOut) return { timedOut: true };
  return { ...result, timedOut: false };
}

/** Fence the owned browser first; only then is a ledger snapshot safe to interpret as final. */
export async function quiesceStagehandSession(dependencies: StagehandQuiescenceDependencies): Promise<StagehandQuiescenceResult> {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const cleanupErrors: string[] = [];
  const browserClose = await bounded(dependencies.closeOwnedBrowser(), timeoutMs);
  if (browserClose.error) cleanupErrors.push(`owned browser close failed: ${browserClose.error}`);
  if (browserClose.timedOut) cleanupErrors.push("owned browser close exceeded the bounded shutdown deadline");

  const browserClosed = await bounded(dependencies.browserPortIsClosed(), timeoutMs);
  const browserFenced = browserClosed.value === true;
  if (!browserFenced) cleanupErrors.push(browserClosed.timedOut ? "browser port closure could not be established before deadline" : "owned browser port remains reachable");

  // Once the owning browser is fenced, disconnecting client handles cannot reopen it.
  for (const [label, operation] of [
    ["Playwright disconnect", dependencies.disconnectPlaywright()],
    ["Stagehand client close", dependencies.closeStagehandClient()],
  ] as const) {
    const closeResult = await bounded(operation, timeoutMs);
    if (closeResult.error) cleanupErrors.push(`${label} failed: ${closeResult.error}`);
    if (closeResult.timedOut) cleanupErrors.push(`${label} exceeded the bounded shutdown deadline`);
  }

  const drained = await bounded(dependencies.waitForInflightBrowserRoutes(), timeoutMs);
  const routesDrained = drained.value === true;
  if (!routesDrained) cleanupErrors.push(drained.timedOut ? "in-flight browser routes did not quiesce before deadline" : "in-flight browser routes remain active");

  const profile = await bounded(dependencies.removeTemporaryProfile(), timeoutMs);
  const profileRemoved = profile.value === true;
  if (!profileRemoved) cleanupErrors.push(profile.timedOut ? "temporary browser profile removal exceeded the bounded shutdown deadline" : "temporary browser profile removal failed");

  return { browserFenced, routesDrained, profileRemoved, quiescenceVerified: browserFenced && routesDrained, cleanupErrors };
}

/** Reconcile only after a proven browser fence, but do not let evidence-write failure skip the independent ledger query. */
export async function reconcileAfterStagehandQuiescence<T>(input: {
  quiescenceVerified: boolean;
  backendReset: boolean;
  knownEventWriteFailure?: string;
  drainPendingEventWrites(): Promise<void>;
  flushEvents(): Promise<void>;
  queryIndependentLedger(): Promise<T[]>;
}): Promise<StagehandReconciliationResult<T>> {
  if (!input.quiescenceVerified || !input.backendReset) return { observerStatus: "observer_inconclusive", effects: [], eventWriteFailure: input.knownEventWriteFailure ?? null, observerError: null };
  let eventWriteFailure = input.knownEventWriteFailure ?? null;
  try {
    await input.drainPendingEventWrites();
    await input.flushEvents();
  } catch (error) {
    eventWriteFailure ??= error instanceof Error ? error.message : String(error);
  }
  try {
    return { observerStatus: "complete", effects: await input.queryIndependentLedger(), eventWriteFailure, observerError: null };
  } catch (error) {
    return { observerStatus: "observer_inconclusive", effects: [], eventWriteFailure, observerError: error instanceof Error ? error.message : String(error) };
  }
}
