import type { ReactNode } from 'react';

/** The shared content column. Width and padding come from `.page-frame` on the layout. */
export function PageColumn({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`page ${className}`}>{children}</div>;
}
