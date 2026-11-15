// 世事占星（2026-11-15 新增）：首页天文卡组第三张，只做「事件层」——
// 入座 / 正在成相 / 逆行站 / 木土大周期，全部由 moonPhase.ts 的同一
// 套星历（JPL Table 1 根数 → 地心黄经，回归黄道）实时算出，打开时
// 算一次（App 侧按小时缓存），不逐帧跑。占星结论一律由本模块的
// 确定性规则表拼装（行星司掌领域 × 星座领域 × 相位性质），不引入
// 规则表之外的断言；卡面已标注「占星传统的规则化解读，非实证预测」。
//
// 天体集口径（2026-11-15 派单定）：八星 = 太阳 + 水星/金星/火星/
// 木星/土星/天王星/海王星（地心换算），共 8 个落轮、28 对相位。
// 月亮不入本卡（入座以 2.3 天计会淹没入座表，且月相卡/今晚黄道卡
// 已覆盖）。冥王星只供「土冥相位角」一行（根数见 moonPhase.ts 注）。
//
// 扫描纪律：粗步进括弧 + 二分求精确时刻（精度到小时级以内）。
// 相位容许度一档定死：合/冲 ±8°、刑/拱 ±6°、六合 ±4°（卡注同文）。

import {
ASTRO_PLANETS,
PLUTO_DEF,
ZODIAC_SIGNS,
planetGeocentricEcliptic,
sunGeocentricEcliptic,
zodiacSignFor,
type GeoPlanetDef,
} from "./moonPhase";

const DAY = 86400000;
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;
/** 有符号角差（−180..180） */
const wrap180 = (deg: number): number => {
  const d = norm360(deg);
  return d > 180 ? d - 360 : d;
};

// ------------------------------------------------------------------
// 天体表：字形（轮盘用单字，避开行星符号字体的跨端缺字风险）+
// 世事传统司掌领域（规则表一元）
// ------------------------------------------------------------------

export interface AstroBody {
  id: string;
  name: string;
  /** 轮盘单字标 */
  glyph: string;
  color: string;
  /** 世事传统司掌领域（结论拼装用） */
  domain: string;
  def: GeoPlanetDef | null; // null = 太阳
}

export const ASTRO_BODIES: AstroBody[] = [
  { id: "sun", name: "太阳", glyph: "日", color: "#ffc45e", domain: "权力中枢与元首层", def: null },
  ...ASTRO_PLANETS.map((def) => {
    const extra: Record<string, { glyph: string; domain: string }> = {
      mercury: { glyph: "水", domain: "信息、商贸与交通" },
      venus: { glyph: "金", domain: "金融、外交与消费" },
      mars: { glyph: "火", domain: "军事、安全与突发冲突" },
      jupiter: { glyph: "木", domain: "法律、扩张与增长预期" },
      saturn: { glyph: "土", domain: "体制、纪律与紧缩" },
      uranus: { glyph: "天", domain: "变革、科技与突发转向" },
      neptune: { glyph: "海", domain: "舆论、能源与集体情绪" },
    };
    const e = extra[def.id]!;
    return {
      id: def.id,
      name: def.name,
      glyph: e.glyph,
      color: def.color,
      domain: e.domain,
      def,
    };
  }),
];

const bodyById = (id: string): AstroBody => ASTRO_BODIES.find((b) => b.id === id)!;

/** 某天体的当前地心黄经（度，0–360） */
export function bodyLongitude(body: AstroBody, date: Date): number {
  if (body.def === null) return sunGeocentricEcliptic(date).lonDeg;
  return planetGeocentricEcliptic(body.def, date).lonDeg;
}

/** 黄经速率（度/天）：±0.75 天中央差分；负 = 逆行 */
export function bodyRate(body: AstroBody, date: Date): number {
  const h = 0.75 * DAY;
  const a = bodyLongitude(body, new Date(date.getTime() - h));
  const b = bodyLongitude(body, new Date(date.getTime() + h));
  return wrap180(b - a) / 1.5;
}

