import { describe, expect, it, vi } from "vitest";
import { ProviderFailure } from "./contract.js";
import { fetchBytes, type FetchImplementation } from "./http.js";

describe("provider HTTP policy", () => {
  it("passes form bodies through for POST-only upstream APIs", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(
      async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toBe("stock=600519");
        return new Response("ok");
      },
    );
    await fetchBytes("https://example.invalid/query", {
      providerId: "fixture",
      signal: new AbortController().signal,
      fetchImplementation,
      method: "POST",
      body: new URLSearchParams({ stock: "600519" }),
      retries: 0,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("retries a transient upstream failure", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const bytes = await fetchBytes("https://example.invalid/data", {
      providerId: "fixture",
      signal: new AbortController().signal,
      fetchImplementation,
      retries: 1,
    });
    expect(new TextDecoder().decode(bytes)).toBe("ok");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication failures", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(fetchBytes("https://example.invalid/data", {
      providerId: "fixture",
      signal: new AbortController().signal,
      fetchImplementation,
      retries: 2,
    })).rejects.toMatchObject({
      issue: { code: "AUTH_REQUIRED", retryable: false },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("enforces a per-request timeout", async () => {
    const fetchImplementation: FetchImplementation = async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    try {
      await fetchBytes("https://example.invalid/data", {
        providerId: "fixture",
        signal: new AbortController().signal,
        fetchImplementation,
        retries: 0,
        timeoutMs: 5,
      });
      throw new Error("Expected fetchBytes to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      expect((error as ProviderFailure).issue.code).toBe("TIMEOUT");
    }
  });
});
