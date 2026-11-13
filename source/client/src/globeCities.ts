// 金融中心/核心城市静态数据与通道强度/配色纯函数（2026-11-13 第 1 档
// 拆分·档一：自 Globe.tsx 原样抽出，零行为变化——数据一字未改，
// 函数无状态、无闭包，只依赖 nationColors 的地域色板）。

import * as THREE from "three";
import { regionColorFor } from "./nationColors";
import type { CenterInfo, CountryCode } from "./globeTypes";

export interface City {
  name: string;
  country: CountryCode;
  lat: number;
  lon: number;
  color: string;
  /** IANA 时区：标签下方的当地时间按它实时计算 */
  tz: string;
}

export const CITIES: City[] = [
  { name: "纽约", country: "US", lat: 40.71, lon: -74.0, color: "#38b6e3", tz: "America/New_York" },
  { name: "旧金山", country: "US", lat: 37.77, lon: -122.42, color: "#38b6e3", tz: "America/Los_Angeles" },
  { name: "上海", country: "CN", lat: 31.23, lon: 121.47, color: "#ff6b6b", tz: "Asia/Shanghai" },
  { name: "北京", country: "CN", lat: 39.9, lon: 116.4, color: "#ff6b6b", tz: "Asia/Shanghai" },
  { name: "东京", country: "JP", lat: 35.68, lon: 139.69, color: "#ff9ec4", tz: "Asia/Tokyo" },
  { name: "大阪", country: "JP", lat: 34.69, lon: 135.5, color: "#ff9ec4", tz: "Asia/Tokyo" },
];

export interface CenterDef extends CenterInfo {
  lat: number;
  lon: number;
  /** IANA 时区：标签下方的当地时间按它实时计算 */
  tz: string;
}

/**
 * 全球金融中心（按 GFCI 头部名单）：第一梯队 8 个常驻大标记，
 * 其余为第二梯队小标记。与六个核心城市重合的中心共用核心节点渲染，
 * 点击行为走国家小结（coreCountry），其余中心点开走中心小卡。
 */
export const CENTERS: CenterDef[] = [
  { id: "nyc", name: "纽约", en: "New York", country: "美国", tier: 1, lat: 40.71, lon: -74.01, coreCountry: "US", tz: "America/New_York" },
  { id: "ldn", name: "伦敦", en: "London", country: "英国", tier: 1, lat: 51.51, lon: -0.13, tz: "Europe/London" },
  { id: "hkg", name: "香港", en: "Hong Kong", country: "中国香港", tier: 1, lat: 22.32, lon: 114.17, tz: "Asia/Hong_Kong" },
  { id: "sin", name: "新加坡", en: "Singapore", country: "新加坡", tier: 1, lat: 1.35, lon: 103.82, tz: "Asia/Singapore" },
  { id: "sfo", name: "旧金山", en: "San Francisco", country: "美国", tier: 1, lat: 37.77, lon: -122.42, coreCountry: "US", tz: "America/Los_Angeles" },
  { id: "sha", name: "上海", en: "Shanghai", country: "中国", tier: 1, lat: 31.23, lon: 121.47, coreCountry: "CN", tz: "Asia/Shanghai" },
  { id: "lax", name: "洛杉矶", en: "Los Angeles", country: "美国", tier: 1, lat: 34.05, lon: -118.24, tz: "America/Los_Angeles" },
  { id: "tyo", name: "东京", en: "Tokyo", country: "日本", tier: 1, lat: 35.68, lon: 139.69, coreCountry: "JP", tz: "Asia/Tokyo" },
  { id: "chi", name: "芝加哥", en: "Chicago", country: "美国", tier: 2, lat: 41.88, lon: -87.63, tz: "America/Chicago" },
  { id: "sel", name: "首尔", en: "Seoul", country: "韩国", tier: 2, lat: 37.57, lon: 126.98, tz: "Asia/Seoul" },
  { id: "fra", name: "法兰克福", en: "Frankfurt", country: "德国", tier: 2, lat: 50.11, lon: 8.68, tz: "Europe/Berlin" },
  { id: "zrh", name: "苏黎世", en: "Zurich", country: "瑞士", tier: 2, lat: 47.38, lon: 8.54, tz: "Europe/Zurich" },
  { id: "par", name: "巴黎", en: "Paris", country: "法国", tier: 2, lat: 48.86, lon: 2.35, tz: "Europe/Paris" },
  { id: "ams", name: "阿姆斯特丹", en: "Amsterdam", country: "荷兰", tier: 2, lat: 52.37, lon: 4.9, tz: "Europe/Amsterdam" },
  { id: "tor", name: "多伦多", en: "Toronto", country: "加拿大", tier: 2, lat: 43.65, lon: -79.38, tz: "America/Toronto" },
  { id: "syd", name: "悉尼", en: "Sydney", country: "澳大利亚", tier: 2, lat: -33.87, lon: 151.21, tz: "Australia/Sydney" },
  { id: "dxb", name: "迪拜", en: "Dubai", country: "阿联酋", tier: 2, lat: 25.2, lon: 55.27, tz: "Asia/Dubai" },
  { id: "pek", name: "北京", en: "Beijing", country: "中国", tier: 2, lat: 39.9, lon: 116.4, coreCountry: "CN", tz: "Asia/Shanghai" },
  { id: "bos", name: "波士顿", en: "Boston", country: "美国", tier: 2, lat: 42.36, lon: -71.06, tz: "America/New_York" },
  { id: "was", name: "华盛顿", en: "Washington, D.C.", country: "美国", tier: 2, lat: 38.9, lon: -77.04, tz: "America/New_York" },
  { id: "edi", name: "爱丁堡", en: "Edinburgh", country: "英国", tier: 3, lat: 55.95, lon: -3.19, tz: "Europe/London" },
  { id: "dub", name: "都柏林", en: "Dublin", country: "爱尔兰", tier: 2, lat: 53.35, lon: -6.26, tz: "Europe/Dublin" },
  { id: "lux", name: "卢森堡", en: "Luxembourg", country: "卢森堡", tier: 3, lat: 49.61, lon: 6.13, tz: "Europe/Luxembourg" },
  { id: "bom", name: "孟买", en: "Mumbai", country: "印度", tier: 3, lat: 19.08, lon: 72.88, tz: "Asia/Kolkata" },
  { id: "kul", name: "吉隆坡", en: "Kuala Lumpur", country: "马来西亚", tier: 3, lat: 3.14, lon: 101.69, tz: "Asia/Kuala_Lumpur" },
  { id: "bkk", name: "曼谷", en: "Bangkok", country: "泰国", tier: 3, lat: 13.76, lon: 100.5, tz: "Asia/Bangkok" },
  { id: "osa", name: "大阪", en: "Osaka", country: "日本", tier: 2, lat: 34.69, lon: 135.5, coreCountry: "JP", tz: "Asia/Tokyo" },
];

