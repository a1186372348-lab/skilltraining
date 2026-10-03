import type { TrainingSessionState } from "@prisma/client";

import { TRAINING_ERROR_CODES as CODES, TrainingError } from "./errors";

/**
 * 训练会话显式状态机（Prd.md 图 1 / R4：服务端单一事实源）。
 *
 * 状态：reading → answering → followup → scored
 * - reading：阅读案例与资料（初始态）
 * - answering：自由作答（请求提示后进入，可继续请求提示）
 * - followup：首答已提交，AI 追问阶段（提示永久禁用，D7）
 * - scored：终答已评分（【T06 接入点】由评分任务经 MARK_SCORED 写入；
 *   T05 终答落库后会话停留在 followup）
 *
 * 幂等由服务层负责：重复提交首答/终答不进入状态机，直接返回既有状态。
 */
export type TrainingEvent =
  | "REQUEST_HINT"
  | "SUBMIT_FIRST_ANSWER"
  | "SUBMIT_FINAL_ANSWER"
  | "MARK_SCORED"; // T06 评分完成后使用

export function nextState(
  state: TrainingSessionState,
  event: TrainingEvent,
): TrainingSessionState {
  switch (event) {
    case "REQUEST_HINT":
      // D7：首答提交后（followup/scored）提示入口永久关闭
      if (state === "reading") return "answering";
      if (state === "answering") return "answering";
      throw new TrainingError(
        CODES.HINT_DISABLED,
        409,
        `状态 ${state} 下不可请求提示：首次提交后提示已禁用`,
      );

    case "SUBMIT_FIRST_ANSWER":
      if (state === "reading" || state === "answering") return "followup";
      throw new TrainingError(
        CODES.FIRST_ANSWER_ALREADY_SUBMITTED,
        409,
        `状态 ${state} 下不可提交首答：首答已存在`,
      );

    case "SUBMIT_FINAL_ANSWER":
      // T05：终答落库后保持 followup；scored 由 T06 评分任务推进
      if (state === "followup") return "followup";
      if (state === "scored") {
        throw new TrainingError(
          CODES.SESSION_ALREADY_SCORED,
          409,
          "会话已评分，不可再提交终答",
        );
      }
      throw new TrainingError(
        CODES.FIRST_ANSWER_REQUIRED,
        409,
        `状态 ${state} 下不可提交终答：请先提交首次答案`,
      );

    case "MARK_SCORED":
      // 【T06 接入点】终答评分完成后调用
      if (state === "followup") return "scored";
      throw new TrainingError(
        CODES.INVALID_STATE,
        409,
        `状态 ${state} 下不可标记评分`,
      );
  }
}
