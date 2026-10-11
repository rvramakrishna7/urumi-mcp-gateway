import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost';
}

export function Button({ variant = 'primary', className, type = 'button', ...rest }: ButtonProps) {
  const classes = [styles.button, variant === 'primary' ? styles.primary : styles.ghost, className].filter(Boolean).join(' ');
  return <button type={type} className={classes} {...rest} />;
}
