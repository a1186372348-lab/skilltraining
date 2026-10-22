// 评测样本共享加载器（T28 切片 2）：eval-baseline-samples.ts（评分 31 样本管线）与
// eval-gate-samples.ts（追问闸门管线）的题目/样本/人审数据加载逻辑统一在此，
// prompt-regression.ts 复用同一入口——三脚本共用一份寻址与校验实现，行为不变。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseQuestionYaml } from "../../server/modules/content/load-questions.ts";
import type { QuestionContent } from "../../server/modules/content/question-schema.ts";
import { parseReferenceAnswerYaml } from "../../server/modules/content/reference-answers.ts";
import {
  buildGateSampleTasks,
  parseGateHumanReview,
  type GateHumanReview,
  type GateSampleTask,
} from "./gate-calibration.ts";
import {
  buildSampleTasks,
  type EvalSampleTask,
  type HumanReviewData,
} from "./eval-calibration.ts";

export const QUESTIONS_DIR = path.resolve("content/questions/draft");
export const EVAL_DIR = path.resolve("content/eval");
/** 评分校准人审映射（sampleIndex ↔ blindId ↔ humanScore） */
export const HUMAN_REVIEW_PATH = path.join(EVAL_DIR, "baseline-8-human-review.json");
/** 闸门人审判定（产品负责人盲评回填；值域 followup/skip/gray） */
export const GATE_HUMAN_REVIEW_PATH = path.join(EVAL_DIR, "gate-human-review.json");

/** 基线 8 题 id 集合（评分套件）；以人审映射文件的 questions 键为准的闸门套件见 loadGateSampleSet */
export const BASELINE_QUESTION_IDS = ["B3", "B5", "B7", "B10", "B12", "B14", "B16", "B17"] as const;

/** 按 id 前缀在 draft 目录定位题目 YAML 并解析校验 */
export function loadQuestionById(questionId: string): QuestionContent {
  const draftFiles = readdirSync(QUESTIONS_DIR).filter((f) => /\.ya?ml$/i.test(f));
  const questionFile = draftFiles.find((f) => f.startsWith(`${questionId}-`));
  if (!questionFile) {
    throw new Error(`未找到题目文件：${QUESTIONS_DIR}/${questionId}-*.yaml`);
  }
  const questionPath = path.join(QUESTIONS_DIR, questionFile);
  const questionResult = parseQuestionYaml(questionPath, readFileSync(questionPath, "utf8"));
  if (!questionResult.ok || !questionResult.content) {
    throw new Error(`题目校验失败：${questionId}：\n${questionResult.issues.join("\n")}`);
  }
  return questionResult.content;
}

/** 加载某题的 eval 样本 YAML（parseReferenceAnswerYaml，已知 id 集合校验） */
export function loadEvalAnswers(questionId: string) {
  const evalPath = path.join(EVAL_DIR, `${questionId}.yaml`);
  if (!existsSync(evalPath)) {
    throw new Error(`未找到评分样本文件：${evalPath}`);
  }
  const evalResult = parseReferenceAnswerYaml(evalPath, readFileSync(evalPath, "utf8"), new Set([questionId]));
  if (!evalResult.ok || !evalResult.answer) {
    throw new Error(`评分样本校验失败：${questionId}：\n${evalResult.issues.join("\n")}`);
  }
  return evalResult.answer.answers;
}

/** 评分套件：8 题样本任务 + 人审映射（人审文件不存在时 humanReview 为 null，调用方自行决定容错或报错） */
export function loadBaselineSampleSet(): {
  tasks: EvalSampleTask[];
  humanReview: HumanReviewData | null;
} {
  const tasks: EvalSampleTask[] = [];
  for (const id of BASELINE_QUESTION_IDS) {
    const question = loadQuestionById(id);
    tasks.push(...buildSampleTasks(question, loadEvalAnswers(id)));
  }
  return { tasks, humanReview: loadHumanReviewMapIfExists() };
}

/** 人审映射文件：不存在返回 null（baseline 脚本容错语义保留）；存在但非法则报错中断 */
export function loadHumanReviewMapIfExists(): HumanReviewData | null {
  if (!existsSync(HUMAN_REVIEW_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(HUMAN_REVIEW_PATH, "utf8")) as HumanReviewData;
  } catch (error) {
    throw new Error(
      `人审映射文件解析失败：${HUMAN_REVIEW_PATH}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 闸门套件：按人审映射的 questions 集合寻址题目，样本带 blindId/humanScore 映射 */
export function loadGateSampleSet(): { tasks: GateSampleTask[]; reviewMap: HumanReviewData } {
  const reviewMap = loadHumanReviewMapIfExists();
  if (!reviewMap) {
    throw new Error(`未找到人审映射文件：${HUMAN_REVIEW_PATH}`);
  }
  const tasks: GateSampleTask[] = [];
  for (const [questionId, review] of Object.entries(reviewMap.questions)) {
    const question = loadQuestionById(questionId);
    tasks.push(...buildGateSampleTasks(question, loadEvalAnswers(questionId), review));
  }
  return { tasks, reviewMap };
}

/** 闸门人审判定文件：缺失/非法均为可读报错（对照与回归门槛的前置） */
export function loadGateHumanReviewFile(tasks: GateSampleTask[]): GateHumanReview {
  if (!existsSync(GATE_HUMAN_REVIEW_PATH)) {
    throw new Error(`未找到闸门人审判定文件：${GATE_HUMAN_REVIEW_PATH}（请先按盲评材料回填）`);
  }
  return parseGateHumanReview(readFileSync(GATE_HUMAN_REVIEW_PATH, "utf8"), tasks);
}
