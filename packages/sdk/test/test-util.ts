export function withProcessCwd<T>(cwd: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(cwd);
  const restore = (): void => {
    process.chdir(prev);
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
