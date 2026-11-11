import type { DetailData, Totals } from "../../src/dashboard-data";
import { Badge } from "./components/ui/badge";
import { When } from "./lib/format";
import { Reopened } from "./reopened";

/** "to · sent 12:54 AM · opened 12:54 AM–1:35 AM" on one line, full dates on hover. */
export const Summary = ({
  message,
  totals,
}: {
  message: Pick<DetailData["message"], "recipient" | "sentAt" | "shared">;
  totals: Pick<Totals, "firstOpen" | "lastOpen"> &
    Partial<Pick<Totals, "lastReopen">>;
}) => {
  const { firstOpen, lastOpen, lastReopen = null } = totals;
  return (
    <p className="type-meta text-muted-foreground flex flex-wrap items-center gap-x-2">
      <span className="text-foreground break-all">{message.recipient}</span>
      {message.shared && <Badge variant="outline">shared copy</Badge>}
      <span aria-hidden>·</span>
      {message.sentAt === null ? (
        <span>not sent</span>
      ) : (
        <span>
          sent <When ms={message.sentAt} none="" />
        </span>
      )}
      <span aria-hidden>·</span>
      {firstOpen === null ? (
        <span>not opened</span>
      ) : (
        <span>
          opened <When ms={firstOpen} none="" />
          {lastOpen !== null && lastOpen !== firstOpen && (
            <>
              –<When ms={lastOpen} none="" />
            </>
          )}
        </span>
      )}
      {lastReopen !== null && (
        <>
          <span aria-hidden>·</span>
          <Reopened ms={lastReopen} />
        </>
      )}
    </p>
  );
};
