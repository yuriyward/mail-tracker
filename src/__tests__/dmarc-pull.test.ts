// `bun run dmarc-pull` against a fake Cloudflare GraphQL endpoint holding synthetic rows.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  canonical,
  FIELDS,
  GRAPHQL_URL,
  pullDmarc,
  runCli,
} from "../cli/dmarc-pull";
import type { Fetch, Row, RunRecord } from "../cli/dmarc-pull";

const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "synthetic-token-Zq81";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const HOUR = 3_600_000;

/** A synthetic row that arrived `hoursAgo` before NOW; text fields carry a marker. */
const row = (n: number, hoursAgo: number, extra: Row = {}): FakeRow => ({
  datetime: new Date(NOW - hoursAgo * HOUR).toISOString(),
  disposition: "none",
  dkim: "pass",
  envelopeFrom: `bounce-${n}.example.net`,
  headerFrom: "example.org",
  orgName: "Example Receiver",
  recordIndex: n % 2,
  reportId: `report-secret-${Math.floor(n / 2)}`,
  sourceIP: `192.0.2.${n}`,
  spf: "pass",
  ...extra,
});

type FakeRow = Row & { datetime: string };

const requestSchema = z.object({
  query: z.string(),
  variables: z.object({
    end: z.string(),
    start: z.string(),
    zoneTag: z.string(),
  }),
});

const lineSchema = z.record(z.string(), z.json());

interface Fake {
  fetch: Fetch;
  rows: FakeRow[];
  calls: { start: string; end: string }[];
  answer?: () => Response;
}

/** Answers like `dmarcReportsAdaptive`: [start, end) by datetime, oldest first, `limit` rows. */
const fakeCloudflare = (limit: number): Fake => {
  const fake: Fake = {
    calls: [],
    fetch: async (request) => {
      expect(request.url).toBe(GRAPHQL_URL);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      const { end, start, zoneTag } = requestSchema.parse(
        await request.json()
      ).variables;
      fake.calls.push({ end, start });
      if (fake.answer !== undefined) {
        return fake.answer();
      }
      const zones =
        zoneTag === ZONE
          ? [
              {
                dmarcReportsAdaptive: fake.rows
                  .filter((r) => {
                    const at = Date.parse(r.datetime);
                    return at >= Date.parse(start) && at < Date.parse(end);
                  })
                  .toSorted((a, b) => a.datetime.localeCompare(b.datetime))
                  .slice(0, limit),
              },
            ]
          : [];
      return Response.json({ data: { viewer: { zones } }, errors: null });
    },
    rows: [],
  };
  return fake;
};

let out: string;

beforeEach(() => {
  out = mkdtempSync(path.join(tmpdir(), "dmarc-pull-"));
});

afterEach(() => {
  rmSync(out, { force: true, recursive: true });
});

const lines = (name: string): Row[] =>
  readFileSync(path.join(out, name), "utf-8")
    .trim()
    .split("\n")
    .map((l) => lineSchema.parse(JSON.parse(l)));

const pull = async (fake: Fake, limit: number): Promise<RunRecord> =>
  await pullDmarc({
    days: 31,
    fetch: fake.fetch,
    limit,
    now: () => NOW,
    out,
    token: TOKEN,
    zone: ZONE,
  });

