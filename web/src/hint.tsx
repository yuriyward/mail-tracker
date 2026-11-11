import type { ReactElement, ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./components/ui/tooltip";

/**
 * Shows `label` in the design system's tooltip while `children` (one element, rendered
 * as the trigger itself) is hovered or focused. Used instead of the browser's title.
 */
export const Hint = ({
  children,
  label,
}: {
  children: ReactElement;
  label: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);
