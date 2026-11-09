# prompt 回归报告：followup（T28 / D31，BR-V2-7）

- 版本：v10 ｜ 模式：live ｜ 模型：deepseek-flash ｜ 时间：2026-11-03T07:42:37.131Z
- 门槛结论：**未通过（存在未达标指标，退出码 1）**

## 门槛判定

| 指标 | 实际值 | 阈值 | 结果 |
|---|---|---|---|
| 放水数（人审该追问但判跳过） | 1 | ≤ 0 | ❌ 未达标 |
| 误伤率（人审不该追问但判追问） | 0.0% | ≤ 20.0% | ✅ 达标 |
| 跑批失败样本数 | 0 | = 0 | ✅ 达标 |
| 泄露检查缺全文样本数 | 0 | = 0 | ✅ 达标 |
| 泄露违规数（三查③规则检查） | 0 | ≤ 0 | ✅ 达标 |

## 逐样本明细

| 样本 | blindId | 人审判定 | 机器判定 | 结论 | 机器 reason |
|---|---|---|---|---|---|
| B10#1 | S1 | gray | 追问 | gray | 首答立场与条件较完整，但消费者价值未具体说明，且失败代价可控缺少依据，需补问。 |
| B10#2 | S4 | followup | 追问 | agree | 首答立场明确且限定在证据支持范围，但缺少分主体价值结构与可迁移标准，值得补问。 |
| B10#3 | S3 | followup | 追问 | agree | 首答有条件式立场与验证路径，但可迁移标准未交付，价值对象未分层，且核心判据中赛道空位与需求真实的证据来源缺失。 |
| B10#4 | S2 | followup | 追问 | agree | 首答立场明确但判据空洞，缺价值结构、成立条件、不确定性与可迁移标准，且以首播结果和未验证前提支撑必然成功，需追问。 |
| B12#1 | S1 | skip | 跳过 | agree | 方案设计必要交付已覆盖：机制拆解、能力边界、改进流程、异常与代价均有回应，未见需追问的重大缺口。 |
| B12#2 | S2 | followup | 追问 | agree | 首答机制拆解和能力边界较完整，但排队成立前提未交代，改进异常对冲的自洽性未论证，需补这两处。 |
| B12#3 | S4 | gray | 追问 | gray | 改进仍以实验区分困难为主，未形成可直接运作的改进流程，代价承担者也未交代；需要补足后再评。 |
| B12#4 | S3 | followup | 追问 | agree | 首答以口号和夸大结论代替机制拆解、边界说明与可运作改进；关键因果前提缺少依据，需追问以判断方案设计能力。 |
| B14#1 | S2 | gray | 追问 | gray | 排序明确且有多条事实支撑，但闪购优先依赖的复用前提及证伪动作未交代，需一轮补足。 |
| B14#2 | S3 | followup | 追问 | agree | 次方向触发条件未交代，且支撑排序的关键前提缺少公开事实核对，影响排序稳健性 |
| B14#3 | S4 | skip | 跳过 | agree | 首答选择信息不足分支，明确缺口、过渡与三个月复核；对关键单位模型假设保持未验证，未把未证实前提当作排序依据，无重大缺陷。 |
| B14#4 | S1 | followup | 追问 | agree | 首答未给出资源排序与次要方向处理，且以未验证前提支撑双线加码，需追问。 |
| B16#1 | S1 | followup | 追问 | agree | 分组依据与组间控制条件未交代，影响检验可执行性。 |
| B16#2 | S4 | followup | 追问 | agree | 主测所需指标边界与检验设计缺失，核心前提也未收束 |
| B16#3 | S2 | followup | 追问 | agree | 首答已明确指标边界与证据缺口，但退坡检验的可执行性不足，且将未验证的增长驱动作为确定结论，需澄清。 |
| B16#4 | S3 | followup | 追问 | agree | 首答把规模与市场热度直接推成生意定论，未交付指标边界、追问清单和可执行检验，核心结论缺证据。 |
| B17#1 | S4 | gray | 跳过 | gray | 首答已明确立场，依据、代价与落地安排完整，未见需追问的重大缺口 |
| B17#2 | S3 | followup | 追问 | agree | 折中方案的关键前提被个案处置支撑过度，需补足证据边界；其余交付基本完整。 |
| B17#3 | S1 | followup | 跳过 | miss | 产品表达各要素齐全：先表明立场，论据结合案例，回应折中的质疑，并给出可执行下一步；核心结论与关键前提均有案例和法规依据支撑，无重大缺陷需追问。 |
| B17#4 | S2 | followup | 追问 | agree | 首答立场与下一步清楚，但未说明下线代价、未回应主要反对意见，关键事实判断又以断言代替依据，需补一轮。 |
| B3#1 | S3 | skip | 跳过 | agree | 首答五要素完整，案例校验与反证条件齐全，未见需追问的重大缺陷。 |
| B3#2 | S2 | followup | 追问 | agree | 回答已覆盖对象场景、目标差距与边界，但核心排除「不在态度或习惯」与自认证据不足存在张力，需澄清。 |
| B3#3 | S4 | followup | 追问 | agree | 首答把信任当作已证结论，缺对象场景、目标差距、边界与可检验判据，且用事后结果反推当年定义，需优先补齐可观察的断点事实与判据。 |
| B3#4 | S1 | skip | 跳过 | agree | 首答覆盖问题定义五要素，并将根因判断限定为待验证假设，无重大缺口需追问 |
| B5#1 | S2 | followup | 追问 | agree | 核心画像与核心价值判断仍以整体或未分层证据支撑，关键前提需澄清。 |
| B5#2 | S1 | followup | 追问 | agree | 首答对存量与增量的使用差异说明不足，并把增速与占比直接落到新流入用户，需澄清关键依据。 |
| B5#3 | S3 | followup | 追问 | agree | 首答给出用户画像与泛化理由，但核心口径依据、具体场景链和优先选择依据均不足，需追问后才能评价用户理解。 |
| B7#1 | S2 | followup | 追问 | agree | 核心主因判断依赖未验证的“增长引擎切换/需求错位”前提，需补足证据并区分替代解释。 |
| B7#2 | S4 | gray | 追问 | gray | 首答已比较两种解释，但下滑结构拆分与主因证据仍是重大缺口，需追问。 |
| B7#3 | S3 | skip | 跳过 | agree | 首答已提出两种解释并分别说明证据支持与缺口，结论以条件式保留不确定性，并列出所需补证，未将未验证前提当作确定事实。 |
| B7#4 | S1 | followup | 追问 | agree | 首答用单一周期解释收束，未按要求比较解释并核对关键前提与证据边界，需补足后判断。 |


