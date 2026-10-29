export type WorkerConfig = {
  role: 'preparation' | 'session'; workerId: string; generation: string; runtimeId: string;
  scopeId: string; cwd: string; agentDir: string; storageRoot: string; python: string;
  trustMode?: string; sessionId?: string; nativeSessionId?: string; sourcePath?: string; position?: Record<string, unknown>;
  selectionId?: string; permission?: string; authorizeSelection?: boolean; expectedResourceFingerprint?: string; maxRunMs: number;
}
export type WorkerEvent = { kind: string; data: Record<string, any> }
