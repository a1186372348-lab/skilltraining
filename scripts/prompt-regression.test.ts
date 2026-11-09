import { matchingPromptEvidence, promptEvidence } from "./lib/regression-evidence";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { loadQuestionDirectory } from "../server/modules/content/load-questions";
import { loadStandardReferences } from "../server/modules/content/standard-references";
import { standardReferenceEvidence } from "./lib/standard-reference-evidence";

const isolatedEnv = {
  ...process.env,
  DATABASE_URL: "postgresql://test@127.0.0.1:1/isolated_test",
  TEST_DATABASE_URL: "postgresql://test@127.0.0.1:1/isolated_test",
  DEEPSEEK_API_KEY: "offline-test-key",
  DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
};

it("旧缓存缺追问全文时离线回归阻断并写出缺失证据", () => {
  const root = path.resolve(".cache/t28-integrity");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "cli-"));
  const cache = path.join(dir, "cache.jsonl");
  const report = path.join(dir, "report.md");
  try {
    writeFileSync(cache, JSON.stringify({ label: "B3#2", attempts: 1, shouldFollowup: true, reason: "mock", followupCount: 1, latencyMs: 0 }) + "\n");
    let exitCode = 0;
    try {
      execFileSync(process.execPath, ["scripts/prompt-regression.ts", "--suite", "followup", "--confirm-runs", "1", "--miss-max", "31", "--harm-rate-max", "1", "--cache", cache, "--out", report], { stdio: "pipe", env: isolatedEnv });
    } catch (error) { exitCode = (error as { status: number }).status; }
    expect(exitCode).toBe(1);
    const content = readFileSync(report, "utf8");
    expect(content).toContain("缺少追问全文");
    expect(content).toContain('"source":"mock_or_unverified_cache"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("同时指定 mock 与 live 时拒绝运行，不调用远程服务", () => {
  try {
    execFileSync(process.execPath, ["scripts/prompt-regression.ts", "--suite", "followup", "--mock", "--live"], { stdio: "pipe", env: isolatedEnv });
    throw new Error("expected failure");
  } catch (error) {
    const result = error as { status?: number; stderr?: Buffer };
    expect(result.status).toBe(1);
    expect(result.stderr?.toString()).toContain("不能同时指定");
  }
});


