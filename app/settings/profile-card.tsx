"use client";

import { useCallback, useState } from "react";

import {
  ABILITY_DIMENSIONS,
  FAMILIAR_PRODUCT_SUGGESTIONS,
  INDUSTRY_OPTIONS,
  INTEREST_AREA_OPTIONS,
  POSITION_OPTIONS,
  YEARS_EXPERIENCE_OPTIONS,
} from "@/server/modules/profile/schema";

import { saveProfile } from "./api";
import type { ProfileData, ProfileFormState } from "./contract";
import {
  buildProfilePayload,
  isProfileSavable,
  profileSummaryRowsOf,
  toProfileFormState,
} from "./view-model";

/**
 * 初始画像卡（P6 /settings，T15）：查看 + 编辑。
 * - 字段结构改造自 app/onboarding/profile-form.tsx（复用同一套选项与 Chip 交互），
 *   但不写草稿、不跳转：预填 GET /api/profile 数据，保存走 PUT /api/profile（幂等）；
 * - 保存失败停留在编辑态并保留当前编辑内容，可直接重试；
 * - 无画像（新用户跳过问卷）时以空表单起步，编辑保存即完成首次提交。
 */

const CHIP_BASE =
  "rounded-full border px-4 py-1.5 text-sm transition-colors cursor-pointer";
const CHIP_ON = "border-[#2563EB] bg-[#EFF5FF] text-[#2563EB] font-medium";
const CHIP_OFF =
  "border-[#E9EDF4] bg-white text-[#475569] hover:border-[#D9E7FD]";

const INPUT_CLASS =
  "w-full rounded-xl border border-[#E9EDF4] bg-white px-4 py-2.5 text-sm text-[#0F172A] outline-none transition-colors focus:border-[#2563EB] placeholder:text-[#94A3B8]";

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

function EditField({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-bold">
        {label}
        {optional ? (
          <span className="ml-2 text-xs font-normal text-[#94A3B8]">可选</span>
        ) : (
          <span className="ml-1 text-[#2563EB]">*</span>
        )}
      </h3>
      {children}
    </section>
  );
}

