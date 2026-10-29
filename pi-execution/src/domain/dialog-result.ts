import { z } from 'zod'
const id = z.string().min(1).max(160)
export const DialogResult = z.union([
  z.object({ kind: z.literal('confirm'), status: z.literal('submitted'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('select'), status: z.literal('submitted'), optionId: id }).strict(),
  z.object({ kind: z.enum(['input', 'editor']), status: z.literal('submitted'), text: z.string().max(1_000_000) }).strict(),
  z.object({ kind: z.enum(['confirm', 'select', 'input', 'editor']), status: z.literal('cancelled') }).strict(),
])
