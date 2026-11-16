/**
 * `bun run dmarc-pull`: keeps a local, append-only copy of a zone's Cloudflare DMARC
 * Management rows (GraphQL `dmarcReportsAdaptive`), since Cloudflare serves only about the
 * last 32 days. Raw rows only: nothing here associates them with messages.
 *
 * `<out>/rows.jsonl` holds one row per line. Rows are keyed by orgName + reportId +
 * recordIndex: a row equal (up to key order) to a stored version of its key is skipped; a
 * changed row is appended with `revisionOf`, the sha256 of the stored version it replaces.
 * `<out>/runs.jsonl` gets one line per run. Neither the token nor any row content is
 * ever printed.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** Rows asked for per query; a full page means the window may hold more. */
export const ROW_LIMIT = 10_000;

/** Cloudflare refuses windows (and ages) beyond 4 weeks 4 days. */
export const MAX_DAYS = 32;

/** 27 of the dataset's fields (Cloudflare allows at most 30 per query). */
export const FIELDS = [
  "datetime",
  "disposition",
  "dkim",
  "domain",
  "envelopeFrom",
  "envelopeTo",
  "evaluatedReason",
  "headerFrom",
  "matchingMessages",
  "orgName",
  "policyDKIMAlignmentMode",
  "policyDomain",
  "policyPercentage",
  "policySPFAlignmentMode",
  "policySubDomain",
  "recordId",
  "recordIndex",
  "reportBegin",
  "reportEnd",
  "reportError",
  "reportId",
  "sampleInterval",
  "sourceIP",
  "sourceOrgName",
  "sourcePTR",
  "spf",
  "spfMFromDomain",
] as const;

const QUERY = `query DmarcPull($zoneTag: string, $start: Time, $end: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      dmarcReportsAdaptive(
        filter: { datetime_geq: $start, datetime_lt: $end }
        limit: ${ROW_LIMIT}
        orderBy: [datetime_ASC]
      ) {
        ${FIELDS.join("\n        ")}
      }
    }
  }
}`;

export type Fetch = (request: Request) => Promise<Response>;

/** A row as Cloudflare returns it: field name to JSON value. */
const rowSchema = z.record(z.string(), z.json());
export type Row = z.output<typeof rowSchema>;
type Json = Row[string];

const apiErrors = z
  .array(z.object({ message: z.string().optional() }).loose())
  .nullish();

const responseSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        zones: z.array(z.object({ dmarcReportsAdaptive: z.array(rowSchema) })),
      }),
    })
    .nullish(),
  errors: apiErrors,
});

/** Why a run failed; printed and logged instead of any response data. */
export type ErrorClass =
  /** The request did not complete. */
  | "network"
  /** Cloudflare answered a non-2xx status. */
  | "http"
  /** The GraphQL response carried `errors`. */
  | "graphql"
  /** The response was not the expected shape. */
  | "invalid-response"
  /** The zone is not visible to this token. */
  | "zone-not-found"
  /** A one-second window still filled a whole page. */
  | "truncated";

export class PullError extends Error {
  readonly errorClass: ErrorClass;

  constructor(errorClass: ErrorClass, message: string) {
    super(message);
    this.name = "PullError";
    this.errorClass = errorClass;
  }
}

export interface Window {
  start: string;
  end: string;
}

export interface RunRecord {
  start: string;
  end: string;
  window: Window;
  /** Rows received from Cloudflare in windows that completed. */
  fetched: number;
  added: number;
  revised: number;
  status: "complete" | "failed";
  /** Null when complete. */
  errorClass: ErrorClass | null;
  /** The API's error message (never row data); null when complete. */
  error: string | null;
}

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const MAX_MESSAGE = 300;

const isoSeconds = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");

/** The value with object keys sorted at every level, so equal rows compare equal. */
const sortKeys = (value: Json): Json => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value instanceof Object) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
};

/** JSON with keys sorted, so rows equal up to key order have one text. */
export const canonical = (row: Row): string => JSON.stringify(sortKeys(row));

const rowKey = (row: Row): string =>
  JSON.stringify([row.orgName, row.reportId, row.recordIndex]);

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** An API message, kept short and with the token blanked should it ever be echoed. */
const scrub = (message: string, token: string): string =>
  (token === "" ? message : message.replaceAll(token, "[token]")).slice(
    0,
    MAX_MESSAGE
  );

const messages = (errors: z.output<typeof apiErrors>): string =>
  (errors ?? []).map((e) => e.message ?? "error").join("; ");

