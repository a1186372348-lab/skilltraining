# prompt 回归报告：scoring（T28 / D31，BR-V2-7）

- 版本：v3 ｜ 模式：live ｜ 模型：deepseek-flash ｜ 时间：2026-11-03T09:51:31.099Z
- 门槛结论：**未通过（存在未达标指标，退出码 1）**

## 门槛判定

| 指标 | 实际值 | 阈值 | 结果 |
|---|---|---|---|
| MAE（人审对齐平均绝对差） | 5.0 | ≤ 9.9 | ✅ 达标 |
| 排序反转组数 | 2 | ≤ 5 | ✅ 达标 |
| 分离度（各题 high-low 最小分差） | 42.7 | ≥ 20 | ✅ 达标 |
| 跑批失败样本数 | 1 | = 0 | ❌ 未达标 |

## 逐样本明细

| 样本 | blindId | 质量档 | 人审总分 | 机器主测分 | 差值 |
|---|---|---|---|---|---|
| B10#1 | S1 | high | 82 | 75 | -7.0 |
| B10#2 | S4 | medium | 65 | 70 | 5.0 |
| B10#3 | S3 | medium | 72 | 72 | 0.0 |
| B10#4 | S2 | low | 15 | 18 | 3.0 |
| B12#1 | S1 | high | 86 | 84 | -2.0 |
| B12#2 | S2 | medium | 69 | 76 | 7.0 |
| B12#3 | S4 | medium | 77 | 66 | -11.0 |
| B12#4 | S3 | low | 8 | 5 | -3.0 |
| B14#1 | S2 | — | 80 | — | — |
| B14#2 | S3 | high | 82 | 76 | -6.0 |
| B14#3 | S4 | medium | 77 | 72 | -5.0 |
| B14#4 | S1 | low | 12 | 15 | 3.0 |
| B16#1 | S1 | medium | 75 | 84 | 9.0 |
| B16#2 | S4 | medium | 58 | 66 | 8.0 |
| B16#3 | S2 | medium | 63 | 68 | 5.0 |
| B16#4 | S3 | low | 8 | 12 | 4.0 |
| B17#1 | S4 | high | 80 | 91 | 11.0 |
| B17#2 | S3 | medium | 78 | 85 | 7.0 |
| B17#3 | S1 | medium | 79 | 84 | 5.0 |
| B17#4 | S2 | low | 39 | 45 | 6.0 |
| B3#1 | S3 | high | 92 | 91 | -1.0 |
| B3#2 | S2 | medium | 78 | 78 | 0.0 |
| B3#3 | S4 | low | 12 | 10 | -2.0 |
| B3#4 | S1 | high | 93 | 88 | -5.0 |
| B5#1 | S2 | medium | 76 | 83 | 7.0 |
| B5#2 | S1 | medium | 70 | 70 | 0.0 |
| B5#3 | S3 | low | 26 | 35 | 9.0 |
| B7#1 | S2 | high | 80 | 75 | -5.0 |
| B7#2 | S4 | medium | 76 | 76 | 0.0 |
| B7#3 | S3 | high | 89 | 76 | -13.0 |
| B7#4 | S1 | low | 13 | 12 | -1.0 |

## 失败样本


### 补跑后仍失败（计入跑批失败样本数；可 --only 定向补跑后重跑回归）

- B14#1：AI 评分输出校验失败：输出不是合法 JSON


提示词证据：{"source":"database","version":"v3","contentHash":"7ac70f430e18e3886e08813551d1e70ee4afc465bccba4f563853465abc3611a","temperature":0.2,"runtimeContract":{"model":"deepseek-flash","thinking":"enabled","effort":"high","maxTokensField":"max_tokens","maxTokens":24576,"temperature":0.2,"temperatureApplicability":"ineffective_in_thinking","hash":"bab3aa89539d152e6891ffe8d92deece98536ed80f6c6dac080f58601c741146"}}
标准材料状态（不作为模型输入）：{"questions":["B10","B12","B14","B16","B17","B3","B5","B7"],"summary":[{"questionId":"B10","id":"B10-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"8773834f419068ba3a99fc1c5bf9c3a0f920b3c0a2761589d406549444aaf42a","approvalId":"B10-reference-1-20261103"},{"questionId":"B12","id":"B12-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"2340515c8a16fc02cce58b04cc2aec4e9caa053e49cbfdb25a9511fe8edd1e1a","approvalId":"B12-reference-1-20261103"},{"questionId":"B14","id":"B14-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"ee7d178a19707d4ca383acd929df151ff0282b3f937ed2fa6b85b9d6da344239","approvalId":"B14-reference-1-20261103"},{"questionId":"B16","id":"B16-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"51aead2d7488216a2af532466fbb7802836d913864122538d88065486336e93c","approvalId":"B16-reference-1-20261103"},{"questionId":"B17","id":"B17-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"ef4c06c2aa69187464bc8a12f512c41fbb134aba71b2ab38c7ee716c0d577bcf","approvalId":"B17-reference-1-20261103"},{"questionId":"B3","id":"B3-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"ce03527053e74ec44eb22d4607be1640ae474097ff2dd7eff3e3e6e58be79314","approvalId":"B3-reference-1-20261103"},{"questionId":"B5","id":"B5-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"a4ef96ae645f2e1575b381c8687141ecbe25fe69ac6bb480b193ccaa8f8db00a","approvalId":"B5-reference-1-20261103"},{"questionId":"B7","id":"B7-reference-1","declaredStatus":"approved","approvalVerified":true,"contentHash":"32a73b422a9a60d08e09922480fbbd5f1e1c69cacee3ec725171d3fe3786011a","approvalId":"B7-reference-1-20261103"}],"structuralIssues":[],"readinessIssues":[],"ready":true,"modelInputUsed":false,"snapshotHash":"904fcbc26d163d953fed871b91746f88ed2415a064033d1c95dc9aad46bf664c"}