/** 星座领域（规则表二元，与 ZODIAC_SIGNS 同序） */
const SIGN_DOMAINS: Record<string, string> = {
  白羊: "攻势与开局",
  金牛: "资源与价格",
  双子: "信息与流通网络",
  巨蟹: "内政与民生安全",
  狮子: "权力舞台与风险偏好",
  室女: "秩序、劳工与公共卫生",
  天秤: "盟约与司法",
  天蝎: "债务与隐秘危机",
  人马: "跨境事务与法律",
  摩羯: "权威与体制结构",
  宝瓶: "改革、科技与群体",
  双鱼: "信仰、舆论与边界",
};

// ------------------------------------------------------------------
// 入座扫描：展开黄经逐歩走，宫界（每 30°）穿越即括弧 + 二分。
// 步长按行星地心速率上限取（单步位移 < 20°，展开不跳变）。
// ------------------------------------------------------------------

export interface Ingress {
  time: Date;
  planetId: string;
  planetName: string;
  fromSign: string;
  toSign: string;
  /** true = 逆行回座（过界时黄经速率为负） */
  retro: boolean;
  conclusion: string;
}

const SCAN_STEP_DAYS: Record<string, number> = {
  mercury: 2, venus: 3, mars: 5, jupiter: 10, saturn: 10, uranus: 15, neptune: 15,
};
/** 前后扫描视界（天）：外行星入座间隔以年计，取足以罩住本时代的窗 */
const SCAN_HORIZON_DAYS: Record<string, number> = {
  mercury: 150, venus: 260, mars: 500, jupiter: 900, saturn: 1300, uranus: 3200, neptune: 3200,
};

function ingressConclusion(
  planetName: string,
  domain: string,
  toSign: string,
  retro: boolean,
): string {
  const sd = SIGN_DOMAINS[toSign] ?? toSign;
  return retro
    ? `${planetName}逆行回${toSign}宫——${domain}的旧议题回炉，复核${sd}的未决事项。`
    : `${planetName}入${toSign}宫——${domain}的议题重心移向${sd}。`;
}

/** 沿一个方向扫描入座事件：dir=+1 向未来（取前 maxCount 笔），−1 向过去（取最近 1 笔） */
function scanIngressesOne(
  body: AstroBody,
  now: Date,
  dir: 1 | -1,
  maxCount: number,
): Ingress[] {
  const def = body.def;
  if (!def) return [];
  const step = (SCAN_STEP_DAYS[body.id] ?? 5) * DAY * dir;
  const horizon = SCAN_HORIZON_DAYS[body.id] ?? 900;
  const out: Ingress[] = [];
  let tPrev = now.getTime();
  let rawPrev = bodyLongitude(body, now);
  let uPrev = rawPrev; // 展开黄经（以当前值为原点连续展开）
  const totalSteps = Math.ceil(horizon / Math.abs(step / DAY));
  for (let i = 1; i <= totalSteps && out.length < maxCount; i++) {
    const t = now.getTime() + i * step;
    const raw = bodyLongitude(body, new Date(t));
    const u = uPrev + wrap180(raw - rawPrev);
    const sPrev = Math.floor(uPrev / 30);
    const sCur = Math.floor(u / 30);
    if (sCur !== sPrev) {
      // 括弧内二分：f(τ) = 展开黄经（以段首为原点连续展开）− 宫界
      // 宫界 = 两段宫号之间那条 30° 线（升越取新宫下界、降越取旧宫下界）
      const target = (sCur > sPrev ? sCur : sPrev) * 30;
      const f = (tau: number): number => {
        const r = bodyLongitude(body, new Date(tau));
        return uPrev + wrap180(r - rawPrev) - target;
      };
      let lo = Math.min(tPrev, t);
      let hi = Math.max(tPrev, t);
      let flo = f(lo);
      for (let it = 0; it < 42; it++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (flo * fm <= 0) {
          hi = mid;
        } else {
          lo = mid;
          flo = fm;
        }
      }
      const tc = new Date((lo + hi) / 2);
      const lonAfter = bodyLongitude(body, new Date(tc.getTime() + dir * 0.5 * DAY));
      const lonBefore = bodyLongitude(body, new Date(tc.getTime() - dir * 0.5 * DAY));
      const toSign = zodiacSignFor(dir > 0 ? lonAfter : lonBefore);
      const fromSign = zodiacSignFor(dir > 0 ? lonBefore : lonAfter);
      const retro = bodyRate(body, tc) < 0;
      out.push({
        time: tc,
        planetId: body.id,
        planetName: body.name,
        fromSign,
        toSign,
        retro,
        conclusion: ingressConclusion(body.name, body.domain, toSign, retro),
      });
    }
    tPrev = t;
    rawPrev = raw;
    uPrev = u;
  }
  return out;
}

