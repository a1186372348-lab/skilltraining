// AI 网关用量汇总纯函数单测（T23；T37 / D39 起 provider 中立命名）：容错解析 + 汇总计算 + 中文报告格式化
import { describe, expect, it } from "vitest";

import { formatAiUsageReport, summarizeAiUsage } from "./ai-usage.ts";

const EVENT = "ai.deepseek.chat_completion";

/** 成功审计事件（默认带 usage，无 error 字段） */
function okEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: EVENT,
    model: "deepseek-flash",
    status: 200,
    attempts: 1,
    latencyMs: 1000,
    promptTokens: 100,
    completionTokens: 50,
    ...overrides,
  });
}

/** 失败审计事件（默认 timeout，不带 usage） */
function failEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: EVENT,
    model: "deepseek-flash",
    status: null,
    attempts: 4,
    latencyMs: 240000,
    error: "timeout",
    ...overrides,
  });
}

function lines(...rows: string[]): string {
  return rows.join("\n");
}

describe("summarizeAiUsage", () => {
  it("空输入与纯空白行：全部计数为 0、统计值为 null", () => {
    const s = summarizeAiUsage("  \n\n   \n");
    expect(s.total).toBe(0);
    expect(s.success).toBe(0);
    expect(s.failure).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.errors).toEqual({ timeout: 0, failed: 0, other: 0 });
    expect(s.attempts.average).toBeNull();
    expect(s.attempts.distribution).toEqual([]);
    expect(s.attempts.firstTrySuccessRate).toBeNull();
    expect(s.attempts.retriedRate).toBeNull();
    expect(s.latencyMs.success.average).toBeNull();
    expect(s.latencyMs.failure.max).toBeNull();
    expect(s.tokens.withUsage).toBe(0);
    expect(s.tokens.missingUsage).toBe(0);
    expect(s.tokens.prompt.average).toBeNull();
    expect(s.tokens.completion.max).toBeNull();
    expect(s.truncatedEmpty).toBe(0);
  });

  it("混合非 JSON 行、其他事件行、非对象 JSON：全部容错跳过", () => {
    const s = summarizeAiUsage(
      lines(
        "GET /today 200 in 123ms",
        "Error: boom",
        "    at Object.<anonymous> (/app/x.ts:1:1)",
        "{broken json",
        JSON.stringify({ event: "training.followup_generation_failed", reason: "x" }),
        JSON.stringify([1, 2, 3]),
        "42",
        "null",
        '"just a string"',
        okEvent(),
      ),
    );
    expect(s.total).toBe(1);
    expect(s.success).toBe(1);
  });

  it("全部成功：成功率 1，失败与错误计数为 0", () => {
    const s = summarizeAiUsage(
      lines(
        okEvent(),
        okEvent({ attempts: 2, latencyMs: 3000, promptTokens: 200, completionTokens: 100 }),
        okEvent({ latencyMs: 5000, promptTokens: 300, completionTokens: 150 }),
      ),
    );
    expect(s.total).toBe(3);
    expect(s.success).toBe(3);
    expect(s.failure).toBe(0);
    expect(s.successRate).toBe(1);
    expect(s.errors).toEqual({ timeout: 0, failed: 0, other: 0 });
    expect(s.truncatedEmpty).toBe(0);
    expect(s.latencyMs.success).toEqual({ count: 3, average: 3000, max: 5000 });
    expect(s.latencyMs.failure).toEqual({ count: 0, average: null, max: null });
    expect(s.tokens.withUsage).toBe(3);
    expect(s.tokens.missingUsage).toBe(0);
    expect(s.tokens.prompt).toEqual({ average: 200, max: 300 });
    expect(s.tokens.completion).toEqual({ average: 100, max: 150 });
  });

  it("全部失败：成功率 0，token 缺失不计入 missingUsage", () => {
    const s = summarizeAiUsage(
      lines(
        failEvent(),
        failEvent({ error: "failed", status: 500, attempts: 2, latencyMs: 60000 }),
      ),
    );
    expect(s.total).toBe(2);
    expect(s.success).toBe(0);
    expect(s.failure).toBe(2);
    expect(s.successRate).toBe(0);
    expect(s.errors).toEqual({ timeout: 1, failed: 1, other: 0 });
    // 失败事件本就不带 usage，不属于"缺 usage"
    expect(s.tokens.withUsage).toBe(0);
    expect(s.tokens.missingUsage).toBe(0);
    expect(s.latencyMs.failure).toEqual({ count: 2, average: 150000, max: 240000 });
    expect(s.latencyMs.success).toEqual({ count: 0, average: null, max: null });
  });

  it("error 为非 timeout/failed 的值时归入其他", () => {
    const s = summarizeAiUsage(lines(failEvent({ error: "network" })));
    expect(s.errors).toEqual({ timeout: 0, failed: 0, other: 1 });
  });

  it("截空指标：仅 status=200 且 error=failed 计入", () => {
    const s = summarizeAiUsage(
      lines(
        failEvent({ error: "failed", status: 200, attempts: 1, latencyMs: 59980 }),
        failEvent({ error: "failed", status: null }),
        failEvent({ error: "timeout", status: 200 }),
        okEvent(),
      ),
    );
    expect(s.truncatedEmpty).toBe(1);
  });

  it("缺 usage 的成功事件：跳过 token 统计并计数", () => {
    const s = summarizeAiUsage(
      lines(
        okEvent({ promptTokens: null, completionTokens: null }),
        okEvent({ promptTokens: 200, completionTokens: null }),
        okEvent(),
      ),
    );
    expect(s.tokens.withUsage).toBe(2);
    expect(s.tokens.missingUsage).toBe(1);
    expect(s.tokens.prompt).toEqual({ average: 150, max: 200 });
    expect(s.tokens.completion).toEqual({ average: 50, max: 50 });
  });

  it("attempts 分布、一次成功占比、含重试占比、平均 attempts", () => {
    const s = summarizeAiUsage(
      lines(
        okEvent(),
        okEvent(),
        okEvent({ attempts: 2 }),
        failEvent({ attempts: 4 }),
      ),
    );
    expect(s.attempts.distribution).toEqual([
      { attempts: 1, count: 2 },
      { attempts: 2, count: 1 },
      { attempts: 4, count: 1 },
    ]);
    expect(s.attempts.average).toBe(2);
    expect(s.attempts.firstTrySuccess).toBe(2);
    expect(s.attempts.firstTrySuccessRate).toBe(0.5);
    expect(s.attempts.retried).toBe(2);
    expect(s.attempts.retriedRate).toBe(0.5);
  });

  it("畸形事件（缺 attempts/latencyMs/usage）：计入总数但跳过对应统计", () => {
    const s = summarizeAiUsage(
      lines(JSON.stringify({ event: EVENT, model: "deepseek-flash" })),
    );
    expect(s.total).toBe(1);
    expect(s.success).toBe(1);
    expect(s.attempts.average).toBeNull();
    expect(s.latencyMs.success).toEqual({ count: 0, average: null, max: null });
    expect(s.tokens.missingUsage).toBe(1);
  });
});