提示词证据：{"source":"file","version":"v10","contentHash":"c4d5b95ea31420b56e24b4a64a342f144fed860795caee6d2fe61cd08c189d9d","temperature":0.2,"runtimeContract":{"model":"deepseek-flash","thinking":"enabled","effort":"high","maxTokensField":"max_tokens","maxTokens":24576,"temperature":0.2,"temperatureApplicability":"ineffective_in_thinking","hash":"bab3aa89539d152e6891ffe8d92deece98536ed80f6c6dac080f58601c741146"},"outputContract":"gate-evidence-v2"}
标准材料状态（不作为模型输入）：{"questions":["B10","B12","B14","B16","B17","B3","B5","B7"],"summary":[{"questionId":"B10","id":"B10-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"8773834f419068ba3a99fc1c5bf9c3a0f920b3c0a2761589d406549444aaf42a","approvalId":null},{"questionId":"B12","id":"B12-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"2340515c8a16fc02cce58b04cc2aec4e9caa053e49cbfdb25a9511fe8edd1e1a","approvalId":null},{"questionId":"B14","id":"B14-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"ee7d178a19707d4ca383acd929df151ff0282b3f937ed2fa6b85b9d6da344239","approvalId":null},{"questionId":"B16","id":"B16-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"51aead2d7488216a2af532466fbb7802836d913864122538d88065486336e93c","approvalId":null},{"questionId":"B17","id":"B17-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"ef4c06c2aa69187464bc8a12f512c41fbb134aba71b2ab38c7ee716c0d577bcf","approvalId":null},{"questionId":"B3","id":"B3-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"ce03527053e74ec44eb22d4607be1640ae474097ff2dd7eff3e3e6e58be79314","approvalId":null},{"questionId":"B5","id":"B5-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"a4ef96ae645f2e1575b381c8687141ecbe25fe69ac6bb480b193ccaa8f8db00a","approvalId":null},{"questionId":"B7","id":"B7-reference-1","declaredStatus":"draft","approvalVerified":false,"contentHash":"32a73b422a9a60d08e09922480fbbd5f1e1c69cacee3ec725171d3fe3786011a","approvalId":null}],"structuralIssues":[],"readinessIssues":["B10 尚未批准或无有效标准答案","B12 尚未批准或无有效标准答案","B14 尚未批准或无有效标准答案","B16 尚未批准或无有效标准答案","B17 尚未批准或无有效标准答案","B3 尚未批准或无有效标准答案","B5 尚未批准或无有效标准答案","B7 尚未批准或无有效标准答案"],"ready":false,"modelInputUsed":false,"snapshotHash":"606f26bb5d2431cbee6c75a82adcb95d7963e7dcdbfcd5753c870d8171440cba"}
