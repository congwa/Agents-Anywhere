import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'
import { createHash } from 'node:crypto'
import { digest, RuntimeFailure } from '../domain/shared.js'
import { requestProfile } from './request-profile.js'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export async function resourceFingerprint(cwd: string, agentDir: string, trusted: boolean): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0, files = 0
  const visited = new Set<string>()
  async function visit(path: string): Promise<void> {
    let resolved: string
    try { resolved = await realpath(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update(path + ':missing'); return }; throw error }
    if (visited.has(resolved)) return
    visited.add(resolved)
    const info = await stat(resolved)
    if (info.isDirectory()) {
      for (const name of (await readdir(resolved)).sort()) if (!['node_modules', '.git', 'cache', 'sessions'].includes(name)) await visit(join(resolved, name))
    } else if (info.isFile()) {
      bytes += info.size; files++
      if (bytes > 64 * 1024 * 1024 || files > 10_000) throw new RuntimeFailure('resource_inventory_too_large', '项目资源超过检查上限。')
      hash.update(resolved).update('\0').update(await readFile(resolved)).update('\0')
    }
  }
  hash.update(cwd).update(trusted ? ':trusted' : ':basic')
  for (const name of ['settings.json', 'models.json', 'auth.json', 'extensions']) await visit(join(agentDir, name))
  if (trusted) {
    await visit(join(cwd, '.pi'))
    let path = cwd
    while (true) { await visit(join(path, '.agents', 'skills')); const parent = dirname(path); if (parent === path) break; path = parent }
  }
  return hash.digest('hex')
}

export function modelCatalog(runtime: ModelRuntime, workspaceId: string): { models: any[]; fingerprint: string; selections: Record<string, { provider: string; model: string; thinkingLevel: string }> } {
  const selections: Record<string, { provider: string; model: string; thinkingLevel: string }> = {}
  const models = runtime.getAvailableSnapshot().map(model => {
    const custom = runtime.getRegisteredProviderConfig(model.provider)
    const supported = !!requestProfile(model) && !custom?.streamSimple && !runtime.getRegisteredNativeProvider(model.provider)
    const efforts = getSupportedThinkingLevels(model)
    const variants = efforts.map(thinkingLevel => {
      const selectionId = 'pi_' + createHash('sha256').update(JSON.stringify([workspaceId, model.provider, model.id, thinkingLevel])).digest('hex').slice(0, 40)
      selections[selectionId] = { provider: model.provider, model: model.id, thinkingLevel }
      return { id: thinkingLevel, title: thinkingLevel, displayName: thinkingLevel, selectionId, default: false, metadata: {}, enabled: supported, disabledReason: supported ? undefined : '该模型请求实现尚不支持严格核验。' }
    })
    return { id: model.provider + '/' + model.id, title: model.name || model.id, displayName: model.name || model.id,
      selectionId: model.reasoning ? undefined : variants[0].selectionId,
      reasoningItems: model.reasoning ? variants : [], default: false, enabled: supported,
      disabledReason: supported ? undefined : '该模型请求实现尚不支持严格核验。',
      metadata: { requestProfileDigest: createHash("sha256").update(JSON.stringify([model.api, model.baseUrl, model.thinkingLevelMap ?? null, model.compat ?? null, requestProfile(model) ?? null])).digest("hex"), provider: model.provider, providerName: model.provider, model: model.id, workspaceId, strictSelectionEnforced: supported } }
  })
  return { models, fingerprint: digest(models), selections }
}
