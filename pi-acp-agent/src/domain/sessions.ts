export type SessionRecord = {
  id: string; platformSessionId: string; generation: string; cwd: string;
  preparationId?: string;
  phase: 'preparing' | 'prepared' | 'opening' | 'ready' | 'closing' | 'closed' | 'recovery_required';
  prepared?: Record<string, any>; selectionId?: string; permission: string;
  sourcePath?: string; position?: Record<string, unknown>;
}

export const EXECUTION_GUARANTEES = [
  'project_trust_before_resources', 'durable_prompt_receipts', 'frozen_tool_parameters',
  'final_model_request_guard', 'native_writer_lease', 'stable_native_identity',
] as const
