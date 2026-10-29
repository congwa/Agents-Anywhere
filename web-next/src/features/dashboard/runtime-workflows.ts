import { apiClient } from "@/lib/api"
import type { ProtocolModelCatalog } from "./types"

export type RuntimeDialogValue = { kind: "confirm"; status: "submitted"; value: boolean }
  | { kind: "form"; values: Record<string, unknown> }
  | { kind: "select"; status: "submitted"; optionId: string }
  | { kind: "input" | "editor"; status: "submitted"; text: string }
export type WorkflowInteraction = {
  interactionId: string; ownerGeneration: string; requestRevision: number; revision: number;
  kind: string; title: string; message?: string; status: string; metadata: Record<string, unknown>;
  actions: { actionId: string; label: string; style: string; input: Record<string, unknown> }[]
}
export type WorkflowView = { protocolVersion: "1.1"; id: string; kind: "preparation" | "creation";
  connectorId: string; runtimeId: string; projectId: string; sessionId?: string | null;
  state: { phase: string; revision: number; catalogRevision?: number; catalog?: ProtocolModelCatalog;
    messageAccepted?: boolean | null; created?: boolean | null; initializationId?: string; workerGeneration?: string;
    interactions: WorkflowInteraction[]; canCancel?: boolean; canCancelInitialization?: boolean;
    failure?: { code: string; message: string } } }
export type PreparedWorkspace = { preparationId: string; expectedRevision: number; catalogRevision: number }
export const workflowApi = {
  prepare: (token: string, body: { connectorId: string; runtimeId: string; projectId: string; clientPreparationId: string }) =>
    apiClient.post<WorkflowView>("/runtime-workflows/preparations", body, { token }),
  begin: (token: string, body: PreparedWorkspace & { createOperationId: string; clientMessageId: string; content: string; selections: Record<string, string | null>; title?: string }) =>
    apiClient.post<WorkflowView>("/runtime-workflows/creations", body, { token }),
  get: (token: string, kind: WorkflowView["kind"], id: string) => apiClient.get<WorkflowView>(`/runtime-workflows/${kind}/${encodeURIComponent(id)}`, { token }),
  respond: (token: string, operation: WorkflowView, interaction: WorkflowInteraction, actionId: string, input?: RuntimeDialogValue) =>
    apiClient.post<{ disposition: string }>(`/runtime-workflows/${operation.kind}/${encodeURIComponent(operation.id)}/responses`, {
      interactionId: interaction.interactionId, requestRevision: interaction.requestRevision, ownerGeneration: interaction.ownerGeneration,
      responseOperationId: crypto.randomUUID(), actionId, ...(input === undefined ? {} : { input }),
    }, { token }),
  cancel: (token: string, operation: WorkflowView) => apiClient.post<WorkflowView>(`/runtime-workflows/${operation.kind}/${encodeURIComponent(operation.id)}/cancel`, { operationId: crypto.randomUUID() }, { token }),
}
