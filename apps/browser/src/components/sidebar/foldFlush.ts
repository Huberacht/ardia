const filling = new Set<() => void>();

export function fillingFold(flush: () => void): () => void {
  filling.add(flush);
  return () => void filling.delete(flush);
}

export const foldsFilling = () => filling.size > 0;

export function flushFolds(): Promise<void> {
  if (!filling.size) return Promise.resolve();
  for (const flush of [...filling]) flush();
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}
