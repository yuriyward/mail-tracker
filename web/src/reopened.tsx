import { Badge } from "./components/ui/badge";
import { When } from "./lib/format";

/** "re-opened" with when, full date on hover; nothing when there was no re-open. */
export const Reopened = ({ ms }: { ms: number | null }) =>
  ms === null ? null : (
    <span className="inline-flex items-center gap-2">
      <Badge variant="highlight">re-opened</Badge>
      <When ms={ms} none="" />
    </span>
  );
