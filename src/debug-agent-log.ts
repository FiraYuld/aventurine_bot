// #region agent log
/** Только диагностика (сессия bd3606). Без секретов. */
export function agentDebugLog(entry: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  const payload = {
    sessionId: "bd3606",
    timestamp: Date.now(),
    ...entry,
  };
  const body = JSON.stringify(payload);
  console.error("[agent-debug]", body);
  fetch("http://127.0.0.1:7458/ingest/15bbcc9f-06b6-4a51-a8b8-fecc59d94e52", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "bd3606",
    },
    body,
  }).catch(() => {});
}
// #endregion
