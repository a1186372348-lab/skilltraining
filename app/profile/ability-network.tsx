"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ForceGraphMethods } from "react-force-graph-3d";
import { Color, CylinderGeometry, Matrix4, Mesh, MeshLambertMaterial } from "three";
import SpriteText from "three-spritetext";

import type { AbilityDimensionView } from "./contract";
import {
  LEGEND_COLOR_MID,
  LEGEND_COLOR_STRONG,
  LEGEND_COLOR_UNOBSERVED,
  LEGEND_COLOR_WARN,
  buildNetworkGraph,
  type NetworkLink,
  type NetworkNode,
} from "./network-model";

/**
 * 能力画像 3D 力导向网络图（T16 / D20；T18 / D21 常态化标签 + 固定大小重设计 + 交付项 6 增强）。
 * - react-force-graph-3d 仅客户端渲染（WebGL）：dynamic import + ssr:false；
 * - 布局确定化（T18 交付项 5）：节点全部由 network-model 以 fx/fy/fz 钉在固定环形上，
 *   cooldownTicks=0 让引擎即刻沉寂，禁用节点拖动，无任何力导向随机结果；
 * - 相机固定：挂载后一次性 cameraPosition 到 FIXED_CAMERA_DISTANCE，不做 zoomToFit；
 *   只设一次，用户之后的旋转/缩放不被重置；
 * - 防闪烁：相机设置完成前图层 opacity 0，设置完成后淡入，用户不会看到错误大小；
 * - 拖动旋转/滚轮缩放为库自带交互；点击节点经 onSelectDimension 回调打开详情弹窗；
 * - 节点/连线数据全部来自 network-model 纯函数（锥形半径、归一化、灰态、色彩分档）；
 * - 节点标签常态化（three-spritetext 精灵）：维度名 + 分数常驻渲染，不依赖悬浮；
 * - 连线锥形渐变粗细（T18 交付项 6）：linkThreeObject 自定义锥体，高分端粗、低分端细，
 *   几何体方向与库默认圆柱一致，默认 linkPositionUpdate 即可完成摆放；
 * - 图例：右上角 HTML 覆盖层四档圆点，色值与 network-model 分档端点同源；
 * - 背景：深色基底 + 纯 CSS 径向光晕与极少量星点（NETWORK_BACKGROUND，无图片资源）；
 * - 库加载或渲染失败由 NetworkErrorBoundary 捕获并回调 onFallback（降级为列表视图）。
 */

/** 库默认 nodeRelSize=4：球体半径 = 4·∛nodeVal，用于把标签抬到节点上方 */
const NODE_REL_SIZE = 4;

/**
 * 固定相机距离（T18 固定大小重设计）推导：
 * - 该库内部 `new PerspectiveCamera()` 未覆盖 fov，即 three 默认 fov=50°（垂直方向），
 *   故距离 z 处可见高度 = 2·z·tan(25°) ≈ 0.9325·z；
 * - 内容纵向跨度（环半径 R=60）：顶部 = R + 节点半径(≈9.2) + 标签抬高(4.1) + 半标签高(3.4) ≈ 76.6，
 *   底部 = R + 节点半径 ≈ 69.2，合计 ≈ 146 世界单位；
 * - 目标：内容约占 520px 容器可见高度的 60%（要求 55~65%）→ z = 146 / (0.6·0.9325) ≈ 261；
 * - 取 250：可见高度 ≈ 233，内容占比 ≈ 62.6%，居中且标签完整可见。
 */
const FIXED_CAMERA_DISTANCE = 250;

/** 常态化节点标签：维度名 + 分数（未观测显示「未观测」），深色背景上用浅色文字 */
function nodeLabelSprite(node: NetworkNode): SpriteText {
  const text =
    node.observed && node.score !== null
      ? `${node.id}\n${Math.round(node.score)} 分`
      : `${node.id}\n未观测`;
  const sprite = new SpriteText(text);
  sprite.color = node.observed ? "#E2E8F0" : "rgba(148,163,184,0.75)";
  // 两行文字的总高约 2·textHeight，与节点尺寸（nodeVal 4~12 → 半径约 6~9）协调
  sprite.textHeight = 3.4;
  // 标签中心抬到节点上方：半径 + 半行高 + 间隙
  sprite.position.y = NODE_REL_SIZE * Math.cbrt(node.size) + sprite.textHeight * 1.2;
  return sprite;
}

/**
 * 图例四档（T18 交付项 6，右上角 HTML 覆盖层）：
 * 色值全部引自 network-model 导出的常量，与节点分档端点同源，避免两处硬编码漂移。
 */
