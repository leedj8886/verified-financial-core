import {
  ProviderFailure,
  type ProviderErrorCode,
} from "./contract.js";

export type FetchImplementation = typeof globalThis.fetch;

export interface FetchBytesOptions {
  providerId: string;
  signal: AbortSignal;
  fetchImplementation?: FetchImplementation;
  headers?: HeadersInit;
  retries?: number;
  timeoutMs?: number;
}

function failure(
  providerId: string,
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
): ProviderFailure {
  return new ProviderFailure({
    providerId,
    code,
    message,
    retryable,
  });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Upstream request failed";
  const cause = error.cause;
  return cause instanceof Error
    ? `${error.message}: ${cause.message}`
    : error.message;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchBytes(
  url: string,
  options: FetchBytesOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([options.signal, timeoutSignal]);
    try {
      const response = await fetchImplementation(url, {
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        redirect: "follow",
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw failure(
          options.providerId,
          "AUTH_REQUIRED",
          `Upstream rejected access with HTTP ${response.status}`,
          false,
        );
      }
      if (response.status === 429) {
        throw failure(
          options.providerId,
          "RATE_LIMITED",
          "Upstream rate limited the request",
          true,
        );
      }
      if (!response.ok) {
        throw failure(
          options.providerId,
          "UPSTREAM_UNAVAILABLE",
          `Upstream returned HTTP ${response.status}`,
          response.status >= 500,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw failure(
          options.providerId,
          "EMPTY_RESPONSE",
          "Upstream returned an empty response",
          true,
        );
      }
      return bytes;
    } catch (error) {
      const normalized = error instanceof ProviderFailure
        ? error
        : signal.aborted
          ? failure(
              options.providerId,
              "TIMEOUT",
              `Upstream request timed out after ${timeoutMs}ms`,
              true,
            )
          : failure(
              options.providerId,
              "UPSTREAM_UNAVAILABLE",
              errorMessage(error),
              true,
            );
      if (!normalized.issue.retryable || attempt === retries) throw normalized;
      await delay(100 * 2 ** attempt, options.signal);
    }
  }
  throw failure(
    options.providerId,
    "UPSTREAM_UNAVAILABLE",
    "Upstream request failed",
    true,
  );
}
