export function installAcceptedSubagentGatewayMock(mock: {
  mockImplementation: (
    impl: (opts: { method?: string; params?: unknown }) => Promise<unknown>,
  ) => unknown;
}) {
  mock.mockImplementation(async ({ method, params }) => {
    if (method === "agent") {
      const runId =
        params &&
        typeof params === "object" &&
        "idempotencyKey" in params &&
        typeof params.idempotencyKey === "string" &&
        params.idempotencyKey.trim()
          ? params.idempotencyKey
          : "run-1";
      return { runId };
    }
    return method?.startsWith("sessions.") ? { ok: true } : {};
  });
}
