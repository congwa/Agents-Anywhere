import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { digest, requireValue } from '../domain/shared.js'

import type { ResumePosition as Position } from '../domain/resume-position.js'
export type { ResumePosition as Position } from '../domain/resume-position.js'
export function capturePosition(manager: SessionManager, generation: string, previous?: Position, clean = false): Position {
  const header = manager.getHeader()
  const branch = manager.getBranch()
  return { piSessionId: manager.getSessionId(), sourceEpoch: digest(header), leafId: manager.getLeafId(),
    anchorDigest: digest(branch), positionRevision: (previous?.positionRevision ?? 0) + 1,
    branchGeneration: previous?.branchGeneration ?? generation, ownerGeneration: generation,
    fileEntriesDigest: digest(manager.getEntries()), clean }
}
export function verifyPosition(manager: SessionManager, position: Position): void {
  requireValue(position.piSessionId === manager.getSessionId() && position.sourceEpoch === digest(manager.getHeader()),
    'pi_position_reconciliation_required', '原生来源已变化，请确认继续位置。')
  requireValue(position.clean && position.fileEntriesDigest === digest(manager.getEntries()),
    'pi_position_reconciliation_required', '原生历史或关闭状态需要确认，请选择继续位置。')
  if (position.leafId === null) manager.resetLeaf()
  else { requireValue(manager.getEntry(position.leafId), 'pi_position_reconciliation_required', '已保存的位置不存在。'); manager.branch(position.leafId) }
  requireValue(position.anchorDigest === digest(manager.getBranch()), 'pi_position_reconciliation_required', '分支锚点校验失败。')
}
