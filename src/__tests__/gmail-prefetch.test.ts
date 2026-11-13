import { expect, test } from "bun:test";

import { z } from "zod";

import { eventDisplay } from "../classify";
import { detailDataSchema } from "../dashboard-data";
import {
  countedOpens,
  listMessages,
  messageDetail,
  recipientActivity,
} from "../store";
import { createHarness, HOUR, START } from "./harness";

const registration = z.object({
  recipients: z.array(z.object({ imageUrl: z.string() })),
  token: z.string(),
});
const headers = {
  "User-Agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)",
};

test.each([false, true])(
  "delivery prefetch excluded across readers, shared %s",
  async (shared) => {
    const h = await createHarness();
    const response = await h.mint(
      JSON.stringify({
        draftId: "synthetic-prefetch",
        draftTracked: true,
        recipients: shared
          ? ["alex@example.test", "sam@example.test"]
          : ["alex@example.test"],
        shared,
      })
    );
    const { token, recipients } = registration.parse(await response.json());
    const image = recipients[0]?.imageUrl;
    await h.markSent(token, START);
    h.state.clock = START + 6000;
    await h.hit(image, headers);
    const initial = await listMessages(h.env.DB, 10);
    expect(initial[0]).toMatchObject({
      first_open: null,
      opened_by: 0,
      opens: 0,
    });
    expect(await countedOpens(h.env.DB)).toEqual([]);
    const later = START + HOUR;
    h.state.clock = later;
    await h.hit(image, headers);
    // Six hours after the prefetch, but less than six hours after the real open.
    h.state.clock = START + 6 * HOUR + 6000;
    await h.hit(image, headers);
    const detail = await messageDetail(h.env.DB, token);
    expect(
      detail?.events.map((e) => [eventDisplay(e).label, e.counted, e.class])
    ).toEqual([
      ["Prefetch by Gmail", 0, "proxy"],
      ["Opened", 1, "proxy"],
      ["Opened", 1, "proxy"],
    ]);
    expect(h.events().every((e) => e.counted === 1)).toBe(true);
    const summaries = await listMessages(h.env.DB, 10);
    expect(summaries[0]).toMatchObject({
      first_open: later,
      opens: 2,
    });
    const opens = await countedOpens(h.env.DB);
    expect(opens.map((e) => e.at)).toEqual([later, h.state.clock]);
    if (!shared) {
      const activity = await recipientActivity(h.env.DB);
      expect(activity[0]).toMatchObject({
        first_open: later,
        opens: 2,
      });
    }
    const dashboardResponse = await h.call(`/app/messages/${token}/data`, {
      headers: { "Cf-Access-Jwt-Assertion": await h.accessJwt() },
    });
    const dashboard = detailDataSchema.parse(await dashboardResponse.json());
    expect(dashboard.totals).toMatchObject({
      firstOpen: later,
      opens: { counted: 2 },
      reopens: 0,
    });
    expect(
      dashboard.timeline.every((e) => e.preloadHint === null && e.hint === null)
    ).toBe(true);
  }
);

test.each([
  [31_000, true, [1]],
  [30_000, true, [0]],
  [6000, false, [1]],
  [6000, true, [0, 1]],
] as const)(
  "first hit +%s sent %s counts %j",
  async (offset, sent, expected) => {
    const h = await createHarness();
    const response = await h.mint(
      JSON.stringify({
        draftId: "synthetic-boundary",
        recipients: ["alex@example.test"],
      })
    );
    const { token, recipients } = registration.parse(await response.json());
    if (sent) {
      await h.markSent(token, START);
    }
    h.state.clock = START + offset;
    await h.hit(recipients[0]?.imageUrl, headers);
    if (expected.length === 2) {
      h.state.clock += 1000;
      // Different actor avoids the existing raw duplicate rule.
      await h.hit(recipients[0]?.imageUrl, {
        "User-Agent": `${headers["User-Agent"]} second`,
      });
    }
    const detail = await messageDetail(h.env.DB, token);
    expect(detail?.events.map((e) => e.counted)).toEqual([...expected]);
  }
);