// ------------------------------------------------------------------
// 相位：28 对全扫。成相 = 当前距角落在容许度内；精确时刻对该相位
// 的有符号距 g(τ)=wrap180(Δλ − c) 括弧二分（c 为与当前 Δλ 最近的
// ±θ 等价点）。入相/出相由距角对目标的增减判定。
// ------------------------------------------------------------------

export type AspectName = "合相" | "冲相" | "刑相" | "拱相" | "六合";

export interface AspectDef {
  name: AspectName;
  angle: number;
  orb: number;
  color: string;
  nature: string;
}

export const ASPECT_DEFS: AspectDef[] = [
  { name: "合相", angle: 0, orb: 8, color: "#ffc45e", nature: "能量合流，议题被放大点燃" },
  { name: "冲相", angle: 180, orb: 8, color: "#ff6b6b", nature: "两极对峙，矛盾公开化" },
  { name: "刑相", angle: 90, orb: 6, color: "#f0924f", nature: "摩擦阻滞，被迫调整" },
  { name: "拱相", angle: 120, orb: 6, color: "#3ddc97", nature: "流畅配合，阻力最小" },
  { name: "六合", angle: 60, orb: 4, color: "#38e1ff", nature: "机会窗口，需主动把握" },
];

export interface ActiveAspect {
  aId: string;
  bId: string;
  aName: string;
  bName: string;
  aspect: AspectName;
  color: string;
  /** 当前容许度（距精确成相的度数） */
  orbDeg: number;
  /** 精确成相时刻 */
  exactTime: Date;
  /** true = 入相（正在靠近精确点，精确时刻在未来）；false = 出相 */
  applying: boolean;
  conclusion: string;
}

function aspectConclusion(a: AstroBody, b: AstroBody, def: AspectDef): string {
  return `${a.name}${def.name}${b.name}——${a.domain}与${b.domain}${def.nature}。`;
}

/** 某对天体在时刻 t 的距角（0–180） */
function separation(a: AstroBody, b: AstroBody, t: Date): number {
  const d = Math.abs(wrap180(bodyLongitude(a, t) - bodyLongitude(b, t)));
  return d;
}

/**
 * 精确成相时刻：双向都扫、取更近者。单向判方向在留站附近靠不住
 * （土星–海王星 2026-11：双方同逆行、距角暂缩但永不再精确——过往
 * 精确点在 2026-02，双向取近才诚实）。入相 = 取到的时刻在未来。
 */
