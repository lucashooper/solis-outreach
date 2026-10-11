import type { NavigateFunction } from 'react-router-dom';

/** React Router stores its own index on the history entry. The first page is 0. */
export function hasInAppHistory(): boolean {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' && state.idx > 0;
}

export function goBack(navigate: NavigateFunction, fallback: string): void {
  if (hasInAppHistory()) navigate(-1);
  else navigate(fallback);
}
