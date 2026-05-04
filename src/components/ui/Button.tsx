"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANT: Record<Variant, string> = {
  primary: "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white",
  secondary: "bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] text-[var(--color-text)]",
  ghost: "bg-transparent hover:bg-[var(--color-surface-2)] text-[var(--color-text)]",
  danger: "bg-[var(--color-danger)] hover:opacity-90 text-white",
  outline: "border border-[var(--color-border-strong)] bg-transparent hover:bg-[var(--color-surface-2)] text-[var(--color-text)]",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-xs rounded-md",
  md: "h-9 px-4 text-sm rounded-md",
  lg: "h-10 px-5 text-sm rounded-md",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    />
  )
);
Button.displayName = "Button";
