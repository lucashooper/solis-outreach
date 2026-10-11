import { useEffect, useRef, useState } from 'react';
import { isStoredAvatarUrl, usableAvatarUrl } from '../../../src/creators/profile.ts';

const failedSources = new Set<string>();

const WASHES: Array<[string, string]> = [
  ['#1c2433', '#3b82f6'],
  ['#241c33', '#8b5cf6'],
  ['#1c2e28', '#34d399'],
  ['#2e241c', '#f59e0b'],
  ['#2e1c24', '#fb7185'],
  ['#1c2a33', '#22d3ee'],
];

const pending: Array<() => Promise<void>> = [];
let activeCopies = 0;
const copies = new Map<string, Promise<Blob | null>>();

function scheduleCopy(task: () => Promise<void>) {
  pending.push(task);
  const pump = () => {
    while (activeCopies < 3 && pending.length) {
      const next = pending.shift();
      if (!next) return;
      activeCopies += 1;
      void next().finally(() => {
        activeCopies -= 1;
        pump();
      });
    }
  };
  pump();
}

/** Copy a CDN avatar into storage once per session, and return the bytes when the row has nothing to show. */
function copyAvatar(creatorId: string): Promise<Blob | null> {
  const existing = copies.get(creatorId);
  if (existing) return existing;
  const promise = new Promise<Blob | null>((resolve) => {
    scheduleCopy(async () => {
      try {
        const res = await fetch(`/api/avatars?creatorId=${encodeURIComponent(creatorId)}`);
        if (!res.ok) {
          resolve(null);
          return;
        }
        const blob = await res.blob();
        resolve(blob.type.startsWith('image/') ? blob : null);
      } catch {
        resolve(null);
      }
    });
  });
  copies.set(creatorId, promise);
  return promise;
}

function initials(name: string): string {
  const clean = name.replace(/^@/, '').trim();
  return (clean[0] || '?').toUpperCase();
}

function wash(name: string): [string, string] {
  const clean = name.replace(/^@/, '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = (hash * 33 + clean.charCodeAt(i)) >>> 0;
  return WASHES[hash % WASHES.length] ?? WASHES[0]!;
}

export function avatarRequestUrl(url: string | null | undefined): string | null {
  const usable = usableAvatarUrl(url);
  if (!usable || failedSources.has(usable)) return null;
  return usable;
}

export function CreatorAvatar({
  name,
  url,
  creatorId,
  size = 'md',
}: {
  name: string;
  url?: string | null;
  creatorId?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const direct = avatarRequestUrl(url);
  const [override, setOverride] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const blobRef = useRef<string | null>(null);
  const dim = size === 'lg' ? 'h-14 w-14 text-base' : size === 'sm' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm';

  useEffect(() => {
    setOverride(null);
    setFailed(false);
  }, [url, creatorId]);

  useEffect(() => {
    if (!creatorId || isStoredAvatarUrl(url)) return;
    let cancelled = false;
    void copyAvatar(creatorId).then((blob) => {
      if (cancelled || !blob) {
        if (!cancelled && !avatarRequestUrl(url)) setFailed(true);
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      blobRef.current = objectUrl;
      if (!avatarRequestUrl(url)) {
        setOverride(objectUrl);
        setFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [creatorId, url]);

  const src = failed ? null : override || direct;
  if (!src) {
    const [from, to] = wash(name);
    return (
      <span
        className={`${dim} inline-flex shrink-0 items-center justify-center rounded-full font-medium text-ink`}
        style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
        aria-hidden
      >
        {initials(name)}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={`${dim} shrink-0 rounded-full object-cover`}
      referrerPolicy="no-referrer"
      onError={() => {
        failedSources.add(src);
        if (blobRef.current && blobRef.current !== src) {
          setOverride(blobRef.current);
          return;
        }
        setFailed(true);
      }}
    />
  );
}
