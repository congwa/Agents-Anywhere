export type ModelPermit = {
  operationId: string; provider: string; model: string; thinkingLevel: string; wireEffort?: string | null;
  api: string; baseUrl: string; generation: string; cancelled: boolean; dispatched: number;
  requiredImages?: number;
  requestProfile?: 'openai' | 'openrouter' | 'responses';
}
