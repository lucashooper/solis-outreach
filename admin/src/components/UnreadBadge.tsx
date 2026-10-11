export function UnreadBadge({
  count,
  dot = false,
  className = '',
}: {
  count: number;
  /** Compact dot for a collapsed sidebar icon. */
  dot?: boolean;
  className?: string;
}) {
  if (count <= 0) return null;
  const noun = count === 1 ? 'reply' : 'replies';
  if (dot) {
    return (
      <span
        className={`absolute right-2 top-2 h-2 w-2 rounded-full bg-accent shadow-[0_0_8px_rgba(59,130,246,0.85)] ${className}`}
        aria-label={`${count} unread ${noun}`}
      />
    );
  }
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      className={`inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-accent/20 px-1.5 text-[10px] font-semibold tabular-nums leading-4 text-accent-hover ${className}`}
      aria-label={`${count} unread ${noun}`}
    >
      {label}
    </span>
  );
}
