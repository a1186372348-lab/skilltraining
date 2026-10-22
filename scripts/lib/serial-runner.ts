// 串行跑批与遍内定向补跑编排（T28 / D31 切片 2）：prompt-regression.ts 的运行时内核。
// 抽出为库以便单测（fake runner 注入，零 AI 出网）：
// - runSerial：串行逐样本执行，缓存命中跳过，单样本失败重试 2 次后记录跳过；
// - runSerialWithSampleRetry：遍内定向补跑（选项 A）——单遍跑完后对失败样本做一次
//   定向补跑（等价于内部 --only，写入该遍缓存，不污染其他遍），经 mergeSampleRetry 归并；
//   sampleRetryEnabled=false（--no-sample-retry）时透传首遍结果。

import { mergeSampleRetry, type SampleRetryMerge } from "./regression-gate.ts";

/** 单样本失败后的额外重试次数（共最多 1 + 2 = 3 次调用） */
export const MAX_SAMPLE_RETRIES = 2;

/** JSONL 断点缓存形状（读写文件由调用方负责，编排层只碰 entries Map 与追加回调） */
export interface JsonlCache<T extends { label: string; attempts: number }> {
  path: string;
  entries: Map<string, T>;
}

export interface SerialRunConfig<TTask, TResult, TEntry extends { label: string; attempts: number }> {
  labelOf: (task: TTask) => string;
  run: (task: TTask) => Promise<{ result: TResult; entry: Omit<TEntry, "label" | "attempts"> }>;
  fromCache: (task: TTask, entry: TEntry) => TResult;
  cache?: JsonlCache<TEntry>;
  validate: (raw: unknown) => raw is TEntry;
  logLine: (task: TTask, result: TResult, attempts: number, cached: boolean) => string;
  /** 缓存追加写盘（调用方注入；缺省只更新内存 Map） */
  appendCacheEntry?: (cache: JsonlCache<TEntry>, entry: TEntry) => void;
  /** 重试退避等待（测试注入 no-op 避免真实等待） */
  sleep?: (ms: number) => Promise<void>;
}

export interface SerialRunBatch<TTask, TResult> {
  results: { task: TTask; result: TResult; attempts: number }[];
  failures: { task: TTask; error: string; attempts: number }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 串行跑全部样本：缓存命中直接跳过；单样本失败重试 2 次，仍失败则记录后跳过，不中断整批；成功即写缓存 */
export async function runSerial<TTask, TResult, TEntry extends { label: string; attempts: number }>(
  config: SerialRunConfig<TTask, TResult, TEntry>,
  tasks: TTask[],
): Promise<SerialRunBatch<TTask, TResult>> {
  const results: { task: TTask; result: TResult; attempts: number }[] = [];
  const failures: { task: TTask; error: string; attempts: number }[] = [];
  const sleepFn = config.sleep ?? sleep;
  let done = 0;
  for (const task of tasks) {
    done += 1;
    const label = config.labelOf(task);
    const cached = config.cache?.entries.get(label);
    if (cached) {
      const result = config.fromCache(task, cached);
      results.push({ task, result, attempts: cached.attempts });
      console.log(`[${done}/${tasks.length}] ${config.logLine(task, result, cached.attempts, true)}`);
      continue;
    }
    let attempts = 0;
    let lastError: string | null = null;
    while (attempts <= MAX_SAMPLE_RETRIES) {
      attempts += 1;
      try {
        const { result, entry } = await config.run(task);
        results.push({ task, result, attempts });
        if (config.cache) {
          const fullEntry = { ...entry, label, attempts } as unknown as TEntry;
          if (config.appendCacheEntry) config.appendCacheEntry(config.cache, fullEntry);
          else config.cache.entries.set(label, fullEntry);
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message.split("\n")[0] : String(error);
        if (attempts <= MAX_SAMPLE_RETRIES) await sleepFn(1000 * attempts);
      }
    }
    if (lastError !== null) {
      failures.push({ task, error: lastError, attempts });
      console.error(`[${done}/${tasks.length}] ${label} 失败（${attempts} 次尝试），已跳过：${lastError}`);
    } else {
      const last = results[results.length - 1];
      console.log(`[${done}/${tasks.length}] ${config.logLine(task, last.result, attempts, false)}`);
    }
  }
  return { results, failures };
}

/** 遍内定向补跑（选项 A）：首遍有失败样本且补跑开启时，对失败样本做一次定向补跑并归并 */
export async function runSerialWithSampleRetry<TTask, TResult, TEntry extends { label: string; attempts: number }>(
  config: SerialRunConfig<TTask, TResult, TEntry>,
  tasks: TTask[],
  sampleRetryEnabled: boolean,
): Promise<{
  merged: SampleRetryMerge<{ task: TTask; result: TResult; attempts: number }>;
}> {
  const first = await runSerial(config, tasks);
  const toItems = (batch: SerialRunBatch<TTask, TResult>) => ({
    results: batch.results.map((r) => ({ label: config.labelOf(r.task), value: r })),
    failures: batch.failures.map((f) => ({ label: config.labelOf(f.task), error: f.error })),
  });
  if (!sampleRetryEnabled || first.failures.length === 0) {
    return { merged: mergeSampleRetry(toItems(first), null) };
  }
  console.log(
    `\n遍内定向补跑：${first.failures.length} 份失败样本一次性补跑（写入该遍缓存，不污染其他遍）…`,
  );
  const retry = await runSerial(config, first.failures.map((f) => f.task));
  return { merged: mergeSampleRetry(toItems(first), toItems(retry)) };
}
