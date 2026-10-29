import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { freezeInput, RuntimeFailure, requireValue } from '../domain/shared.js'
import { requestProfile, type RequestProfile } from './request-profile.js'

import type { ModelPermit } from '../domain/model-permit.js'
export type { ModelPermit } from '../domain/model-permit.js'

export class ModelGuard {
  session?: AgentSession
  permit?: ModelPermit
  lastFailure?: { code: string; message: string }
  constructor(readonly generation: string, private readonly rejected: (error: RuntimeFailure) => void) {}
  private deny(code: string, message: string): never {
    const error = new RuntimeFailure(code, message)
    this.lastFailure = { code, message }; this.rejected(error)
    throw error
  }
  private check(model: any, reasoning?: string): ModelPermit {
    const permit = this.permit
    if (!permit || permit.cancelled || permit.generation !== this.generation) return this.deny('pi_request_not_authorized', '当前没有有效的模型请求授权。')
    const actual = this.session?.model
    if (model.provider !== permit.provider || model.id !== permit.model || model.api !== permit.api
      || (actual && (actual.provider !== permit.provider || actual.id !== permit.model))) {
      return this.deny('pi_request_selection_changed', '扩展改变了模型选择，本次请求已阻止。请确认模型后再继续。')
    }
    if ((reasoning ?? 'off') !== permit.thinkingLevel || (this.session && this.session.thinkingLevel !== permit.thinkingLevel)) {
      return this.deny('pi_request_effort_changed', '推理强度发生变化，本次请求已阻止。')
    }
    return permit
  }
  private payload(payload: any, permit: ModelPermit, profile: RequestProfile): void {
    if (!payload || payload.model !== permit.model) this.deny('pi_request_payload_changed', '最终请求中的模型与已确认选择不一致。')
    if (permit.requiredImages) {
      const messages = payload.messages ?? payload.input
      const latestUser = Array.isArray(messages) ? messages.filter((message: any) => message.role === 'user').at(-1) : undefined
      const images = Array.isArray(latestUser?.content) ? latestUser.content.filter((part: any) => part.type === 'image_url' || part.type === 'input_image').length : 0
      if (images < permit.requiredImages) this.deny('pi_request_images_omitted', '图片未完整进入最终模型请求，本次请求已阻止。')
    }
    const wireEffort = profile === 'openai' ? payload.reasoning_effort : payload.reasoning?.effort
    const effort = wireEffort === 'none' || wireEffort === undefined ? 'off' : wireEffort
    const expected = permit.wireEffort === null || permit.wireEffort === 'none' ? 'off' : permit.wireEffort ?? permit.thinkingLevel
    if (effort !== expected) this.deny('pi_request_effort_changed', '最终请求中的推理强度与已确认选择不一致。')
  }
  wrap(runtime: ModelRuntime): ModelRuntime {
    const guard = this
    const requests = new Set(['stream', 'streamSimple', 'complete', 'completeSimple'])
    const unsupported = new Set(['streamDeferred', 'fetchDeferred', 'generateImages', 'classify'])
    return new Proxy(runtime, { get(target, key) {
      if (typeof key === 'string' && unsupported.has(key)) return () => guard.deny('pi_request_profile_unsupported', '该模型请求类型尚不支持严格核验。')
      if (typeof key === 'string' && requests.has(key)) return (model: any, context: any, options: any = {}) => {
        const permit = guard.check(model, options.reasoning)
        const profile = requestProfile(model)
        if (!profile || permit.requestProfile && permit.requestProfile !== profile) return guard.deny('pi_request_profile_unsupported', '该模型请求格式尚不支持严格核验，或已发生变化。')
        const configuration = target.getRegisteredProviderConfig(model.provider)
        if (configuration?.streamSimple || target.getRegisteredNativeProvider(model.provider)) guard.deny('pi_request_profile_unsupported', '自定义请求实现需要单独验证。')
        const previousPayload = options.onPayload
        const originalFetch = globalThis.fetch
        const guardedOptions = { ...options, transport: 'sse',
          onPayload: async (payload: unknown, requestModel: any) => {
            const transformed = await previousPayload?.(payload, requestModel)
            const result = transformed === undefined ? payload : transformed
            guard.check(model, options.reasoning); guard.payload(result, permit, profile)
            return freezeInput(JSON.parse(JSON.stringify(result)))
          },
          fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            guard.check(model, options.reasoning)
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
            const allowed = new URL(permit.baseUrl)
            const root = allowed.pathname.replace(/\/$/, '') + '/'
            if (url.origin !== allowed.origin || !url.pathname.startsWith(root)) guard.deny('pi_request_endpoint_changed', '模型请求目标发生变化。')
            requireValue(typeof init?.body === 'string', 'pi_request_profile_unsupported', '无法核验该请求格式。')
            guard.payload(JSON.parse(init.body), permit, profile)
            permit.dispatched++
            return originalFetch(input, init)
          },
        }
        // All four entry points receive the same wrapped payload/fetch, including
        // complete() methods that internally invoke a target-bound stream().
        return (target[key as keyof ModelRuntime] as Function).call(target, model, context, guardedOptions)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  bind(session: AgentSession): void {
    this.session = session
    const prepare = session.agent.prepareRequest
    session.agent.prepareRequest = async (request, signal) => {
      const result = await prepare?.(request, signal)
      this.check(result?.model ?? request.model, result?.thinkingLevel ?? request.thinkingLevel)
      return result || undefined
    }
  }
  cancel(): void { if (this.permit) this.permit.cancelled = true }
}
