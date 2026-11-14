/**
 * —— 银河系模式数据（2026-11-14 立项，用户：「在太阳系之外再做一个
 * 银河系 / 银河系里就可以直接标出太阳系里面星星的绝对位置」）——
 *
 * 旋臂几何唯一出处：Xu et al. 2023, ApJ 947:54《What Does the Milky
 * Way Look Like?》（紫金山天文台徐烨团队多旋臂模型；The Innovation
 * 同期发表中文版）。拟合式为其式 (2) 对数螺旋：
 *   ln(R/Rref) = −(β − βref)·tanψ
 * β = 银心方位角，0 指太阳方向、沿银河自转方向递增（自北银极俯视
 * 为顺时针）；太阳置于 (0, R0)、银心 (0, 0)（论文图 3/5 同款坐标）。
 * 六臂参数 = 论文 Table 2 的脉泽拟合行（N / Rref / βref / ψ / 臂宽）。
 * 半人马臂论文未给拟合参数：正文以切点 l≈311.5° 推断、图 5 画虚
 * 线——此处按论文自述的两条约束复现：螺距取矩尺臂拟合 ψ=15.0°
 * （论文：矩尺臂自分半人马臂分叉），振幅由「视线在 l=311.5° 与臂
 * 相切」数值解出（切点 β=−56.5°、R=6.32 kpc，R(β=0)=4.85 kpc），
 * 渲染作推断臂（稀疏暗点）。矩尺臂向外延伸段（β<0，论文以恒定螺
 * 距延伸过切点 305.5°）与船底臂第四象限段（切点 283.5° 推断）同
 * 作推断段渲染。参数表与出处全文见 DATA-PLAN「银河系模式」节。
 */

/** 太阳到银心的距离（kpc）：论文图 3 采用值（Reid et al. 2019） */
export const GAL_R0_KPC = 8.15;
/** 太阳在银盘面之上的高度（pc）：约 20 pc（通行值 15–25 pc，取整标「约」） */
export const GAL_SUN_Z_PC = 20;
/** 太阳绕银心公转周期（年）：约 2.3 亿年 */
export const GAL_SUN_ORBIT_YEARS = 2.3e8;
/** 中央棒半长（kpc）：论文 §4.3 引 Hilmi et al. 2020 的棒半径 ≈3.1 kpc */
export const GAL_BAR_HALF_KPC = 3.1;
/**
 * 棒的方位角（度，自太阳方向量起）：图 3 的 Hilmi 椭圆呈约 25–30°
 * 倾角，此处取 27°——展示量、非 Xu 拟合参数（DATA-PLAN 有注）。
 */
export const GAL_BAR_ANGLE_DEG = 27;

export interface GalaxyArm {
  /** 中文名（与论文图例/新华社图同名） */
  name: string;
  en: string;
  /** 对数螺旋参数（论文 Table 2 脉泽拟合；半人马为切点解算，见文件头） */
  rRef: number;
  betaRefDeg: number;
  psiDeg: number;
  /** 拟合段 β 范围（度，论文 Table 2 的 β Range） */
  betaMinDeg: number;
  betaMaxDeg: number;
  /** 臂宽（kpc，论文 Table 2 的 Width_l；半人马无发表值，借矩尺臂宽作散布尺度） */
  widthKpc: number;
  /** 论文推断延伸段的 β 下限（度）：有值时 [extMin, betaMin) 作推断段渲染 */
  extMinDeg?: number;
  /** 整臂为推断臂（半人马）：全程稀疏暗点 */
  inferred?: boolean;
  /** 臂名标签锚定的 β（度，取拟合段中段） */
  labelBetaDeg: number;
}

