import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createHarness } from "./harness";
import type { AppFiles, Harness } from "./harness";

/** web/dist, written by `bun run build:web` (which `bun run check` runs before the tests). */
const DIST = new URL("../../web/dist/", import.meta.url).pathname;

let files: AppFiles = {};
let h: Harness;

beforeAll(async () => {
  const paths = await Array.fromAsync(
    new Bun.Glob("app/**/*").scan({ cwd: DIST })
  );
  if (!paths.includes("app/index.html")) {
    throw new Error(
      "web/dist/app/index.html is missing: run bun run build:web"
    );
  }
  const entries = await Promise.all(
    paths.map(
      async (path) =>
        [`/${path}`, await Bun.file(`${DIST}${path}`).text()] as const
    )
  );
  files = Object.fromEntries(entries);
});

beforeEach(async () => {
  h = await createHarness();
  h.serveFiles(files);
});

const owner = async () => ({
  "Cf-Access-Jwt-Assertion": await h.accessJwt(),
});

const attributes = (html: string, tag: string, name: string): string[] =>
  [
    ...html.matchAll(
      new RegExp(`<${tag}\\b[^>]*\\b${name}="(?<value>[^"]*)"`, "gu")
    ),
  ].map((match) => match.groups?.value ?? "");

const statuses = async (urls: string[], owned: boolean): Promise<number[]> => {
  const headers = owned ? await owner() : {};
  const responses = await Promise.all(
    urls.map(async (url) => await h.call(url, { headers }))
  );
  return responses.map((response) => response.status);
};

describe("the built app (web/dist)", () => {
  test("loads only same-origin files from /app/, with no inline script or style", async () => {
    const response = await h.call("/app", { headers: await owner() });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toBe(files["/app/index.html"] ?? "");
    const scripts = [
      ...html.matchAll(/<script\b(?<attrs>[^>]*)>(?<body>[^<]*)<\/script>/gu),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.groups?.attrs).toMatch(
        /\bsrc="\/app\/assets\/[\w.-]+\.js"/u
      );
      expect(script.groups?.body).toBe("");
    }
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle="/u);
    expect(html).not.toContain("http-equiv");
    for (const url of [
      ...attributes(html, "script", "src"),
      ...attributes(html, "link", "href"),
    ]) {
      expect(url).toMatch(/^\/app\//u);
    }
  });

  test("every file the page and its styles reference is served only behind Access", async () => {
    const html = files["/app/index.html"] ?? "";
    const referenced = [
      ...attributes(html, "script", "src"),
      ...attributes(html, "link", "href"),
    ];
    const styles = referenced.filter((url) => url.endsWith(".css"));
    expect(styles.length).toBeGreaterThan(0);
    const fonts = styles.flatMap((css) =>
      [...(files[css] ?? "").matchAll(/url\((?<url>[^)]+)\)/gu)].map(
        (match) => match.groups?.url ?? ""
      )
    );
    expect(fonts.length).toBeGreaterThan(0);
    const urls = [...referenced, ...fonts];
    for (const url of urls) {
      expect(url).toMatch(/^\/app\/(?:assets\/[\w.-]+|favicon\.svg)$/u);
      expect(files[url]).toBeDefined();
    }
    expect(await statuses(urls, false)).toEqual(urls.map(() => 401));
    expect(await statuses(urls, true)).toEqual(urls.map(() => 200));
  });
});
