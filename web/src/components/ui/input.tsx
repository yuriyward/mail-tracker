import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import type { ComponentProps } from "react";

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      className={cn(
        "h-11 w-full min-w-0 border border-input bg-transparent px-3 py-1 text-base outline-none transition-[color,border-color] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground not-aria-invalid:hover:border-foreground focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      data-slot="input"
      type={type}
      {...props}
    />
  );
}

export { Input };
