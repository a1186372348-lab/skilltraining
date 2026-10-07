/**
 * MiMo 开放平台 AI 网关（Prd.md D13 / 3.5）。
 *
 * - OpenAI 兼容 chat completions：base_url / api_key 一律走环境变量
 *   （MIMO_BASE_URL / MIMO_API_KEY），模型固定 mimo-v2.6-pro；
 * - 统一超时（默认 80s，AbortSignal 实现；2026-10-07 由 60s 上调——推理模型高负载下单次可达 ~58s，80s 留余量又不至于让故障悬挂过久）；
 * - 指数退避重试（429、5xx，以及 T22 起「200 但 content 为空」——推理模型
 *   高负载下正文被截空属瞬时退化，重试大概率自愈；最多 1 + maxRetries 次）；
 * - 审计日志只记元数据（模型 / 状态 / 耗时 / 用量 / 重试次数），
 *   绝不打印 API Key、prompt 与答案明文；
 * - fetch 与 sleep 可注入，测试全程 mock，不出网。
 */

export const MIMO_MODEL = "mimo-v2.6-pro";
const DEFAULT_TIMEOUT_MS = 80_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

export interface MimoConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 启动/调用前校验：密钥缺失即失败（Prd.md 3.5：启动时校验存在性） */
export class MimoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimoConfigError";
  }
}

export class MimoApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly timeout: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; timeout?: boolean } = {},
  ) {
    super(message);
    this.name = "MimoApiError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.timeout = options.timeout ?? false;
  }
}

export function getMimoConfig(): MimoConfig {
  const baseUrl = process.env.MIMO_BASE_URL?.trim().replace(/\/+$/, "");
  const apiKey = process.env.MIMO_API_KEY?.trim();
  if (!baseUrl) throw new MimoConfigError("缺少环境变量 MIMO_BASE_URL");
  if (!apiKey) throw new MimoConfigError("缺少环境变量 MIMO_API_KEY");
  return { baseUrl, apiKey, model: MIMO_MODEL };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionParams {
  messages: ChatMessage[];
  /** 低 temperature（R1：结构化任务建议 0.2~0.3） */
  temperature?: number;
  maxCompletionTokens?: number;
  responseFormat?: { type: "json_object" };
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface MimoClientOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** 退避等待（测试注入以断言指数退避节奏） */
  sleep?: (ms: number) => Promise<void>;
  /** 审计日志输出（默认 console.info，仅元数据） */
  auditLog?: (record: Record<string, unknown>) => void;
}

export interface MimoClient {
  chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createMimoClient(options: MimoClientOptions): MimoClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const audit = options.auditLog ?? ((record) => console.info(JSON.stringify(record)));
  const model = options.model ?? MIMO_MODEL;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    let attempt = 0;
    let lastError: MimoApiError | null = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: params.messages,
            temperature: params.temperature ?? 0.3,
            ...(params.maxCompletionTokens !== undefined
              ? { max_completion_tokens: params.maxCompletionTokens }
              : {}),
            ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          lastError = new MimoApiError(`MiMo API 返回 ${response.status}`, {
            status: response.status,
            retryable,
          });
          if (!retryable || attempt > maxRetries) break;
          await sleep(backoffDelayMs(attempt));
          continue;
        }

        const body = (await response.json()) as {
          model?: string;
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          // T22：推理模型高负载推理 token 暴涨截空正文，属瞬时退化，标为可重试
          throw new MimoApiError("MiMo API 响应缺少 choices[0].message.content", {
            status: response.status,
            retryable: true,
          });
        }

        // 审计：仅元数据，不含 Key 与消息明文
        audit({
          event: "ai.mimo.chat_completion",
          model,
          status: response.status,
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
          promptTokens: body.usage?.prompt_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null,
        });
        return {
          content,
          model: body.model ?? model,
          usage:
            body.usage?.prompt_tokens !== undefined
              ? {
                  promptTokens: body.usage.prompt_tokens,
                  completionTokens: body.usage.completion_tokens ?? 0,
                }
              : null,
        };
      } catch (error) {
        if (error instanceof MimoApiError) {
          lastError = error;
          // 不可重试错误（如 400）单次即抛；可重试的结构错误（T22：200 空 content）走退避重试
          if (!error.retryable || attempt > maxRetries) break;
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        const aborted = controller.signal.aborted;
        lastError = new MimoApiError(
          aborted ? "MiMo API 调用超时" : "MiMo API 网络错误",
          { retryable: true, timeout: aborted },
        );
        if (attempt > maxRetries) break;
        await sleep(backoffDelayMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    audit({
      event: "ai.mimo.chat_completion",
      model,
      status: lastError?.status ?? null,
      attempts: attempt,
      latencyMs: Date.now() - startedAt,
      error: lastError?.timeout ? "timeout" : "failed",
    });
    throw lastError ?? new MimoApiError("MiMo API 调用失败");
  }

  return { chatCompletion };
}

/** 按环境变量创建默认客户端（路由/服务层使用） */
export function createMimoClientFromEnv(): MimoClient {
  const config = getMimoConfig();
  return createMimoClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
}
