# 关键功能参考（maps/features.md）

> 文档类型：已实现事实地图——关键功能高层概览
> 负责范围：每个关键功能「是什么、入口在哪、由哪些模块支撑、受哪些规则约束、当前状态」，用于规划改进与定位 bug
> 事实来源：`Prd.md` §1/§2（需求）、`task/`（交付状态）、实际代码入口；与代码冲突时以代码为准
> 更新触发：功能交付、行为变化、入口或支撑模块变化——必须在同一变更中更新对应小节，否则该改动不算完成

> 用途说明：本文件只做高层概览与路由，不记录实现细节；细节查 [`architecture.md`](architecture.md)（模块交互）与代码本身。改进或修 bug 时先在本文件定位功能，再沿「入口 / 支撑模块」深入。

## F1 产品训练闭环（核心）

- 概述：每日一题完整链路——大厅选题/回看 → 案例 → 作答 → 5 层渐进提示 → AI 总监追问 → 终答 → 评分 → 反馈页 → 再练一题（D27：训练链路合并为单一「产品训练」模块，不离开模块的连续闭环）。
- 用户入口：`app/training/`（大厅，模块主页：当前训练卡三态 + 训练历史列表）；工作台 `app/training/session/[id]/`（P3，三栏布局，按会话寻址）；反馈页 `app/training/feedback/[id]/`（P4）；回放详情 `app/training/history/[id]/`（只读）。旧路由 `/today`、`/history` 307 重定向到新路由。
- API：`app/api/training/`（hub、today、[id]、[id]/abandon（T38 终止）、hint、first-answer、followup-retry、final-answer、extra、score-notifications）。
- 支撑模块：`server/modules/training`（状态机、系数、大厅视图 hub-view、单会话视图）、`scoring`（Rubric 评分）、`selection`（选题）、`profile`（画像更新）、`server/ai/followup.ts`（追问）。
- 关键规则：BR-1/BR-2（有效分与系数）、BR-3（提示）、BR-4（追问）、BR-7（反馈必须具体可行动）、D7/D22/D23/D27；追问闸门（T35 / D37）：首答后同一次 AI 调用先判定必要性——主测维度（abilityTags[0]）无重大缺项、证据链完整则不追问，前端渲染正向零追问卡直进终答；判定该追问则给 1~2 问；闸门判定记录两分支落库（followups jsonb 首元素恒为 gate_decision 标记：shouldFollowup + 中文判定理由，仅审计不下发；存量 gate_skip 标记读取侧兼容），并配 gate-probe 探针（`scripts/gate-probe.ts`：--recent 判定分布监测，全部为同一判定时警示形同虚设；--live 真实调 DeepSeek 核查思考链）；追问生成失败态（空数组，与闸门跳过可区分）隐藏作答输入区，提供「重试本次对话」（followup-retry，幂等；闸门跳过会话 409 FOLLOWUP_GATE_SKIPPED 守卫）与「跳过追问直接作答」逃生口（T37 / D39）；训练终止与重启（T38 / D40）：进行中态当前训练卡提供「重启训练」（两步内联确认），终止为状态推进（`abandoned` 终态）而非删除——不评分不计入画像，历史以「已终止」徽章只读展示；仅未提交终答的日常会话（含加练）可终止（基线/已交终答/已评分一律 409）；被终止题进入选题排除集，重启走 get-or-create 出新题；终止会话的工作台直达 409 `SESSION_ABANDONED`，前端挡回大厅。
- 状态：已交付（T05/T06/T07）；追问提示（T19）、三栏工作台（T20）、加练（T21）、追问可靠性（T22）、评分通知（T24）陆续增强；IA 重构（T25）合并为「产品训练」模块；追问闸门（T35 DONE，2026-10-20 人审校准 R2：放水 0、误伤率 20% 裁定达标——判定标准为结构性缺陷三类 + 证据-结论错配 + 达标即放行 + 承认未知保护，报告 `docs/v2/gate-calibration-report.md`）；训练终止与重启（T38 DONE，实测确认）。

## F2 基线测评

- 概述：新用户完成初始画像后必做的综合测评，当前为 8 题试测名单（覆盖 8 维，按 id 升序固定顺序），结果作为画像初始值，完成后解锁日常训练；每次登录按状态分发落点——问卷未完成 → `/onboarding`，基线未完成 → `/baseline`（`server/modules/auth/post-login`）。
- 用户入口：`app/baseline/`（复用训练组件，BaselineFlow 不跳反馈页；T36 / D38 题间并行评分——提交终答即后台触发评分、按已作答推进；题间过渡卡：提交后「已提交 ✓ + 分段进度 + 评审统一揭晓预告」，手动点「进入下一题」继续，最后一题为「完成测评，查看能力边界 →」进「能力边界生成中」收尾页，按评分完成进度逐项点亮 8 维，全部评完自动跳 /profile 揭晓）。
- API：`app/api/training/baseline/`（状态查询 + 已作答未评分会话补触发自愈）；`app/api/training/today` 在全部已作答待评分期间返回 409 `BASELINE_SCORING_PENDING`，各入口挡回 `/baseline`；`app/api/training/extra` 对基线未完成用户返回 409 `BASELINE_REQUIRED`（T36 试测修补：加练接口原本无基线门禁）。
- 基线题反馈页分流：反馈页按题目类型切换动作按钮——基线题不出「再练一题」，主按钮为「回到基线测评」（`feedback/view.ts` 下发 `questionKind`）；日常题不变。
- 支撑模块：`server/modules/baseline`（双计数：answeredCount 推进、doneCount 完成判定）、复用 `training` / `scoring`（`trigger.ts` 后台评分触发共享入口）。
- 关键规则：BR-9、D19、D38。
- 状态：流程（T17a）与题目生产（T17b）进行中。

