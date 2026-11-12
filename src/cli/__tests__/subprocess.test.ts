// Runs `bun run compose` and `bun run sync-sent` as the owner's agent does: separate
// processes, the runtime's own fetch, a Worker reached over the network. A local Bun.serve
// stands in for the Worker (the real app on an in-memory D1), over http on loopback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  API_TOKEN,
  createHarness,
  READ_TOKEN,
  START,
} from "../../__tests__/harness";
import type { Harness } from "../../__tests__/harness";

const CLI = path.join(import.meta.dir, "..");

const receiptSchema = z.object({
  imageUrl: z.string(),
  links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
  shared: z.boolean(),
  status: z.literal("tracked"),
  token: z.string(),
});

const splitReceiptSchema = z.object({
  items: z.array(
    z.object({
      address: z.string(),
      i: z.number(),
      imageToken: z.string(),
      linkTokens: z.array(z.string()),
      role: z.string(),
    })
  ),
  links: z.array(z.string()),
  mode: z.literal("per-recipient"),
  status: z.literal("tracked"),
  token: z.string(),
});

const reportSchema = z.object({
  failed: z.number(),
  marked: z.number(),
  results: z.array(
    z.object({ status: z.string(), token: z.string().nullable() })
  ),
});

let h: Harness;
let server: ReturnType<typeof Bun.serve>;
let dir: string;
let origin: string;

beforeAll(async () => {
  h = await createHarness();
  server = Bun.serve({
    fetch: async (request) => await h.handle(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  origin = `http://127.0.0.1:${server.port ?? 0}`;
  dir = mkdtempSync(path.join(tmpdir(), "mail-tracker-cli-"));
  writeFileSync(path.join(dir, "api-token"), `${API_TOKEN}\n`);
  writeFileSync(path.join(dir, "read-token"), `${READ_TOKEN}\n`);
  writeFileSync(
    path.join(dir, "body.md"),
    "Hi Alex,\n\nThe **deck**: https://example.org/deck\n"
  );
});

afterAll(async () => {
  await server.stop(true);
  rmSync(dir, { force: true, recursive: true });
});

/** Runs one CLI with only the settings the agent would give it. */
const run = async (script: string, args: string[], stdin = "") => {
  const child = Bun.spawn(["bun", path.join(CLI, script), ...args], {
    env: {
      MAIL_TRACKER_API_TOKEN_FILE: path.join(dir, "api-token"),
      MAIL_TRACKER_READ_TOKEN_FILE: path.join(dir, "read-token"),
      MAIL_TRACKER_URL: origin,
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
};

describe("the command-line tools as separate processes", () => {
  test("compose registers over the network and writes a tracked draft; sync-sent marks it sent", async () => {
    const out = path.join(dir, "out");
    const composed = await run("compose.ts", [
      "--to",
      "alex@example.com",
      "--cc",
      "sam@example.net",
      "--subject",
      "Proposal",
      "--body-file",
      path.join(dir, "body.md"),
      "--out",
      out,
    ]);
    expect(composed.stderr).toBe("");
    expect(composed.code).toBe(0);
    const receipt = receiptSchema.parse(
      JSON.parse(readFileSync(path.join(out, "receipt.json"), "utf-8"))
    );
    expect(receipt.shared).toBe(true);
    expect(receipt.imageUrl).toStartWith(`${origin}/i/`);
    expect(receipt.links.map((link) => link.url)).toEqual([
      "https://example.org/deck",
    ]);
    const html = readFileSync(path.join(out, "body.html"), "utf-8");
    expect(html).toContain(`<img alt="" src="${receipt.imageUrl}">`);
    expect(html).toContain(`href="${receipt.links[0]?.redirectUrl ?? ""}"`);
    expect(h.rows("SELECT token, draft_tracked FROM messages")).toEqual([
      { draft_tracked: 1, token: receipt.token },
    ]);

    // Within the Worker's accepted skew of its (fixed) clock.
    const sentAt = START + 60_000;
    const synced = await run(
      "sync-sent.ts",
      [],
      JSON.stringify([
        { html, recipients: ["alex@example.com"], sentAt, subject: "Proposal" },
        { html: "<p>Lunch?</p>", sentAt, subject: "Lunch" },
      ])
    );
    expect(synced.stderr).toBe("");
    expect(synced.code).toBe(0);
    const report = reportSchema.parse(JSON.parse(synced.stdout));
    expect(report.results.map((r) => [r.status, r.token])).toEqual([
      ["marked", receipt.token],
      ["unmatched", null],
    ]);
    expect(h.rows("SELECT sent_at FROM messages")).toEqual([
      { sent_at: sentAt },
    ]);
  });

  test("compose --per-recipient writes one copy per recipient, the owner's copy and the receipt", async () => {
    const out = path.join(dir, "split");
    const composed = await run("compose.ts", [
      "--per-recipient",
      "--to",
      "alex@example.com",
      "--bcc",
      "boss@example.net",
      "--subject",
      "Proposal",
      "--body-file",
      path.join(dir, "body.md"),
      "--out",
      out,
    ]);
    expect(composed.stderr).toBe("");
    expect(composed.code).toBe(0);
    const printed = readFileSync(path.join(out, "receipt.json"), "utf-8");
    expect(composed.stdout).toBe(printed);
    const receipt = splitReceiptSchema.parse(JSON.parse(printed));
    expect(receipt.items.map((item) => [item.i, item.address])).toEqual([
      [0, "alex@example.com"],
      [1, "boss@example.net"],
    ]);
    const read = (...parts: string[]): string =>
      readFileSync(path.join(out, ...parts), "utf-8");
    for (const item of receipt.items) {
      const html = read("recipients", String(item.i), "body.html");
      expect(html).toContain(
        `<img alt="" src="${origin}/i/${item.imageToken}.png">`
      );
      expect(html).toContain(`href="${origin}/l/${item.linkTokens[0] ?? ""}"`);
      expect(read("recipients", String(item.i), "body.txt")).toBe(
        read("self", "body.txt")
      );
    }
    expect(read("self", "body.html")).toContain(
      'href="https://example.org/deck"'
    );
    expect(read("self", "body.html")).not.toContain(origin);
  });

  test("compose --per-recipient refuses --no-track", async () => {
    const refused = await run("compose.ts", [
      "--per-recipient",
      "--no-track",
      "--to",
      "alex@example.com",
      "--body-file",
      path.join(dir, "body.md"),
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("leave out --no-track");
  });

  test("plain http is refused for anything but loopback", async () => {
    const child = Bun.spawn(["bun", path.join(CLI, "sync-sent.ts")], {
      env: {
        MAIL_TRACKER_API_TOKEN: API_TOKEN,
        MAIL_TRACKER_READ_TOKEN: READ_TOKEN,
        MAIL_TRACKER_URL: "http://track.example.test",
        PATH: process.env.PATH ?? "",
      },
      stderr: "pipe",
      stdin: new TextEncoder().encode("[]"),
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(
      "Worker URL (https)"
    );
  });
});