const LEGEND_ITEMS = [
  { label: "已评估（较强）", color: LEGEND_COLOR_STRONG },
  { label: "已评估（一般）", color: LEGEND_COLOR_MID },
  { label: "已评估（较弱）", color: LEGEND_COLOR_WARN },
  { label: "未观测", color: LEGEND_COLOR_UNOBSERVED },
] as const;

/**
 * 背景层次（T18 交付项 6，纯 CSS 多层 background-image，无图片资源、无新依赖）：
 * 顶层到底层依次为——极少量星点（1~1.5px 径向渐变、低透明度）、中心偏上淡蓝光晕、
 * 原深色基底渐变（from-[#0D1626] to-[#0A111F]）；保持克制，不抢节点与标签的视觉优先级。
 */
const NETWORK_BACKGROUND = [
  "radial-gradient(1px 1px at 12% 22%, rgba(226,232,240,0.35) 50%, transparent 50%)",
  "radial-gradient(1px 1px at 28% 68%, rgba(226,232,240,0.22) 50%, transparent 50%)",
  "radial-gradient(1px 1px at 46% 13%, rgba(226,232,240,0.3) 50%, transparent 50%)",
  "radial-gradient(1px 1px at 63% 82%, rgba(226,232,240,0.2) 50%, transparent 50%)",
  "radial-gradient(1px 1px at 79% 31%, rgba(226,232,240,0.3) 50%, transparent 50%)",
  "radial-gradient(1px 1px at 90% 64%, rgba(226,232,240,0.22) 50%, transparent 50%)",
  "radial-gradient(1.5px 1.5px at 35% 44%, rgba(191,219,254,0.3) 50%, transparent 50%)",
  "radial-gradient(1.5px 1.5px at 71% 11%, rgba(191,219,254,0.26) 50%, transparent 50%)",
  "radial-gradient(ellipse 60% 50% at 50% 34%, rgba(59,130,246,0.13) 0%, rgba(59,130,246,0.05) 45%, transparent 72%)",
  "linear-gradient(to bottom, #0D1626, #0A111F)",
].join(", ");

/** network-model 产出的连线色固定为 rgba(r,g,b,a) 格式 */
const LINK_COLOR_PATTERN = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/;

/**
 * 锥形渐变连线（T18 交付项 6）：高分端粗、低分端细，两端半径由 network-model 产出。
 * 方向约定（three-forcegraph dist/three-forcegraph.mjs 源码核实）：
 * 库的默认位置更新对 Mesh 连线执行 position=source 端、scale.z=两端距离、lookAt(target)，
 * 即局部 +Z 轴指向 target；库默认圆柱几何体经 translate(0, 1/2, 0) + rotateX(π/2)
 * 预变换后 span z∈[0,1]、radiusTop 位于 +Z（target）端。此处沿用同一预变换
 *（radiusTop=targetRadius、radiusBottom=sourceRadius），默认 linkPositionUpdate
 * 即可正确摆放，无需自定义位置更新。
 */
function linkConeOf(link: NetworkLink): Mesh {
  const geometry = new CylinderGeometry(link.targetRadius, link.sourceRadius, 1, 8, 1, false);
  geometry.applyMatrix4(new Matrix4().makeTranslation(0, 0.5, 0));
  geometry.applyMatrix4(new Matrix4().makeRotationX(Math.PI / 2));
  const match = LINK_COLOR_PATTERN.exec(link.color);
  const material = new MeshLambertMaterial({
    // 已评估：半透明蓝（rgba(96,165,250,…)）；faint：更淡的灰——均由 network-model 给出
    color: match
      ? new Color(`rgb(${match[1]},${match[2]},${match[3]})`)
      : new Color("rgb(96,165,250)"),
    transparent: true,
    opacity: match ? Number(match[4]) : 0.4,
    depthWrite: false,
  });
  return new Mesh(geometry, material);
}

/** 3D 库按需加载：失败时 promise reject，由 ErrorBoundary 兜底 */
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[520px] items-center justify-center text-sm text-[#7C8BA8]">
      正在加载 3D 网络图…
    </div>
  ),
});

