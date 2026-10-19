# T37 模型切换 DeepSeek 与追问失败重试

- 状态：IN_PROGRESS
- 决策来源：D39（maps/changelog.md 决策记录）；D25④ 的用户侧重试入口暂缓决定被本任务取代
- 背景：试测中 MiMo 追问生成失败（「总监暂时离开」）+ 长时段评分抖动；产品负责人裁定全量切换 DeepSeek（`deepseek-flash`，当前即 V4.1-Flash-1017）。失败态 UX 同步修复。

## 目标与范围

**目标**：

1. AI 网关从 MiMo 切换到 DeepSeek（OpenAI 兼容协议不变，追问/评分/脚本全链路），provider 中立化；
2. 追问失败态修复：失败时隐藏作答输入框，提供「重试本次对话」按钮（用户侧重新生成入口），保留「跳过追问直接作答」逃生口。

**范围外（明确不做）**：

- T35 追问闸门（在本任务之后启动，于 DeepSeek 上校准）；
- 评分/追问 prompt 内容调优（仅迁移，不改文案）；
- DeepSeek 思考档位（thinking effort）调参——先按默认行为上线，观测后再议；
- MiMo 相关历史任务文档（T22/T23 等 DONE 记录）不改写。

## 前置依赖（既有事实）

- `.env` 已就位：`DEEPSEEK_API_KEY`（用户已填）、`DEEPSEEK_BASE_URL="https://api.deepseek.com"`；MiMo 字段保留作回退。
- 2026-10-14 连通性实测（curl，真实密钥）：基本调用 200（约 0.7s）；`response_format: json_object` 可用；`max_completion_tokens=16` 下推理 token 计入 completion 预算但仍返回正文（不截空）；`deepseek-flash` 别名指向最新快照。
- 现有客户端 `server/ai/mimo-client.ts`：OpenAI 兼容 fetch 封装，指数退避重试（含「200 空 content」纳入重试，D25②）、超时 80s（D25⑤）、用量审计日志（事件 `ai.mimo.chat_completion`）。
- 追问生成失败语义（T22）：`submitFirstAnswer` 追问生成失败时 followups 落库为空数组，前端据「空追问 + 超 120 秒窗口」渲染失败态；运维补救脚本 `scripts/regen-followup.ts`。

## 受影响模块、数据和接口

1. **网关 provider 中立化**：`server/ai/mimo-client.ts` → `server/ai/client.ts`（重命名），导出改 provider 中立命名（如 `createAiClientFromEnv` / `AI_MODEL`），读取 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`，模型常量 `deepseek-flash`；重试/超时/审计机制原样保留，审计事件名改 `ai.deepseek.chat_completion`。消费方同步更新：`server/ai/followup.ts`、`server/modules/scoring/rubric-scorer.ts`、`scripts/regen-followup.ts`、`scripts/eval-baseline-samples.ts`、`scripts/scoring-calibration.ts`、相关测试（`mimo-client.test.ts` → `client.test.ts` 等）。
2. **用量监控脚本**：`scripts/lib/mimo-usage.ts` 与 `scripts/mimo-usage-report.ts` 随事件名改 provider 中立命名（如 `ai-usage-report.ts`），package.json 脚本命令同步；README/AGENTS.md 命令表引用更新。
3. **追问重试接口**：新增 `POST /api/training/[id]/followup-retry`——守卫：会话归属、state=followup、已提交首答、当前 followups 为空（仅失败态可重试；非空幂等返回既有追问）；复用追问生成逻辑落库（含预生成提示，D22 不变）；AI 端点统一限流。响应与首答接口的 followups 视图同构。
4. **前端失败态**（`app/training/session/training-flow.tsx`）：失败态（非生成中且无总监消息）隐藏作答输入区，渲染「总监暂时离开」+ 主按钮「重试本次对话」+ 文字按钮「跳过追问，直接作答」（点击展开输入区，placeholder 提示直接终答）；重试中显示「总监思考中…」复用生成中样式；重试成功就地渲染追问气泡并恢复输入区；重试失败回失败态并提示。纯判定逻辑下沉 view-model（补单测）。
5. **文档同步（DoD）**：`AGENTS.md` 架构概览 AI 行（MiMo → DeepSeek `deepseek-flash`）；`maps/architecture.md` AI 网关小节；`maps/features.md` F1 训练闭环（失败态重试入口）与涉及 MiMo 的描述；`.env.example` 移除 MiMo 字段（用户 `.env` 保留作回退）；README 若提及模型同步更新。changelog 时间线随合并补记。

## 可执行步骤及顺序（TDD）

1. RED：客户端配置测试（读 DeepSeek env、模型常量、缺 key 报错）、followup-retry 路由测试（守卫/幂等/限流/成功落库）、view-model 失败态判定用例；
2. 客户端重命名 + DeepSeek 配置切换（全部消费方与测试更新，grep 旧标识零命中：mimo-client、MIMO_MODEL、createMimoClientFromEnv、MIMO_API_KEY、MIMO_BASE_URL、ai.mimo 事件名）；
3. followup-retry 服务端（service 抽取可复用的追问生成落库函数 + 路由）；
4. 前端失败态改造（输入区显隐、重试按钮、跳过通道、重试中态）；
5. 门禁三件套 + 实测：真实追问生成（DeepSeek）、kill 模拟失败 → 重试按钮恢复。

## 失败、回滚和数据保护

- 密钥仅存服务端环境变量，日志与错误信息不得泄露；测试禁止真实冒烟（mock 注入）。
- 切换为硬切换（代码只读 DeepSeek env）；回滚 = git revert + 保留的 MiMo env 字段。
- 追问重试接口幂等：已有追问的会话重复调用不覆盖、不重复调 AI。
- 不迁移任何历史数据（已生成的追问/评分保持原样）。

## 测试、验收条件和完成证据

- 单测：客户端配置/重试语义（沿用既有用例迁移）；集成：followup-retry 全守卫分支；view-model 失败态判定。
- 实测证据：真实首答 → DeepSeek 追问生成成功；制造一次失败（如临时错误 key）→ 失败态无输入框 + 重试按钮 → 恢复后重试成功。
- 切换后由主代理执行 31 份校准集复跑（`scripts/eval-baseline-samples.ts --live`），对照人审结论出报告（`docs/v2/calibration-report-baseline-8-deepseek.md`）。
- 全程通过 `npm run lint`、`npm run typecheck`、`npm test`。
