import { expect, test } from "bun:test";

import { messageByMessageId, markSent } from "../store";
import { API_TOKEN, READ_TOKEN, UNKNOWN_TOKEN, createHarness } from "./harness";

const status = async (response: Promise<Response>): Promise<number> => {
  const result = await response;
  return result.status;
};
const ID = "<Agent-1@example.test>";
const path = (id: string) =>
  `/api/messages/by-message-id/${encodeURIComponent(id)}`;

test("Message-ID endpoints store an immutable exact match and keep send time", async () => {
  const h = await createHarness();
  const { token } = await h.mintOk();
  const send = async (messageId: string, sentAt = h.state.clock) =>
    await h.call(`/api/messages/${token}/sent`, {
      body: JSON.stringify({ messageId, sentAt }),
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      method: "POST",
    });
  expect(await status(h.read(path(ID)))).toBe(404);
  expect(await status(send(ID))).toBe(200);
  expect(await messageByMessageId(h.db, ID)).toEqual({ token });
  const response = await h.read(path(ID));
  expect(await response.json()).toEqual({ token });
  expect(await status(h.read(path(ID.toLowerCase())))).toBe(404);
  expect(await status(send(ID, h.state.clock + 1))).toBe(200);
  expect(await status(send("<other@example.test>"))).toBe(409);
  expect(h.rows("SELECT message_id, sent_at FROM messages")).toEqual([
    { message_id: ID, sent_at: h.state.clock },
  ]);
  expect(
    await markSent(h.db, token, {
      messageId: ID,
      now: h.state.clock,
      reported: null,
    })
  ).toBe(true);
  expect(
    await markSent(h.db, token, {
      messageId: "<new@example.test>",
      now: h.state.clock,
      reported: null,
    })
  ).toBe("conflict");
  expect(
    await markSent(h.db, UNKNOWN_TOKEN, {
      messageId: ID,
      now: h.state.clock,
      reported: null,
    })
  ).toBe(false);
  expect(await status(h.read(path(ID), API_TOKEN))).toBe(401);
  expect(await status(h.read(path(ID), "wrong"))).toBe(401);
  expect(await status(h.call(path(ID)))).toBe(401);
  expect(
    await status(
      h.call(`/api/messages/${token}/sent`, {
        body: JSON.stringify({ messageId: ID }),
        headers: { Authorization: `Bearer ${READ_TOKEN}` },
        method: "POST",
      })
    )
  ).toBe(401);
});

test.each([
  "bare@example.test",
  "<one@example.test> <two@example.test>",
  "<a\n@example.test>",
  "<a\u007F@example.test>",
  `<${"a".repeat(985)}@example.test>`,
  "<>",
  42,
  null,
])("rejects invalid Message-ID %j", async (messageId) => {
  const h = await createHarness();
  const { token } = await h.mintOk();
  const result = await h.call(`/api/messages/${token}/sent`, {
    body: JSON.stringify({ messageId }),
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    method: "POST",
  });
  expect(result.status).toBe(400);
  expect(h.rows("SELECT message_id, sent_at FROM messages")).toEqual([
    { message_id: null, sent_at: null },
  ]);
});

test("accepts the 998-character boundary and can attach an ID after delivery", async () => {
  const h = await createHarness();
  const { token } = await h.mintOk();
  await h.markSent(token);
  const id = `<${"a".repeat(983)}@example.test>`;
  expect(id.length).toBe(998);
  const response = await h.call(`/api/messages/${token}/sent`, {
    body: JSON.stringify({ messageId: id }),
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(await messageByMessageId(h.db, id)).toEqual({ token });
});
