import { beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { linkRow } from "../schema";
import { assertTokensKept } from "../store";
import { API_TOKEN, createHarness, UNKNOWN_TOKEN } from "./harness";
import type { Harness } from "./harness";

let h: Harness;

const registration = (draftId: string, links: string[]) =>
  JSON.stringify({
    draftId,
    links,
    recipient: "alex@example.com, sam@example.net",
    recipients: ["alex@example.com", "sam@example.net"],
    subject: "Proposal",
  });

const sets = z.object({
  recipients: z.array(
    z.object({
      address: z.string(),
      imageUrl: z.string(),
      links: z.array(z.object({ redirectUrl: z.string(), url: z.string() })),
    })
  ),
  token: z.string(),
});

const tokenOf = (url: string): string =>
  (new URL(url).pathname.split("/")[2] ?? "").replace(/\.png$/u, "");

const parsed = async <S extends z.ZodType>(
  schema: S,
  response: Promise<Response>
): Promise<z.infer<S>> => {
  const answered = await response;
  return schema.parse(await answered.json());
};

const target = z.object({
  kind: z.string(),
  message: z.string(),
  position: z.number().nullable(),
  recipient: z.string().nullable(),
  recipients: z.number(),
  url: z.string().nullable(),
});

const status = async (response: Promise<Response>): Promise<number> => {
  const answered = await response;
  return answered.status;
};

const linkTable = () =>
  z.array(linkRow).parse(h.rows("SELECT * FROM links ORDER BY position"));

beforeEach(async () => {
  h = await createHarness();
});

describe("GET /api/tokens/:token", () => {
  test("names a message-level image and redirect, with no recipient", async () => {
    const message = await h.mintOk(["https://example.org/a"]);
    expect(
      await parsed(target, h.read(`/api/tokens/${message.token}`))
    ).toEqual({
      kind: "image",
      message: message.token,
      position: null,
      recipient: null,
      recipients: 0,
      url: null,
    });
    const link = h.read(
      `/api/tokens/${tokenOf(message.links[0]?.redirectUrl ?? "")}`
    );
    expect(await parsed(target, link)).toEqual({
      kind: "link",
      message: message.token,
      position: 0,
      recipient: null,
      recipients: 0,
      url: "https://example.org/a",
    });
  });

  test("a shared set has no recipient", async () => {
    const answer = await parsed(
      sets,
      h.mint(
        JSON.stringify({
          draftId: "<shared@example.test>",
          links: [],
          recipients: ["alex@example.com", "sam@example.net"],
          shared: true,
        })
      )
    );
    const [set] = answer.recipients;
    const response = h.read(`/api/tokens/${tokenOf(set?.imageUrl ?? "")}`);
    expect(await parsed(target, response)).toMatchObject({
      kind: "image",
      recipient: null,
      recipients: 0,
    });
  });

  test("404 for an unknown or malformed token; the read token only", async () => {
    expect(await status(h.read(`/api/tokens/${UNKNOWN_TOKEN}`))).toBe(404);
    expect(await status(h.read("/api/tokens/not-a-token"))).toBe(404);
    expect(
      await status(h.read(`/api/tokens/${UNKNOWN_TOKEN}`, API_TOKEN))
    ).toBe(401);
    expect(await status(h.call(`/api/tokens/${UNKNOWN_TOKEN}`))).toBe(401);
  });
});

describe("token rows never change once minted", () => {
  test("registering again keeps every token's destination, set and position", async () => {
    const first = await parsed(
      sets,
      h.mint(
        registration("<draft@example.test>", [
          "https://example.org/a",
          "https://example.org/b",
        ])
      )
    );
    const before: unknown[] = h.rows(
      "SELECT * FROM recipient_links ORDER BY token"
    );
    const links = linkTable();
    const again = await parsed(
      sets,
      h.mint(
        registration("<draft@example.test>", [
          "https://example.org/b",
          "https://example.org/c",
          "https://example.org/a",
        ])
      )
    );
    expect(again.token).toBe(first.token);
    expect(linkTable().slice(0, 2)).toEqual(links);
    const after = h.rows("SELECT * FROM recipient_links ORDER BY token");
    const kept = new Set(after.map((row) => JSON.stringify(row)));
    expect(before.filter((row) => !kept.has(JSON.stringify(row)))).toEqual([]);
    const minted = first.recipients.flatMap((set) =>
      set.links.map((link) => ({ recipient: set.address, url: link.url }))
    );
    const found = await Promise.all(
      first.recipients.flatMap((set) =>
        set.links.map(
          async (link) =>
            await parsed(
              target,
              h.read(`/api/tokens/${tokenOf(link.redirectUrl)}`)
            )
        )
      )
    );
    expect(found).toMatchObject(minted);
  });

  test("the database refuses an UPDATE of a token's meaning; text and `current` may change", async () => {
    await h.mint(
      registration("<draft@example.test>", ["https://example.org/a"])
    );
    const refused = (sql: string): string => {
      try {
        h.db.sqlite.run(sql);
        return "updated";
      } catch (error) {
        return String(error);
      }
    };
    expect(refused("UPDATE links SET url = 'https://example.net/'")).toContain(
      "never change"
    );
    expect(refused("UPDATE links SET position = 7")).toContain("never change");
    expect(refused("UPDATE links SET token = 'x'")).toContain("never change");
    expect(
      refused("UPDATE recipient_links SET link_token = link_token")
    ).toContain("never change");
    expect(
      refused("UPDATE recipients SET address = 'eve@example.net'")
    ).toContain("never change");
    expect(refused("UPDATE links SET text = 'Deck'")).toBe("updated");
    expect(refused("UPDATE recipients SET current = 0")).toBe("updated");
  });

  test("the store throws if a registration changed a token anyway", () => {
    const link = {
      message_token: "m",
      position: 0,
      text: "",
      token: "t",
      url: "https://example.org/a",
    };
    expect(() => {
      assertTokensKept([link], [link, { ...link, position: 1, token: "u" }]);
    }).not.toThrow();
    expect(() => {
      assertTokensKept([link], [{ ...link, url: "https://example.net/" }]);
    }).toThrow("changed after it was minted");
    expect(() => {
      assertTokensKept([link], []);
    }).toThrow("changed after it was minted");
  });
});
