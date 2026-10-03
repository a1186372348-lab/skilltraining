/**
 * 脚手架冒烟示例：仅用于验证 vitest 管线真实可用（T01 验收项）。
 * 不承载业务逻辑；后续任务落地真实模块（出题/训练/评分/画像/内容）时可替换本文件。
 */

/** 能力画像一级维度数量（Prd.md 1.3：8 个一级维度）。 */
export const ABILITY_DIMENSION_COUNT = 8;

/** 每题提示树固定层数（Prd.md D5：每题固定 5 层渐进提示）。 */
export const HINT_TREE_LAYERS = 5;

/** 判断提示层级是否在合法范围（1~5 层，逐级请求，BR-3）。 */
export function isValidHintLayer(layer: number): boolean {
  return Number.isInteger(layer) && layer >= 1 && layer <= HINT_TREE_LAYERS;
}
