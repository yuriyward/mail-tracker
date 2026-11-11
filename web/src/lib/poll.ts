import { useEffect, useState } from "react";
import type { z } from "zod";

import { REFRESH_MS } from "../../../src/dashboard-data";

export type Poll<T> =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  /** `stale`: the last refresh failed, so `data` is from the last success. */
  | { kind: "ready"; data: T; stale: boolean };

/** A failed refresh keeps the last data on screen and marks it stale. */
export const afterFailure = <T>(previous: Poll<T>): Poll<T> =>
  previous.kind === "ready" ? { ...previous, stale: true } : { kind: "failed" };

/** One read: the parsed data, `missing` on 404, or null on any other failure. */
const read = async <T>(
  url: string,
  schema: z.ZodType<T>
): Promise<Poll<T> | null> => {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    // An expired Access session answers with a redirect to the login page: a failure here.
    redirect: "error",
  });
  if (response.status === 404) {
    return { kind: "missing" };
  }
  if (!response.ok) {
    return null;
  }
  const parsed = schema.safeParse(await response.json());
  return parsed.success
    ? { data: parsed.data, kind: "ready", stale: false }
    : null;
};

/**
 * Fetches `url` now and every REFRESH_MS while the tab is visible; a tab that becomes
 * visible again refreshes at once. `schema` must be a module constant.
 */
export const usePoll = <T>(url: string, schema: z.ZodType<T>): Poll<T> => {
  const [state, setState] = useState<Poll<T>>({ kind: "loading" });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (busy) {
        return;
      }
      busy = true;
      try {
        const next = await read(url, schema);
        if (!stopped) {
          setState((previous) => next ?? afterFailure(previous));
        }
      } catch {
        if (!stopped) {
          setState(afterFailure);
        }
      } finally {
        busy = false;
        // oxlint-disable-next-line no-use-before-define -- tick and schedule call each other.
        schedule();
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer =
        stopped || document.hidden
          ? undefined
          : setTimeout(() => {
              void tick();
            }, REFRESH_MS);
    };

    const onVisibility = () => {
      if (document.hidden) {
        schedule();
      } else {
        void tick();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, schema]);

  return state;
};
