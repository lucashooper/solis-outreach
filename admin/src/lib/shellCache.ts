const box = new Map<string, { at: number; data: unknown }>();

export function putCache<T>(key: string, data: T): void {
  box.set(key, { at: Date.now(), data });
}

export function getCache<T>(key: string, maxMs = 20000): T | null {
  const hit = box.get(key);
  if (!hit || Date.now() - hit.at > maxMs) return null;
  return hit.data as T;
}
