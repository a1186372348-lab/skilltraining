# 架构地图（maps/architecture.md）

> 文档类型：已实现事实地图——架构与组件交互
> 负责范围：当前代码可证明的技术架构、分层、模块职责与主要组件交互方式
> 事实来源：`Prd.md` §3（设计蓝图）+ 仓库实际代码结构；与代码冲突时以代码为准
> 更新触发：新增/删除模块、模块职责变化、分层或数据流变化、技术选型变化——必须在同一变更中更新本文件，否则该改动不算完成

## 1. 技术架构总览

单仓 Next.js 16（App Router）+ TypeScript 应用：页面与 API Route Handlers 同仓，领域逻辑集中于 `server/modules/`，PostgreSQL + Prisma 持久化，AI 能力经自建网关接入 DeepSeek（OpenAI 兼容 API，模型 `deepseek-flash`；D39 起取代 MiMo）。

| 层 | 选型 | 关键约束 |
|---|---|---|
| 框架 / UI | Next.js 16 + React 19 + Tailwind CSS 4 | 页面只负责渲染与交互，不写业务逻辑 |
| API 层 | `app/api/` Route Handlers | 入参必须 zod 验证；响应统一走 `server/lib/api-response.ts`（`jsonOk` / `jsonError`） |
| 领域层 | `server/modules/` | 业务编排（service）与数据访问（repository）分离 |
| 数据层 | PostgreSQL + Prisma | 本地 docker-compose，宿主机端口 5433；一律参数化查询 |
| AI 层 | `server/ai/` 自建网关 | `DEEPSEEK_API_KEY` 仅存服务端，禁止下发前端；调用需限流与审计 |
| 内容层 | YAML 题库（`content/questions/`）+ 导入脚本 | 内容 Git 管理，可评审、可 diff、可回滚 |
| 认证 | 邮箱魔法链接（users + auth_identities） | 无密码存储；身份模型可扩展 |
| 测试 | Vitest（node 环境） | 独立测试库 `skilltraining_test`，与开发库隔离（T14） |

## 2. 分层与依赖方向

```
页面（app/ 各路由）
  → API 层（app/api/，zod 验证 + 统一响应封装）
    → 领域模块（server/modules/*，service → repository）
      → Prisma（server/db.ts / server/lib/prisma.ts）→ PostgreSQL
      → AI 网关（server/ai/*）→ DeepSeek 开放平台
```

- 依赖方向自上而下，领域模块不反向依赖页面或 Route Handler。
- 计划 current/reject/review 及训练 baseline/feedback/final-answer 六个入口的处理器工厂位于同目录 `handler.ts`，`route.ts` 仅导出对应 HTTP 方法及原有必要路由配置；迁移未改变认证、授权、校验、限流、后台评分调度或错误处理。
- 跨模块共享的服务端工具只放 `server/lib/`；模块私有函数不跨模块导出。

部署候选通过 `vercel.json` 请求启用 Fluid compute，并指定 webpack 构建；实际云端生效和项目计划仍须核验。候选安装使用 Next 16.4.5、React 19.2.9 和 Zod 4.6.6。

