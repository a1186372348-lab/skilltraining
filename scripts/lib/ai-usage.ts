// AI 网关用量汇总纯函数（T23；T37 / D39 起随 DeepSeek 切换改 provider 中立命名）
// 事件形状见 server/ai/client.ts 审计输出（成功带 usage，失败带 error，均单行 JSON）

export const AI_AUDIT_EVENT = "ai.deepseek.chat_completion";
/** 当前 max_completion_tokens 预算（D25⑤）；校准标准：峰值 × 约 2 倍余量内为健康 */
export const COMPLETION_TOKEN_BUDGET = 4096;
export const HEALTHY_HEADROOM_RATIO = 2;

export interface AiUsageSummary {
  /** ai.deepseek.chat_completion 事件总数 */
  total: number;
  /** 无 error 字段的事件数 */
  success: number;
  /** 带 error 字段的事件数 */
  failure: number;
  /** success / total；total 为 0 时 null */
  successRate: number | null;
  /** 按 error 值分布；非 timeout/failed 归入 other */
  errors: { timeout: number; failed: number; other: number };
  attempts: {
    average: number | null;
    /** 按 attempts 升序的分布 */
    distribution: { attempts: number; count: number }[];
    /** attempts===1 且成功的调用数 */
    firstTrySuccess: number;
    /** 一次成功占比（占总调用数） */
    firstTrySuccessRate: number | null;
    /** attempts>1 的调用数 */
    retried: number;
    /** 含重试调用占比（占总调用数） */
    retriedRate: number | null;
  };
  /** 成功与失败分开统计；count 为带有效 latencyMs 的事件数 */
  latencyMs: {
    success: { count: number; average: number | null; max: number | null };
    failure: { count: number; average: number | null; max: number | null };
  };
  tokens: {
    /** 带有效 usage 的成功事件数 */
    withUsage: number;
    /** 缺 usage 被跳过的成功事件数（失败事件本就不带 usage，不计入） */
    missingUsage: number;
    prompt: { average: number | null; max: number | null };
    completion: { average: number | null; max: number | null };
  };
  /** status=200 且 error=failed 的次数：「200 空 content」截空的直接观测 */
  truncatedEmpty: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statsOf(values: number[]): { average: number | null; max: number | null } {
  if (values.length === 0) return { average: null, max: null };
  return {
    average: values.reduce((sum, v) => sum + v, 0) / values.length,
    max: Math.max(...values),
  };
}

/** 逐行容错扫描日志，汇总 ai.deepseek.chat_completion 审计事件 */
export function summarizeAiUsage(logText: string): AiUsageSummary {
  let total = 0;
  let success = 0;
  let failure = 0;
  const errors = { timeout: 0, failed: 0, other: 0 };
  let truncatedEmpty = 0;

  let attemptsSum = 0;
  let attemptsCount = 0;
  let firstTrySuccess = 0;
  let retried = 0;
  const attemptsDist = new Map<number, number>();

  const successLatencies: number[] = [];
  const failureLatencies: number[] = [];
  const promptValues: number[] = [];
  const completionValues: number[] = [];
  let withUsage = 0;
  let missingUsage = 0;

  for (const rawLine of logText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // 非 JSON 行（Next.js 请求日志、堆栈等）直接跳过
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.event !== AI_AUDIT_EVENT) continue;

    total += 1;
    const error =
      typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : null;
    const failed = error !== null;
    if (failed) {
      failure += 1;
      if (error === "timeout") errors.timeout += 1;
      else if (error === "failed") errors.failed += 1;
      else errors.other += 1;
      if (parsed.status === 200 && error === "failed") truncatedEmpty += 1;
    } else {
      success += 1;
    }

    const attempts = asNumber(parsed.attempts);
    if (attempts !== null && attempts >= 1) {
      attemptsSum += attempts;
      attemptsCount += 1;
      attemptsDist.set(attempts, (attemptsDist.get(attempts) ?? 0) + 1);
      if (attempts === 1 && !failed) firstTrySuccess += 1;
      if (attempts > 1) retried += 1;
    }

    const latency = asNumber(parsed.latencyMs);
    if (latency !== null) {
      (failed ? failureLatencies : successLatencies).push(latency);
    }

    // token 仅统计成功事件；缺 usage（null/缺失）跳过并计数
    if (!failed) {
      const prompt = asNumber(parsed.promptTokens);
      const completion = asNumber(parsed.completionTokens);
      if (prompt === null && completion === null) {
        missingUsage += 1;
      } else {
        withUsage += 1;
        if (prompt !== null) promptValues.push(prompt);
        if (completion !== null) completionValues.push(completion);
      }
    }
  }

  const distribution = [...attemptsDist.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempts, count]) => ({ attempts, count }));

  return {
    total,
    success,
    failure,
    successRate: total > 0 ? success / total : null,
    errors,
    attempts: {
      average: attemptsCount > 0 ? attemptsSum / attemptsCount : null,
      distribution,
      firstTrySuccess,
      firstTrySuccessRate: total > 0 ? firstTrySuccess / total : null,
      retried,
      retriedRate: total > 0 ? retried / total : null,
    },
    latencyMs: {
      success: { count: successLatencies.length, ...statsOf(successLatencies) },
      failure: { count: failureLatencies.length, ...statsOf(failureLatencies) },
    },
    tokens: {
      withUsage,
      missingUsage,
      prompt: statsOf(promptValues),
      completion: statsOf(completionValues),
    },
    truncatedEmpty,
  };
}

