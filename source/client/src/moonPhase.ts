// 月相计算 —— 与 Globe 里 3D 月球严格同源（2026-11-13 月相卡）：
// · 月球位置：moonLongitude（Meeus《Astronomical Algorithms》低精度
//   公式主要摄动项）——Globe 的太阳系月球正是用它定起始黄经、再被
//   太阳点光源真实照亮成相；本模块是这条公式的唯一定义处，Globe
//   与主页月相卡都从这里 import，不许另抄一份口径打架。
// · 太阳位置：地球日心黄经走 JPL《Approximate Positions》Table 1
//   地球行根数 + 开普勒方程，与 Globe 的 planetLongitude（地球行）
//   同根数同算法；地心太阳黄经 = 日心黄经 + 180°。
// 相位角 = 月球地心黄经 − 太阳地心黄经（距角 elongation）：0° 朔、
// 90° 上弦、180° 望、270° 下弦；照亮比 = (1 − cos 距角) / 2。

const SYNODIC_DAYS = 29.530588853;

/** 月球地心黄道经度（弧度）：Meeus 低精度公式主要摄动项，精度约 0.3° */
export function moonLongitude(date: Date): number {
  const rad = Math.PI / 180;
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const lon =
    Lp +
    6.289 * Math.sin(Mp * rad) +
    1.274 * Math.sin((2 * D - Mp) * rad) +
    0.658 * Math.sin(2 * D * rad) +
    0.214 * Math.sin(2 * Mp * rad) -
    0.186 * Math.sin(M * rad) -
    0.114 * Math.sin(2 * F * rad);
  return lon * rad;
}

/** 地球日心黄道经度（弧度）：JPL Table 1 地球根数，与 Globe
 * planetLongitude 同式（a/e 只用于开普勒求解，经度 = ν + ϖ） */
function earthHeliocentricLongitude(date: Date): number {
  const rad = Math.PI / 180;
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const a = 1.00000261 + 0.00000562 * T;
  const e = 0.01671123 - 0.00004392 * T;
  const L = 100.46457166 + 35999.37244981 * T;
  const pomega = 102.93768193 + 0.32327364 * T;
  let M = (((L - pomega) % 360) + 360) % 360;
  if (M > 180) M -= 360;
  const Mr = M * rad;
  let E = Mr + e * Math.sin(Mr) * (1 + e * Math.cos(Mr));
  for (let i = 0; i < 5; i++) {
    E = E - (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  }
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return Math.atan2(yp, xp) + pomega * rad;
}

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** 日月距角（度，0–360）：月球地心黄经 − 太阳地心黄经 */
export function moonElongationDeg(date: Date): number {
  const moonDeg = moonLongitude(date) / (Math.PI / 180);
  const sunDeg =
    earthHeliocentricLongitude(date) / (Math.PI / 180) + 180;
  return norm360(moonDeg - sunDeg);
}

/** 八分相位名（通行中文口径，按距角每 45° 一档、档心对齐四相） */
function phaseNameFor(elongDeg: number): string {
  const names = [
    "朔",
    "娥眉月",
    "上弦",
    "盈凸月",
    "望",
    "亏凸月",
    "下弦",
    "残月",
  ] as const;
  const idx = Math.floor(norm360(elongDeg + 22.5) / 45) % 8;
  return names[idx]!;
}

export interface MoonPhaseInfo {
  /** 日月距角（度，0–360） */
  elongationDeg: number;
  /** 照亮比例（0–1） */
  illum: number;
  /** 月龄（天）：由距角按朔望月周期换算，与相位角同源自洽 */
  ageDays: number;
  /** 八分相位名 */
  name: string;
  /** 盈（距角 <180°，月渐满）/ 亏 */
  waxing: boolean;
  /** 下一次望（满月）的推算时刻（同一历表向前步进求距角过 180°） */
  nextFull: Date;
  /** 下一次朔（新月）的推算时刻（同一历表向前步进求距角过 360°） */
  nextNew: Date;
}

/** 距角向前步进求下一次穿越 targetDeg（展开口径） 的时刻，线性内插 */
function nextElongationCrossing(from: Date, targetDeg: number): Date {
  const stepMs = 0.2 * 86400000;
  let prevE = moonElongationDeg(from);
  let unwrapped = prevE;
  for (let i = 1; i <= 170; i++) {
    const t = new Date(from.getTime() + i * stepMs);
    const e = moonElongationDeg(t);
    let d = e - prevE;
    if (d < -180) d += 360;
    unwrapped += d;
    prevE = e;
    if (unwrapped >= targetDeg) {
      const prevU = unwrapped - d;
      const frac = d !== 0 ? (targetDeg - prevU) / d : 0;
      return new Date(from.getTime() + (i - 1 + frac) * stepMs);
    }
  }
  // 步进 34 天仍未穿越（历表异常）时的兜底：按平均朔望月估算
  return new Date(from.getTime() + SYNODIC_DAYS * 86400000);
}

/** 当前（或任意时刻）的月相：全部由真实时间经上述历表实时算出 */
export function moonPhaseAt(date: Date): MoonPhaseInfo {
  const elongationDeg = moonElongationDeg(date);
  const illum = (1 - Math.cos((elongationDeg * Math.PI) / 180)) / 2;
  const fullTarget = elongationDeg < 180 ? 180 : 540;
  return {
    elongationDeg,
    illum,
    ageDays: (elongationDeg / 360) * SYNODIC_DAYS,
    name: phaseNameFor(elongationDeg),
    waxing: elongationDeg < 180,
    nextFull: nextElongationCrossing(date, fullTarget),
    nextNew: nextElongationCrossing(date, 360),
  };
}
