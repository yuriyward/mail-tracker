import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Networking globals the runtime provides. happy-dom's registration replaces them with its
 * own browser emulation, whose fetch rejects the runtime's AbortSignal ("signal is not of
 * type AbortSignal"), so they are put back after it registers.
 */
const NETWORK_GLOBALS = [
  "AbortController",
  "AbortSignal",
  "Blob",
  "fetch",
  "File",
  "FormData",
  "Headers",
  "ReadableStream",
  "Request",
  "Response",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WebSocket",
  "WritableStream",
] as const;

/**
 * Gives the command-line tools the DOM the plugin's code expects (document, DOMParser, Node,
 * Text, NodeFilter) while their requests to the Worker keep the runtime's own fetch.
 */
export const registerDom = (): void => {
  const native = Object.fromEntries(
    NETWORK_GLOBALS.map((name) => [name, globalThis[name]])
  );
  GlobalRegistrator.register();
  Object.assign(globalThis, native);
};
