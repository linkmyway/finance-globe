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

/**
 * 八分相位名（2026-11-14 起全套改日本传统月名，用户点名：峨眉月
 * 那档用日本版「三日月」）：按距角每 45° 一档、档心对齐四相。
 * 对照（距角 → 月齢目安 → 名称）：337.5–22.5° → 27.7–1.8 日 → 新月；
 * 22.5–67.5° → 1.8–5.5 日 → 三日月；67.5–112.5° → 5.5–9.2 日 →
 * 上弦の月；112.5–157.5° → 9.2–12.9 日 → 十三夜月；157.5–202.5° →
 * 12.9–16.6 日 → 満月；202.5–247.5° → 16.6–20.3 日 → 居待月；
 * 247.5–292.5° → 20.3–24.0 日 → 下弦の月；292.5–337.5° →
 * 24.0–27.7 日 → 有明の月。
 */
function phaseNameFor(elongDeg: number): string {
  const names = [
    "新月",
    "三日月",
    "上弦の月",
    "十三夜月",
    "満月",
    "居待月",
    "下弦の月",
    "有明の月",
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

// ------------------------------------------------------------------
// 潮汐（2026-11-14 新增）：潮名不接外部数据，与月相同一套月齢星历
// 算出。日本通行的月齢潮名对照（历书/潮汐表通行的整数月齢表）：
//   月齢 0–2・14–17・29 → 大潮；6–8・21–23 → 小潮；9・24 → 長潮；
//   10・25 → 若潮；其余（3–5・11–13・18–20・26–28）→ 中潮。
// 自检（2026-11 本朔望月，离线验算）：朔 11/9 落大潮区（11/9–12）、
// 上弦 11/17 落小潮区（11/16–19）、望 11/25 落大潮区（11/24–27）、
// 下弦 12/1 落小潮区（12/1–2）——四相位全被对应潮名区间罩住。
// ------------------------------------------------------------------

export type TideName = "大潮" | "中潮" | "小潮" | "長潮" | "若潮";

/** 月齢（天）→ 潮名：按整数月齢查上表 */
export function tideNameForAge(ageDays: number): TideName {
  const day = Math.floor(
    ((ageDays % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS,
  );
  if (day === 9 || day === 24) return "長潮";
  if (day === 10 || day === 25) return "若潮";
  if ((day >= 6 && day <= 8) || (day >= 21 && day <= 23)) return "小潮";
  if (day <= 2 || (day >= 14 && day <= 17) || day === 29) return "大潮";
  return "中潮";
}

/** 某时刻所属 JST 日历日的正午（UTC 03:00 = JST 12:00） */
function jstNoonOf(date: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 3, 0, 0));
}

export interface TideInfo {
  /** 今日潮名（按当前月齢） */
  today: TideName;
  /** 大潮起始日（今日已在大潮内则为本轮起始日，否则为下轮起始日） */
  nextSpringStart: Date;
  /** 小潮起始日（口径同上） */
  nextNeapStart: Date;
}

/** 潮名起始日：以 JST 日历日正午的月齢潮名为准逐日判定 */
function tideStartDay(from: Date, want: TideName): Date {
  const noon = jstNoonOf(from);
  const nameAt = (d: Date): TideName =>
    tideNameForAge(moonPhaseAt(d).ageDays);
  if (nameAt(noon) === want) {
    // 已在该潮名区间内：回退到本轮起始日
    let d = noon;
    for (let i = 0; i < 20; i++) {
      const prev = new Date(d.getTime() - 86400000);
      if (nameAt(prev) !== want) break;
      d = prev;
    }
    return d;
  }
  let d = noon;
  for (let i = 0; i < 40; i++) {
    d = new Date(d.getTime() + 86400000);
    if (nameAt(d) === want) return d;
  }
  return noon;
}

/** 当前潮汐概况：今日潮名 + 大潮/小潮起始日，全部同源月齢算出 */
export function tideInfoAt(date: Date): TideInfo {
  return {
    today: tideNameForAge(moonPhaseAt(date).ageDays),
    nextSpringStart: tideStartDay(date, "大潮"),
    nextNeapStart: tideStartDay(date, "小潮"),
  };
}

// ------------------------------------------------------------------
// 月食（2026-11-14 新增）：数据为策展嵌入——只许出自 NASA 月食
// canon（Espenak & Meeus《Five Millennium Canon of Lunar Eclipses》，
// eclipse.gsfc.nasa.gov 各年页，取数 2026-11-14，见 DATA-PLAN）。
// 接触时刻为 UT 分精度（canon 原表口径）；东京可见性不抄 canon 的
// 区域描述，由本模块星历实时算食甚时东京的月球高度判定：
// 高度 > 0° = 月亮在地平线上 = 可见。出表范围（2029 年末）之后
// eclipseOutlook 返回 null，卡片整节隐藏，不外推不编造。
// ------------------------------------------------------------------

export type LunarEclipseType = "皆既月食" | "部分月食" | "半影月食";

export interface LunarEclipseContact {
  /** 接触名（半影食始/部分食始/皆既食始/食甚/皆既食終/部分食終/半影食終） */
  label: string;
  /** UT 时刻（ISO 字符串） */
  utc: string;
}

export interface LunarEclipse {
  type: LunarEclipseType;
  /** 半影食分（canon Pen. Mag.） */
  penMag: number;
  /** 本影食分（canon Um. Mag.，半影月食为负值 = 本影未触月面） */
  umMag: number;
  contacts: LunarEclipseContact[];
}

const C = (label: string, utc: string): LunarEclipseContact => ({ label, utc });

export const LUNAR_ECLIPSES: LunarEclipse[] = [
  {
    type: "半影月食",
    penMag: 0.9266,
    umMag: -0.0569,
    contacts: [
      C("半影食始", "2027-02-20T21:12:00Z"),
      C("食甚", "2027-02-20T23:13:00Z"),
      C("半影食終", "2027-02-21T01:13:00Z"),
    ],
  },
  {
    type: "半影月食",
    penMag: 0.0014,
    umMag: -1.068,
    contacts: [
      C("半影食始", "2027-07-18T15:57:00Z"),
      C("食甚", "2027-07-18T16:03:00Z"),
      C("半影食終", "2027-07-18T16:09:00Z"),
    ],
  },
  {
    type: "半影月食",
    penMag: 0.5456,
    umMag: -0.5254,
    contacts: [
      C("半影食始", "2027-08-17T05:24:00Z"),
      C("食甚", "2027-08-17T07:14:00Z"),
      C("半影食終", "2027-08-17T09:03:00Z"),
    ],
  },
  {
    type: "部分月食",
    penMag: 1.0468,
    umMag: 0.0662,
    contacts: [
      C("半影食始", "2028-01-12T02:08:00Z"),
      C("部分食始", "2028-01-12T03:45:00Z"),
      C("食甚", "2028-01-12T04:13:00Z"),
      C("部分食終", "2028-01-12T04:41:00Z"),
      C("半影食終", "2028-01-12T06:18:00Z"),
    ],
  },
  {
    type: "部分月食",
    penMag: 1.4266,
    umMag: 0.3892,
    contacts: [
      C("半影食始", "2028-07-06T15:44:00Z"),
      C("部分食始", "2028-07-06T17:09:00Z"),
      C("食甚", "2028-07-06T18:20:00Z"),
      C("部分食終", "2028-07-06T19:30:00Z"),
      C("半影食終", "2028-07-06T20:55:00Z"),
    ],
  },
  {
    type: "皆既月食",
    penMag: 2.2742,
    umMag: 1.2463,
    contacts: [
      C("半影食始", "2028-12-31T14:04:00Z"),
      C("部分食始", "2028-12-31T15:08:00Z"),
      C("皆既食始", "2028-12-31T16:16:00Z"),
      C("食甚", "2028-12-31T16:52:00Z"),
      C("皆既食終", "2028-12-31T17:28:00Z"),
      C("部分食終", "2028-12-31T18:36:00Z"),
      C("半影食終", "2028-12-31T19:40:00Z"),
    ],
  },
  {
    type: "皆既月食",
    penMag: 2.8266,
    umMag: 1.8436,
    contacts: [
      C("半影食始", "2029-06-26T00:35:00Z"),
      C("部分食始", "2029-06-26T01:32:00Z"),
      C("皆既食始", "2029-06-26T02:31:00Z"),
      C("食甚", "2029-06-26T03:22:00Z"),
      C("皆既食終", "2029-06-26T04:13:00Z"),
      C("部分食終", "2029-06-26T05:12:00Z"),
      C("半影食終", "2029-06-26T06:10:00Z"),
    ],
  },
  {
    type: "皆既月食",
    penMag: 2.2008,
    umMag: 1.1174,
    contacts: [
      C("半影食始", "2029-12-20T19:43:00Z"),
      C("部分食始", "2029-12-20T20:55:00Z"),
      C("皆既食始", "2029-12-20T22:15:00Z"),
      C("食甚", "2029-12-20T22:42:00Z"),
      C("皆既食終", "2029-12-20T23:09:00Z"),
      C("部分食終", "2029-12-21T00:29:00Z"),
      C("半影食終", "2029-12-21T01:41:00Z"),
    ],
  },
];

/** 月球黄道纬度（度）：Meeus 低精度公式主要摄动项，精度约 0.1° */
function moonLatitudeDeg(date: Date): number {
  const rad = Math.PI / 180;
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const D = 297.8501921 + 445267.1114034 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  return (
    5.128 * Math.sin(F * rad) +
    0.281 * Math.sin((Mp + F) * rad) +
    0.278 * Math.sin((Mp - F) * rad) +
    0.173 * Math.sin((2 * D - F) * rad)
  );
}

/** 格林尼治平恒星时（度）——与 globeMath.gmstDeg 同式（标准公式） */
function gmstDegLocal(date: Date): number {
  const JD = date.getTime() / 86400000 + 2440587.5;
  const D = JD - 2451545.0;
  let h = (18.697374558 + 24.06570982441908 * D) % 24;
  if (h < 0) h += 24;
  return h * 15;
}

const TOKYO_LAT = 35.6762;
const TOKYO_LON = 139.6503;

/**
 * 黄道坐标 → 东京地平坐标（度）：黄道经纬 → 赤经赤纬（黄赤交角
 * 23.4393°）→ 时角法（东京 35.6762°N, 139.6503°E）。方位角自北
 * 起顺时针（东 90° / 南 180° / 西 270°）。精度约 0.3° 量级，只用
 * 于可见性判定与高度目安，不作观测级预报。
 */
export function eclipticAltAzTokyo(
  lonDeg: number,
  latDeg: number,
  date: Date,
): { altDeg: number; azDeg: number } {
  const rad = Math.PI / 180;
  const lamR = lonDeg * rad;
  const betaR = latDeg * rad;
  const eps = 23.4393 * rad;
  const dec = Math.asin(
    Math.sin(betaR) * Math.cos(eps) +
      Math.cos(betaR) * Math.sin(eps) * Math.sin(lamR),
  );
  const raDeg =
    Math.atan2(
      Math.sin(lamR) * Math.cos(eps) - Math.tan(betaR) * Math.sin(eps),
      Math.cos(lamR),
    ) / rad;
  const latR = TOKYO_LAT * rad;
  const H = (gmstDegLocal(date) + TOKYO_LON - raDeg) * rad;
  const altDeg =
    Math.asin(
      Math.sin(latR) * Math.sin(dec) +
        Math.cos(latR) * Math.cos(dec) * Math.cos(H),
    ) / rad;
  const azDeg = norm360(
    Math.atan2(
      Math.sin(H),
      Math.cos(H) * Math.sin(latR) - Math.tan(dec) * Math.cos(latR),
    ) /
      rad +
      180,
  );
  return { altDeg, azDeg };
}

/**
 * 东京上空月球高度角（度，负 = 地平线下）：月球黄道经纬（本模块
 * Meeus 历表）走 eclipticAltAzTokyo 同一条换算。
 */
export function moonAltitudeTokyoDeg(date: Date): number {
  return eclipticAltAzTokyo(
    moonLongitude(date) / (Math.PI / 180),
    moonLatitudeDeg(date),
    date,
  ).altDeg;
}

export interface EclipseVisibility {
  eclipse: LunarEclipse;
  /** 食甚时刻（canon UT） */
  greatest: Date;
  /** 食甚时东京的月球高度（度） */
  altAtGreatestDeg: number;
  /** 东京可见 = 食甚时月亮在地平线上 */
  visibleInTokyo: boolean;
}

function eclipseVisibility(e: LunarEclipse): EclipseVisibility {
  const greatest = new Date(
    e.contacts.find((c) => c.label === "食甚")?.utc ?? e.contacts[0]!.utc,
  );
  const alt = moonAltitudeTokyoDeg(greatest);
  return { eclipse: e, greatest, altAtGreatestDeg: alt, visibleInTokyo: alt > 0 };
}

export interface EclipseOutlook {
  /** 下一次月食（进行中未结束的也算） */
  next: EclipseVisibility;
  /** 下一次东京可见的月食（与 next 同一条时为 null，避免重复列） */
  nextVisibleInTokyo: EclipseVisibility | null;
  /** 下一次东京可见的皆既月食（已在上两行出现时为 null） */
  nextVisibleTotalInTokyo: EclipseVisibility | null;
}

/** 月食展望：出表（2029 年末）之后返回 null，卡片整节隐藏 */
export function eclipseOutlook(now: Date): EclipseOutlook | null {
  const upcoming = LUNAR_ECLIPSES.filter((e) => {
    const last = e.contacts[e.contacts.length - 1]!;
    return new Date(last.utc).getTime() > now.getTime();
  });
  const first = upcoming[0];
  if (!first) return null;
  const next = eclipseVisibility(first);
  let nextVisible: EclipseVisibility | null = null;
  let nextTotal: EclipseVisibility | null = null;
  for (const e of upcoming) {
    const v = eclipseVisibility(e);
    if (!v.visibleInTokyo) continue;
    if (nextVisible === null && e !== first) nextVisible = v;
    if (e.type === "皆既月食") {
      if (e !== first && v !== nextVisible) nextTotal = v;
      break;
    }
  }
  return { next, nextVisibleInTokyo: nextVisible, nextVisibleTotalInTokyo: nextTotal };
}

// ------------------------------------------------------------------
// 黄道十二宫 + 行星地心黄经（2026-11-14 新增）：太阳系模式的黄道
// 环与首页「今晚黄道」卡共用。宫界 = 黄经每 30° 一宫、白羊宫起点
// = 春分点（黄经 0°），宫名用传统叫法（室女/人马/宝瓶/摩羯…）。
// 行星地心黄经：JPL Table 1 根数（与 globeMath.ts PLANET_ELEMENTS
// 同值同源，此处按本模块的纯函数纪律自带一份）先算日心黄道直角
// 坐标（含倾角 I 与升交点 Ω），行星减地球即地心坐标 → 黄经黄纬。
// 精度为 Table 1 低精度历表量级（约 0.5° 内），与全站星历同档。
// ------------------------------------------------------------------

/** 黄道十二宫宫名（白羊 0° 起，顺序即黄经递增方向） */
export const ZODIAC_SIGNS = [
  "白羊",
  "金牛",
  "双子",
  "巨蟹",
  "狮子",
  "室女",
  "天秤",
  "天蝎",
  "人马",
  "摩羯",
  "宝瓶",
  "双鱼",
] as const;

export function zodiacSignFor(lonDeg: number): string {
  return ZODIAC_SIGNS[Math.floor(norm360(lonDeg) / 30)]!;
}

type ElementsRow = [number, number, number, number, number, number];

export interface GeoPlanetDef {
  id: string;
  name: string;
  color: string;
  el: ElementsRow;
  rates: ElementsRow;
}

/** 五颗肉眼行星（+ 内部用的地球行）：JPL Table 1 根数，[a,e,I,L,ϖ,Ω] */
const GEO_ELEMENTS: Record<string, GeoPlanetDef> = {
  mercury: {
    id: "mercury", name: "水星", color: "#b8ab9c",
    el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rates: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  venus: {
    id: "venus", name: "金星", color: "#e8c07a",
    el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rates: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  },
  earth: {
    id: "earth", name: "地球", color: "#5fa8e8",
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rates: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  },
  mars: {
    id: "mars", name: "火星", color: "#d1603a",
    el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rates: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  jupiter: {
    id: "jupiter", name: "木星", color: "#d8b48f",
    el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rates: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  saturn: {
    id: "saturn", name: "土星", color: "#e3cf9e",
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rates: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  // 天王/海王（2026-11-15 世事占星卡扩）：与 globeMath.PLANET_ELEMENTS
  // 同一份 JPL Table 1 根数，走同一条地心换算链，不另立口径。
  uranus: {
    id: "uranus", name: "天王星", color: "#9fd8d4",
    el: [19.18916464, 0.04725744, -0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rates: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  neptune: {
    id: "neptune", name: "海王星", color: "#7d9fe8",
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rates: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
  // 冥王星（2026-11-15）：JPL Table 1 不收冥王星，此行用同文
  // Table 2 的附加根数（1800–2050 有效，精度低于 Table 1）；只供
  // 世事占星卡「土冥相位角」一行目安，不入八星轮盘与两两相位。
  pluto: {
    id: "pluto", name: "冥王星", color: "#c9a0b4",
    el: [39.482, 0.2488, 17.14, 238.929, 224.069, 110.299],
    rates: [0.0, 0.0, 0.0, 145.18, -0.011, -0.009],
  },
};

/** 世事占星卡的七行星（由内到外；太阳另由 sunGeocentricEcliptic 给） */
export const ASTRO_PLANETS: GeoPlanetDef[] = [
  GEO_ELEMENTS.mercury!,
  GEO_ELEMENTS.venus!,
  GEO_ELEMENTS.mars!,
  GEO_ELEMENTS.jupiter!,
  GEO_ELEMENTS.saturn!,
  GEO_ELEMENTS.uranus!,
  GEO_ELEMENTS.neptune!,
];

/** 冥王星定义（仅供土冥相位角，见上方注） */
export const PLUTO_DEF: GeoPlanetDef = GEO_ELEMENTS.pluto!;

/** 「今晚黄道」卡画的行星（由内到外） */
export const TONIGHT_PLANETS: GeoPlanetDef[] = [
  GEO_ELEMENTS.mercury!,
  GEO_ELEMENTS.venus!,
  GEO_ELEMENTS.mars!,
  GEO_ELEMENTS.jupiter!,
  GEO_ELEMENTS.saturn!,
];

/** 日心黄道直角坐标（AU）：开普勒求解 + 倾角/升交点旋转 */
function helioRectEcl(
  def: GeoPlanetDef,
  date: Date,
): [number, number, number] {
  const rad = Math.PI / 180;
  const JD = date.getTime() / 86400000 + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const at = (i: number): number => def.el[i]! + def.rates[i]! * T;
  const a = at(0);
  const e = at(1);
  const I = at(2) * rad;
  const L = at(3);
  const pomega = at(4);
  const Om = at(5) * rad;
  let M = norm360(L - pomega);
  if (M > 180) M -= 360;
  const Mr = M * rad;
  let E = Mr + e * Math.sin(Mr) * (1 + e * Math.cos(Mr));
  for (let i = 0; i < 5; i++) {
    E = E - (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  }
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const nu = Math.atan2(yp, xp);
  const r = Math.hypot(xp, yp);
  const u = nu + (pomega - at(5)) * rad;
  return [
    r * (Math.cos(Om) * Math.cos(u) - Math.sin(Om) * Math.sin(u) * Math.cos(I)),
    r * (Math.sin(Om) * Math.cos(u) + Math.cos(Om) * Math.sin(u) * Math.cos(I)),
    r * (Math.sin(u) * Math.sin(I)),
  ];
}

export interface EclipticCoord {
  lonDeg: number;
  latDeg: number;
}

/**
 * 黄经岁差（度）：IAU 简式 ψ ≈ 50.29″/年 × 自 J2000.0 起的年数。
 * 2026-11-15 主座实测：Table 1 链是 J2000 平黄道口径、未对齐当日，
 * 与 DE421 比对有共同系统偏差 ≈ −0.36°（三日期太阳 −0.358°/
 * −0.376°/−0.377°，与岁差累积逐年对齐）；扣掉后各行星残差仅角
 * 分级。故在 Table 1 地心链的两个出口（行星/太阳地心黄经）统一
 * 加 ψ 对齐当日回归黄道——今晚黄道卡与世事占星卡共用同一修正后
 * 口径。月亮走 Meeus 另一公式、无此偏差（实测 −0.7′～+4.7′），
 * moonLongitude / moonEcliptic / moonElongationDeg 一律不加修正。
 */
export function eclipticPrecessionDeg(date: Date): number {
  const JD = date.getTime() / 86400000 + 2440587.5;
  return (50.29 / 3600) * ((JD - 2451545.0) / 365.25);
}

/** 行星地心黄道经纬（度）：日心坐标行星减地球，黄经已作岁差对齐 */
export function planetGeocentricEcliptic(
  def: GeoPlanetDef,
  date: Date,
): EclipticCoord {
  const p = helioRectEcl(def, date);
  const e = helioRectEcl(GEO_ELEMENTS.earth!, date);
  const dx = p[0] - e[0];
  const dy = p[1] - e[1];
  const dz = p[2] - e[2];
  return {
    lonDeg: norm360(
      Math.atan2(dy, dx) / (Math.PI / 180) + eclipticPrecessionDeg(date),
    ),
    latDeg: Math.atan2(dz, Math.hypot(dx, dy)) / (Math.PI / 180),
  };
}

/** 太阳地心黄经（度）：地球日心黄经 + 180°，与行星同一条换算链，黄经已作岁差对齐 */
export function sunGeocentricEcliptic(date: Date): EclipticCoord {
  const e = helioRectEcl(GEO_ELEMENTS.earth!, date);
  return {
    lonDeg: norm360(
      Math.atan2(e[1], e[0]) / (Math.PI / 180) +
        180 +
        eclipticPrecessionDeg(date),
    ),
    latDeg: 0,
  };
}

/** 月球地心黄道经纬（度）：本模块 Meeus 历表（黄经 + 黄纬主要项） */
export function moonEcliptic(date: Date): EclipticCoord {
  return {
    lonDeg: norm360(moonLongitude(date) / (Math.PI / 180)),
    latDeg: moonLatitudeDeg(date),
  };
}

/**
 * 下一个东京午夜（JST 次日 0:00）：JST 日历日 D 的次日 0:00 =
 * UTC D 日 15:00。今晚黄道卡的取样时点，卡上印明其日期时刻。
 */
export function nextTokyoMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  return new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), 15, 0, 0),
  );
}
