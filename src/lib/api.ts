/**
 * Tiny typed client for PermitFrame JSON routes. Centralizes response and
 * error parsing so pages and hooks never hand-roll `fetch` handling.
 * Visual primitives must not import this — only hooks and pages.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(endpoint: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

function friendlyMessage(status: number, serverMessage: string | null, endpoint: string): string {
  if (serverMessage) return serverMessage;
  if (status === 401) return "Your session expired. Sign in again to continue.";
  if (status === 404) return "The requested record was not found. It may have been removed or the link is wrong.";
  if (status === 502) return "An upstream network (Livepeer / DKG) did not answer. Retry in a moment.";
  if (status >= 500) return "The server hit an unexpected error. Retry — your input is preserved.";
  return `Request to ${endpoint} failed (status ${status}).`;
}

function serverError(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const message = (payload as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}

/** GET/POST JSON with centralized error parsing. Aborts propagate as AbortError. */
export async function api<T>(
  endpoint: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }
): Promise<T> {
  // Default 30s guard: a hung server (e.g. DKG CLI timeouts) must surface as
  // an honest, retryable error — never an infinite spinner.
  const budgetMs = options?.timeoutMs ?? 30000;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: options?.method ?? "GET",
      headers: options?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      if (timeout.aborted && !options?.signal?.aborted) {
        throw new ApiError(
          endpoint,
          0,
          `Request timed out after ${Math.round(budgetMs / 1000)}s — the server may still be working (first-time setup talks to the DKG). Your input is safe; retry in a moment.`
        );
      }
      throw cause;
    }
    throw new ApiError(endpoint, 0, "Network request failed — check your connection and retry.");
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // non-JSON body: fall through to status handling
  }
  if (!response.ok) {
    throw new ApiError(endpoint, response.status, friendlyMessage(response.status, serverError(payload), endpoint).slice(0, 400));
  }
  return payload as T;
}

export const apiGet = <T>(endpoint: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> =>
  api<T>(endpoint, { signal, timeoutMs });
export const apiPost = <T>(endpoint: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> =>
  api<T>(endpoint, { method: "POST", body: body ?? {}, signal, timeoutMs });

/** Honest publication wording: never claim "published" for Working-Memory-only records. */
export function describeRecord(ual: string | null | undefined): { recorded: boolean; headline: string; detail: string } {
  if (!ual) {
    return {
      recorded: false,
      headline: "Saved to the local evidence store",
      detail: "No DKG record exists yet — the data lives only in this workspace."
    };
  }
  if (ual.startsWith("did:dkg:local/")) {
    return {
      recorded: true,
      headline: "Saved to the local evidence store",
      detail: `Reference ${ual}. Configure DKG edge mode for shared DKG records.`
    };
  }
  return {
    recorded: true,
    headline: "Recorded on the DKG",
    detail: "Held in DKG Working Memory — not yet anchored on-chain. Anchor it for a public explorer proof."
  };
}
