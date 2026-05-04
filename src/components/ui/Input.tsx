"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-sm placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] transition-colors disabled:opacity-50",
        className
      )}
      {...rest}
    />
  )
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] px-3 py-2 text-sm placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] transition-colors disabled:opacity-50 font-mono resize-y",
        className
      )}
      {...rest}
    />
  )
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...rest }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] px-3 text-sm focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)] transition-colors disabled:opacity-50",
        className
      )}
      {...rest}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

export function Label({ className, ...rest }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-medium text-[var(--color-text-dim)]", className)} {...rest} />;
}
