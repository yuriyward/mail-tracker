import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";

import { createHarness, HOUR, ORIGIN, START } from "../../__tests__/harness";
import type { Harness } from "../../__tests__/harness";
import { sentInput, syncSent } from "../sync-sent";
import { composeWith, workerClient } from "./worker";

let h: Harness;

const sentAt = () =>
  h.rows("SELECT subject, sent_at FROM messages ORDER BY created_at, subject");

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  h = await createHarness();
});

describe("bun run sync-sent", () => {
  test("marks each sent copy's email sent by the image it carries, at its send time", async () => {
    const one = await composeWith(h, { subject: "One" });
    const several = await composeWith(h, {
      cc: ["sam@example.net"],
      subject: "Several",
    });
    // Composed but not sent yet: stays unsent.
    await composeWith(h, { subject: "Later" });
    h.state.clock = START + 2 * HOUR;
    const report = await syncSent(
      workerClient(h),
      sentInput.parse([
        {
          html: several.html,
          recipients: ["alex@example.com", "sam@example.net"],
          sentAt: new Date(START + HOUR).toISOString(),
          subject: "Several",
        },
        {
          // The sent copy as the client stored it: wrapped, with a reply quote below.
          html: `<div dir="ltr">${one.html}</div><blockquote><p>Earlier</p></blockquote>`,
          recipients: ["alex@example.com"],
          sentAt: START + HOUR / 2,
          subject: "One",
        },
        {
          html: "<p>Lunch?</p>",
          recipients: ["kim@example.org"],
          sentAt: START + HOUR,
          subject: "Lunch",
        },
      ])
    );
    expect(report.results).toEqual([
      {
        httpStatus: null,
        sentAt: START + HOUR / 2,
        status: "marked",
        subject: "One",
        token: one.receipt.token,
      },
      {
        httpStatus: null,
        sentAt: START + HOUR,
        status: "marked",
        subject: "Several",
        token: several.receipt.token,
      },
      {
        httpStatus: null,
        sentAt: START + HOUR,
        status: "unmatched",
        subject: "Lunch",
        token: null,
      },
    ]);
    expect(report).toMatchObject({ failed: 0, marked: 2, unmatched: 1 });
    expect(sentAt()).toEqual([
      { sent_at: null, subject: "Later" },
      { sent_at: START + HOUR / 2, subject: "One" },
      { sent_at: START + HOUR, subject: "Several" },
    ]);
  });

  test("an image only in quoted text belongs to an earlier email and is not a match", async () => {
    const earlier = await composeWith(h, { subject: "Earlier" });
    const report = await syncSent(
      workerClient(h),
      sentInput.parse([
        {
          html: `<p>Following up.</p><blockquote>${earlier.html}</blockquote>`,
          sentAt: START + HOUR,
          subject: "Re: Earlier",
        },
        {
          html: `<p>Again.</p><div class="gmail_quote">${earlier.html}</div>`,
          sentAt: START + HOUR,
          subject: "Re: Earlier",
        },
      ])
    );
    expect(report.results.map((r) => r.status)).toEqual([
      "unmatched",
      "unmatched",
    ]);
    expect(sentAt()).toEqual([{ sent_at: null, subject: "Earlier" }]);
  });

  test("sent twice, or synced again: the first send time stays", async () => {
    const one = await composeWith(h, { subject: "One" });
    h.state.clock = START + 3 * HOUR;
    const first = await syncSent(
      workerClient(h),
      sentInput.parse([
        { html: one.html, sentAt: START + 2 * HOUR, subject: "One" },
        { html: one.html, sentAt: START + HOUR, subject: "One" },
      ])
    );
    expect(first.results.map((r) => [r.status, r.sentAt])).toEqual([
      ["marked", START + HOUR],
      ["duplicate", START + 2 * HOUR],
    ]);
    // Once sent, the email no longer awaits sending.
    const again = await syncSent(
      workerClient(h),
      sentInput.parse([
        { html: one.html, sentAt: START + 2 * HOUR, subject: "One" },
      ])
    );
    expect(again.results.map((r) => r.status)).toEqual(["unmatched"]);
    expect(sentAt()).toEqual([{ sent_at: START + HOUR, subject: "One" }]);
  });

  test("a send time that is not a date is reported, not guessed", async () => {
    const one = await composeWith(h, { subject: "One" });
    const report = await syncSent(
      workerClient(h),
      sentInput.parse([{ html: one.html, sentAt: "yesterday", subject: "One" }])
    );
    expect(report.results.map((r) => r.status)).toEqual(["invalid"]);
    expect(report.failed).toBe(1);
    expect(sentAt()).toEqual([{ sent_at: null, subject: "One" }]);
  });

  test("the read API lists every unsent email with its image tokens, events or not", async () => {
    const one = await composeWith(h, { subject: "One" });
    // Not in the usual list: no events, not sent.
    const listed = await h.read("/api/messages");
    expect(await listed.json()).toEqual({ messages: [] });
    const unsent = await h.read("/api/messages?unsent=1");
    const body = z
      .object({
        messages: z.array(
          z.object({ image_tokens: z.array(z.string()), token: z.string() })
        ),
      })
      .parse(await unsent.json());
    const image = new URL(one.receipt.imageUrl ?? "").pathname
      .slice(3)
      .replace(".png", "");
    expect(body.messages.map((m) => [m.token, m.image_tokens])).toEqual([
      [one.receipt.token ?? "", [one.receipt.token ?? "", image]],
    ]);
    expect(new URL(one.receipt.imageUrl ?? "").origin).toBe(ORIGIN);
  });
});
