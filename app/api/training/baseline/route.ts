import { createBaselineGetHandler } from "./handler";

// T39：后台评分保活上限（Vercel Hobby 单请求最长 300s，覆盖评分真实延迟 35~49 秒）
export const maxDuration = 300;

export const GET = createBaselineGetHandler();
