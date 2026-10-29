export type RequestProfile = 'openai' | 'openrouter' | 'responses'

/** Mirrors the relevant compatibility defaults of the pinned pi-ai 1.4.0.
 * Unknown thinking encodings stay unavailable until their wire format is verified.
 */
export function requestProfile(model: any): RequestProfile | undefined {
  if (model.api === 'openai-responses') return 'responses'
  if (model.api !== 'openai-completions') return
  const provider = model.provider, url = model.baseUrl ?? ''
  const zai = ['zai', 'zai-coding-cn'].includes(provider) || url.includes('api.z.ai') || url.includes('open.bigmodel.cn')
  const together = provider === 'together' || url.includes('api.together.ai') || url.includes('api.together.xyz')
  const ant = provider === 'ant-ling' || url.includes('api.ant-ling.com')
  const deepseek = provider === 'deepseek' || url.toLowerCase().includes('deepseek.com')
  const openrouter = provider === 'openrouter' || url.includes('openrouter.ai')
  const format = model.compat?.thinkingFormat ?? (deepseek ? 'deepseek' : zai ? 'zai' : together ? 'together' : ant ? 'ant-ling' : openrouter ? 'openrouter' : 'openai')
  if (format !== 'openai' && format !== 'openrouter') return
  const suppressedEffort = zai || together || ant || provider === 'xai' || url.includes('api.x.ai')
    || ['moonshotai', 'moonshotai-cn'].includes(provider) || url.includes('api.moonshot.')
    || provider === 'cloudflare-ai-gateway' || url.includes('gateway.ai.cloudflare.com')
    || provider === 'nvidia' || url.includes('integrate.api.nvidia.com')
  if (format === 'openai' && model.reasoning && !(model.compat?.supportsReasoningEffort ?? !suppressedEffort)) return
  return format
}
