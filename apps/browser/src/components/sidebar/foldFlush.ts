const MAX_ROUNDS = 8;
const filling = new Map<string, Set<() => void>>();

export function fillingFold(windowId: string, flush: () => void): () => void {
  let folds = filling.get(windowId);
  if (!folds) filling.set(windowId, (folds = new Set()));
  folds.add(flush);
  return () => {
    folds.delete(flush);
    if (!folds.size && filling.get(windowId) === folds) filling.delete(windowId);
  };
}

export const foldsFilling = (windowId: string | null) => windowId !== null && (filling.get(windowId)?.size ?? 0) > 0;

const twoFrames = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

export async function flushFolds(windowId: string): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS && foldsFilling(windowId); round++) {
    for (const flush of [...filling.get(windowId)!]) flush();
    await twoFrames();
  }
}
