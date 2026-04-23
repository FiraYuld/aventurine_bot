/**
 * Минимальный LLM-клиент для оффлайн-аналитики.
 *
 * Осознанно НЕ используем `src/chat/llm.ts` + `src/config.ts`, чтобы:
 *  - не тянуть required env vars (telegram bot token и т.п.) в аналитику;
 *  - иметь независимые `ANALYSIS_LLM_*` переменные с безопасным дефолтом.
 */

export type Provider = "openai" | "anthropic" | "openrouter";

export interface CliLlmClient {
  readonly provider: Provider;
  readonly model: string;
  chat(input: ChatInput): Promise<string>;
}

export interface ChatInput {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Включить JSON-режим (пока поддерживается только для OpenAI/OpenRouter). */
  json?: boolean;
}

export function getCliLlmClient(): CliLlmClient {
  const apiKey = process.env.ANALYSIS_LLM_API_KEY ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LLM API key не задан. Положи LLM_API_KEY (или ANALYSIS_LLM_API_KEY) в .env",
    );
  }
  const provider = (process.env.ANALYSIS_LLM_PROVIDER ??
    process.env.LLM_PROVIDER ??
    "openai") as Provider;
  const model =
    process.env.ANALYSIS_LLM_MODEL ??
    process.env.LLM_MODEL ??
    defaultModel(provider);

  switch (provider) {
    case "openai":
      return new OpenAiClient({ apiKey, model, baseUrl: "https://api.openai.com/v1", provider });
    case "openrouter":
      return new OpenAiClient({
        apiKey,
        model,
        baseUrl: "https://openrouter.ai/api/v1",
        provider,
      });
    case "anthropic":
      return new AnthropicClient({ apiKey, model });
  }
}

function defaultModel(p: Provider): string {
  switch (p) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-3-5-haiku-latest";
    case "openrouter":
      return "openai/gpt-4o-mini";
  }
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
      throw new Error(`LLM таймаут ${timeoutMs}мс (${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class OpenAiClient implements CliLlmClient {
  readonly provider: Provider;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  constructor(p: { apiKey: string; model: string; baseUrl: string; provider: Provider }) {
    this.apiKey = p.apiKey;
    this.model = p.model;
    this.baseUrl = p.baseUrl.replace(/\/$/, "");
    this.provider = p.provider;
  }
  async chat(input: ChatInput): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: input.maxTokens ?? 1200,
      temperature: 0.4,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    };
    if (input.json) body.response_format = { type: "json_object" };

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
      input.timeoutMs ?? 60_000,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM вернул пустой ответ");
    return text;
  }
}

class AnthropicClient implements CliLlmClient {
  readonly provider: Provider = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  constructor(p: { apiKey: string; model: string }) {
    this.apiKey = p.apiKey;
    this.model = p.model;
  }
  async chat(input: ChatInput): Promise<string> {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: input.maxTokens ?? 1200,
          temperature: 0.4,
          system: input.system,
          messages: [{ role: "user", content: input.user }],
        }),
      },
      input.timeoutMs ?? 60_000,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = json.content
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("Anthropic вернул пустой ответ");
    return text;
  }
}

/**
 * Параллельный executor с ограничением concurrency.
 */
export async function parallelLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

/** Пытается извлечь JSON-объект из произвольного ответа LLM. */
export function parseJsonLoose<T>(text: string): T | null {
  // сначала пробуем весь текст
  try {
    return JSON.parse(text) as T;
  } catch {
    // ...
  }
  // ищем первый `{` и последний `}` и пробуем кусок
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const chunk = text.slice(first, last + 1);
    try {
      return JSON.parse(chunk) as T;
    } catch {
      return null;
    }
  }
  return null;
}