const parseRows = (body: string): Row[] => {
  let json: Json;
  try {
    json = z.json().parse(JSON.parse(body));
  } catch {
    throw new PullError("invalid-response", "response is not JSON");
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PullError(
      "invalid-response",
      "response is not the expected shape"
    );
  }
  const { data, errors } = parsed.data;
  if (errors !== null && errors !== undefined && errors.length > 0) {
    throw new PullError("graphql", messages(errors));
  }
  if (data === null || data === undefined) {
    throw new PullError("invalid-response", "response has no data");
  }
  const [zone] = data.viewer.zones;
  if (zone === undefined) {
    throw new PullError("zone-not-found", "zone not visible to this token");
  }
  return zone.dmarcReportsAdaptive;
};

const httpMessage = (status: number, body: string): string => {
  let json: Json = null;
  try {
    json = z.json().parse(JSON.parse(body));
  } catch {
    json = null;
  }
  const parsed = z.object({ errors: apiErrors }).safeParse(json);
  const { errors } = parsed.success ? parsed.data : { errors: null };
  const detail = messages(errors);
  return detail === "" ? `HTTP ${status}` : `HTTP ${status}: ${detail}`;
};

const queryWindow = async (
  options: { fetch: Fetch; token: string; zone: string },
  startMs: number,
  endMs: number
): Promise<Row[]> => {
  const request = new Request(GRAPHQL_URL, {
    body: JSON.stringify({
      query: QUERY,
      variables: {
        end: isoSeconds(endMs),
        start: isoSeconds(startMs),
        zoneTag: options.zone,
      },
    }),
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  let response: Response;
  let body: string;
  try {
    response = await options.fetch(request);
    body = await response.text();
  } catch (error) {
    throw new PullError(
      "network",
      error instanceof Error ? error.message : "request failed"
    );
  }
  if (!response.ok) {
    throw new PullError("http", httpMessage(response.status, body));
  }
  return parseRows(body);
};

/**
 * Every row in [startMs, endMs): a window whose answer fills a whole page is split in two
 * and each half asked again, down to one second; a one-second window that is still full
 * fails rather than pass a truncated window off as complete. `onWindow` gets each
 * completed window's rows, oldest first.
 */
export const fetchWindow = async (
  options: { fetch: Fetch; token: string; zone: string; limit?: number },
  startMs: number,
  endMs: number,
  onWindow: (rows: Row[]) => void
): Promise<void> => {
  const rows = await queryWindow(options, startMs, endMs);
  if (rows.length < (options.limit ?? ROW_LIMIT)) {
    onWindow(rows);
    return;
  }
  if (endMs - startMs <= SECOND) {
    throw new PullError(
      "truncated",
      `a one-second window at ${isoSeconds(startMs)} filled the row limit`
    );
  }
  const mid = startMs + Math.floor((endMs - startMs) / 2 / SECOND) * SECOND;
  await fetchWindow(options, startMs, mid, onWindow);
  await fetchWindow(options, mid, endMs, onWindow);
};

/** A stored line; a parse failure names the line, never its content. */
const parseLine = (line: string, number: number): Row => {
  try {
    return rowSchema.parse(JSON.parse(line));
  } catch {
    throw new Error(`rows.jsonl line ${number} is not a JSON object`);
  }
};

/** The stored versions of each key, as canonical JSON without `revisionOf`. */
const loadStore = (file: string): Map<string, string[]> => {
  const store = new Map<string, string[]>();
  if (!existsSync(file)) {
    return store;
  }
  for (const [index, line] of readFileSync(file, "utf-8")
    .split("\n")
    .entries()) {
    if (line.trim() !== "") {
      const { revisionOf: _revisionOf, ...row } = parseLine(line, index + 1);
      const key = rowKey(row);
      store.set(key, [...(store.get(key) ?? []), canonical(row)]);
    }
  }
  return store;
};

const appendPrivate = (file: string, lines: string[]): void => {
  if (lines.length > 0) {
    appendFileSync(file, lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
  }
  if (existsSync(file)) {
    chmodSync(file, 0o600);
  }
};

export interface StoreCounts {
  added: number;
  revised: number;
}

/** Appends the rows that are new or changed; answers how many of each. */
export const storeRows = (
  file: string,
  store: Map<string, string[]>,
  rows: Row[]
): StoreCounts => {
  const lines: string[] = [];
  let added = 0;
  let revised = 0;
  for (const row of rows) {
    const { revisionOf: _ignored, ...raw } = row;
    const key = rowKey(raw);
    const text = canonical(raw);
    const versions = store.get(key) ?? [];
    const latest = versions.at(-1);
    if (!versions.includes(text)) {
      if (latest === undefined) {
        lines.push(JSON.stringify(raw));
        added += 1;
      } else {
        lines.push(JSON.stringify({ ...raw, revisionOf: hash(latest) }));
        revised += 1;
      }
      store.set(key, [...versions, text]);
    }
  }
  appendPrivate(file, lines);
  return { added, revised };
};

export interface PullOptions {
  fetch: Fetch;
  token: string;
  zone: string;
  out: string;
  days: number;
  now?: () => number;
  limit?: number;
}

/** One run: fetch the window, store what is new, log the run. Never throws a PullError. */
export const pullDmarc = async (options: PullOptions): Promise<RunRecord> => {
  const now = options.now ?? Date.now;
  const started = now();
  const endMs = Math.floor(started / SECOND) * SECOND;
  const startMs = endMs - options.days * DAY;
  mkdirSync(options.out, { mode: 0o700, recursive: true });
  const rowsFile = path.join(options.out, "rows.jsonl");
  const store = loadStore(rowsFile);
  const counts = { added: 0, fetched: 0, revised: 0 };
  let failure: PullError | null = null;
  try {
    await fetchWindow(options, startMs, endMs, (rows) => {
      counts.fetched += rows.length;
      const stored = storeRows(rowsFile, store, rows);
      counts.added += stored.added;
      counts.revised += stored.revised;
    });
  } catch (error) {
    if (!(error instanceof PullError)) {
      throw error;
    }
    failure = error;
  }
  const record: RunRecord = {
    ...counts,
    end: new Date(now()).toISOString(),
    error: failure === null ? null : scrub(failure.message, options.token),
    errorClass: failure?.errorClass ?? null,
    start: new Date(started).toISOString(),
    status: failure === null ? "complete" : "failed",
    window: { end: isoSeconds(endMs), start: isoSeconds(startMs) },
  };
  appendPrivate(path.join(options.out, "runs.jsonl"), [JSON.stringify(record)]);
  return record;
};

const USAGE = `usage: bun run dmarc-pull --zone <zoneTag> --token-file <path> --out <dir> [--days 31]

Fetches the zone's DMARC report rows that arrived in the last --days days (1-${MAX_DAYS})
and appends new or changed ones to <out>/rows.jsonl; logs the run to <out>/runs.jsonl.
Prints the run record (counts and status, never rows). Exits 1 unless status is complete.`;

const ZONE_TAG = /^[0-9a-f]{32}$/u;

export const parseCliArgs = (
  args: string[]
): { zone: string; tokenFile: string; out: string; days: number } | null => {
  const { values } = parseArgs({
    args,
    options: {
      days: { default: "31", type: "string" },
      help: { type: "boolean" },
      out: { type: "string" },
      "token-file": { type: "string" },
      zone: { type: "string" },
    },
    strict: true,
  });
  if (values.help === true) {
    return null;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  if (values.zone === undefined || !ZONE_TAG.test(values.zone)) {
    throw new Error("--zone must be a 32-character hex zone tag");
  }
  if (values["token-file"] === undefined || values.out === undefined) {
    throw new Error("--token-file and --out are required");
  }
  return {
    days,
    out: values.out,
    tokenFile: values["token-file"],
    zone: values.zone,
  };
};

/** The command with its I/O passed in; answers the exit code. */
export const runCli = async (
  args: string[],
  io: {
    fetch: Fetch;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  }
): Promise<number> => {
  try {
    const parsed = parseCliArgs(args);
    if (parsed === null) {
      io.stdout(`${USAGE}\n`);
      return 0;
    }
    const token = readFileSync(parsed.tokenFile, "utf-8").trim();
    if (token === "") {
      throw new Error("the token file is empty");
    }
    const record = await pullDmarc({ ...parsed, fetch: io.fetch, token });
    io.stdout(`${JSON.stringify(record)}\n`);
    return record.status === "complete" ? 0 : 1;
  } catch (error) {
    // Usage and file errors: their messages name a flag or path, never file content.
    io.stderr(
      `dmarc-pull: ${error instanceof Error ? error.message : "failed"}\n`
    );
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    fetch,
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdout: (text) => {
      process.stdout.write(text);
    },
  });
}
