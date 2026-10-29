export type Interaction = {
  interactionId: string; ownerGeneration: string; requestRevision: number; revision: number;
  scope: 'preparation' | 'creation' | 'session'; scopeId: string; kind: string; purpose: string;
  title: string; message?: string; status: 'open' | 'resolved' | 'cancelled' | 'expired';
  actions: { actionId: string; label: string; style: string; input: Record<string, unknown> }[];
  expiresAt: string; metadata: Record<string, unknown>;
}
export type Response = {
  interactionId: string; ownerGeneration: string; requestRevision: number;
  actionId: string; responseOperationId: string; input?: unknown;
}
export type DecisionReceipt = { interactionId: string; responseOperationId: string; ownerGeneration: string; requestRevision: number; revision: number; disposition: string }
