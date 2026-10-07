"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ABILITY_DIMENSIONS,
  FAMILIAR_PRODUCT_SUGGESTIONS,
  INDUSTRY_OPTIONS,
  INTEREST_AREA_OPTIONS,
  POSITION_OPTIONS,
  YEARS_EXPERIENCE_OPTIONS,
} from "@/server/modules/profile/schema";

/**
 * 画像问卷表单（T04 / US-001）。
 * - 9 个契约字段，选择为主、必填仅 3 项（职位/年限/行业），3 分钟内可完成；
 * - 变更后防抖暂存草稿到服务端（刷新不丢）；
 * - 提交成功跳转 /baseline（能力基线测评，D19/BR-9：注册后首步，T17a 实现）；
 *   基线已完成的用户由 /baseline 侧自动放行到首页。
 */

interface FormState {
  position: string;
  yearsExperience: string;
  industry: string;
  projectExperience: string;
  familiarProducts: string[];
  interestAreas: string[];
  learningGoal: string;
  selfAssessment: string[];
}

const EMPTY_STATE: FormState = {
  position: "",
  yearsExperience: "",
  industry: "",
  projectExperience: "",
  familiarProducts: [],
  interestAreas: [],
  learningGoal: "",
  selfAssessment: [],
};

/** 草稿/提交前的载荷：丢弃未填字段，保持"未填"语义 */
function toPayload(state: FormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (state.position) payload.position = state.position;
  if (state.yearsExperience) payload.yearsExperience = state.yearsExperience;
  if (state.industry) payload.industry = state.industry;
  if (state.projectExperience.trim())
    payload.projectExperience = state.projectExperience;
  if (state.familiarProducts.length)
    payload.familiarProducts = state.familiarProducts;
  if (state.interestAreas.length) payload.interestAreas = state.interestAreas;
  if (state.learningGoal.trim()) payload.learningGoal = state.learningGoal;
  if (state.selfAssessment.length) payload.selfAssessment = state.selfAssessment;
  return payload;
}

function isValidForSubmit(state: FormState): boolean {
  return Boolean(state.position && state.yearsExperience && state.industry);
}

