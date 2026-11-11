import type { Api, ApiName } from "./api.ts";

export class RpcError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Asks the service worker to do something. Only pages from this extension are answered. */
export async function rpc<Name extends ApiName>(name: Name, ...args: Parameters<Api[Name]>): Promise<ReturnType<Api[Name]>> {
  const answer = await chrome.runtime.sendMessage({ rpc: name, args });
  if (!answer?.ok) throw new RpcError(answer?.error?.kind ?? "unavailable", answer?.error?.message ?? "Couldn’t reach the service. Try again.");
  return answer.value;
}

/** Calls back when anything a page draws has changed. */
export function onChanged(callback: () => void) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.fatline === "changed") callback();
  });
}