// ── 报告格式化 ──────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function int(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

/** 终端显示宽度：CJK 字符按 2 列计，用于标签对齐 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  }
  return width;
}

function align(label: string, width: number): string {
  return label + " ".repeat(Math.max(0, width - displayWidth(label)));
}

export interface FormatAiUsageOptions {
  /** max_completion_tokens 预算，默认 4096 */
  completionTokenBudget?: number;
}

/** 结构化汇总 → 中文对齐报告（末尾两行判断提示） */
export function formatAiUsageReport(
  summary: AiUsageSummary,
  options: FormatAiUsageOptions = {},
): string {
  const budget = options.completionTokenBudget ?? COMPLETION_TOKEN_BUDGET;
  const LABEL_WIDTH = 14;
  const label = (text: string) => align(text, LABEL_WIDTH);
  const divider = "─".repeat(48);

  const rows: string[] = [];
  rows.push(`AI 网关调用健康度汇总（事件：${AI_AUDIT_EVENT}）`);
  rows.push(divider);

  if (summary.total === 0) {
    rows.push(`未找到 ${AI_AUDIT_EVENT} 事件（日志可能不含 AI 网关调用）。`);
  } else {
    const { attempts, latencyMs, tokens } = summary;
    rows.push(
      `${label("调用量")}：共 ${summary.total} 次，成功 ${summary.success}，失败 ${summary.failure}，成功率 ${pct(summary.successRate)}`,
    );
    rows.push(
      `${label("失败分布")}：timeout ${summary.errors.timeout}，failed ${summary.errors.failed}，其他 ${summary.errors.other}`,
    );
    rows.push(
      `${label("截空次数")}：${summary.truncatedEmpty}（status=200 且 error=failed，「200 空 content」直接观测）`,
    );
    rows.push(
      `${label("重试")}：一次成功 ${pct(attempts.firstTrySuccessRate)}（${attempts.firstTrySuccess}/${summary.total}），` +
        `含重试 ${pct(attempts.retriedRate)}（${attempts.retried}/${summary.total}），` +
        `平均 attempts ${attempts.average === null ? "—" : attempts.average.toFixed(2)}`,
    );
    rows.push(
      `${label("attempts 分布")}：${
        attempts.distribution.length === 0
          ? "—"
          : attempts.distribution.map((d) => `${d.attempts} 次×${d.count}`).join("，")
      }`,
    );
    rows.push(
      `${label("耗时（成功）")}：平均 ${int(latencyMs.success.average)} ms，最大 ${int(latencyMs.success.max)} ms（${latencyMs.success.count} 条）`,
    );
    rows.push(
      `${label("耗时（失败）")}：平均 ${int(latencyMs.failure.average)} ms，最大 ${int(latencyMs.failure.max)} ms（${latencyMs.failure.count} 条）`,
    );
    rows.push(
      `${label("promptTokens")}：平均 ${int(tokens.prompt.average)}，最大 ${int(tokens.prompt.max)}`,
    );
    rows.push(
      `${label("completionTokens")}：平均 ${int(tokens.completion.average)}，最大 ${int(tokens.completion.max)}`,
    );
    rows.push(
      `${label("usage 覆盖")}：有效 ${tokens.withUsage} 条，缺 usage 跳过 ${tokens.missingUsage} 条（仅统计成功事件；失败事件本就不带 usage）`,
    );
  }

  rows.push(divider);
  // 判断一：completion 峰值相对预算的余量倍数（D25⑤：峰值 × 约 2 倍余量内为健康）
  const peak = summary.tokens.completion.max;
  if (peak === null) {
    rows.push("判断·completion 预算：无 completion 观测，本次无法校验预算余量。");
  } else {
    const headroom = budget / peak;
    const verdict =
      headroom >= HEALTHY_HEADROOM_RATIO
        ? "健康（D25⑤：峰值 × 约 2 倍余量内为健康）"
        : `低于 ${HEALTHY_HEADROOM_RATIO} 倍健康线，建议上调 max_completion_tokens 预算或排查高负载截断`;
    rows.push(
      `判断·completion 预算：峰值 ${Math.round(peak)} / 预算 ${budget}，余量 ${headroom.toFixed(1)} 倍 → ${verdict}`,
    );
  }
  // 判断二：截空次数
  if (summary.truncatedEmpty === 0) {
    rows.push("判断·截空：0 次 → 未发现「200 空 content」退化，保持例行观察即可。");
  } else {
    rows.push(
      `判断·截空：截空 ${summary.truncatedEmpty} 次 → 存在「200 空 content」退化，建议结合耗时峰值与高负载时段排查。`,
    );
  }

  return rows.join("\n");
}