describe("formatAiUsageReport", () => {
  it("输出核心栏目：调用量、失败分布、截空、重试、耗时、token、两行判断", () => {
    const report = formatAiUsageReport(
      summarizeAiUsage(lines(okEvent(), failEvent())),
    );
    expect(report).toContain("成功率 50.0%");
    expect(report).toContain("timeout 1");
    expect(report).toContain("截空");
    expect(report).toContain("重试");
    expect(report).toContain("耗时");
    expect(report).toContain("promptTokens");
    expect(report).toContain("判断");
  });

  it("completion 峰值余量 ≥2 倍：判定健康", () => {
    const report = formatAiUsageReport(
      summarizeAiUsage(okEvent({ completionTokens: 623 })),
    );
    // 4096 / 623 ≈ 6.6 倍
    expect(report).toContain("6.6 倍");
    expect(report).toContain("健康");
  });

  it("completion 峰值余量 <2 倍：给出告警提示", () => {
    const report = formatAiUsageReport(
      summarizeAiUsage(okEvent({ completionTokens: 3900 })),
    );
    expect(report).toContain("低于 2 倍健康线");
  });

  it("无 completion 观测：提示无法校验预算余量", () => {
    const report = formatAiUsageReport(summarizeAiUsage(failEvent()));
    expect(report).toContain("无法校验预算余量");
  });

  it("截空 0 次与非 0 次给出不同提示语", () => {
    const clean = formatAiUsageReport(summarizeAiUsage(okEvent()));
    expect(clean).toContain("未发现「200 空 content」");

    const dirty = formatAiUsageReport(
      summarizeAiUsage(
        lines(
          failEvent({ error: "failed", status: 200 }),
          failEvent({ error: "failed", status: 200 }),
        ),
      ),
    );
    expect(dirty).toContain("截空 2 次");
    expect(dirty).toContain("存在「200 空 content」");
  });

  it("空输入：明确提示未找到事件", () => {
    const report = formatAiUsageReport(summarizeAiUsage(""));
    expect(report).toContain("未找到 ai.deepseek.chat_completion 事件");
  });
});
