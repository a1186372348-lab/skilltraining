/**
 * 侧边栏导航项：全站固定顺序（首页 → 产品训练 → 能力画像 → 我的）。
 * T25 / D27①：「今日训练」+「训练历史」合并为「产品训练」模块，导航 5 项变 4 项；
 * 路由依据 Prd.md 3.2 路由地图；当前页就地高亮，不随页面调整顺序。
 */

export interface NavItem {
  label: string;
  href: string;
  active: boolean;
}

const NAV_DEFINITIONS = [
  { label: "首页", href: "/" },
  { label: "产品训练", href: "/training" },
  { label: "能力画像", href: "/profile" },
  { label: "我的", href: "/settings" },
] as const;

export type NavLabel = (typeof NAV_DEFINITIONS)[number]["label"];

/** 按固定顺序生成导航数组，并按标签标记当前页（就地高亮，不挪位置）。 */
export function navItemsFor(activeLabel: NavLabel): NavItem[] {
  return NAV_DEFINITIONS.map((item) => ({
    ...item,
    active: item.label === activeLabel,
  }));
}
