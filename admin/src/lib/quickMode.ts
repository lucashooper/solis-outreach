import { useEffect, useState } from 'react';

const KEY = 'solis-quick-mode';
const EVENT = 'solis-quick-mode';

export function readQuickMode(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function writeQuickMode(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useQuickMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readQuickMode);
  useEffect(() => {
    const sync = () => setOn(readQuickMode());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [on, writeQuickMode];
}
