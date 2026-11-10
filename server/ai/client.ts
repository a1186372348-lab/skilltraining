/**
 * DeepSeek 开放平台 AI 网关（D39 取代 D13；Prd.md 3.5）。
 *
 * - OpenAI 兼容 chat completions：base_url / api_key 一律走环境变量
 *   （DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY），模型固定 deepseek-flash
 *   （请求别名不能证明后端版本；响应元数据仅记录服务端声明标识及指纹摘要）；
 * - 统一超时（默认 80s，AbortSignal 实现；2026-10-07 由 60s 上调——推理模型高负载下单次可达 ~58s，80s 留余量又不至于让故障悬挂过久）；
 * - 指数退避重试（429、5xx，以及 T22 起「200 但 content 为空」——推理模型
 *   高负载下正文被截空属瞬时退化，重试大概率自愈；最多 1 + maxRetries 次）；
 * - 审计日志只记元数据（模型 / 状态 / 耗时 / 用量 / 重试次数），
 *   绝不打印 API Key、prompt 与答案明文；
 * - fetch 与 sleep 可注入，测试全程 mock，不出网。
 */

import { requestAudit, responseAudit, unknownRequestAudit } from "./client-audit.ts";
import { buildRuntimeContract, DEFAULT_MAX_TOKENS, REQUEST_MODEL, RuntimeContractError } from "./runtime-contract.ts";

export const AI_MODEL = REQUEST_MODEL;
/** 用量审计事件名（scripts/lib/ai-usage.ts 按此聚合） */
export const AI_AUDIT_EVENT = "ai.deepseek.chat_completion";
const DEFAULT_TIMEOUT_MS = 80_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5_000;

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 启动/调用前校验：密钥缺失即失败（Prd.md 3.5：启动时校验存在性） */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export class AiApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly timeout: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; timeout?: boolean } = {},
  ) {
    super(message);
    this.name = "AiApiError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.timeout = options.timeout ?? false;
  }
}

export function getAiConfig(): AiConfig {
  const configuredBaseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
  const baseUrl = configuredBaseUrl?.replace(/\/+$/, "");
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!baseUrl) throw new AiConfigError("缺少环境变量 DEEPSEEK_BASE_URL");
  if (!apiKey) throw new AiConfigError("缺少环境变量 DEEPSEEK_API_KEY");
  if (process.env.NODE_ENV === "production" && !/^https:\/\/api\.deepseek\.com\/?$/i.test(configuredBaseUrl!)) {
    throw new AiConfigError("无效 DEEPSEEK_BASE_URL：生产环境必须使用官方 HTTPS 地址");
  }
  return { baseUrl, apiKey, model: AI_MODEL };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionParams {
  messages: ChatMessage[];
  /** 本次调用的绝对截止时间（毫秒时间戳），仅在调用方显式提供时生效。 */
  deadlineMs?: number;
  /** 请求的 temperature；是否生效取决于服务端模式。 */
  temperature?: number;
  maxCompletionTokens?: number;
  responseFormat?: { type: "json_object" };
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  /**
   * 推理模型的思考链（DeepSeek 响应 choices[0].message.reasoning_content，D39）；
   * 供应商未返回或非推理模型时为 null。仅诊断/探针用途（scripts/gate-probe.ts），
   * 不落库、不下发前端；现有调用方行为不变。
   */
  reasoningContent?: string | null;
}

export interface AiClientOptions {
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

export interface AiClient {
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

export function createAiClient(options: AiClientOptions): AiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const audit = options.auditLog ?? ((record) => console.info(JSON.stringify(record)));
  const model = options.model ?? AI_MODEL;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    let attempt = 0;
    let lastError: AiApiError | null = null;
    let lastResponseAudit = responseAudit(null);
    let requestMetadata: ReturnType<typeof requestAudit> = unknownRequestAudit();
    const remaining = () => params.deadlineMs === undefined ? Infinity : params.deadlineMs - Date.now();
    const deadlineError = () => new AiApiError("AI API 调用超时", { retryable: true, timeout: true });
    const waitForRetry = async () => {
      if (remaining() > 0) await sleep(Math.min(backoffDelayMs(attempt), remaining()));
    };

    while (attempt <= maxRetries) {
      if (remaining() <= 0) {
        lastError = deadlineError();
        break;
      }
      attempt += 1;
      lastResponseAudit = responseAudit(null);
      requestMetadata = unknownRequestAudit();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining()));
      try {
        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        };
        const messages = params.messages;
        const requestedTemperature = params.temperature;
        const requestedLimit = params.maxCompletionTokens;
        const runtime = buildRuntimeContract(
          model,
          requestedTemperature === undefined ? 0.3 : requestedTemperature,
          requestedLimit === undefined ? DEFAULT_MAX_TOKENS : requestedLimit,
        );
        const requestBody = {
          model: runtime.model,
          messages,
          temperature: runtime.temperature,
          max_tokens: runtime.maxTokens,
          thinking: { type: runtime.thinking },
          reasoning_effort: runtime.effort,
          ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
        };
        const serializedBody = JSON.stringify(requestBody);
        requestMetadata = requestAudit(runtime);
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: serializedBody,
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          lastError = new AiApiError(`AI API 返回 ${response.status}`, {
            status: response.status,
            retryable,
          });
          if (!retryable || attempt > maxRetries) break;
          await waitForRetry();
          continue;
        }

        const body = (await response.json()) as {
          model?: string;
          choices?: { message?: { content?: string; reasoning_content?: unknown } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (controller.signal.aborted || remaining() <= 0) throw deadlineError();
        lastResponseAudit = responseAudit(body);
        const message = body.choices?.[0]?.message;
        const content = message?.content;
        if (typeof content !== "string" || content.length === 0) {
          // T22：推理模型高负载推理 token 暴涨截空正文，属瞬时退化，标为可重试
          throw new AiApiError("AI API 响应缺少 choices[0].message.content", {
            status: response.status,
            retryable: true,
          });
        }
        // 思考链（reasoning_content）：仅诊断用途透传，缺省 null；不进审计日志（元数据纪律不变）
        const reasoningContent =
          typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
            ? message.reasoning_content
            : null;

        // 审计：仅元数据，不含 Key 与消息明文
        audit({
          event: AI_AUDIT_EVENT,
          ...requestMetadata,
          ...lastResponseAudit,
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
          reasoningContent,
        };
      } catch (error) {
        if (error instanceof RuntimeContractError) throw error;
        if (error instanceof AiApiError) {
          lastError = error;
          // 不可重试错误（如 400）单次即抛；可重试的结构错误（T22：200 空 content）走退避重试
          if (!error.retryable || attempt > maxRetries) break;
          await waitForRetry();
          continue;
        }
        const aborted = controller.signal.aborted;
        lastError = new AiApiError(
          aborted ? "AI API 调用超时" : "AI API 网络错误",
          { retryable: true, timeout: aborted },
        );
        if (attempt > maxRetries) break;
        await waitForRetry();
      } finally {
        clearTimeout(timer);
      }
    }

    audit({
      event: AI_AUDIT_EVENT,
      ...requestMetadata,
      ...lastResponseAudit,
      model,
      status: lastError?.status ?? null,
      attempts: attempt,
      latencyMs: Date.now() - startedAt,
      error: lastError?.timeout ? "timeout" : "failed",
    });
    throw lastError ?? new AiApiError("AI API 调用失败");
  }

  return { chatCompletion };
}

/** 按环境变量创建默认客户端（路由/服务层使用） */
export function createAiClientFromEnv(): AiClient {
  const config = getAiConfig();
  return createAiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
}
