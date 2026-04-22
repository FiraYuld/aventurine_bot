import { getConfig, type LlmProvider } from "../config.js";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmChatInput {
  system: string;
  messages: LlmMessage[];
  /** Жёсткий потолок выходных токенов на один ответ. */
  maxTokens?: number;
  /** Таймаут запроса, мс. */
  timeoutMs?: number;
}

export interface LlmChatOutput {
  text: string;
}

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  chat(input: LlmChatInput): Promise<LlmChatOutput>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "http" | "format" | "disabled" | "unknown",
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

let cached: LlmClient | undefined;

export function getLlmClient(): LlmClient | null {
  if (cached) return cached;
  const c = getConfig();
  if (!c.llmApiKey) return null;

  switch (c.llmProvider) {
    case "openai":
      cached = new OpenAiCompatibleClient({
        apiKey: c.llmApiKey,
        model: c.llmModel,
        baseUrl: "https://api.openai.com/v1",
        provider: "openai",
      });
      break;
    case "openrouter":
      cached = new OpenAiCompatibleClient({
        apiKey: c.llmApiKey,
        model: c.llmModel,
        baseUrl: "https://openrouter.ai/api/v1",
        provider: "openrouter",
      });
      break;
    case "anthropic":
      cached = new AnthropicClient({
        apiKey: c.llmApiKey,
        model: c.llmModel,
      });
      break;
  }
  return cached ?? null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      throw new LlmError(`LLM таймаут ${timeoutMs} мс`, "timeout");
    }
    throw new LlmError(
      `Сетевая ошибка LLM: ${err instanceof Error ? err.message : String(err)}`,
      "unknown",
    );
  } finally {
    clearTimeout(timer);
  }
}

class OpenAiCompatibleClient implements LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(params: {
    apiKey: string;
    model: string;
    baseUrl: string;
    provider: LlmProvider;
  }) {
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.baseUrl = params.baseUrl.replace(/\/$/, "");
    this.provider = params.provider;
  }

  async chat(input: LlmChatInput): Promise<LlmChatOutput> {
    const c = getConfig();
    const timeoutMs = input.timeoutMs ?? c.llmTimeoutMs;
    const maxTokens = input.maxTokens ?? c.llmMaxOutputTokens;

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0.8,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    const res = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new LlmError(
        `LLM HTTP ${res.status}: ${truncate(text, 300)}`,
        "http",
        res.status,
      );
    }

    const json = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | null;
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new LlmError("LLM вернул пустой ответ", "format");
    }
    return { text };
  }
}

class AnthropicClient implements LlmClient {
  readonly provider: LlmProvider = "anthropic";
  readonly model: string;
  private readonly apiKey: string;

  constructor(params: { apiKey: string; model: string }) {
    this.apiKey = params.apiKey;
    this.model = params.model;
  }

  async chat(input: LlmChatInput): Promise<LlmChatOutput> {
    const c = getConfig();
    const timeoutMs = input.timeoutMs ?? c.llmTimeoutMs;
    const maxTokens = input.maxTokens ?? c.llmMaxOutputTokens;

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0.8,
      system: input.system,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new LlmError(
        `Anthropic HTTP ${res.status}: ${truncate(text, 300)}`,
        "http",
        res.status,
      );
    }

    const json = (await res.json().catch(() => null)) as
      | { content?: Array<{ type: string; text?: string }> }
      | null;
    const text = json?.content
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new LlmError("Anthropic вернул пустой ответ", "format");
    }
    return { text };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
