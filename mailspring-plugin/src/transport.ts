import { request } from "node:https";
import type { RequestOptions } from "node:https";

export interface ApiRequest {
  method?: "GET" | "POST";
  url: string;
  token: string;
  body?: string;
}

export interface ApiResponse {
  status: number;
  body: string;
}

/** POSTs to the Worker's API; tests pass a fake. */
export type Transport = (call: ApiRequest) => Promise<ApiResponse>;

const TIMEOUT_MS = 10_000;

/** Shared by POST registration and read-only GETs; credentials never enter the URL. */
export const httpsOptions = (call: ApiRequest): RequestOptions => ({
  headers: {
    Authorization: `Bearer ${call.token}`,
    "Content-Length": Buffer.byteLength(call.body ?? ""),
    "Content-Type": "application/json",
  },
  method: call.method ?? "POST",
  timeout: TIMEOUT_MS,
});

/**
 * Node's https rather than the renderer's fetch: Mailspring windows load from file:// with
 * web security on, so a fetch with an Authorization header would need a CORS preflight the
 * Worker deliberately does not answer. Mailspring windows run with nodeIntegration.
 */
export const httpsTransport: Transport = async (call) =>
  // oxlint-disable-next-line promise/avoid-new -- wraps Node's callback-based https.request.
  await new Promise<ApiResponse>((resolve, reject) => {
    const body = call.body ?? "";
    const req = request(call.url, httpsOptions(call), (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf-8"),
          status: res.statusCode ?? 0,
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