describe("bun run dmarc-pull", () => {
  test("asks for the 27 fields over the last --days of arrivals", async () => {
    let query = "";
    const fake = fakeCloudflare(100);
    const inner = fake.fetch;
    fake.fetch = async (request) => {
      ({ query } = requestSchema.parse(await request.clone().json()));
      return await inner(request);
    };
    const record = await pull(fake, 100);
    expect(FIELDS).toHaveLength(27);
    for (const field of FIELDS) {
      expect(query).toMatch(new RegExp(`\\b${field}\\b`, "u"));
    }
    expect(query).toContain("datetime_geq: $start, datetime_lt: $end");
    expect(record.window).toEqual({
      end: "2026-11-16T12:00:00Z",
      start: "2026-10-16T12:00:00Z",
    });
    expect(record.status).toBe("complete");
  });

  test("skips rows already stored, whatever their key order", async () => {
    const fake = fakeCloudflare(100);
    fake.rows = [row(0, 5), row(1, 4), row(2, 3)];
    expect(await pull(fake, 100)).toMatchObject({
      added: 3,
      fetched: 3,
      revised: 0,
    });
    fake.rows = fake.rows.map((r) => ({
      ...Object.fromEntries(Object.entries(r).toReversed()),
      datetime: r.datetime,
    }));
    expect(await pull(fake, 100)).toMatchObject({
      added: 0,
      fetched: 3,
      revised: 0,
      status: "complete",
    });
    expect(lines("rows.jsonl")).toHaveLength(3);
    expect(lines("runs.jsonl")).toHaveLength(2);
  });

  test("appends a changed row as a revision of the stored one", async () => {
    const fake = fakeCloudflare(100);
    const first = row(0, 5);
    fake.rows = [first, row(1, 4)];
    await pull(fake, 100);
    fake.rows = [row(0, 5, { disposition: "quarantine" }), row(1, 4)];
    expect(await pull(fake, 100)).toMatchObject({ added: 0, revised: 1 });
    // Seen again, the revision is not stored twice.
    expect(await pull(fake, 100)).toMatchObject({ added: 0, revised: 0 });
    const stored = lines("rows.jsonl");
    expect(stored).toHaveLength(3);
    const revision = stored.at(-1);
    expect(revision?.disposition).toBe("quarantine");
    expect(revision?.revisionOf).toBe(
      new Bun.CryptoHasher("sha256").update(canonical(first)).digest("hex")
    );
    expect(stored[0]?.revisionOf).toBeUndefined();
  });

  test("splits a window that fills the row limit until every part fits", async () => {
    const fake = fakeCloudflare(3);
    fake.rows = Array.from({ length: 10 }, (_, n) => row(n, 700 - n * 70));
    const record = await pull(fake, 3);
    expect(record).toMatchObject({
      added: 10,
      fetched: 10,
      status: "complete",
    });
    expect(fake.calls.length).toBeGreaterThan(1);
    expect(new Set(lines("rows.jsonl").map((r) => r.sourceIP)).size).toBe(10);
    // fetched counts every row once: the parts neither overlap nor leave gaps.
  });

  test("fails, not completes, when one second still fills the limit", async () => {
    const fake = fakeCloudflare(2);
    fake.rows = [row(0, 1), row(1, 1), row(2, 1), row(3, 9)];
    const record = await pull(fake, 2);
    expect(record.status).toBe("failed");
    expect(record.errorClass).toBe("truncated");
    const [run] = lines("runs.jsonl");
    expect(run?.status).toBe("failed");
  });

  test("reports a missing zone and API errors by class and message", async () => {
    const fake = fakeCloudflare(100);
    expect(
      await pullDmarc({
        days: 1,
        fetch: fake.fetch,
        now: () => NOW,
        out,
        token: TOKEN,
        zone: "f".repeat(32),
      })
    ).toMatchObject({ errorClass: "zone-not-found", status: "failed" });
    fake.answer = () =>
      Response.json({
        data: null,
        errors: [{ message: "cannot request data older than 2764800s" }],
      });
    expect(await pull(fake, 100)).toMatchObject({
      error: "cannot request data older than 2764800s",
      errorClass: "graphql",
    });
    fake.answer = () => new Response("nope", { status: 403 });
    expect(await pull(fake, 100)).toMatchObject({
      error: "HTTP 403",
      errorClass: "http",
    });
  });

  test("stores files readable by the owner only", async () => {
    const fake = fakeCloudflare(100);
    fake.rows = [row(0, 5)];
    await pull(fake, 100);
    for (const name of ["rows.jsonl", "runs.jsonl"]) {
      expect(statSync(path.join(out, name)).mode.toString(8).slice(-3)).toBe(
        "600"
      );
    }
  });

  test("prints neither the token nor any row content", async () => {
    const tokenFile = path.join(out, "token");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const store = path.join(out, "store");
    const fake = fakeCloudflare(2);
    fake.rows = [row(0, 50), row(1, 40), row(2, 30), row(3, 20)];
    const printed: string[] = [];
    const io = {
      fetch: fake.fetch,
      stderr: (text: string) => printed.push(text),
      stdout: (text: string) => printed.push(text),
    };
    const args = ["--zone", ZONE, "--token-file", tokenFile, "--out", store];
    expect(await runCli(args, io)).toBe(0);
    // An API error that echoes the token is printed with the token blanked.
    fake.answer = () =>
      Response.json({ errors: [{ message: `bad token ${TOKEN}` }] });
    expect(await runCli(args, io)).toBe(1);
    // A corrupt store is named by line, not quoted.
    writeFileSync(path.join(store, "rows.jsonl"), "report-secret-9 garbage\n");
    expect(await runCli(args, io)).toBe(1);
    const output = printed.join("");
    expect(output).toContain('"status":"complete"');
    expect(output).toContain("[token]");
    expect(output).toContain("line 1 is not a JSON object");
    for (const secret of [
      TOKEN,
      "report-secret",
      "192.0.2.",
      "bounce-",
      "example.org",
      "Example Receiver",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  test("refuses bad arguments before any request", async () => {
    const fake = fakeCloudflare(100);
    const printed: string[] = [];
    const io = {
      fetch: fake.fetch,
      stderr: (text: string) => printed.push(text),
      stdout: (text: string) => printed.push(text),
    };
    const base = ["--token-file", "x", "--out", out];
    expect(await runCli([...base, "--zone", "example.org"], io)).toBe(1);
    expect(await runCli([...base, "--zone", ZONE, "--days", "33"], io)).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });
});
