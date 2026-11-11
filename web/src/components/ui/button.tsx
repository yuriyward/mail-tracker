import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const variants = cva(
  "group/button inline-flex max-w-full shrink-0 select-none items-center justify-center text-balance rounded-none border border-transparent text-center font-medium text-base outline-none transition-colors duration-(--duration-feedback) ease-brand active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 hover:[&_svg.lucide-arrow-down]:translate-y-0.5 hover:[&_svg.lucide-arrow-right]:translate-x-0.5 hover:[&_svg.lucide-arrow-up-right]:translate-x-0.5 hover:[&_svg.lucide-arrow-up-right]:-translate-y-0.5 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-(--duration-feedback)",
  {
    compoundVariants: [
      {
        class:
          "min-h-0 px-0 py-0 has-data-[icon=inline-end]:pr-0 has-data-[icon=inline-start]:pl-0",
        variant: "link",
      },
    ],
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "min-h-9 gap-1.5 px-4 py-1.5 text-sm transition-(--header-control-properties) duration-(--header-control-durations) has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 motion-reduce:transition-none",
        default:
          "min-h-11 gap-2 px-6 py-2 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        header:
          "min-h-9 gap-1.5 px-4 py-1.5 text-sm transition-(--header-control-properties) duration-(--header-control-durations) has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3 motion-reduce:transition-none md:min-h-11 md:gap-2 md:px-6 md:py-2 md:text-base md:has-data-[icon=inline-end]:pr-4 md:has-data-[icon=inline-start]:pl-4",
        icon: "size-11",
        "icon-lg": "size-12",
        "icon-sm": "size-10",
        "icon-xs": "size-8 [&_svg:not([class*='size-'])]:size-3",
        lg: "min-h-12 gap-2 px-8 py-2.5 text-[1.0625rem] has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5",
        sm: "min-h-10 gap-1.5 px-4 py-1.5 text-sm has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "min-h-8 gap-1 px-3 py-1 text-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover aria-expanded:bg-primary-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive-hover",
        ghost:
          "text-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-control-hover aria-expanded:hover:border-input",
        highlight:
          "bg-field-yellow text-field-yellow-foreground hover:bg-highlight-hover",
        link: "h-auto px-0 text-emphasis underline decoration-1 underline-offset-[0.2em] hover:decoration-2 hover:decoration-current",
        outline:
          "border-input bg-transparent text-foreground hover:border-foreground hover:bg-accent aria-expanded:bg-control-hover aria-expanded:hover:bg-accent",
        secondary:
          "border-input bg-secondary text-secondary-foreground hover:border-foreground hover:bg-accent aria-expanded:bg-accent",
      },
    },
  }
);

/** Merged through `cn()`, so a size's own transition replaces the base `transition-colors` even when a caller styles
 *  a link with `buttonVariants` directly (an unmerged class list kept `transition-colors` and the header size jumped). */
function buttonVariants(props?: Parameters<typeof variants>[0]) {
  return cn(variants(props));
}

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      className={cn(buttonVariants({ className, size, variant }))}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  );
}

export { Button, buttonVariants };
