import * as React from 'react';

const tones = {
  primary: 'bg-accent text-white',
  secondary: 'bg-white text-zinc-900 border border-zinc-300',
  danger: 'bg-red-600 text-white',
};

export interface ButtonProps extends React.ComponentProps<'button'> {
  tone?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
}

export function Button({ tone = 'primary', size = 'md', className = '', ...props }: ButtonProps) {
  return <button className={`inline-flex rounded-md font-medium ${size === 'sm' ? 'px-2 py-1 text-sm' : 'px-4 py-2'} ${tones[tone]} ${className}`} {...props} />;
}