## 3. 领域模块职责（server/modules/）

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `auth` | 魔法链接登录、会话签发与校验、登录限流、邮件投递及登录后画像/基线落点分流 | `service.ts` `session.ts` `token.ts` `rate-limiter.ts` `mailer.ts` `post-login.ts` |
| `training` | 训练会话状态机（reading/answering/followup/scored + abandoned 终止态，T38 / D40）、渐进提示记录、独立完成系数、今日题视图、单会话工作台视图、产品训练大厅视图（本人可见历史与基线标识）、加练、训练终止（abandon，T38）、评分完成通知 | `state-machine.ts` `coefficient.ts` `today-view.ts` `hub-view.ts` `service.ts` |
| `scoring` | 按 Rubric 调 AI 评分、有效分计算、评分置信度落库（`Score.confidence`，T28 / BR-V2-6）、评分校准、后台评分触发共享入口（`trigger.ts`：进程内去重和数据库租约协调、失败待重试，T36） | `rubric-scorer.ts` `calibration.ts` `service.ts` `trigger.ts` |
| `selection` | 包、可执行周计划、复测和自适应分层选择；显式日常模式仅跳过复测，排除本人已练题及活动包保留题 | `service.ts` `repository.ts` |
| `profile` | 能力画像读写（8 维度分数、观察次数、提示依赖特征）、基于维度事实的下一步建议及各次评分信心展示数据 | `ability-page.ts` |
| `content` | 题库 YAML 读取与契约校验 | — |
| `packs` | 专项训练包组题、逐题解锁、规则诊断、本人可用性读取及生命周期；训练工作台与画像、计划和评分流程相连 | `selection.ts` `progress.ts` `diagnosis.ts` `service.ts` `opening.ts` `lifecycle.ts` `availability.ts` |
| `stages` | 阶段概览、事件与观察水位、连续有效表现触发、独立复测及恢复；真实评分序号与维度快照由评分事务写入，历史不回填 | `judge.ts` `service.ts` `repository.ts` `index.ts` |
| `baseline` | 基线测评流程（八维固定顺序，低置信度动态加深，新测评最多 12 题；旧超额会话按 D44 保留）；提供只读结果可见性条件 | `result-visibility.ts` |
| `dashboard` | 基线揭晓门禁后聚合首页仪表盘数据；「当前训练」卡复用 `training` 的 `getCurrentTrainingCard`（T26 / D28②，单一事实源） | `service.ts` |
| `feedback` | 训练反馈视图、评分信心及训练后感知问卷；基线可见性检查先于懒触发评分 | `view.ts` |
| `history` | 按本人和结果可见性查询只读回放详情（T25 起仅详情——历史列表已由 training 大厅视图承接） | `repository.ts` `view.ts` |
| `planning` | 周期训练计划（T29 / F5）：周一懒生成（画像最低分维度，规则引擎不用 AI）、拒绝/撤销幂等、进度聚合（本周 plan 已评分数 + scoredAt UTC 日期去重天数）、周日首访固定回顾快照；active 归档 completed，rejected 保留，可在本周撤销 | `service.ts` `repository.ts` `schemas.ts` `errors.ts` `index.ts` |

生产环境会话密钥至少 32 字节且不能以空白开头；创建认证服务时校验 HTTPS 回调地址与完整 SMTP 凭据，要求隐式 TLS；配置不符则失败关闭，不退回控制台投递。开发环境保留本地默认值；签名会话读取只依赖会话密钥。生产 AI 网关仅接受官方 HTTPS 地址。

终答、反馈及基线入口为评分设置从请求开始计算的 270 秒绝对截止时间，相对路由配置的 300 秒预留 30 秒；评分调用和重试共享截止时间，耗尽后停止后续尝试。该约束不保证云平台的实际执行、落库或中断恢复成功。评分任务以数据库原子租约跨实例协调，有效期 330 秒，完成后仅持有者可释放；租约过期可被接管，不能保证过期旧任务绝不重叠。

D45 运行契约显式请求 thinking enabled/high 和 `max_tokens` 总生成预算，默认 24576；非法预算在请求前拒绝，80 秒超时与既有重试保留。回归缓存和报告绑定契约身份，旧或异配置 live 缓存拒绝复用；请求温度不是思考模式有效采样温度的证明。本次新参数评分单遍 30 成功、1 失败，未通过原自动门槛；产品负责人已接受已知限制完成本轮开发验收，该结果不改变门槛或版本状态；成功样本指标及适用范围见[评分结果](../docs/v2/regression/scoring-v3-d45-20261103-review.md)，本次不足以证明全部样本的模型质量。

AI 网关审计仅记录末次尝试的请求参数与白名单响应元数据；模型及结束原因受限枚举，推理用量校验为安全整数，指纹仅保存限长校验后的 SHA-256 摘要。未知字段降级，新增审计元数据不包含提示、答案、评分标准、密钥或思考内容；观测功能本身不改变请求、重试与超时；评分入口另有共享截止时间。D45 显式请求 thinking enabled / high 和 max_tokens 24576；官方说明 thinking 模式下温度不生效，历史实际模式及参数生效情况仍未知。

AI 网关（`server/ai/`）：`client.ts`（DeepSeek OpenAI 兼容客户端，provider 中立封装，D39）、`followup.ts`（AI 总监追问生成；T35 / D37 追问闸门——同一次调用先判定必要性，输出 `{ should_followup, reason, followups }`，判定锚定主测维度 abilityTags[0] 的 Rubric 要点、标准从紧；followup v3 起请求温度 0.2，D43；生效条件见 [运行参数核查](../docs/v2/t28-runtime-parameter-review-20261029.md)）。