## F3 自适应出题 v0.1

- 概述：探索期优先未知维度，强化期按弱项 + 提示依赖 + 兴趣 + 难度选题；新用户基线后直接进入强化期。
- 入口：被训练链路调用，无独立页面。
- 支撑模块：`server/modules/selection`。
- 关键规则：BR-5、D11、D19。
- 状态：已交付（T11）。

## F4 能力画像

- 概述：8 个一级维度的分数 / 观察次数 / 提示依赖特征 / 趋势；允许「未知」；主视图 3D 力导向网络图，点击节点看评估记录与下一步方向。
- 用户入口：`app/profile/`（P2）。
- API：`app/api/profile/`。
- 支撑模块：`server/modules/profile`；3D 图依赖 `react-force-graph-3d` + `three`。
- 关键规则：BR-6、D20/D21。
- 状态：页面已交付（T09），3D 网络图（T16）进行中。

## F5 首页仪表盘

- 概述：问候行 + 统计条 + 「当前训练」三态卡（T26 / D28：与产品训练大厅同一张共享组件 `app/training/current-training-card.tsx`、同一判定数据源 `getCurrentTrainingCard`，两处永不漂移；题面预览已由大厅与工作台承接，首页只保留三态行动卡）+ 能力总览 + 最近一条诊断。
- 用户入口：`app/page.tsx`（P1），共享组件在 `app/_dashboard/`（三态卡除外，见上）。
- API：`app/api/dashboard/`（载荷含 `currentTraining`，单卡失败降级 null 空态）。
- 支撑模块：`server/modules/dashboard`；当前训练卡判定复用 `server/modules/training/hub-view.ts`。
- 状态：已交付（T08）；三态卡同构（T26）。

## F6 训练历史与回放

- 概述：训练历史列表并入产品训练大厅（D27④：加练并入，以「加练」徽章区分；基线会话不进列表；T38 / D40②：已终止会话以「已终止」徽章保留在列表中，不评分不计入画像）；回放详情只读（案例、两版答案、提示使用、追问记录、最终反馈、能力变化）。
- 用户入口：大厅历史列表 `app/training/`；回放详情 `app/training/history/[id]/`（P5，自 `app/history/` 迁移，旧列表页已被大厅取代不共存）。
- API：`app/api/training/hub/`（大厅历史列表）、`app/api/history/[id]/`（回放详情）；`GET /api/history`（旧列表）已随大厅落地删除。
- 支撑模块：`server/modules/training/hub-view.ts`（大厅列表）、`server/modules/history`（回放详情）。
- 状态：已交付（T10）；T25 迁入产品训练模块。

## F7 认证与我的

- 概述：邮箱魔法链接登录（无密码）；每次登录（verify 核销成功）按状态分发落点——无画像行 → `/onboarding`，基线未完成 → `/baseline`，全部完成 → `/`；「我的」页承载初始画像查看/编辑、兴趣方向、基础设置。
- 用户入口：`app/login/`、`app/onboarding/`（初始画像问卷，入口由登录分发提供）、`app/settings/`（P6）。
- API：`app/api/auth/`、`app/api/profile/`（画像部分）。
- 支撑模块：`server/modules/auth`（token/session/rate-limit/mailer；`post-login` 登录落点分发）、`profile`。
- 关键规则：D17；登录与发信端点必须限流。
- 状态：登录（T03）与初始画像（T04）已交付；我的页面（T15）进行中。

## F8 题库内容管线

- 概述：YAML 题库 Git 管理，校验后导入数据库；案例五要素每字段必须带真实来源引用。
- 入口：`content/questions/`（draft/ 为草稿区）；命令 `npm run content:validate` / `content:import`。
- 支撑模块：`server/modules/content`、`scripts/validate-content.ts`、`scripts/import-content.ts`。
- 关键规则：BR-8、D18；无来源论断不得进入案例背景。
- 状态：已交付（T02）；首日 12 题（T12）与真实来源改写（T13）完成。

## F9 反馈与感知问卷

- 概述：每次训练后两问（1~5 分）+ 周期性一问，用于评估训练方向有效性。
- 用户入口：反馈页内嵌（P4）。
- API：`app/api/feedback-survey/`。
- 支撑模块：`server/modules/feedback`。
- 状态：已交付（T07）。

## F10 基础设施与运维

- 概述：本地 PostgreSQL（docker-compose，5433）、测试库隔离、AI 网关用量监控、评分校准等脚本。
- 入口：`docker-compose.yml`、`scripts/`（`prepare-test-db.ts`、`ai-usage-report.ts`、`scoring-calibration.ts` 等）。
- 关键规则：`DEEPSEEK_API_KEY` 仅存服务端；测试一律运行于 `skilltraining_test`。
- 状态：测试隔离（T14）已交付；用量监控（T23）进行中。