function findExactAspectTime(
  a: AstroBody,
  b: AstroBody,
  def: AspectDef,
  now: Date,
): { time: Date; applying: boolean } {
  // 与当前 Δλ 最近的 ±θ 等价点 c（diff 空间）
  const D = bodyLongitude(a, now) - bodyLongitude(b, now);
  const r = norm360(D);
  const cands = def.angle === 0 ? [0] : def.angle === 180 ? [180] : [def.angle, 360 - def.angle];
  let c = cands[0]!;
  let best = Infinity;
  for (const cand of cands) {
    const dist = Math.abs(wrap180(r - cand));
    if (dist < best) {
      best = dist;
      c = cand;
    }
  }
  const g = (tau: number): number =>
    wrap180(bodyLongitude(a, new Date(tau)) - bodyLongitude(b, new Date(tau)) - c);
  const scanDir = (dir: 1 | -1): Date | null => {
    const stepMs = 3 * DAY * dir;
    let tPrev = now.getTime();
    let gPrev = g(tPrev);
    if (Math.abs(gPrev) < 1e-9) return now;
    for (let i = 1; i <= 420; i++) {
      const t = now.getTime() + i * stepMs;
      const gv = g(t);
      if (gPrev * gv <= 0) {
        let lo = Math.min(tPrev, t);
        let hi = Math.max(tPrev, t);
        let flo = g(lo);
        for (let it = 0; it < 42; it++) {
          const mid = (lo + hi) / 2;
          const fm = g(mid);
          if (flo * fm <= 0) hi = mid;
          else {
            lo = mid;
            flo = fm;
          }
        }
        return new Date((lo + hi) / 2);
      }
      tPrev = t;
      gPrev = gv;
    }
    return null;
  };
  const fwd = scanDir(1);
  const back = scanDir(-1);
  if (fwd && back) {
    return Math.abs(fwd.getTime() - now.getTime()) <= Math.abs(back.getTime() - now.getTime())
      ? { time: fwd, applying: true }
      : { time: back, applying: false };
  }
  if (fwd) return { time: fwd, applying: true };
  if (back) return { time: back, applying: false };
  return { time: now, applying: true }; // 双向视界内未括到（历表异常）——回当前时刻，不编造
}

function scanAspects(now: Date): ActiveAspect[] {
  const out: ActiveAspect[] = [];
  for (let i = 0; i < ASTRO_BODIES.length; i++) {
    for (let j = i + 1; j < ASTRO_BODIES.length; j++) {
      const a = ASTRO_BODIES[i]!;
      const b = ASTRO_BODIES[j]!;
      const sep = separation(a, b, now);
      for (const def of ASPECT_DEFS) {
        const orbDeg = Math.abs(sep - def.angle);
        if (orbDeg > def.orb) continue;
        const exact = findExactAspectTime(a, b, def, now);
        out.push({
          aId: a.id,
          bId: b.id,
          aName: a.name,
          bName: b.name,
          aspect: def.name,
          color: def.color,
          orbDeg,
          exactTime: exact.time,
          applying: exact.applying,
          conclusion: aspectConclusion(a, b, def),
        });
      }
    }
  }
  out.sort((x, y) => x.orbDeg - y.orbDeg);
  return out;
}

// ------------------------------------------------------------------
// 逆行站：当前速率为负的行星，向两头扫速率变号点 = 本轮起止站。
// ------------------------------------------------------------------

export interface RetroStation {
  planetId: string;
  planetName: string;
  /** 本轮逆行开始（留站）时刻 */
  start: Date | null;
  /** 本轮逆行结束（留站）时刻 */
  end: Date | null;
  conclusion: string;
}

function findStation(body: AstroBody, now: Date, dir: 1 | -1): Date | null {
  const stepMs = 3 * DAY * dir;
  let tPrev = now.getTime();
  let rPrev = bodyRate(body, now);
  for (let i = 1; i <= 240; i++) {
    const t = now.getTime() + i * stepMs;
    const rv = bodyRate(body, new Date(t));
    if (rPrev * rv <= 0 && rPrev !== rv) {
      let lo = Math.min(tPrev, t);
      let hi = Math.max(tPrev, t);
      let flo = bodyRate(body, new Date(lo));
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        const fm = bodyRate(body, new Date(mid));
        if (flo * fm <= 0) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      return new Date((lo + hi) / 2);
    }
    tPrev = t;
    rPrev = rv;
  }
  return null;
}

function scanRetrogrades(now: Date): RetroStation[] {
  const out: RetroStation[] = [];
  for (const body of ASTRO_BODIES) {
    if (body.def === null) continue;
    if (bodyRate(body, now) >= 0) continue;
    const sign = zodiacSignFor(bodyLongitude(body, now));
    const sd = SIGN_DOMAINS[sign] ?? sign;
    out.push({
      planetId: body.id,
      planetName: body.name,
      start: findStation(body, now, -1),
      end: findStation(body, now, 1),
      conclusion: `${body.name}在${sign}宫逆行——${body.domain}回头复核${sd}，推进中的事项宜复盘不宜新启。`,
    });
  }
  return out;
}

