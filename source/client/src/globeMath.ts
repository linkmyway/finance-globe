// Globe 纯数学件（2026-11-13 第 1 档拆分·档一：自 Globe.tsx 原样抽出，
// 零行为变化）：经纬→三维坐标、真实太阳位置（GMST/赤纬赤经）、
// 八大行星开普勒轨道根数与黄道经度。全部无状态纯函数/常量。

import * as THREE from "three";

export const R = 1;

export function latLonToVec3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * 真实太阳位置：由当前 UTC 时刻算太阳直射点（赤纬 + 直射经度）。
 * 标准近似：平均黄经/平近点角 → 黄道经度（含 1.915° 主摄动项）→ 赤纬、
 * 赤经；格林尼治恒星时（GMST）→ 直射经度 = 赤经 − GMST。
 * 精度约 0.1° 量级，足够让晨昏线与真实世界同步（已离线校验：
 * 2026-11-10 03:00 UTC 直射经度 +131°、11 月赤纬 ≈ −17°、春分赤纬 ≈ 0°）。
 * 直射点地理坐标（纬度=赤纬、经度=赤经−GMST）经 latLonToVec3 得到
 * 太阳在地球本地系中的方向（见组件内 sunLocalFor），每帧随球体姿态
 * 一同变换到世界系即太阳向——同向量即光照向。明暗因此钉在地理上：
 * 东京此刻是白天，东京所在面就是亮面，与球的展示自转无关。
 */
/** 格林尼治平恒星时 GMST（度，0–360）：地球真实姿态的锚 */
export function gmstDeg(date: Date): number {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const D = JD - 2451545.0;
  let h = (18.697374558 + 24.06570982441908 * D) % 24;
  if (h < 0) h += 24;
  return h * 15;
}

/** 太阳赤纬与赤经（度）：由日期算，精度约 0.1° 量级 */
export function solarDecRa(date: Date): { dec: number; ra: number } {
  const rad = Math.PI / 180;
  const JD = date.getTime() / 86400000 + 2440587.5;
  const D = JD - 2451545.0;
  const norm360 = (v: number) => ((v % 360) + 360) % 360;
  const L = norm360(280.46 + 0.9856474 * D);
  const g = norm360(357.528 + 0.9856003 * D) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * D) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / rad;
  const ra =
    Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / rad;
  return { dec, ra };
}


/**
 * 八大行星开普勒轨道根数（JPL《Approximate Positions of the Major
 * Planets》Table 1，Standish 1992；1800–2050 有效）：
 * [a(AU), e, I(°), L(°), ϖ(°), Ω(°)] 与每儒略世纪变化率同序。
 * 来源：https://ssd.jpl.nasa.gov/planets/approx_pos.html
 */
export const PLANET_ELEMENTS: Array<{
  id: string;
  name: string;
  color: string;
  /** 示意半径（世界单位，未缩放前）——大小为示意比例 */
  size: number;
  /**
   * 示意轨道半径（世界单位）——距离为压缩示意，顺序与相对间隔可信。
   * 2026-11-10 拉开内圈间距：地–金、地–火间距各 ≥0.43 世界单位，
   * 给绕地月球轨道留出「不穿邻星轨道、不碰邻星盘面」的安全余量
   * （月轨上限推导见 MOON_ORBIT_R 处注释）。
   */
  orbitR: number;
  el: [number, number, number, number, number, number];
  rates: [number, number, number, number, number, number];
}> = [
  { id: "mercury", name: "水星", color: "#b8ab9c", size: 0.045, orbitR: 1.15, el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593], rates: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
  { id: "venus", name: "金星", color: "#e8c07a", size: 0.072, orbitR: 1.75, el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], rates: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418] },
  { id: "earth", name: "地球", color: "#5fa8e8", size: 0.075, orbitR: 2.45, el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], rates: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0] },
  { id: "mars", name: "火星", color: "#d1603a", size: 0.058, orbitR: 3.25, el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891], rates: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  { id: "jupiter", name: "木星", color: "#d8b48f", size: 0.16, orbitR: 4.35, el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], rates: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
  { id: "saturn", name: "土星", color: "#e3cf9e", size: 0.14, orbitR: 5.55, el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], rates: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
  { id: "uranus", name: "天王星", color: "#9fd8d4", size: 0.115, orbitR: 6.55, el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503], rates: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
  { id: "neptune", name: "海王星", color: "#4a6fd8", size: 0.11, orbitR: 7.45, el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], rates: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
  // 星街彗星（第十一号天体，2026-11-12 晚升格，用户令：正名 + 可
  // 点选 + 发光特效）：虚构客串星，外观按星街すいせい主视觉原案调
  // 准；el 只借 a=35.3 AU 定公转角速度（与八行星同一星历基准公
  // 式），相位走专用历元式（见行星构建循环内的 SUISEI 口径），轨
  // 道带 6° 倾角（guestPosAt），不走 planetLongitude。
  { id: "suisei", name: "星街彗星", color: "#f0924f", size: 0.155, orbitR: 8.344, el: [35.3, 0, 6, 0, 0, 0], rates: [0, 0, 0, 0, 0, 0] },
];

/**
 * 行星当前黄道经度（弧度）：由轨道根数算平近点角 → 牛顿迭代解开普勒
 * 方程得真近点角 → 黄道经度。只取经度定方向，轨道半径用示意值——
 * 「相对位置可信、距离示意」正是页面的标注口径。
 */
export function planetLongitude(
  p: (typeof PLANET_ELEMENTS)[number],
  date: Date,
): number {
  const rad = Math.PI / 180;
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const a = p.el[0] + p.rates[0] * T;
  const e = p.el[1] + p.rates[1] * T;
  const L = p.el[3] + p.rates[3] * T;
  const pomega = p.el[4] + p.rates[4] * T;
  let M = (((L - pomega) % 360) + 360) % 360;
  if (M > 180) M -= 360;
  const Mr = M * rad;
  let E = Mr + e * Math.sin(Mr) * (1 + e * Math.cos(Mr));
  for (let i = 0; i < 5; i++) {
    E = E - (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  }
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const nu = Math.atan2(yp, xp);
  // 黄道经度 = 真近点角 + 近日点黄经 ϖ（轨道倾角只影响黄纬，示意场景略）
  return nu + pomega * rad;
}