prompt 文件化与版本管理（`server/ai/prompts/`，T28 / D31）：`scoring.v1~v3.ts` / `followup.v1~v10.ts`（`{{slot}}` 插值模板，`template.ts` 渲染器；`snapshot.test.ts` 逐字快照行为不变底线）；`registry.ts`（状态机 draft→passed→active→rolled_back、内容哈希、回滚计划，纯函数）；`repository.ts`（`prompt_versions` / `eval_runs` 表读写，同 name 唯一 active 事务保证）；`resolver.ts`（运行时解析：进程内缓存（V1 单实例），DB active 优先、无 active 回退文件版本、旧版哈希漂移仅 warn；V8/V9/V10 strict 契约或哈希异常失败关闭）；回滚仅选择 passed / rolled_back 版本，draft 不可直接激活。可信协议显式绑定 V8→gate-evidence-v1、V9/V10→gate-evidence-v2，生产和回归复用解析器，校验来源原文与检查关联并剥离内部证据；V9 允许保留非重大缺项而不追问，跳过时仍需两组合法检查覆盖，V8/v1 原约束保留。V10 增强关键因果前提核对，真实单遍完整返回 31 份、退出码 1，固定标签漏问 1 份，未通过原零漏问门槛，用户接受当前产品表现并停止继续语义调优（D46）；独立语义预审未覆盖全部输出，原自动门槛及标签未改变。V10 未启用，当前实际 active 版本未查询；结构校验不证明语义正确。build 函数保持同步纯函数签名（模板作参数注入），调用方（`scoring/service.ts`、`training/service.ts` 生成追问处）异步解析注入。

## 4. 主要组件交互

### 4.1 今日训练主链路

打开今日训练 → `selection` 按画像选题 → 渲染训练页（三栏工作台）→ 用户逐级请求提示（记录次数与时间，回传当前系数）→ 首次提交（提示按钮消失）→ AI 网关同一次调用先经追问闸门判定（T35 / D37）：判定记录两分支落库（followups jsonb 首元素恒为 gate_decision 标记，含 shouldFollowup 与判定理由，仅审计不下发）——判定无需追问（主测维度无重大缺项、证据链完整）→ 无追问轮次，前端正向零追问卡直进终答；判定需要追问 → 生成总监追问 1~2 轮（各附预生成提示，轮次跟随判定记录；followup v3 含边界规则④⑤+实质性门槛，D41）→ 最终提交 → 提交成功即经 `scoring/trigger.ts` 后台触发评分（T36 / D38；fire-and-forget，不等结果）→ `scoring` 按 Rubric 评分（scoring v3 低分上浮修正；输出含 confidence 自评置信度，落库 `Score.confidence` 可空，T28 / BR-V2-6）→ `有效分 = 原始分 × 独立完成系数` → `profile` 更新画像 → 跳转反馈页 → 存感知问卷。反馈页打开时若仍未评分，经同一触发入口懒触发补评分（T07）；详见 `Prd.md` §3.2 图 1。

### 4.2 自适应出题 v0.1

存在未知维度 → 探索期优先覆盖未知维度；否则 → 强化期取最低分弱项，叠加提示依赖特征；过滤已练与近期同类案例；匹配兴趣与难度；首次训练优先熟悉产品案例（D11）。详见 `Prd.md` §3.2 图 2。

V2 自动训练优先级（BR-V2-1、BR-V2-2）：`training/service.ts` 先承接活动训练包，并保留已有普通会话的续练语义。需选新题时，`selection/service.ts` 依次尝试本周计划、待复测和自适应弱项。计划层在本周计划有效且今日尚未练计划题时，只读查询主攻维度的上架未练题，由 planning 模块负责首访生成计划。显式「先做日常训练」跳过复测层。计划、训练包和复测的会话分别保留 `sourceType`、`sourceId`，独立复测不占用普通每日槽位。

### 4.3 基线测评

新用户完成初始画像问卷后强制进入（D19）：八维固定顺序起步，以主问所属维度锚定低置信度加深，每维最多加深一题，新测评总数不超过 12；旧超额会话按 D44 保留，复用训练闭环组件（`app/baseline/` + `BaselineFlow`，不跳反馈页），结果作为画像初始值，完成后解锁日常训练。T36 / D38 起题间并行评分：提交终答即后台触发评分、按已作答推进下一题（`getBaselineStatus` 双计数：answeredCount 推进、doneCount 完成判定）；全部作答后进入收尾页等待全部评分完成，`GET /api/training/baseline` 对已作答未评分会话补触发自愈；中途任何 today 入口被 409 `BASELINE_SCORING_PENDING` 挡回 `/baseline`。

