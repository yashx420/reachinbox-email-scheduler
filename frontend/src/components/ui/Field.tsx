'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const CONTROL_STYLES =
  'w-full rounded-xl border border-surface-border bg-surface-base/60 px-3.5 py-2.5 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 transition-colors hover:border-slate-700 focus:border-brand-500 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}

/** Shared label/hint/error frame so every control lines up identically. */
function FieldShell({ label, hint, error, htmlFor, children, className }: FieldShellProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {/* An unlabelled control (the search box) relies on aria-label instead of
          rendering an empty <label>. */}
      {(label || hint) && (
        <div className="flex items-baseline justify-between gap-3">
          {label ? (
            <label htmlFor={htmlFor} className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {label}
            </label>
          ) : (
            <span />
          )}
          {hint && <span className="text-xs text-slate-500">{hint}</span>}
        </div>
      )}
      {children}
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}

export interface InputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  containerClassName?: string;
}

export const InputField = forwardRef<HTMLInputElement, InputFieldProps>(function InputField(
  { label, hint, error, containerClassName, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId} className={containerClassName}>
      <input
        ref={ref}
        id={fieldId}
        className={cn(CONTROL_STYLES, error && 'border-rose-500/60', className)}
        {...props}
      />
    </FieldShell>
  );
});

export interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  containerClassName?: string;
}

export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(function TextareaField(
  { label, hint, error, containerClassName, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;

  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={fieldId} className={containerClassName}>
      <textarea
        ref={ref}
        id={fieldId}
        className={cn(CONTROL_STYLES, 'resize-none leading-relaxed', error && 'border-rose-500/60', className)}
        {...props}
      />
    </FieldShell>
  );
});