it.each(["leak", "missing"])("首轮 %s 后复跑通过仍阻断", (kind) => {
  const root = path.resolve(".cache/t28-integrity");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "hard-gate-"));
  const cache = path.join(dir, "cache.jsonl");
  const retry = path.join(dir, "cache.retry1.jsonl");
  const report = path.join(dir, "report.md");
  const base = ["scripts/prompt-regression.ts", "--suite", "followup", "--miss-max", "31", "--harm-rate-max", "1", "--cache", cache];
  try {
    execFileSync(process.execPath, [...base, "--confirm-runs", "1"], { stdio: "pipe", env: isolatedEnv });
    const rows = readFileSync(cache, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    writeFileSync(retry, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const altered = rows.map((row) => row.label !== "B3#2" ? row : kind === "missing" ? { ...row, followups: [] } : { ...row, followups: [{ question: "甲".repeat(121), hint: "提示" }] });
    writeFileSync(cache, altered.map((row) => JSON.stringify(row)).join("\n") + "\n");
    let status = 0;
    try { execFileSync(process.execPath, [...base, "--confirm-runs", "2", "--out", report], { stdio: "pipe", env: isolatedEnv }); }
    catch (error) { status = (error as { status: number }).status; }
    expect(status).toBe(1);
    expect(readFileSync(report, "utf8")).toContain("双跑阻断");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


it("版本证据不可跨版本复用，即使内容和温度相同", () => {
  const v3 = promptEvidence("database", "v3", "same content", 0.2);
  const v4 = promptEvidence("database", "v4", "same content", 0.2);
  expect(matchingPromptEvidence(v3, v4)).toBe(false);
  expect(matchingPromptEvidence(v4, v4)).toBe(true);
});

it("v5 证据不可复用 v4 缓存", () => {
  const v4 = promptEvidence("database", "v4", "same content", 0.2);
  const v5 = promptEvidence("database", "v5", "same content", 0.2);
  expect(matchingPromptEvidence(v4, v5)).toBe(false);
  expect(matchingPromptEvidence(v5, v5)).toBe(true);
});

it("v6 版本证据拒绝复用 v5", () => {
  const v5 = promptEvidence("database", "v5", "same content", 0.2);
  const v6 = promptEvidence("database", "v6", "same content", 0.2);
  expect(matchingPromptEvidence(v5, v6)).toBe(false);
  expect(matchingPromptEvidence(v6, v6)).toBe(true);
});

it("离线报告标注标准材料状态及未输入模型", () => {
  const root = path.resolve(".cache/t28-integrity");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "standard-"));
  const report = path.join(dir, "report.md");
  try {
    try { execFileSync(process.execPath, ["scripts/prompt-regression.ts", "--suite", "followup", "--confirm-runs", "1", "--out", report], { stdio: "pipe", env: isolatedEnv }); } catch { /* 门槛可不通过 */ }
    const text = readFileSync(report, "utf8");
    const questionIds = ["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"];
    const knownIds = new Set(loadQuestionDirectory(path.resolve("content/questions"))
      .map((item) => item.content?.id).filter((id): id is string => id !== undefined));
    const expected = standardReferenceEvidence(loadStandardReferences(
      path.resolve("content/standard-references"), path.resolve("task/evidence/standard-reference-approvals"), questionIds, knownIds,
    ), questionIds);
    const evidence = text.match(/^标准材料状态（不作为模型输入）：(.+)$/m);
    expect(evidence).not.toBeNull();
    expect(JSON.parse(evidence![1])).toEqual(expected);
    expect(expected.modelInputUsed).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("文件候选以拦截的假响应运行并产出本地证据，不依赖数据库", () => {
  const root = path.resolve(".cache/t28-v9-semantic-candidate/file-cli");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "offline-"));
  const preload = path.join(dir, "preload.mjs");
  const report = path.join(dir, "report.md");
  const marker = path.join(dir, "fetch.txt");
  try {
    writeFileSync(preload, `import { appendFileSync } from "node:fs"; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(marker)}, "fake\\n"); return new Response("{}", {status: 400}); };`);
    let result: { status?: number; stdout?: Buffer; stderr?: Buffer } = {};
    try {
      execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/prompt-regression.ts", "--suite", "followup", "--live", "--prompt-source", "file", "--version", "v9", "--only", "B3#1", "--confirm-runs", "1", "--no-sample-retry", "--out", report], { stdio: "pipe", env: isolatedEnv });
    } catch (error) { result = error as typeof result; }
    expect(result.status).toBe(1); // 假响应故意失败，仍需生成完整报告
    expect(readFileSync(marker, "utf8")).toContain("fake");
    expect(readFileSync(report, "utf8")).toContain('"source":"file"');
    expect(result.stdout?.toString()).toContain("文件候选不写入 eval_runs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ["--suite", "scoring", "--live", "--prompt-source", "file", "--version", "v9"],
  ["--suite", "followup", "--live", "--prompt-source", "file", "--version", "v8"],
  ["--suite", "followup", "--live", "--prompt-source", "else"],
  ["--suite", "followup", "--live", "--prompt-source", "file", "--version", "v9", "--version", "v8"],
])("非法候选参数在调用前拒绝 %#", (...args) => {
  const root = path.resolve(".cache/t28-v9-semantic-candidate/file-cli");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "reject-"));
  const preload = path.join(dir, "preload.mjs");
  const marker = path.join(dir, "fetch.txt");
  try {
    writeFileSync(preload, `import { writeFileSync } from "node:fs"; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, "called"); throw new Error("unexpected fetch"); };`);
    try {
      execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/prompt-regression.ts", ...args], { stdio: "pipe", env: isolatedEnv });
      throw new Error("expected failure");
    } catch (error) {
      const result = error as { status?: number; stderr?: Buffer };
      expect(result.status).toBe(1);
      expect(result.stderr?.toString()).toMatch(/prompt-source|version/);
      expect(existsSync(marker)).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