加深候选在状态响应展示前以基线会话预留；可串行化事务与有限重试保护并发，`baselineActivatedAt` 标记首次实际选中，预留本身不激活。状态 API 通过白名单输出进度，不下发 Rubric 和提示树。收尾期间若晚到评分触发加深，流程继续作答，已展示或激活的补测不被挤掉。

`baseline/result-visibility.ts` 提供只读条件：本人日常结果维持原口径；本人基线结果须有 `baselineCompletedAt`，且具备激活、作答、提示、评分或有效流程状态等参与证据。大厅历史在排序取最近 20 条前应用该条件并返回 `isBaseline`；历史详情与反馈按同一条件查本人会话，不符合或越权一律 404，反馈在懒触发评分前检查。历史详情新增 `questionKind`，题目仍通过白名单读取，不下发 Rubric、提示树或未释放提示。旧版无激活标记且无答案、提示、评分等参与证据的空白 reading 与未激活预留无法区分，安全排除，不回填推测数据。

本人存在任意基线会话而完成标记为空时，`assertAbilityResultsVisible` 在画像与首页装配前及计划 current/review/reject 读取或写入前阻断，接口返回 409 `BASELINE_REQUIRED`。无基线会话的旧用户当时仍可读取结果，但既有登录与今日训练会将未完成基线的用户引导到基线；首次会话创建后，结果至基线完成前暂隐。不能将读取守卫的这一条件解释为老用户免测或登录必回首页。无完成标记即使已有全部评分也暂不揭晓，等待现有基线状态流程写入完成标记。此只读门禁不改变基线推进、评分、通知或今日训练槽逻辑。

登录分流仅对画像存在性查询失败记录固定脱敏日志并回首页，其他认证及基线状态错误不由该分支吞掉。画像下一步方向优先未知维度；全部已观察时依次比较当前分、观察次数和固定维度顺序，结合所选维度的提示依赖及具体行动，实际选题仍可能受周计划影响。反馈 `scores[].confidence` 与画像 `dimensions[].recentEvaluations[].confidence` 逐条对应其评分，仅保留 0～100 整数，0 有效，NULL 或非法值降为 NULL；不求平均或表示准确率。

### 4.4 内容管线

YAML 题库（`content/questions/`，案例五要素每字段带 `{text, citations[]}` 来源引用，BR-8）→ `npm run content:validate` 契约校验 → `npm run content:import` 同步入库。

第二、三批 Q13～Q48 题目及独立参考已由负责人定稿，题目状态为 `published`、参考状态为 `approved`，以正文哈希绑定批准记录。新建隔离测试环境的分批及全库重复导入、持久化内容比对与八维组包已通过，尚未导入开发或线上题库。标准参考与题目分别维护，参考正文不进入面向训练用户的题目字段。常规覆盖函数会计入有效草稿；发布可用性须另按 `published` 日常题筛选，本地覆盖或隔离组包结果不等于具体用户扣除已练题后的实际供给。

### 4.5 训练终止与重启（T38 / D40）

「当前训练」卡进行中态（首页/大厅同源，D28）→「重启训练」两步内联确认 → `POST /api/training/[id]/abandon`（统一限流，无 AI 调用）→ 状态机 ABANDON 事件：`reading / answering / followup` → `abandoned` 终态；写入为带守卫条件的 `updateMany`（进行中三态 + 未交终答），并发双击/「终止-交卷」竞态只有首次生效，重复终止幂等返回成功。守卫（D40④）：基线会话 409 `BASELINE_SESSION`、已提交终答 409 `FINAL_ANSWER_ALREADY_SUBMITTED`、已评分 409 `SESSION_ALREADY_SCORED`。
已终止会话：不删除、不评分、不计入画像——当前训练卡进行中查询、`getLatestDailySession` / `getOrCreateTodaySession` / `getOrCreateExtraSession` 的复用查询全部排除之（卡片回未开始态，重启走 get-or-create 出新题）；选题的已练排除语义覆盖任何状态会话，被终止题不再被选到；历史列表以「已终止」徽章展示，跳转只读回放详情；工作台直达（`GET /api/training/[id]`）对其返回 409 `SESSION_ABANDONED`，前端重定向训练大厅。

