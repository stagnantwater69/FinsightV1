/*
 * A failed AI provider call, described without the provider's response text.
 *
 * Gemini and OpenRouter error bodies can quote the request back — the
 * owner's question, record descriptions, amounts — and this error is logged
 * (and reported to Sentry once configured). So the message carries the HTTP
 * status and the provider's machine-readable code (`RESOURCE_EXHAUSTED`,
 * `rate_limit_exceeded`, 429) and nothing else from the body.
 */

export type AiProvider = "gemini" | "openrouter";

const PROVIDER_NAMES: Record<AiProvider, string> = { gemini: "Gemini", openrouter: "OpenRouter" };

/** Enum-like provider codes only: never free text. */
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export class AiProviderError extends Error {
  constructor(
    readonly provider: AiProvider,
    readonly httpStatus: number,
    readonly providerCode: string | undefined,
  ) {
    super(`${PROVIDER_NAMES[provider]} responded ${httpStatus}${providerCode ? ` (${providerCode})` : ""}`);
    this.name = "AiProviderError";
  }
}

/** Gemini: { error: { status: "INVALID_ARGUMENT" } }; OpenRouter: { error: { code: 429 | "..." } }. */
export function providerErrorCode(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return undefined;
  for (const candidate of [(error as { status?: unknown }).status, (error as { code?: unknown }).code]) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return String(candidate);
    if (typeof candidate === "string" && SAFE_CODE.test(candidate)) return candidate;
  }
  return undefined;
}

/** Reads (and so releases) the failed response, keeping only its status and code. */
export async function providerHttpError(provider: AiProvider, res: Response): Promise<AiProviderError> {
  const body = await res.text().catch(() => "");
  return new AiProviderError(provider, res.status, providerErrorCode(body));
}