// ------------------------------------------------------------------
// 大周期：木土合相（约 19.86 年一轮）。展开 Δλ 扫 360° 穿越点。
// 阶段名按当前相位角（木星领先土星的展开角 0–360）查八分表。
// ------------------------------------------------------------------

export interface GrandCycle {
  lastConj: { time: Date; sign: string } | null;
  nextConj: { time: Date; sign: string } | null;
  /** 当前相位角（0–360，木星相对土星） */
  phaseDeg: number;
  stageName: string;
  conclusion: string;
  /** 土天 / 土冥当前距角（0–180）与最近主要相位 */
  satUranus: { angleDeg: number; nearest: string };
  satPluto: { angleDeg: number; nearest: string };
}

const CYCLE_STAGES: Array<{ until: number; name: string; gloss: string }> = [
  { until: 45, name: "定调期", gloss: "新一轮二十年框架定调，权力与资本结构重排" },
  { until: 90, name: "扩张期", gloss: "新框架落地生根，扩张先于检验" },
  { until: 135, name: "上刑考验期", gloss: "扩张遭遇结构阻力，先前的承诺接受检验" },
  { until: 180, name: "张力累积期", gloss: "两极力量持续累积，对峙面扩大" },
  { until: 225, name: "冲相中点期", gloss: "周期行至中点，成果与代价同时显形" },
  { until: 270, name: "调整期", gloss: "对峙之后进入再平衡，旧安排逐项修订" },
  { until: 315, name: "下刑再考验期", gloss: "收尾前的第二次结构检验，积弊集中暴露" },
  { until: 360, name: "收束期", gloss: "旧周期尾声，未了事项赶在新框架前清账" },
];

function findConjunction(
  a: AstroBody,
  b: AstroBody,
  from: Date,
  dir: 1 | -1,
): { time: Date; sign: string } | null {
  const stepMs = 5 * DAY * dir;
  const horizonSteps = dir > 0 ? 1600 : 900; // 未来 21.9 年 / 过去 12.3 年
  let tPrev = from.getTime();
  let rawPrev = wrap180(bodyLongitude(a, from) - bodyLongitude(b, from));
  let uPrev = rawPrev;
  for (let i = 1; i <= horizonSteps; i++) {
    const t = from.getTime() + i * stepMs;
    const raw = wrap180(bodyLongitude(a, new Date(t)) - bodyLongitude(b, new Date(t)));
    const u = uPrev + wrap180(raw - rawPrev);
    if (Math.floor(uPrev / 360) !== Math.floor(u / 360)) {
      const target = (Math.max(Math.floor(uPrev / 360), Math.floor(u / 360))) * 360;
      const f = (tau: number): number => {
        const r = wrap180(bodyLongitude(a, new Date(tau)) - bodyLongitude(b, new Date(tau)));
        return uPrev + wrap180(r - rawPrev) - target;
      };
      let lo = Math.min(tPrev, t);
      let hi = Math.max(tPrev, t);
      let flo = f(lo);
      for (let it = 0; it < 42; it++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (flo * fm <= 0) hi = mid;
        else {
          lo = mid;
          flo = fm;
        }
      }
      const tc = new Date((lo + hi) / 2);
      return { time: tc, sign: zodiacSignFor(bodyLongitude(a, tc)) };
    }
    tPrev = t;
    rawPrev = raw;
    uPrev = u;
  }
  return null;
}

function nearestAspectLabel(angleDeg: number): string {
  let bestName = "";
  let bestDist = Infinity;
  for (const def of ASPECT_DEFS) {
    const d = Math.abs(angleDeg - def.angle);
    if (d < bestDist) {
      bestDist = d;
      bestName = def.name;
    }
  }
  return bestDist <= 10 ? `近${bestName}（差 ${bestDist.toFixed(1)}°）` : "未成主要相位";
}