## 5. 基础设施

- 本地数据库：`docker-compose.yml`（PostgreSQL，宿主机 5433；Windows 下连接串用 `127.0.0.1`）。容器创建配置必须提供 `POSTGRES_PASSWORD`，密码保存在被Git忽略且限制访问的本地环境文件，开发与测试连接使用同一角色并须与该值保持一致；`.env.example`仅保留占位说明，不提供可直接使用的默认密码。更新已初始化数据库的密码需同步实际角色与连接配置，仅修改容器环境变量不会更新现有角色。
- 测试隔离：`npm test` 的 pretest 钩子自动建 `skilltraining_test` 并执行 `prisma migrate deploy`。
- 评分解析：`parseScoringOutput` 解析 JSON 后先校验顶层为非 null、非数组对象，否则抛 `SCORING_OUTPUT_INVALID`；合法对象继续按原字段校验，confidence 缺失或无效仍降级为空。
- 标准参考答案：16道基线题及新增36道日常题的独立参考分别经产品负责人认可，`content/standard-references/` 的批准状态与 `task/evidence/standard-reference-approvals/` 审批记录以正文哈希绑定，结构及相应范围的严格就绪检查通过；本地绑定校验不认证审批人身份，参考正文不输入模型。
- 调优数据契约（T28 / D31）：`prompt_versions` 表（prompt 版本注册表：id / name / version / content / contentHash / status / createdAt，迁移 20261020120000）；`eval_runs` 表（回归留档：id / promptVersionId / consistencyScore / report Json / createdAt，同迁移）；`Score.confidence`（评分置信度可空 Int，迁移 20261022120000；老数据 NULL，T27 消费侧不触发加深判定）。
- 计划数据契约（T29 / F5）：`TrainingSession.sourceType`（枚举 daily/extra/baseline/plan/pack/retest，默认 daily 兜底）+ `sourceId`（可空 Uuid，计划命中落计划 id）——迁移 20261022140000，历史会话按 question.kind/isExtra 幂等回填（baseline→baseline、isExtra→extra、其余→daily，回填前后分组计数一致）；`training_plans` 表（迁移 20261022150000：id/userId/weekStartDate(@db.Date 周一）/focusDimension/startScore/targetScore/status(active/rejected/completed)/reason/createdAt；@@unique(userId, weekStartDate) 懒生成幂等 + @@index(userId, status)）。
- 统一回归门禁：`scripts/prompt-regression.ts`（scoring/followup 双套件，mock/live 双模式；双跑确认制 + 遍内定向补跑 + followup 样本级确认与抖动率门槛 + 三查③泄露硬门槛，D42；门槛不过退出码 1）。缺省数据库来源的 live 写 eval_runs 与 `docs/v2/regression/` 报告；显式 `--prompt-source file --suite followup --version v9` 或 `v10` 经 `regression-file-prompt.ts` 静态选择可信候选，mock 仍为桩，live 记录 file 来源和实际模板哈希，只写本地报告与缓存，不查写数据库或改变版本状态。配套 `scripts/prompt-register.ts`（版本登记与晋级）、`scripts/gate-probe.ts`（闸门探针）、`scripts/lib/`（eval-calibration / gate-calibration / regression-gate / serial-runner / followup-leak-check / eval-sample-loaders 等回归与校准纯函数库，含 fixtures 单测）。
- 部署选型（T39）：Vercel + Neon 云 PostgreSQL（Singapore 区域）+ QQ 邮箱 SMTP（465 隐式 TLS，复用现有 `SmtpMailer`）+ DeepSeek API；候选请求启用 Fluid compute，项目实际计划与配置、云迁移和公网验收尚待核验。环境差异走环境变量，本地开发不受影响。早期「云服务器 + Docker + Nginx + 云 RDS」设想（D15）由本选型取代。
- 后台评分保活（T39）：`triggerSessionScoring` 支持路由层注入 `schedule`（`next/server` 的 `after`，响应返回后在函数时限内继续执行）；三个触发路由（final-answer / baseline / feedback）传入并声明 `maxDuration = 300`。基线状态接口只在有待评分会话时检查按用户限流，超额时跳过补触发并返回正常进度。缺省维持 fire-and-forget；限流与触发去重均为进程内，Serverless 多实例仍可能并行触发。