export function ProfileCard({
  initialProfile,
}: {
  /** 进入页面时 GET /api/profile 的结果；null 表示尚未提交过画像 */
  initialProfile: ProfileData | null;
}) {
  /** 已保存的画像快照（查看态数据源；保存成功后更新） */
  const [saved, setSaved] = useState<ProfileFormState>(() =>
    toProfileFormState(initialProfile),
  );
  /** 编辑中的草稿状态；保存失败不回滚，避免丢失编辑内容 */
  const [draft, setDraft] = useState<ProfileFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const [customProduct, setCustomProduct] = useState("");

  const editing = draft !== null;

  const startEdit = useCallback(() => {
    setDraft(saved);
    setError(null);
    setSavedHint(false);
  }, [saved]);

  const cancelEdit = useCallback(() => {
    setDraft(null);
    setError(null);
    setCustomProduct("");
  }, []);

  const save = useCallback(async () => {
    if (!draft || !isProfileSavable(draft) || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveProfile(buildProfilePayload(draft));
      setSaved(draft);
      setDraft(null);
      setCustomProduct("");
      setSavedHint(true);
    } catch (err) {
      // 失败保留 draft 与全部编辑内容，用户可直接重试
      setError(
        err instanceof Error
          ? `${err.message}（已编辑内容不会丢失）`
          : "保存失败，请稍后重试（已编辑内容不会丢失）",
      );
    } finally {
      setSaving(false);
    }
  }, [draft, saving]);

  const updateDraft = useCallback(
    (patch: Partial<ProfileFormState>) =>
      setDraft((prev) => (prev ? { ...prev, ...patch } : prev)),
    [],
  );

  const toggleMulti = useCallback(
    (field: "familiarProducts" | "interestAreas" | "selfAssessment") =>
      (option: string) =>
        setDraft((prev) =>
          prev
            ? {
                ...prev,
                [field]: prev[field].includes(option)
                  ? prev[field].filter((item) => item !== option)
                  : [...prev[field], option],
              }
            : prev,
        ),
    [],
  );

  const addCustomProduct = useCallback(() => {
    const name = customProduct.trim();
    if (!name) return;
    setDraft((prev) =>
      prev && !prev.familiarProducts.includes(name)
        ? { ...prev, familiarProducts: [...prev.familiarProducts, name] }
        : prev,
    );
    setCustomProduct("");
  }, [customProduct]);

  return (
    <section className="rounded-2xl border border-[#E9EDF4] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E9EDF4] px-6 py-4">
        <div>
          <h2 className="text-[15px] font-bold">初始画像</h2>
          <p className="mt-0.5 text-xs text-[#94A3B8]">
            出题与追问会参考这里的画像信息
          </p>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={startEdit}
            className="rounded-xl border border-[#D9E7FD] bg-[#EFF5FF] px-4 py-2 text-sm font-medium text-[#2563EB] transition-colors hover:bg-[#E3EEFF]"
          >
            编辑
          </button>
        ) : null}
      </div>

      {!editing ? (
        <div className="px-6 py-5">
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {profileSummaryRowsOf(saved).map((row) => (
              <div key={row.label}>
                <dt className="text-xs text-[#94A3B8]">{row.label}</dt>
                <dd className="mt-1 text-sm text-[#1E293B]">{row.value}</dd>
              </div>
            ))}
          </dl>
          {savedHint ? (
            <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
              已保存，刷新后仍然生效
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-6 px-6 py-5">
          <EditField label="你的职位">
            <ChipGroup
              options={POSITION_OPTIONS}
              selected={draft.position ? [draft.position] : []}
              onToggle={(option) => updateDraft({ position: option })}
            />
          </EditField>

          <EditField label="产品相关经验年限">
            <ChipGroup
              options={YEARS_EXPERIENCE_OPTIONS}
              selected={draft.yearsExperience ? [draft.yearsExperience] : []}
              onToggle={(option) => updateDraft({ yearsExperience: option })}
            />
          </EditField>

          <EditField label="所在行业">
            <ChipGroup
              options={INDUSTRY_OPTIONS}
              selected={draft.industry ? [draft.industry] : []}
              onToggle={(option) => updateDraft({ industry: option })}
            />
          </EditField>

          <EditField label="熟悉的产品" optional>
            <ChipGroup
              options={FAMILIAR_PRODUCT_SUGGESTIONS}
              selected={draft.familiarProducts}
              onToggle={toggleMulti("familiarProducts")}
            />
            <div className="mt-3 flex gap-2">
              <input
                className={INPUT_CLASS}
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
          </EditField>

          <EditField label="感兴趣的领域" optional>
            <ChipGroup
              options={INTEREST_AREA_OPTIONS}
              selected={draft.interestAreas}
              onToggle={toggleMulti("interestAreas")}
            />
          </EditField>

          <EditField label="项目经验" optional>
            <textarea
              className={`${INPUT_CLASS} min-h-20 resize-y`}
              placeholder="一两句即可，例如：负责过一款工具类 App 的从 0 到 1"
              value={draft.projectExperience}
              onChange={(event) =>
                updateDraft({ projectExperience: event.target.value })
              }
              maxLength={300}
            />
          </EditField>

          <EditField label="学习目标" optional>
            <input
              className={INPUT_CLASS}
              placeholder="例如：提升方案设计与取舍能力"
              value={draft.learningGoal}
              onChange={(event) =>
                updateDraft({ learningGoal: event.target.value })
              }
              maxLength={200}
            />
          </EditField>

          <EditField label="你觉得自己相对更强的方向" optional>
            <ChipGroup
              options={ABILITY_DIMENSIONS}
              selected={draft.selfAssessment}
              onToggle={toggleMulti("selfAssessment")}
            />
          </EditField>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              className="rounded-xl border border-[#E9EDF4] bg-white px-5 py-2.5 text-sm font-medium text-[#475569] transition-colors hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!isProfileSavable(draft) || saving}
              className="rounded-xl bg-[#2563EB] px-6 py-2.5 text-sm font-bold text-white shadow-[0_4px_12px_rgba(37,99,235,0.25)] transition-colors hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:shadow-none"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
