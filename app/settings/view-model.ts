import type {
  AccountView,
  ProfileData,
  ProfileFormState,
  ProfileSummaryRow,
  SessionData,
} from "./contract";

/**
 * 我的页面（P6 /settings，T15）视图装配纯函数。
 * 页面组件只负责渲染与调用 api 适配层；数据→视图的判定全部落在本文件，
 * 由 view-model.test.ts 覆盖（画像预填映射、dev/真实身份分支、保存载荷构造）。
 */

/** 开发态占位邮箱：与 server/lib/dev-identity.ts 的 DEFAULT_DEV_EMAIL 保持一致（仅用于展示） */
export const DEFAULT_DEV_EMAIL = "dev@skilltraining.local";

export const EMPTY_PROFILE_STATE: ProfileFormState = {
  position: "",
  yearsExperience: "",
  industry: "",
  projectExperience: "",
  familiarProducts: [],
  interestAreas: [],
  learningGoal: "",
  selfAssessment: [],
};

/** 账号信息卡视图：有会话为真实身份；无会话（开发态无 cookie）回退 dev 占位身份 */
export function accountViewOf(session: SessionData | null): AccountView {
  if (!session) {
    return { email: DEFAULT_DEV_EMAIL, isDev: true, badge: "dev 开发身份" };
  }
  return { email: session.user.email, isDev: false, badge: "已登录" };
}

/** 把 GET /api/profile 返回的画像归一化为表单状态（防御 jsonb 脏数据） */
export function toProfileFormState(
  raw: ProfileData | null | undefined,
): ProfileFormState {
  if (!raw) return { ...EMPTY_PROFILE_STATE };
  const asStrings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const asText = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return {
    position: asText(raw.position),
    yearsExperience: asText(raw.yearsExperience),
    industry: asText(raw.industry),
    projectExperience: asText(raw.projectExperience),
    familiarProducts: asStrings(raw.familiarProducts),
    interestAreas: asStrings(raw.interestAreas),
    learningGoal: asText(raw.learningGoal),
    selfAssessment: asStrings(raw.selfAssessment),
  };
}

/** 保存载荷：丢弃未填字段（空串/空白/空数组），文本去空白；PUT 幂等，可原样重试 */
export function buildProfilePayload(
  state: ProfileFormState,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (state.position) payload.position = state.position;
  if (state.yearsExperience) payload.yearsExperience = state.yearsExperience;
  if (state.industry) payload.industry = state.industry;
  if (state.projectExperience.trim())
    payload.projectExperience = state.projectExperience.trim();
  if (state.familiarProducts.length)
    payload.familiarProducts = state.familiarProducts;
  if (state.interestAreas.length) payload.interestAreas = state.interestAreas;
  if (state.learningGoal.trim())
    payload.learningGoal = state.learningGoal.trim();
  if (state.selfAssessment.length) payload.selfAssessment = state.selfAssessment;
  return payload;
}

/** 必填三项（职位/年限/行业）齐备才允许保存，与 onboarding 问卷一致 */
export function isProfileSavable(state: ProfileFormState): boolean {
  return Boolean(state.position && state.yearsExperience && state.industry);
}

/** 查看态摘要行：未填字段显示「未填写」，多值以顿号连接 */
export function profileSummaryRowsOf(
  state: ProfileFormState,
): ProfileSummaryRow[] {
  const orEmpty = (value: string) => (value.trim() ? value : "未填写");
  const joinOrEmpty = (list: string[]) =>
    list.length ? list.join("、") : "未填写";
  return [
    { label: "职位", value: orEmpty(state.position) },
    { label: "产品相关经验年限", value: orEmpty(state.yearsExperience) },
    { label: "所在行业", value: orEmpty(state.industry) },
    { label: "熟悉的产品", value: joinOrEmpty(state.familiarProducts) },
    { label: "感兴趣的领域", value: joinOrEmpty(state.interestAreas) },
    { label: "项目经验", value: orEmpty(state.projectExperience) },
    { label: "学习目标", value: orEmpty(state.learningGoal) },
    { label: "自评更强的方向", value: joinOrEmpty(state.selfAssessment) },
  ];
}
