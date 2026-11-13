// 配色（两套并行）：
// 1) 国家配色 NATION_COLORS——节点/小卡等按国家取色的旧表，保留不动。
// 2) 地域定性色板 REGION_COLORS（2026-11-11 用户定版）——连接线（弧线/
//    粒子）与金融中心节点按「地域」取色：参考 D3 category / Okabe-Ito /
//    Tol bright 一类定性色系的骨架（色相环拉开、同明度带、深底高彩度
//    发光色），差异靠色相不靠明暗。三个身份锚点与国家配色同值不动：
//    中国＝暖红、日本＝樱粉、美国＝青蓝；其余按地域分带：韩国靛蓝、
//    香港珊瑚橙（与中国红拉开）、东南亚翡翠绿、南亚琥珀橙、中东金黄、
//    欧洲紫罗兰、北美（非美）天蓝、大洋洲薄荷青、拉美黄绿（当前 27
//    中心无拉美城市，先占位，圣保罗仅为指数板锚点、无弧线）。
// 独立成小模块：App（图例/小卡）与 Globe（线/粒子/节点）共用一处定义，
// 且不把懒加载的 Globe 本体提前拉进主包。

export type CoreCountryCode = "US" | "CN" | "JP";

export const CORE_COUNTRY_COLORS: Record<CoreCountryCode, string> = {
  US: "#38b6e3",
  CN: "#ff6b6b",
  JP: "#ff9ec4",
};

/** 键与 Globe 的 CENTERS.country 字段（中文国名）对应 */
export const NATION_COLORS: Record<string, string> = {
  美国: "#38b6e3",
  中国: "#ff6b6b",
  中国香港: "#ffa08a",
  日本: "#ff9ec4",
  英国: "#a78bfa",
  德国: "#f2c14e",
  新加坡: "#ff9f43",
  瑞士: "#8fd8b6",
  法国: "#8b93f0",
  加拿大: "#f28ba4",
  澳大利亚: "#2fd4c4",
  阿联酋: "#e3c07f",
  韩国: "#a5d8f5",
  爱尔兰: "#5fc98d",
  荷兰: "#ffb37e",
  卢森堡: "#c9ced6",
  印度: "#ffc46b",
  马来西亚: "#c4d94e",
  泰国: "#7ed957",
};

/** 按国家取色：核心三国走 CountryCode，其余按中文国名查表 */
export function nationColorFor(
  countryName: string,
  coreCountry?: CoreCountryCode,
): string {
  if (coreCountry) return CORE_COUNTRY_COLORS[coreCountry];
  return NATION_COLORS[countryName] ?? "#8fd0ee";
}

// —— 地域定性色板（弧线/粒子/中心节点/图例的现行口径） ——

export type RegionCode =
  | "cn"
  | "hk"
  | "jp"
  | "kr"
  | "sea"
  | "sa"
  | "me"
  | "eu"
  | "us"
  | "na"
  | "oc"
  | "latam";

export const REGION_COLORS: Record<
  RegionCode,
  { label: string; color: string }
> = {
  cn: { label: "中国", color: "#ff6b6b" }, // 暖红（锚点，与国别色同值）
  hk: { label: "香港", color: "#ff7a4d" }, // 珊瑚橙（与中国红拉开）
  jp: { label: "日本", color: "#ff9ec4" }, // 樱粉（锚点）
  kr: { label: "韩国", color: "#5f83ff" }, // 靛蓝
  sea: { label: "东南亚", color: "#2ed489" }, // 翡翠绿
  sa: { label: "南亚", color: "#ffa01f" }, // 琥珀橙
  me: { label: "中东", color: "#ffd23f" }, // 金黄
  eu: { label: "欧洲", color: "#a78bfa" }, // 紫罗兰
  us: { label: "美国", color: "#38b6e3" }, // 青蓝（锚点）
  na: { label: "北美（加拿大）", color: "#82c4ff" }, // 天蓝
  oc: { label: "大洋洲", color: "#3fe3c8" }, // 薄荷青
  latam: { label: "拉美", color: "#b5e048" }, // 黄绿（暂无中心，占位）
};

/** 中文国名 → 地域（键与 CENTERS.country 对应） */
export const REGION_BY_COUNTRY: Record<string, RegionCode> = {
  美国: "us",
  中国: "cn",
  中国香港: "hk",
  日本: "jp",
  韩国: "kr",
  新加坡: "sea",
  马来西亚: "sea",
  泰国: "sea",
  印度: "sa",
  阿联酋: "me",
  英国: "eu",
  德国: "eu",
  瑞士: "eu",
  法国: "eu",
  荷兰: "eu",
  爱尔兰: "eu",
  卢森堡: "eu",
  加拿大: "na",
  澳大利亚: "oc",
};

/** 按地域取色：核心三国（coreCountry）直接落锚点地域，其余按国名查表 */
export function regionColorFor(
  countryName: string,
  coreCountry?: CoreCountryCode,
): string {
  if (coreCountry === "US") return REGION_COLORS.us.color;
  if (coreCountry === "CN") return REGION_COLORS.cn.color;
  if (coreCountry === "JP") return REGION_COLORS.jp.color;
  const region = REGION_BY_COUNTRY[countryName];
  return region ? REGION_COLORS[region].color : "#8fd0ee";
}

/** 图例展示顺序（按色相环排：暖→冷→粉）；拉美暂无中心不在图例内 */
export const REGION_LEGEND: Array<{
  code: RegionCode;
  label: string;
  color: string;
}> = (["cn", "hk", "sa", "me", "sea", "oc", "us", "na", "kr", "eu", "jp"] as RegionCode[]).map(
  (code) => ({ code, label: REGION_COLORS[code].label, color: REGION_COLORS[code].color }),
);