function scanGrandCycle(now: Date): GrandCycle {
  const jupiter = bodyById("jupiter");
  const saturn = bodyById("saturn");
  const uranus = bodyById("uranus");
  const lastConj = findConjunction(jupiter, saturn, now, -1);
  const nextConj = findConjunction(jupiter, saturn, now, 1);
  const phaseDeg = norm360(bodyLongitude(jupiter, now) - bodyLongitude(saturn, now));
  const stage = CYCLE_STAGES.find((s) => phaseDeg < s.until) ?? CYCLE_STAGES[0]!;
  const plutoBody: AstroBody = {
    id: "pluto", name: "冥王星", glyph: "冥", color: PLUTO_DEF.color, domain: "", def: PLUTO_DEF,
  };
  const su = separation(saturn, uranus, now);
  const sp = separation(saturn, plutoBody, now);
  return {
    lastConj,
    nextConj,
    phaseDeg,
    stageName: stage.name,
    conclusion: `木土周期行至${stage.name}（相位角 ${phaseDeg.toFixed(0)}°）——${stage.gloss}。`,
    satUranus: { angleDeg: su, nearest: nearestAspectLabel(su) },
    satPluto: { angleDeg: sp, nearest: nearestAspectLabel(sp) },
  };
}

// ------------------------------------------------------------------
// 总装：打开时算一次。主结论选择规则（确定性，卡注同文）：
// ① 木土相位角距最近的合/刑/冲节点 ≤8° 时取周期结论（周期级
//    的触发窗就是这 ≤8°，窗外周期结论只在「大周期」一节常驻、
//    不占主结论位）；② 否则取容许度最小的正在成相事件；
// ③ 再否则取下一笔入座事件。
// ------------------------------------------------------------------

export interface MundaneAstroData {
  computedAt: Date;
  /** 八星当前落轮：黄经 + 所在宫 + 是否逆行 */
  bodies: Array<{
    body: AstroBody;
    lonDeg: number;
    sign: string;
    retro: boolean;
  }>;
  pastIngress: Ingress | null;
  nextIngresses: Ingress[];
  /** 下一笔入座（轮盘高亮其目标宫） */
  nextIngress: Ingress | null;
  aspects: ActiveAspect[];
  retrogrades: RetroStation[];
  cycle: GrandCycle;
  main: { kind: "周期" | "成相" | "入座"; conclusion: string };
}

export function computeMundaneAstro(now: Date): MundaneAstroData {
  const bodies = ASTRO_BODIES.map((body) => {
    const lonDeg = bodyLongitude(body, now);
    return {
      body,
      lonDeg,
      sign: zodiacSignFor(lonDeg),
      retro: body.def !== null && bodyRate(body, now) < 0,
    };
  });

  // 入座：过去最近一次（七行星各回扫一笔取最晚者）+ 未来排队
  let pastIngress: Ingress | null = null;
  const futureAll: Ingress[] = [];
  for (const body of ASTRO_BODIES) {
    if (body.def === null) continue;
    const past = scanIngressesOne(body, now, -1, 1)[0];
    if (past && (!pastIngress || past.time.getTime() > pastIngress.time.getTime())) {
      pastIngress = past;
    }
    futureAll.push(...scanIngressesOne(body, now, 1, 2));
  }
  futureAll.sort((x, y) => x.time.getTime() - y.time.getTime());
  const nextIngresses = futureAll.slice(0, 5);
  const nextIngress = futureAll[0] ?? null;

  const aspects = scanAspects(now);
  const retrogrades = scanRetrogrades(now);
  const cycle = scanGrandCycle(now);

  // 主结论选择（规则见文件头）
  const nodeDist = Math.min(
    ...[0, 90, 180, 270, 360].map((n) => Math.abs(cycle.phaseDeg - n)),
  );
  let main: MundaneAstroData["main"];
  if (nodeDist <= 8) {
    main = { kind: "周期", conclusion: cycle.conclusion };
  } else if (aspects.length > 0) {
    main = { kind: "成相", conclusion: aspects[0]!.conclusion };
  } else if (nextIngress) {
    main = { kind: "入座", conclusion: nextIngress.conclusion };
  } else {
    main = { kind: "周期", conclusion: cycle.conclusion };
  }

  return {
    computedAt: now,
    bodies,
    pastIngress,
    nextIngresses,
    nextIngress,
    aspects,
    retrogrades,
    cycle,
    main,
  };
}

export { ZODIAC_SIGNS };