export const GALAXY_ARMS: GalaxyArm[] = [
  {
    name: "矩尺臂",
    en: "Norma",
    rRef: 4.96,
    betaRefDeg: 13.07,
    psiDeg: 15.0,
    betaMinDeg: 0,
    betaMaxDeg: 120,
    widthKpc: 0.36,
    extMinDeg: -62,
    labelBetaDeg: 52,
  },
  {
    name: "半人马臂",
    en: "Centaurus",
    // 切点解算值（非 Table 2 拟合）：ψ 借矩尺臂 15.0°、振幅由
    // l=311.5° 相切条件解出 R(β=0)=4.85 kpc；切点 β=−56.5°
    rRef: 4.85,
    betaRefDeg: 0,
    psiDeg: 15.0,
    betaMinDeg: -125,
    betaMaxDeg: -2,
    widthKpc: 0.36,
    inferred: true,
    labelBetaDeg: -78,
  },
  {
    name: "人马臂",
    en: "Sagittarius",
    rRef: 6.02,
    betaRefDeg: 119.11,
    psiDeg: 1.3,
    betaMinDeg: 26,
    betaMaxDeg: 150,
    widthKpc: 0.47,
    labelBetaDeg: 84,
  },
  {
    name: "船底臂",
    en: "Carina",
    rRef: 6.35,
    betaRefDeg: 9.93,
    psiDeg: 21.4,
    betaMinDeg: -5,
    betaMaxDeg: 20,
    widthKpc: 0.29,
    extMinDeg: -52,
    labelBetaDeg: 6,
  },
  {
    name: "本地臂",
    en: "Local",
    rRef: 8.29,
    betaRefDeg: 8.95,
    psiDeg: 11.3,
    betaMinDeg: -10,
    betaMaxDeg: 40,
    widthKpc: 0.3,
    labelBetaDeg: 16,
  },
  {
    name: "英仙臂",
    en: "Perseus",
    rRef: 9.5,
    betaRefDeg: 18.78,
    psiDeg: 11.0,
    betaMinDeg: -10,
    betaMaxDeg: 160,
    widthKpc: 0.41,
    labelBetaDeg: 58,
  },
  {
    name: "外臂",
    en: "Outer",
    rRef: 12.05,
    betaRefDeg: 17.9,
    psiDeg: 3.6,
    betaMinDeg: -25,
    betaMaxDeg: 70,
    widthKpc: 0.96,
    labelBetaDeg: 26,
  },
];

const D2R = Math.PI / 180;

/** 臂中心线在方位角 β（度）处的银心半径（kpc）——论文式 (2) */
export function armRadiusAt(arm: GalaxyArm, betaDeg: number): number {
  return (
    arm.rRef *
    Math.exp(
      -(betaDeg - arm.betaRefDeg) * D2R * Math.tan(arm.psiDeg * D2R),
    )
  );
}

/** 臂中心线的银面坐标（kpc）：X = R·sinβ、Y = R·cosβ（太阳在 +Y 轴上） */
export function armPlanPoint(
  arm: GalaxyArm,
  betaDeg: number,
): { x: number; y: number; r: number } {
  const r = armRadiusAt(arm, betaDeg);
  return { x: r * Math.sin(betaDeg * D2R), y: r * Math.cos(betaDeg * D2R), r };
}

/**
 * —— 太阳邻域八星（与太阳系模式背景八星同一份名单/同一套星色）——
 * 赤经/赤纬为 J2000 历元坐标（SIMBAD 通行值）；距离为视差距离，
 * 逐颗出处见 DATA-PLAN 八星表。银经银纬由标准 J2000 赤道→银河
 * 旋转矩阵（Hipparcos 卷 1 §1.5）正经换算，不查表抄数；离线验算
 * 与通行值逐颗对上（天狼星 l=227.23°/b=−8.89°、织女星 67.45°/
 * +19.24°、参宿四 199.79°/−8.96°、天津四 84.28°/+2.00°、角宿一
 * 316.11°/+50.84°，见 DATA-PLAN）。
 */
export interface GalaxyStar {
  name: string;
  en: string;
  /** J2000 赤经（时）/ 赤纬（度） */
  raH: number;
  decDeg: number;
  /** 距离（pc） */
  distPc: number;
  /** 距离展示文案（卡上/图例用） */
  distLabel: string;
  /** 星色：与太阳系模式 addNamedStar 登记色逐颗一致 */
  color: string;
  /** 换算所得银经/银纬（度） */
  lDeg: number;
  bDeg: number;
  /** 银面坐标（kpc，太阳为原点平移后：银心在 (0,0)、太阳在 (0,R0)）+ 盘面高度 z */
  planX: number;
  planY: number;
  planZ: number;
  /** 天鹅座 β 的蓝伴星：无名签、贴金点旁一线（与太阳系模式同纪律） */
  companion?: boolean;
}

const EQ2GAL: number[][] = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.4448296300, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];

