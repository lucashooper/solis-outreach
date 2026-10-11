import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function IconButton({
  label,
  children,
  className = '',
  tone = 'default',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`icon-btn ${tone === 'danger' ? 'icon-btn-danger' : ''} ${className}`}
      {...props}
    >
      {children}
      <span className="icon-btn-tip" role="tooltip" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}