/** 3D 渲染失败边界：捕获后通知父级降级为列表视图（T16 失败与回滚） */
class NetworkErrorBoundary extends Component<
  { onFallback: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFallback();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** 容器尺寸跟随：react-force-graph-3d 需显式宽高 */
function useContainerSize(): { ref: React.RefObject<HTMLDivElement | null>; size: { width: number; height: number } } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 520 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width > 0) setSize((prev) => (prev.width === width ? prev : { ...prev, width }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

export function AbilityNetwork({
  dimensions,
  onSelectDimension,
  onFallback,
}: {
  dimensions: AbilityDimensionView[];
  /** 点击节点：打开该维度详情弹窗 */
  onSelectDimension: (dimension: string) => void;
  /** 3D 库加载/渲染失败：降级为列表视图 */
  onFallback: () => void;
}) {
  const { ref, size } = useContainerSize();
  // 节点/连线映射为纯函数产物（短板规则、归一化、灰态、固定环形钉住坐标），组件不重复实现
  const graphData = useMemo(() => buildNetworkGraph(dimensions), [dimensions]);
  // imperative 实例：仅用于挂载后一次性设置固定相机位（T18 固定大小重设计）
  const graphRef = useRef<ForceGraphMethods | undefined>(undefined);
  // 相机设置完成前图层透明，完成后淡入；任何时刻用户不会看到错误大小
  const [cameraReady, setCameraReady] = useState(false);

  useEffect(() => {
    if (cameraReady || size.width === 0) return undefined;
    let cancelled = false;
    let attempts = 0;
    const applyFixedCamera = () => {
      if (cancelled) return;
      const graph = graphRef.current;
      if (!graph) {
        // ref 随组件挂载提交，正常首帧即可用；rAF 轮询覆盖 dynamic import 的挂载时序
        attempts += 1;
        if (attempts > 120) {
          // 兜底：2 秒仍未就绪则直接显示，避免容器永久不可见（此时为库默认远景，由 ErrorBoundary 之外的极端情形）
          setCameraReady(true);
          return;
        }
        requestAnimationFrame(applyFixedCamera);
        return;
      }
      // 一次性固定相机位：时长 0 = 无动画；之后用户旋转/缩放不再被重置
      graph.cameraPosition({ x: 0, y: 0, z: FIXED_CAMERA_DISTANCE }, { x: 0, y: 0, z: 0 }, 0);
      setCameraReady(true);
    };
    applyFixedCamera();
    return () => {
      cancelled = true;
    };
  }, [cameraReady, size.width]);

  return (
    <div
      ref={ref}
      className="relative h-[520px] w-full overflow-hidden rounded-2xl"
      // 深色基底 + 克制的径向光晕与星点（纯 CSS 多层渐变，见 NETWORK_BACKGROUND）
      style={{ backgroundImage: NETWORK_BACKGROUND }}
    >
      <NetworkErrorBoundary onFallback={onFallback}>
        {size.width > 0 ? (
          // 防闪烁：相机未设置完成前透明（占位仍在，不引发布局跳动），完成后 150ms 淡入
          <div
            className="transition-opacity duration-150"
            style={{ opacity: cameraReady ? 1 : 0 }}
          >
            <ForceGraph3D
              ref={graphRef}
              width={size.width}
              height={size.height}
              graphData={graphData}
              nodeId="id"
              nodeVal="size"
              nodeColor="color"
              nodeLabel="label"
              nodeResolution={16}
              nodeThreeObject={(node) => nodeLabelSprite(node as NetworkNode)}
              nodeThreeObjectExtend={true}
              // 锥形渐变连线（T18 交付项 6）：自定义锥体后库不再读取 linkWidth/linkColor，
              // 摆放由默认 linkPositionUpdate 完成（方向约定见 linkConeOf 注释）
              linkThreeObject={(link) => linkConeOf(link as NetworkLink)}
              backgroundColor="rgba(0,0,0,0)"
              showNavInfo={false}
              onNodeClick={(node) => onSelectDimension(String(node.id))}
              // 引沉寂止（T18）：节点全部 fx/fy/fz 钉住，引擎 0 帧即停，布局永不漂移
              cooldownTicks={0}
              // 禁用节点拖动：消除"拖节点重燃引擎重置视角"一类副作用
              enableNodeDrag={false}
            />
          </div>
        ) : null}
      </NetworkErrorBoundary>
      {/* 图例（T18 交付项 6）：右上角四档圆点，pointer-events-none 不挡旋转/缩放/点击 */}
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-3 rounded-full bg-white/5 px-3.5 py-1.5 text-[11px] leading-none text-[#A8B4CC] backdrop-blur-sm">
        {LEGEND_ITEMS.map((item) => (
          <span key={item.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
      <p className="pointer-events-none absolute bottom-3 left-4 text-[11px] text-[#5B6B8C]">
        拖动旋转 · 滚轮缩放 · 点击节点查看评估记录
      </p>
    </div>
  );
}
