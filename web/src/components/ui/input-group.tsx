"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ComponentProps, MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Preserve the public div props/ref API and flex sizing without fieldset's special layout behavior.
    <div
      className={cn(
        "group/input-group relative flex h-11 w-full min-w-0 items-center rounded-none border border-input bg-transparent outline-none transition-[color,border-color] in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 not-has-[[aria-invalid=true]]:not-data-[disabled=true]:hover:border-foreground has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-start]]:h-auto has-[>textarea]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:flex-col has-[textarea]:rounded-none has-data-[align=block-end]:rounded-none has-data-[align=block-start]:rounded-none has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-destructive has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3",
        className
      )}
      data-slot="input-group"
      role="group"
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text select-none items-center justify-center gap-2 py-2 font-medium text-muted-foreground text-sm **:data-[slot=kbd]:rounded-none **:data-[slot=kbd]:bg-muted-foreground/10 **:data-[slot=kbd]:px-1.5 group-data-[disabled=true]/input-group:opacity-50 [&>svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      align: "inline-start",
    },
    variants: {
      align: {
        "block-end":
          "order-last w-full justify-start px-3 pb-3 group-has-[>input]/input-group:pb-3.5 [.border-t]:pt-3.5",
        "block-start":
          "order-first w-full justify-start px-3 pt-3 group-has-[>input]/input-group:pt-3.5 [.border-b]:pb-3.5",
        "inline-end": "order-last pr-3 has-[>button]:pr-[3px]",
        "inline-start": "order-first pl-3 has-[>button]:pl-[3px]",
      },
    },
  }
);

function focusAddonInput(event: MouseEvent<HTMLDivElement>) {
  if ((event.target as HTMLElement).closest("button")) {
    return;
  }
  event.currentTarget.parentElement?.querySelector("input")?.focus();
}

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: Clicking the adornment only focuses the input already reachable by Tab; nested buttons retain their own actions.
    <div
      className={cn(inputGroupAddonVariants({ align }), className)}
      data-align={align}
      data-slot="input-group-addon"
      onClick={focusAddonInput}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva(
  "flex min-h-0 items-center gap-2 rounded-none border-transparent py-0 text-sm shadow-none hover:border-transparent",
  {
    defaultVariants: {
      size: "xs",
    },
    variants: {
      size: {
        "icon-sm": "size-8 p-0 has-[>svg]:p-0",
        "icon-xs": "size-6 p-0 text-xs has-[>svg]:p-0",
        sm: "h-9 px-3",
        xs: "h-6 gap-1 rounded-none px-1.5 text-xs [&>svg:not([class*='size-'])]:size-3.5",
      },
    },
  }
);

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset";
  }) {
  return (
    <Button
      className={cn(inputGroupButtonVariants({ size }), className)}
      data-size={size}
      type={type}
      variant={variant}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-muted-foreground text-sm [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none",
        className
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <Input
      className={cn(
        "flex-1 border-0 bg-transparent ring-0 focus-visible:ring-0 group-has-[>[data-align=inline-end]]/input-group:pr-2 group-has-[>[data-align=inline-start]]/input-group:pl-2 aria-invalid:ring-0 dark:bg-transparent",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

function InputGroupTextarea({
  className,
  ...props
}: ComponentProps<"textarea">) {
  return (
    <Textarea
      className={cn(
        "flex-1 resize-none border-0 bg-transparent py-2.5 ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
};
