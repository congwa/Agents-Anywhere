"use client"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { StructuredAgentFields } from "./structured-agent-fields"
import { configSchema, formDefaults, formErrors, type AgentConfiguration } from "@/features/dashboard/runtime-forms"
import { workflowApi } from "@/features/dashboard/runtime-workflows"

type Props = { token: string; sessionId: string; ownerGeneration?: unknown; canUpdate: boolean }
export function AgentConfigurationDialog(props: Props) {
  return <ConfigurationEditor key={JSON.stringify([props.token, props.sessionId, props.ownerGeneration ?? null])} {...props} />
}
function ConfigurationEditor({ token, sessionId, canUpdate }: Props) {
  const [open, setOpen] = React.useState(false)
  const [configuration, setConfiguration] = React.useState<AgentConfiguration>()
  const [values, setValues] = React.useState<Record<string, unknown>>({})
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const alive = React.useRef(true)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const schema = configuration ? configSchema(configuration, true) : { type: "object", properties: {} }
  const load = async () => {
    setPending(true); setError(undefined)
    try {
      const result = await workflowApi.configuration(token, sessionId)
      if (alive.current) { setConfiguration(result.configuration); setValues(formDefaults(configSchema(result.configuration, true))) }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setPending(false) }
  }
  const save = async () => {
    if (!configuration || pending || !canUpdate) return
    setPending(true); setError(undefined)
    try {
      const result = await workflowApi.updateConfiguration(token, sessionId, { operationId: crypto.randomUUID(), expectedRevision: configuration.revision, values: values as Record<string, string | boolean> })
      if (!alive.current) return
      setConfiguration(result.configuration)
      setValues(formDefaults(configSchema(result.configuration, true)))
      if (result.phase === "completed") setOpen(false)
      else setError("配置结果尚未确认，请查询当前配置。")
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (alive.current) setPending(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (pending) return; setOpen(value); if (value) void load() }}>
    <DialogTrigger asChild><Button variant="ghost" size="sm">Agent 配置</Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>Agent 配置</DialogTitle></DialogHeader>
      {configuration ? <StructuredAgentFields schema={schema} values={values} onChange={setValues} disabled={pending || !canUpdate} /> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="flex gap-2"><Button variant="outline" disabled={pending} onClick={() => void load()}>刷新当前配置</Button>
        <Button disabled={pending || !canUpdate || !configuration || Object.keys(formErrors(schema, values)).length > 0} onClick={() => void save()}>保存</Button></div>
    </DialogContent>
  </Dialog>
}