/** J2000 赤道坐标 → 银经/银纬（度）：标准旋转矩阵（Hipparcos） */
export function equatorialToGalactic(
  raH: number,
  decDeg: number,
): { lDeg: number; bDeg: number } {
  const a = raH * 15 * D2R;
  const d = decDeg * D2R;
  const v = [
    Math.cos(d) * Math.cos(a),
    Math.cos(d) * Math.sin(a),
    Math.sin(d),
  ];
  const g = EQ2GAL.map(
    (row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!,
  );
  const bDeg =
    Math.asin(Math.max(-1, Math.min(1, g[2]!))) / D2R;
  let lDeg = Math.atan2(g[1]!, g[0]!) / D2R;
  if (lDeg < 0) lDeg += 360;
  return { lDeg, bDeg };
}

function makeStar(
  name: string,
  en: string,
  raH: number,
  decDeg: number,
  distPc: number,
  distLabel: string,
  color: string,
): GalaxyStar {
  const { lDeg, bDeg } = equatorialToGalactic(raH, decDeg);
  const dKpc = distPc / 1000;
  const cb = Math.cos(bDeg * D2R);
  return {
    name,
    en,
    raH,
    decDeg,
    distPc,
    distLabel,
    color,
    lDeg,
    bDeg,
    // 银面投影：自太阳沿银经方向量——朝银心为 −Y、朝自转方向为 +X。
    // planZ 含太阳自身盘面高度（+20 pc）：(l, b, d) 是以太阳为原点
    // 的日心量，星的银心系 z = 太阳 z + d·sinb——2026-11-14 位置审
    // 计纠正（旧式漏加太阳高度：渲染偏移的 z 分量恒比真实日心偏
    // 移多 −20 pc，全览/邻域尺度下仅 0.01 世界单位不可见，但在约
    // 15 pc 级的小尺度取景里会把八星整体压出画面；纠正后渲染偏
    // 移与真实日心三维偏移逐分量恒等、模长 = 视差距离）
    planX: dKpc * cb * Math.sin(lDeg * D2R),
    planY: GAL_R0_KPC - dKpc * cb * Math.cos(lDeg * D2R),
    planZ: GAL_SUN_Z_PC / 1000 + dKpc * Math.sin(bDeg * D2R),
  };
}

const albireo = makeStar(
  "天鹅座β星",
  "Albireo",
  19 + 30 / 60 + 43.28 / 3600,
  27 + 57 / 60 + 34.8 / 3600,
  133,
  "约 430 光年",
  "#ffab1a",
);
const denebPlan = { x: 0.798, y: 8.07 };
/** 蓝伴星：沿天津四→金点方向错开 6 pc（真实角距在图上不可见，
 * 与太阳系模式同为示意间距——DATA-PLAN 有注），无名签 */
const albireoCompanion: GalaxyStar = (() => {
  const dx = albireo.planX - denebPlan.x;
  const dy = albireo.planY - denebPlan.y;
  const dl = Math.hypot(dx, dy) || 1;
  return {
    ...albireo,
    name: "",
    en: "Albireo B",
    color: "#4a86ff",
    planX: albireo.planX + (dx / dl) * 0.006,
    planY: albireo.planY + (dy / dl) * 0.006,
    companion: true,
  };
})();

export const GALAXY_STARS: GalaxyStar[] = [
  makeStar(
    "参宿四",
    "Betelgeuse",
    5 + 55 / 60 + 10.31 / 3600,
    7 + 24 / 60 + 25.4 / 3600,
    168,
    "约 550 光年",
    "#ff7d2a",
  ),
  makeStar(
    "天狼星",
    "Sirius",
    6 + 45 / 60 + 8.92 / 3600,
    -(16 + 42 / 60 + 58 / 3600),
    2.64,
    "8.6 光年",
    "#a9c9ff",
  ),
  makeStar(
    "南河三",
    "Procyon",
    7 + 39 / 60 + 18.12 / 3600,
    5 + 13 / 60 + 29.9 / 3600,
    3.51,
    "11.5 光年",
    "#ffe396",
  ),
  makeStar(
    "天津四",
    "Deneb",
    20 + 41 / 60 + 25.92 / 3600,
    45 + 16 / 60 + 49.2 / 3600,
    802,
    "约 2,600 光年",
    "#eef4ff",
  ),
  makeStar(
    "织女星",
    "Vega",
    18 + 36 / 60 + 56.34 / 3600,
    38 + 47 / 60 + 1.3 / 3600,
    7.68,
    "25 光年",
    "#a3c2ff",
  ),
  makeStar(
    "牛郎星",
    "Altair",
    19 + 50 / 60 + 46.99 / 3600,
    8 + 52 / 60 + 5.9 / 3600,
    5.13,
    "16.7 光年",
    "#ffffff",
  ),
  albireo,
  albireoCompanion,
  makeStar(
    "角宿一",
    "Spica",
    13 + 25 / 60 + 11.58 / 3600,
    -(11 + 9 / 60 + 40.8 / 3600),
    76.6,
    "约 250 光年",
    "#9db4ff",
  ),
];
