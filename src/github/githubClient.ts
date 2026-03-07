import type { GitHubConfig } from "./githubConfig.js";

export class GitHubApiError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;
  public readonly responseHeaders: Headers | null;

  public constructor(message: string, status: number, responseBody: unknown, responseHeaders?: Headers | null) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.responseHeaders = responseHeaders ?? null;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

function readPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

export class GitHubClient {
  private readonly baseIssueUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  public constructor(config: GitHubConfig) {
    const apiBase = config.apiBaseUrl.replace(/\/+$/, "");
    this.baseIssueUrl = `${apiBase}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`;
    this.token = config.token;
    this.requestTimeoutMs = readPositiveInteger(
      config.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxRetries = readNonNegativeInteger(config.maxRetries, DEFAULT_MAX_RETRIES, "maxRetries");
    this.retryBaseDelayMs = readNonNegativeInteger(
      config.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
  }

  public async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  public async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  public async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  public async delete(path: string): Promise<void> {
    await this.request<null>(path, { method: "DELETE" });
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const url = `${this.baseIssueUrl}${path}`;
    const totalAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, options);
        const responseBody = await this.readResponseBody(response);

        if (!response.ok) {
          const message = this.getErrorMessage(responseBody, response.status);
          throw new GitHubApiError(message, response.status, responseBody, response.headers);
        }

        return responseBody as T;
      } catch (error) {
        const shouldRetry = attempt < totalAttempts && this.isRetryableError(error);
        if (!shouldRetry) {
          throw error;
        }

        await this.waitBeforeRetry(this.getRetryDelayMs(attempt, error));
      }
    }

    throw new Error("Unexpected request flow.");
  }

  private async fetchWithTimeout(url: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      return await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new Error(`GitHub API request timed out after ${this.requestTimeoutMs}ms.`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof GitHubApiError) {
      return RETRYABLE_STATUS_CODES.has(error.status);
    }

    if (error instanceof Error) {
      if (error.message.startsWith("GitHub API request timed out")) {
        return true;
      }

      return error instanceof TypeError;
    }

    return false;
  }

  private isAbortError(error: unknown): boolean {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
      return error.name === "AbortError";
    }

    if (error instanceof Error) {
      return error.name === "AbortError";
    }

    return false;
  }

  private async waitBeforeRetry(delayMs: number): Promise<void> {
    const normalizedDelayMs = Math.max(0, Math.floor(delayMs));
    await new Promise((resolve) => {
      setTimeout(resolve, normalizedDelayMs);
    });
  }

  private getRetryDelayMs(attempt: number, error: unknown): number {
    const attemptDelayMs = this.retryBaseDelayMs * attempt;
    if (!(error instanceof GitHubApiError)) {
      return attemptDelayMs;
    }

    const retryAfterDelayMs = this.parseRetryAfterDelayMs(error.responseHeaders);
    const rateLimitResetDelayMs = this.parseRateLimitResetDelayMs(error.responseHeaders);
    const advertisedDelayMs = Math.max(retryAfterDelayMs, rateLimitResetDelayMs);
    return Math.max(attemptDelayMs, advertisedDelayMs);
  }

  private parseRetryAfterDelayMs(headers: Headers | null): number {
    const rawValue = headers?.get("retry-after")?.trim();
    if (!rawValue) {
      return 0;
    }

    const seconds = Number(rawValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }

    const parsedDateMs = Date.parse(rawValue);
    if (Number.isNaN(parsedDateMs)) {
      return 0;
    }

    return Math.max(0, parsedDateMs - Date.now());
  }

  private parseRateLimitResetDelayMs(headers: Headers | null): number {
    const rawValue = headers?.get("x-ratelimit-reset")?.trim();
    if (!rawValue) {
      return 0;
    }

    const resetAtSeconds = Number(rawValue);
    if (!Number.isFinite(resetAtSeconds) || resetAtSeconds < 0) {
      return 0;
    }

    const resetAtMs = Math.floor(resetAtSeconds * 1000);
    return Math.max(0, resetAtMs - Date.now());
  }

  private async readResponseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      return response.json();
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    return text || null;
  }

  private getErrorMessage(responseBody: unknown, status: number): string {
    if (responseBody !== null && typeof responseBody === "object" && "message" in responseBody) {
      const message = (responseBody as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return `GitHub API request failed (${status}): ${message}`;
      }
    }

    return `GitHub API request failed with status ${status}.`;
  }
}
