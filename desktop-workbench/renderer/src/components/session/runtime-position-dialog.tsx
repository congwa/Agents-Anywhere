"use client"
import * as React from "react"
import { apiClient } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type Tree = { sourceEpoch: string; fileEntriesDigest: string; positionRevision: number; leafId: string | null; entries: { id: string; type: string }[]; nextCursor: string | null }
type Props = { token: string; sessionId: string; ownerGeneration?: unknown; canClose: boolean; canSelect: boolean }
export function RuntimePositionDialog(props: Props) {
  return <RuntimePositionView key={JSON.stringify([props.sessionId, props.ownerGeneration ?? null])} {...props} />
}
function RuntimePositionView({ token, sessionId, ownerGeneration, canClose, canSelect }: Props) {
  const [open, setOpen] = React.useState(false), [tree, setTree] = React.useState<Tree | null>(null)
  const [leaf, setLeaf] = React.useState("root"), [error, setError] = React.useState<string>()
  const [pending, setPending] = React.useState(false), [closed, setClosed] = React.useState(false)
  const path = `/runtime-workflows/sessions/${encodeURIComponent(sessionId)}`
  const load = React.useCallback(async () => {
    const result = await apiClient.get<Tree>(path + "/tree", { token }); setTree(result); setLeaf(result.leafId ?? "root")
  }, [path, token])
  React.useEffect(() => { if (open) void load().catch(error => setError(String(error))) }, [open, load])
  const execute = async (work: () => Promise<unknown>) => {
    setPending(true); setError(undefined)
    try { await work() } catch (error) { setError(String(error)) } finally { setPending(false) }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="ghost" size="sm">原生历史与继续位置</Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>原生历史与继续位置</DialogTitle></DialogHeader>
      <FieldGroup><Field><FieldLabel htmlFor="runtime-position">继续位置</FieldLabel>
        <Select value={leaf} onValueChange={setLeaf} disabled={pending}><SelectTrigger id="runtime-position"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
          <SelectItem value="root">会话起点</SelectItem>{tree?.entries.map(entry => <SelectItem key={entry.id} value={entry.id}>{entry.type} · {entry.id}</SelectItem>)}
        </SelectGroup></SelectContent></Select>
      </Field>
      {tree?.nextCursor ? <Button variant="outline" disabled={pending} onClick={() => execute(async () => {
        const next = await apiClient.get<Tree>(path + "/tree", { token, query: { cursor: tree.nextCursor } })
        if (next.sourceEpoch !== tree.sourceEpoch || next.positionRevision !== tree.positionRevision) { await load(); throw new Error("历史或位置已变化，请重新选择。") }
        setTree({ ...next, entries: [...tree.entries, ...next.entries] })
      })}>加载更多</Button> : null}
      {canClose && !closed && typeof ownerGeneration === "string" ? <Button variant="outline" disabled={pending} onClick={() => execute(async () => {
        await apiClient.post(path + "/close", { ownerGeneration, closeOperationId: crypto.randomUUID() }, { token }); setClosed(true); await load()
      })}>关闭当前执行进程</Button> : null}
      {tree && (canSelect || closed) ? <Button disabled={pending || (canClose && !closed)} onClick={() => execute(async () => {
        await apiClient.post(path + "/position", { sourceEpoch: tree.sourceEpoch, fileEntriesDigest: tree.fileEntriesDigest, positionRevision: tree.positionRevision, leafId: leaf === "root" ? null : leaf }, { token }); await load(); setOpen(false)
      })}>从选定位置继续</Button> : null}
      {error ? <p role="alert">{error}</p> : null}
      </FieldGroup>
    </DialogContent>
  </Dialog>
}
