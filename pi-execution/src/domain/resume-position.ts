export type ResumePosition = {
  piSessionId: string; sourceEpoch: string; leafId: string | null; anchorDigest: string;
  positionRevision: number; branchGeneration: string; ownerGeneration: string;
  fileEntriesDigest: string; clean: boolean;
}
