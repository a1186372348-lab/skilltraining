/**
 * 我的页面（P6 /settings）前端契约（T15）。
 *
 * - SessionData 与 GET /api/auth/session 的 data 负载对齐；
 * - ProfileData 与 GET /api/profile 的 data 负载对齐（user_profiles 行 JSON 序列化，
 *   jsonb 字段为弱类型，视图装配时统一走 view-model 的防御性归一化）；
 * - 统一响应封装沿用 server/lib/api-response.ts：{ success: true, data } / { success: false, error }。
 */

/** 会话信息（GET /api/auth/session 的 data） */
export interface SessionData {
  user: { id: string; email: string };
  expiresAt: string;
}

/** 画像数据（GET /api/profile 的 data；未提交过画像时为 null） */
export type ProfileData = Record<string, unknown>;

/** 画像编辑表单的本地状态（8 个契约字段，与 onboarding 问卷一致） */
export interface ProfileFormState {
  position: string;
  yearsExperience: string;
  industry: string;
  projectExperience: string;
  familiarProducts: string[];
  interestAreas: string[];
  learningGoal: string;
  selfAssessment: string[];
}

/** 账号信息卡视图：dev 分支显示 dev 标识与开发占位邮箱 */
export interface AccountView {
  email: string;
  isDev: boolean;
  badge: string;
}

/** 画像查看态的一行摘要 */
export interface ProfileSummaryRow {
  label: string;
  value: string;
}
