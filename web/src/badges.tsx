import { Fragment } from "react";

import { personPath, recipientLabel } from "../../src/dashboard-data";
import { Badge } from "./components/ui/badge";
import { Hint } from "./hint";
import { linkClass } from "./layout";
import { duration } from "./lib/dates";
import { openStateLabel } from "./lib/tables";
import type { OpenState } from "./lib/tables";

const STATE_BADGE = {
  clicked: "secondary",
  "not-opened": "outline",
  opened: "default",
  reopened: "highlight",
} as const satisfies Record<OpenState, string>;

/** The statuses of an email (or one person's view of it) as badges. */
export const StatusBadges = ({ states }: { states: OpenState[] }) => (
  <span className="flex flex-wrap items-center gap-1">
    {states.map((state) => (
      <Badge key={state} variant={STATE_BADGE[state]}>
        {openStateLabel(state)}
      </Badge>
    ))}
  </span>
);

/** An address linking to that person's page; a shared copy ('') has none. */
export const PersonLink = ({
  address,
  className = "",
}: {
  address: string;
  className?: string;
}) =>
  address === "" ? (
    <span className={className}>{recipientLabel(address)}</span>
  ) : (
    <a className={`${linkClass} ${className}`} href={personPath(address)}>
      {address}
    </a>
  );

/**
 * Each current recipient linking to their page, or the display text when the email has
 * no known addresses (a shared copy, or tokens from before per-recipient tracking).
 */
export const RecipientLinks = ({
  addresses,
  fallback,
}: {
  addresses: readonly string[];
  fallback: string;
}) => {
  if (addresses.length === 0) {
    return (
      <Hint label={fallback}>
        <span className="block max-w-[28ch] truncate">{fallback}</span>
      </Hint>
    );
  }
  return (
    <Hint label={addresses.join(", ")}>
      <span className="block max-w-[28ch] truncate">
        {addresses.map((address, index) => (
          <Fragment key={address}>
            {index > 0 && ", "}
            <PersonLink address={address} />
          </Fragment>
        ))}
      </span>
    </Hint>
  );
};

/** A link's short name, its full URL in the tooltip. */
export const LinkName = ({
  className = "",
  name,
  url,
}: {
  className?: string;
  name: string;
  url: string;
}) => (
  <Hint label={<span className="font-mono break-all">{url}</span>}>
    <span className={`block max-w-[40ch] truncate ${className}`}>{name}</span>
  </Hint>
);

/** "3 h 5 min"; a dash when no email was opened by a probable human. */
export const MedianFirstOpen = ({ ms }: { ms: number | null }) =>
  ms === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span className="whitespace-nowrap tabular-nums">{duration(ms)}</span>
  );
