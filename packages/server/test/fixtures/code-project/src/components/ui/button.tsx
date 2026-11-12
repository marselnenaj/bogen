import * as React from 'react';
import { cn } from '@/lib/cn';

const variants = {
  default: 'bg-brand text-brand-ink hover:bg-brand/90',
  outline: 'border border-zinc-300 bg-white text-zinc-900',
  ghost: 'bg-transparent text-zinc-900 hover:bg-zinc-100',
};

const sizes = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-base',
  lg: 'h-12 px-6 text-lg',
};

export interface ButtonProps extends React.ComponentProps<'button'> {
  /** How loud the button is. */
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  /** Takes the whole width of its container. */
  block?: boolean;
}

export function Button({ variant = 'default', size = 'md', block = false, className, ...props }: ButtonProps) {
  return (
    <button
      className={cn('inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap', variants[variant], sizes[size], block && 'w-full', className)}
      {...props}
    />
  );
}
