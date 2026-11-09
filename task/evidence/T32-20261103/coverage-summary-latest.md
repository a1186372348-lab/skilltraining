# T32 复验：全量测试与逐文件覆盖

来源：validation/v2_core_20261103_f1133070f2c7-coverage-all.log；独立测试库及 schema。完整套件 140 个测试文件、1431 项通过；源码摘要 a66707aff42d3ae6444abde6b8b904b5c201afbf5f1b4f306723224dc18f6152。

| 代码文件 | 语句 | 分支 | 函数 | 行 |
|---|---:|---:|---:|---:|
| server/modules/baseline/result-visibility.ts | 100% | 100% | 100% | 100% |
| server/modules/auth/post-login.ts | 100% | 100% | 100% | 100% |
| server/modules/training/hub-view.ts | 100% | 100% | 100% | 100% |
| server/modules/history/repository.ts | 100% | 100% | 100% | 100% |
| server/modules/history/view.ts | 100% | 100% | 100% | 100% |
| server/modules/feedback/view.ts | 100% | 100% | 100% | 100% |
| server/modules/scoring/service.ts | 98.52% | 85.71% | 94.11% | 100% |
| server/modules/profile/ability-page.ts | 100% | 86.11% | 100% | 100% |
| server/modules/dashboard/service.ts | 100% | 100% | 100% | 100% |
| app/api/profile/ability/route.ts | 100% | 100% | 100% | 100% |
| app/api/dashboard/route.ts | 100% | 100% | 100% | 100% |
| app/api/plans/current/handler.ts | 92.85% | 85.71% | 100% | 92.3% |
| app/api/plans/review/handler.ts | 90.9% | 85.71% | 100% | 90% |
| app/api/plans/reject/handler.ts | 90.47% | 90.9% | 100% | 90% |
| app/profile/api.ts | 100% | 100% | 100% | 100% |
| app/profile/node-detail-modal.tsx | 100% | 90.9% | 100% | 100% |
| app/profile/profile-flow.tsx | 90.76% | 80% | 92.3% | 94.91% |
| app/training/view-model.ts | 100% | 100% | 100% | 100% |
| app/training/hub-flow.tsx | 95.65% | 86.66% | 100% | 100% |
| app/training/history/view-model.ts | 100% | 100% | 100% | 100% |
| app/training/history/[id]/detail-flow.tsx | 95.91% | 89.13% | 100% | 100% |
| app/training/feedback/[id]/feedback-flow.tsx | 95.95% | 82.92% | 100% | 100% |
| app/_dashboard/api.ts | 100% | 100% | 100% | 100% |
| app/_dashboard/home-dashboard.tsx | 100% | 88.88% | 100% | 100% |
| app/_shared/plan-api.ts | 100% | 100% | 100% | 100% |

四个纯类型声明文件由类型检查覆盖。25 个业务源文件的四项指标均不低于 80%。

全项目被测试导入代码：语句 95.16%，分支 89.39%，函数 97.98%，行 96.54%；不代表未导入文件的覆盖。
