"use client";
import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...rest }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("relative flex w-full touch-none select-none items-center h-5", className)}
    {...rest}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[var(--color-surface-2)]">
      <SliderPrimitive.Range className="absolute h-full bg-[var(--color-accent)]" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-[var(--color-accent)] bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40" />
  </SliderPrimitive.Root>
));
Slider.displayName = "Slider";
