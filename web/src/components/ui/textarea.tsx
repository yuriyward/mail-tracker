import { cn } from "cn";
import type { ComponentProps } from "react";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "field-sizing-content flex min-h-16 w-full resize-none rounded-none border border-input bg-transparent px-3 py-2.5 text-base outline-none transition-[color,border-color] placeholder:text-muted-foreground not-aria-invalid:hover:border-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