/** 把接口返回的草稿/画像归一化为表单状态 */
function toFormState(raw: Record<string, unknown>): FormState {
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

const CHIP_BASE =
  "rounded-full border px-4 py-1.5 text-sm transition-colors cursor-pointer";
const CHIP_ON = "border-[#2563EB] bg-[#EFF5FF] text-[#2563EB] font-medium";
const CHIP_OFF =
  "border-[#E9EDF4] bg-white text-[#475569] hover:border-[#D9E7FD]";

function ChipGroup({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (option: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onToggle(option)}
          className={`${CHIP_BASE} ${selected.includes(option) ? CHIP_ON : CHIP_OFF}`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#E9EDF4] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <h2 className="mb-4 text-[15px] font-bold">
        {label}
        {optional ? (
          <span className="ml-2 text-xs font-normal text-[#94A3B8]">
            可选，可跳过
          </span>
        ) : (
          <span className="ml-1 text-[#2563EB]">*</span>
        )}
      </h2>
      {children}
    </section>
  );
}

export function ProfileForm() {
  const router = useRouter();
  const [state, setState] = useState<FormState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [customProduct, setCustomProduct] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初始化：优先读草稿（刷新不丢），无草稿则回填已提交画像
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const draftRes = await fetch("/api/profile/draft");
        const draftJson = await draftRes.json();
        if (!cancelled && draftJson.success && draftJson.data) {
          setState(toFormState(draftJson.data));
          return;
        }
        const profileRes = await fetch("/api/profile");
        const profileJson = await profileRes.json();
        if (!cancelled && profileJson.success && profileJson.data) {
          setState(toFormState(profileJson.data));
        }
      } catch {
        // 草稿读取失败不阻塞填写
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 变更防抖暂存草稿
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/profile/draft", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toPayload(state)),
        });
        const json = await res.json();
        if (json.success) {
          setDraftSavedAt(
            new Date().toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          );
        }
      } catch {
        // 暂存失败静默重试于下次变更；不打扰填写
      }
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, loaded]);

  const toggleMulti = useCallback(
    (field: "familiarProducts" | "interestAreas" | "selfAssessment") =>
      (option: string) =>
        setState((prev) => ({
          ...prev,
          [field]: prev[field].includes(option)
            ? prev[field].filter((item) => item !== option)
            : [...prev[field], option],
        })),
    [],
  );

  const selectSingle = useCallback(
    (field: "position" | "yearsExperience" | "industry") => (option: string) =>
      setState((prev) => ({ ...prev, [field]: option })),
    [],
  );

  const addCustomProduct = useCallback(() => {
    const name = customProduct.trim();
    if (!name) return;
    setState((prev) =>
      prev.familiarProducts.includes(name)
        ? prev
        : { ...prev, familiarProducts: [...prev.familiarProducts, name] },
    );
    setCustomProduct("");
  }, [customProduct]);

  const submit = useCallback(async () => {
    if (!isValidForSubmit(state) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPayload(state)),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        router.push("/baseline");
        return;
      }
      setError(
        json?.error?.message ?? "提交失败，请稍后重试（已填内容不会丢失）",
      );
    } catch {
      setError("网络异常，提交失败，请重试（已填内容不会丢失）");
    } finally {
      setSubmitting(false);
    }
  }, [state, submitting, router]);

  const inputClass =
    "w-full rounded-xl border border-[#E9EDF4] bg-white px-4 py-2.5 text-sm text-[#0F172A] outline-none transition-colors focus:border-[#2563EB] placeholder:text-[#94A3B8]";

  return (
    <div className="flex flex-col gap-4">
      <Field label="你的职位">
        <ChipGroup
          options={POSITION_OPTIONS}
          selected={state.position ? [state.position] : []}
          onToggle={selectSingle("position")}
        />
      </Field>

      <Field label="产品相关经验年限">
        <ChipGroup
          options={YEARS_EXPERIENCE_OPTIONS}
          selected={state.yearsExperience ? [state.yearsExperience] : []}
          onToggle={selectSingle("yearsExperience")}
        />
      </Field>

      <Field label="所在行业">
        <ChipGroup
          options={INDUSTRY_OPTIONS}
          selected={state.industry ? [state.industry] : []}
          onToggle={selectSingle("industry")}
        />
      </Field>

      <Field label="熟悉的产品" optional>
        <ChipGroup
          options={FAMILIAR_PRODUCT_SUGGESTIONS}
          selected={state.familiarProducts}
          onToggle={toggleMulti("familiarProducts")}
        />
        <div className="mt-3 flex gap-2">
          <input
            className={inputClass}
            placeholder="不在列表里？输入后回车添加"
            value={customProduct}
            onChange={(event) => setCustomProduct(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomProduct();
              }
            }}
            maxLength={50}
          />
          <button
            type="button"
            onClick={addCustomProduct}
            className="shrink-0 rounded-xl border border-[#D9E7FD] bg-[#EFF5FF] px-4 text-sm font-medium text-[#2563EB]"
          >
            添加
          </button>
        </div>
        <p className="mt-2 text-xs text-[#94A3B8]">
          第一道题的案例会优先来自这里的产品。
        </p>
      </Field>

      <Field label="感兴趣的领域" optional>
        <ChipGroup
          options={INTEREST_AREA_OPTIONS}
          selected={state.interestAreas}
          onToggle={toggleMulti("interestAreas")}
        />
      </Field>

      <Field label="项目经验" optional>
        <textarea
          className={`${inputClass} min-h-20 resize-y`}
          placeholder="一两句即可，例如：负责过一款工具类 App 的从 0 到 1"
          value={state.projectExperience}
          onChange={(event) =>
            setState((prev) => ({
              ...prev,
              projectExperience: event.target.value,
            }))
          }
          maxLength={300}
        />
      </Field>

      <Field label="学习目标" optional>
        <input
          className={inputClass}
          placeholder="例如：提升方案设计与取舍能力"
          value={state.learningGoal}
          onChange={(event) =>
            setState((prev) => ({ ...prev, learningGoal: event.target.value }))
          }
          maxLength={200}
        />
      </Field>

      <Field label="你觉得自己相对更强的方向" optional>
        <ChipGroup
          options={ABILITY_DIMENSIONS}
          selected={state.selfAssessment}
          onToggle={toggleMulti("selfAssessment")}
        />
      </Field>

      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-[#94A3B8]">
          {draftSavedAt ? `草稿已暂存 · ${draftSavedAt}` : "填写内容会自动暂存"}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!isValidForSubmit(state) || submitting}
          className="rounded-xl bg-[#2563EB] px-8 py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none"
        >
          {submitting ? "提交中…" : "开始今日训练"}
        </button>
      </div>
    </div>
  );
}