// 配色表在 ./nationColors（与 App 的图例/小卡共用一处定义）：
// 连接线与中心节点现行口径是「地域定性色板」REGION_COLORS

/** 核心城市标签锚点偏移（度）：把地理上贴近的标签先天拉开（东京↔大阪等） */
export const LABEL_OFFSETS: Record<string, { dLat: number; dLon: number }> = {
  纽约: { dLat: 3.0, dLon: -2.0 },
  旧金山: { dLat: 3.2, dLon: -3.5 },
  上海: { dLat: 2.2, dLon: -3.2 },
  北京: { dLat: 3.6, dLon: -0.5 },
  东京: { dLat: 3.4, dLon: 3.0 },
  大阪: { dLat: -3.6, dLon: -3.0 },
};

/** 核心城市标签优先级（统一避让池里高者保留显示）：上海是第一梯队
 * 金融中心且处在东亚标签最密的区域，给最高优先级，不许被避让藏掉 */
export const LABEL_PRIORITY: Record<string, number> = {
  上海: 100,
  东京: 99,
  纽约: 95,
  北京: 90,
  旧金山: 86,
  大阪: 72,
};

/**
 * 无文字标签名单（2026-11-12，用户：亚洲太挤）：大阪、香港两城在
 * 球面上不挂任何文字标签——名称与名称下的当地时间行都不生成、
 * 不进避让池。只摘文字：两城的节点/标记、弧线端点照常，香港的
 * 恒生指数板（板专用锚点 hkg，与中心标签是两套系统）照常显示；
 * 其余城市标签行为不变。核心城市按城市名匹配，金融中心按 id
 * 匹配（大阪的中心条目带 coreCountry、本就共用核心城市标签，
 * 只需在核心侧摘一次）。
 */
export const NO_TEXT_LABEL_CITY_NAMES = new Set(["大阪"]);
export const NO_TEXT_LABEL_CENTER_IDS = new Set(["hkg"]);

/** 节点色：按城市所在地域取色（与连接线、粒子同一套地域色板） */
export function centerColor(c: CenterDef): string {
  return regionColorFor(c.country, c.coreCountry);
}

/**
 * 通道强度（0..1 连续值）由两端城市的金融梯队组合决定：梯队权重
 * 一/二/三 = 1 / 0.52 / 0.26，强度取两端权重的加权几何平均并向
 * 弱端倾斜（弱端 0.7 次幂、强端 0.3 次幂），再线性归一化——
 * 一线↔一线 = 1.00、一线↔二线 ≈ 0.43、一线↔三线 ≈ 0.06。
 * 不是强弱两档硬切，而是一条连续梯度：金融实力越强的城市，
 * 它的弧越粗、越亮、抬得越高、流得越急。强度只管「形」：
 * 线芯粗细与亮度、隆起弧度、粒子大小/密度/速度；「色」由两端
 * 城市的地域决定（见 arcRegionColors），两者正交。
 */
export function arcStrength(a: CenterDef, b: CenterDef): number {
  const w = (t: 1 | 2 | 3) => (t === 1 ? 1 : t === 2 ? 0.52 : 0.26);
  const wa = w(a.tier);
  const wb = w(b.tier);
  const s =
    Math.pow(Math.min(wa, wb), 0.7) * Math.pow(Math.max(wa, wb), 0.3);
  return THREE.MathUtils.clamp((s - 0.35) / 0.65, 0, 1);
}

/**
 * 通道配色按地域（定性色板，见 nationColors.ts 的 REGION_COLORS）：
 * 返回 [起点地域色, 终点地域色]，线身沿程在两色间渐变，粒子（含
 * 彗星拖尾）逐点按所在位置取同一渐变色——流到哪段就是哪片地域的
 * 色。同地域连线两端同色，自然成纯色。两端各向白轻提一档保辉光
 * 透亮感。
 */
export function arcRegionColors(
  a: CenterDef,
  b: CenterDef,
): [THREE.Color, THREE.Color] {
  const white = new THREE.Color("#ffffff");
  const colA = new THREE.Color(centerColor(a)).lerp(white, 0.1);
  const colB = new THREE.Color(centerColor(b)).lerp(white, 0.1);
  return [colA, colB];
}
