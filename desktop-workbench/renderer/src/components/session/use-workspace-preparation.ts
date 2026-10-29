"use client"
import * as React from "react"
import { workflowApi, type RuntimeDialogValue, type WorkflowInteraction, type WorkflowView } from "@/features/dashboard/runtime-workflows"

export function useWorkspacePreparation(token: string | undefined, target: string) {
  const [operation, setOperation] = React.useState<WorkflowView | null>(null)
  const [error, setError] = React.useState<string>()
  const [pending, setPending] = React.useState(false)
  const generation = React.useRef(0)
  React.useEffect(() => { generation.current++; setOperation(null); setError(undefined); setPending(false) }, [token, target])
  React.useEffect(() => {
    if (!token || !operation || ["failed", "cancelled", "expired", "consumed"].includes(operation.state.phase)) return
    let closed = false
    const timer = window.setInterval(() => {
      void workflowApi.get(token, "preparation", operation.id).then(value => { if (!closed) { setOperation(value); setError(undefined) } }).catch(reason => { if (!closed) setError(String(reason)) })
    }, 1500)
    return () => { closed = true; window.clearInterval(timer) }
  }, [token, operation?.id, operation?.state.phase])
  const prepare = async (body: { connectorId: string; runtimeId: string; projectId: string }) => {
    if (!token || pending) return
    const version = generation.current; setPending(true)
    try { const value = await workflowApi.prepare(token, { ...body, clientPreparationId: crypto.randomUUID() }); if (version === generation.current) setOperation(value) }
    catch (reason) { if (version === generation.current) setError(String(reason)) }
    finally { if (version === generation.current) setPending(false) }
  }
  const respond = async (request: WorkflowInteraction, actionId: string, input?: RuntimeDialogValue) => {
    if (!token || !operation || pending) return
    const version = generation.current; setPending(true)
    try { await workflowApi.respond(token, operation, request, actionId, input); const value = await workflowApi.get(token, "preparation", operation.id); if (version === generation.current) { setOperation(value); setError(undefined) } }
    catch (reason) { if (version === generation.current) setError(String(reason)) }
    finally { if (version === generation.current) setPending(false) }
  }
  const cancel = async () => {
    if (!token || !operation || pending) return
    const version = generation.current; setPending(true)
    try { const value = await workflowApi.cancel(token, operation); if (version === generation.current) setOperation(value) }
    catch (reason) { if (version === generation.current) setError(String(reason)) }
    finally { if (version === generation.current) setPending(false) }
  }
  return { operation, pending, error, prepare, respond, cancel }
}
