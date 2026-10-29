export type ProjectTrustDecision = { enabled: boolean; mode: 'basic' | 'once' | 'persistent' }

export function existingTrust(resources: boolean, requested?: string, stored?: boolean): ProjectTrustDecision | undefined {
  if (!resources || requested === 'basic') return { enabled: false, mode: 'basic' }
  if (requested === 'once') return { enabled: true, mode: 'once' }
  if (stored !== undefined) return { enabled: stored, mode: stored ? 'persistent' : 'basic' }
  return undefined
}

export function trustAnswer(action: string): ProjectTrustDecision {
  if (action === 'basic') return { enabled: false, mode: 'basic' }
  if (action === 'once') return { enabled: true, mode: 'once' }
  if (action === 'trust_directory') return { enabled: true, mode: 'persistent' }
  throw new Error('Unsupported project trust decision')
}
