/** Provider-independent failures cross the ACP boundary with a stable code. */
export class AgentFailure extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message) }
}
