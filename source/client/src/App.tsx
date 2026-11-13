import {
lazy,
Suspense,
useEffect,
useMemo,
useRef,
useState,
type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import type { CenterInfo, CountryCode, IndexBoardInfo } from "./Globe";
import { REGION_LEGEND, regionColorFor } from "./nationColors";
import { moonPhaseAt } from "./moonPhase";
import {
CABLES,
CABLE_CONTINENT_LABEL,
cableStatusFor,
type CableContinent,
type CableStatusInfo,
} from "./cablesData";

// 地球（three.js + 地理/灯光数据）是整个包的大头：懒加载成异步块，
// 数据面板与状态条先渲染可读，地球随后填入固定高度的区域（不跳版）。
const Globe = lazy(() =>
  import("./Globe").then((m) => ({ default: m.Globe })),
);

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Block = NonNullable<Dashboard["fx"]>;

interface FxPair {
  code: string;
  rate: number;
  changePct: number | null;
  spark: number[];
}
interface Mag7Component {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  marketCap: number | null;
}
interface Mag7Row {
  symbol: string;
  name: string;
  /** 合并行（Tesla + SpaceX）没有单一股价，为 null，分项价在 components 里 */
  price: number | null;
  changePct: number | null;
  marketCap: number | null;
  asOf: string | null;
  spark: number[];
  /** 月点走势（2024-12 起每月一个点，当月为最新收盘）；合并行的
   *  走势仍用它（只从 SpaceX 上市的 2026-06 起，约 6 个点，不往
   *  前补），单股行自 2026-11-14 年周期统一后改画 sparkY。 */
  sparkM?: number[];
  sparkMDates?: string[];
  /** 年点走势（2016–2025 各年年底收盘 + 最新收盘，约 11 点）：
   *  单股行的走势线；旧快照没有时回退月点/日线。 */
  sparkY?: number[];
  sparkYDates?: string[];
  /** 行首大字涨幅：单股行 = 近 12 个月（月线收盘算）；合并行 =
   *  上市以来（自首个合并点起算）。当日涨跌仍在 changePct 里，
   *  以小字渲染。旧快照可能缺省。 */
  changeYearPct?: number | null;
  combined?: boolean;
  components?: Mag7Component[];
}
interface CountryCapComponent {
  code: string;
  name: string;
  marketCap: number;
  companies: number;
}
interface CountryCapDecomp {
  windowDays: number;
  /** "12m" 近 12 个月（2026-11-14 起的标准窗口）/
   *  "full" 从最早记录算到现在 / "30d" 最近 30 天 /
   *  "sinceStart" 记录还不满 30 天、从开始记录以来 /
   *  "calibrated" 中国行只从 2025-07-31 开始算 /
   *  "mixed" 七行合计、各行按自己开始算的日期汇总 */
  basis: "12m" | "full" | "30d" | "sinceStart" | "calibrated" | "mixed";
  baseDate: string;
  lastDate: string;
  deltaUsd: number;
  deltaPct: number;
  valuationUsd: number;
  /** 剩下的那一块 = 市值变化减去跟着大盘和汇率涨的那一块（混着
   *  新上市/多发新股/回购/外国资金买卖，不是官方资金流数据，
   *  见板块说明） */
  residualUsd: number;
  residualPct: number;
  benchmarks: string[];
  /** 统计的公司变多了：这段时间里某地统计的公司家数变动 >5%
   *  （按数字判定），剩下的那一块照常显示、只加一句提醒；
   *  明细如「中国公司数 321→498 家（+55.1%）」 */
  coverageChange?: boolean;
  coverageNotes?: string[];
}
interface CountryCapRow {
  rank: number;
  code: string;
  name: string;
  marketCap: number;
  companies: number;
  /** 占同一批统计的各国总市值的百分比（同一次抓取、同一批名单内计算） */
  sharePct: number;
  combined?: boolean;
  components?: CountryCapComponent[] | null;
  /** 总市值走势（每年一个点：每年最后一个记录点 + 最新点；
   *  合并行为构成国同日点之和） */
  spark?: number[];
  sparkDates?: string[];
  /** 与 spark 平行：该点是否为 2023 年早期存档点（收录公司远
   *  少于现在，只作水位参考，线段以虚线淡色绘制） */
  sparkEarly?: boolean[];
  /** 近 12 个月涨了多少（2026-11-14 起统一为近 12 个月窗口；
   *  CN+TW 行的窗口在 2025-07-31 校准锚点之后） */
  changePct?: number | null;
  windowDays?: number;
  changeBasis?:
    | "12m"
    | "full"
    | "30d"
    | "sinceStart"
    | "calibrated"
    | "mixed"
    | null;
  /** 中国行的分界日期（仅 CN+TW 行非空）：走势线在此日期之前
   *  的段落统计的公司不一样，以虚线区隔、不算进涨跌 */
  calibrationAnchor?: string | null;
  decomp?: CountryCapDecomp | null;
}
interface CuratedItem {
  key: string;
  label: string;
  value: string;
  detail: string | null;
  asOf: string;
  source: string;
}
interface FredObsT {
  date: string;
  value: number;
}
interface IndexRow {
  name: string;
  price: number;
  changePct: number | null;
  /** 数值真实日期（交易所时区 YYYY-MM-DD）；旧快照可能缺省 */
  asOf?: string | null;
}
interface M2Country {
  code: string;
  name: string;
  /** 公布口径名（M2 / M3 / M4 / M3（欧元区）），旧快照可能缺省 */
  measure?: string;
  /** 年度增速算法：avg = 年平均存量，eop = 年末比年末；旧快照可能缺省 */
  basis?: "avg" | "eop";
  latestYear: number | null;
  latestValue: number | null;
  points: Array<{ year: number; value: number }>;
  source?: string;
}

const COUNTRY_META: Record<
  CountryCode,
  { name: string; color: string; cities: [string, string] }
> = {
  US: { name: "美国", color: "#38b6e3", cities: ["纽约", "旧金山"] },
  CN: { name: "中国", color: "#ff6b6b", cities: ["上海", "北京"] },
  JP: { name: "日本", color: "#ff9ec4", cities: ["东京", "大阪"] },
};

/** 金融中心 → 本页已收录的市场指数（没有现成数据的中心不显示指数行） */
const CENTER_INDEX: Record<string, string> = {
  nyc: "标普 500",
  sfo: "标普 500",
  lax: "标普 500",
  chi: "标普 500",
  bos: "标普 500",
  was: "标普 500",
  sha: "上证综指",
  pek: "上证综指",
  tyo: "日经 225",
  osa: "日经 225",
};

/**
 * 太阳系天体极简信息（NASA 行星档案口径的真实数据：直径 / 公转周期 /
 * 自转周期）。点选聚焦后在画面边缘小字呈现，不挡星球本体。
 */
const BODY_INFO: Record<string, { name: string; en: string; facts: string }> = {
  sun: { name: "太阳", en: "Sun", facts: "直径 1,392,700 km · 自转约 27 天 · G 型主序星" },
  mercury: { name: "水星", en: "Mercury", facts: "直径 4,879 km · 公转 88 天 · 自转 58.6 天" },
  venus: { name: "金星", en: "Venus", facts: "直径 12,104 km · 公转 225 天 · 自转 243 天（逆行）" },
  earth: { name: "地球", en: "Earth", facts: "直径 12,742 km · 公转 365.25 天 · 自转 23.9 小时" },
  moon: { name: "月球", en: "Moon", facts: "直径 3,474 km · 绕地 27.3 天 · 距地球约 384,400 km" },
  mars: { name: "火星", en: "Mars", facts: "直径 6,779 km · 公转 687 天 · 自转 24.6 小时" },
  jupiter: { name: "木星", en: "Jupiter", facts: "直径 139,820 km · 公转 11.9 年 · 自转 9.9 小时" },
  saturn: { name: "土星", en: "Saturn", facts: "直径 116,460 km · 公转 29.4 年 · 自转 10.7 小时" },
  uranus: { name: "天王星", en: "Uranus", facts: "直径 50,724 km · 公转 84 年 · 自转 17.2 小时" },
  neptune: { name: "海王星", en: "Neptune", facts: "直径 49,244 km · 公转 164.8 年 · 自转 16.1 小时" },
  suisei: { name: "星街彗星", en: "Hoshimachi Suisei", facts: "客串天体 · 原型为星街すいせい主视觉中的彗星之星 · 木星级体量 · 外围轨道约 210 年" },
};

/** 底栏主页星球菜单名单：太阳 → 八大行星（由内向外）→ 月球 →
 * 星街彗星（客串天体升格，2026-11-12 按用户口径列为第十一项、
 * 置于末位）；地球只是其中一项，不再有专属的「换回地球」按钮 */
const HOME_PLANET_MENU: string[] = [
  "sun",
  "mercury",
  "venus",
  "earth",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
  "moon",
  "suisei",
];

/** 租金九城 → 国家色（与 nationColors 同一色板；COUNTRY_META 只含
 *  监控三国，租金点色在这里按国家代码查全色板）。country 仅用于
 *  国家小结卡把租金行挂到对应国家（非监控三国不挂）。 */
const RENT_CITY: Record<
  string,
  { city: string; color: string; country?: CountryCode }
> = {
  rent_new_york: { city: "纽约", color: "#38b6e3", country: "US" },
  rent_toronto: { city: "多伦多", color: "#f28ba4" },
  rent_shanghai: { city: "上海", color: "#ff6b6b", country: "CN" },
  rent_taipei: { city: "台北", color: "#ffa08a" },
  rent_tokyo: { city: "东京", color: "#ff9ec4", country: "JP" },
  rent_london: { city: "伦敦", color: "#a78bfa" },
  rent_mumbai: { city: "孟买", color: "#ffc46b" },
  rent_zurich: { city: "苏黎世", color: "#8fd8b6" },
  rent_paris: { city: "巴黎", color: "#8b93f0" },
};

function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function pctColor(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-[var(--dim)]";
  return v > 0 ? "text-[#ff6b6b] glow-up" : "text-[#3ddc97] glow-down";
}

/** 数字滚动动画：值变化时从旧值缓动到新值（count-up 感），不引起布局变化 */
function useAnimatedNumber(value: number, duration = 700): number {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (from === value || !Number.isFinite(from) || !Number.isFinite(value)) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * e);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

function AnimNum({
  value,
  format,
}: {
  value: number;
  format: (v: number) => string;
}) {
  const v = useAnimatedNumber(value);
  return <>{format(v)}</>;
}

function fmtT(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${(v / 1e12).toFixed(2)}T`;
}

/** 带符号的美元金额（每行下面那句账用）：+$1.23T / -$0.45T / +$123B */
function fmtUsdSigned(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "+";
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(0)}B`;
  return `${sign}$${(a / 1e6).toFixed(0)}M`;
}

/** 剩下的那一块的配色：正 = 变多了（红，与涨同色系），
 *  负 = 变少了（绿，与跌同色系）——沿用本页涨红跌绿的既有约定 */
function residualColor(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-[var(--dim)]";
  return v > 0 ? "text-[#ff8a8a]" : "text-[#3ddc97]";
}

function Spark({
  values,
  width = 84,
  height = 26,
  color = "#38e1ff",
  labels,
  splitIndex,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  labels?: [string, string];
  /** 分界点：此索引（含）之前的段落不可比（中国行校准锚点之前
   *  统计的公司不一样 / 2023 早期存档点收录太薄），统一以虚线
   *  绘制区隔；此后段落为可比段，实线绘制。
   *  两段在分界处共享一个点，保持线条连续。 */
  splitIndex?: number | null;
}) {
  if (values.length < 2) {
    return <div style={{ width, height }} aria-hidden="true" />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const ptList = values.map(
    (v, i) =>
      `${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(
        height -
        3 -
        ((v - min) / span) * (height - 6)
      ).toFixed(1)}`,
  );
  const pts = ptList.join(" ");
  const up = values[values.length - 1]! >= values[0]!;
  const stroke = labels ? color : up ? "#ff6b6b" : "#3ddc97";
  const hasSplit =
    splitIndex != null && splitIndex > 0 && splitIndex < values.length - 1;
  return (
    <svg
      width={width}
      height={height}
      className="shrink-0"
      role="img"
      aria-label={labels ? `走势：${labels[0]} 至 ${labels[1]}` : "走势小图"}
    >
      {hasSplit ? (
        <>
          <polyline
            points={ptList.slice(0, splitIndex + 1).join(" ")}
            fill="none"
            stroke={stroke}
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="3 3"
            opacity="0.38"
          />
          <polyline
            points={ptList.slice(splitIndex).join(" ")}
            fill="none"
            stroke={stroke}
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.95"
          />
        </>
      ) : (
        <polyline
          points={pts}
          fill="none"
          stroke={stroke}
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.9"
        />
      )}
    </svg>
  );
}

function BlockShell({
  title,
  block,
  freq,
  children,
  emptyText,
  hideSourceLine = false,
}: {
  title: string;
  block: Block | null;
  freq: string;
  children: ReactNode;
  emptyText: string;
  /** 块尾自带来源段落时置 true，关掉壳的通用来源行，避免重复复述
      （Cap 7：用户定稿的四段块尾末段即来源行）。 */
  hideSourceLine?: boolean;
}) {
  return (
    <section className="glass p-4 sm:p-5" aria-label={title}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold tracking-wide text-[#eaf3ff]">
          {title}
        </h2>
        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--dim)]">
          {freq}
        </span>
      </div>
      {block ? (
        <>
          {children}
          {!hideSourceLine && (
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
              来源：{block.source} · 截至 {block.asOf || "—"}
              {block.status === "stale" && (
                <span className="text-[#ffc45e]">
                  {" "}
                  · 本次更新失败，显示最近一次可用数据
                </span>
              )}
            </p>
          )}
          {hideSourceLine && block.status === "stale" && (
            <p className="mt-3 text-[11px] leading-relaxed text-[#ffc45e]">
              本次更新失败，显示最近一次可用数据
            </p>
          )}
        </>
      ) : (
        <p className="py-4 text-sm text-[var(--dim)]">{emptyText}</p>
      )}
    </section>
  );
}

/**
 * 左上角时钟（一行简化）：东京时间 HH:MM:SS 走字 + 日期小字。
 * 每秒重渲染本组件自身，不牵动面板其余部分。
 */
function TokyoClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(now);
  return (
    <p
      className="pointer-events-auto flex h-[30px] items-center gap-2 rounded-full bg-[rgba(4,10,22,0.55)] px-3 backdrop-blur-sm"
      aria-label={`东京时间 ${time}`}
    >
      <span className="text-[11px] text-[var(--dim)]">东京</span>
      <span className="num text-sm font-semibold text-[#eaf3ff]">{time}</span>
      <span className="text-[11px] text-[var(--dim)]">{date}</span>
    </p>
  );
}

/**
 * 月相卡（2026-11-13）：月盘按当前相位精确画明暗界线（北半球视角，
 * 盈月亮面在右、亏月在左）。相位不查表不写死：moonPhaseAt 用与
 * Globe 太阳系月球同一条 Meeus 月球黄经公式 + 同一套 JPL 地球根
 * 数算日月距角，打开/每分钟重算即为当时真值——卡上画的上弦，
 * 球上的月亮也是上弦（同源一致）。月盘画法：亮半圆盘 + 椭圆明暗
 * 界线（界线椭圆横半径 = R·cos 距角，符号随距角自然分出眉/凸），
 * 采样折线成path，任意相位角下界线形状精确。
 */
function MoonPhaseCard() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);
  const ph = moonPhaseAt(now);
  const R = 44;
  const C = 50;
  const phi = (ph.elongationDeg * Math.PI) / 180;
  const side = ph.waxing ? 1 : -1;
  const pts: string[] = [];
  const N = 36;
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI;
    pts.push(
      `${(C + side * R * Math.sin(th)).toFixed(2)},${(C - R * Math.cos(th)).toFixed(2)}`,
    );
  }
  for (let i = 1; i <= N; i++) {
    const u = (i / N) * Math.PI;
    pts.push(
      `${(C + side * R * Math.cos(phi) * Math.sin(u)).toFixed(2)},${(C + R * Math.cos(u)).toFixed(2)}`,
    );
  }
  const litPath = `M ${pts.join(" L ")} Z`;
  const fmtDay = (d: Date): string =>
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
    }).format(d);
  return (
    <section className="glass p-4 sm:p-5" aria-label="月相">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold tracking-wide text-[#eaf3ff]">
          月相
        </h2>
        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--dim)]">
          实时计算
        </span>
      </div>
      <div className="flex items-center gap-4">
        <svg
          viewBox="0 0 100 100"
          className="h-[92px] w-[92px] shrink-0"
          role="img"
          aria-label={`当前月相 ${ph.name}，照亮 ${(ph.illum * 100).toFixed(0)}%`}
          style={{ filter: "drop-shadow(0 0 10px rgba(190,205,235,0.25))" }}
        >
          <defs>
            <radialGradient id="moonLitGrad" cx="38%" cy="34%" r="80%">
              <stop offset="0%" stopColor="#fdfaf0" />
              <stop offset="55%" stopColor="#eae4d0" />
              <stop offset="100%" stopColor="#c9c2ab" />
            </radialGradient>
            <clipPath id="moonLitClip">
              <path d={litPath} />
            </clipPath>
          </defs>
          <circle cx={C} cy={C} r={R} fill="#131b2e" />
          <path d={litPath} fill="url(#moonLitGrad)" />
          <g clipPath="url(#moonLitClip)" fill="rgba(110,104,86,0.20)">
            <ellipse cx="36" cy="38" rx="13" ry="10" />
            <ellipse cx="55" cy="60" rx="16" ry="12" />
            <ellipse cx="33" cy="64" rx="8" ry="7" />
            <ellipse cx="60" cy="30" rx="7" ry="6" />
          </g>
          <circle
            cx={C}
            cy={C}
            r={R}
            fill="none"
            stroke="rgba(170,195,235,0.35)"
            strokeWidth="1"
          />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="font-display text-2xl font-semibold text-[#eaf3ff]">
            {ph.name}
          </div>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--dim)]">照亮比例</dt>
              <dd className="num font-medium">
                {(ph.illum * 100).toFixed(1)}%
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--dim)]">月龄</dt>
              <dd className="num font-medium">{ph.ageDays.toFixed(1)} 天</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--dim)]">下一次满月</dt>
              <dd className="num font-medium">{fmtDay(ph.nextFull)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--dim)]">下一次新月</dt>
              <dd className="num font-medium">{fmtDay(ph.nextNew)}</dd>
            </div>
          </dl>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
        来源：天文算法实时计算（月球黄经 Meeus 低精度历表，与太阳系
        3D 月球同源）· 按打开时刻每分钟重算
      </p>
    </section>
  );
}

/**
 * 回到顶部悬浮按钮（2026-11-13，用户：页面太长了）：固定右下角的
 * 玻璃小钮，滚过约一屏半才淡入出现、顶部时藏起；点按平滑滚回最
 * 上方（reduced-motion 时直接跳）。太阳系模式没有页面滚动，
 * scrollY 不动，自然不会出现。
 */
function BackToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // 布局事实（2026-11-14 全页核对）：全页没有任何 overflow-y
    // 滚动盒（仅两处浮层小盒），页面滚动者就是 document 本身——
    // 根节点 overflow-x: clip 不建滚动容器，main 也不是滚动盒
    // （data-scroll-panel 只是定位锚，见 main 处注释，两处口径
    // 一致）。旧实现其实已读 document.scrollingElement＋window
    // capture 监听，静态代码查无确凿失效点，真机永不出现的确切
    // 失效环节未能从代码断定。本轮按纵深防御处理：显形判定同时
    // 读文档滚动者、window.scrollY 与定位锚元素三路（任一过阈值
    // 即显示，阈值降到 1.2 屏），监听挂 window capture＋锚元素双
    // 通道，回顶对文档与 window 双写；层级 z-[70] 压过一切卡片。
    // 是否修好以探针深滚复演为准（见本轮构建回报）。
    const panel = () =>
      document.querySelector<HTMLElement>("[data-scroll-panel]");
    const docTop = () =>
      document.scrollingElement?.scrollTop ?? window.scrollY ?? 0;
    const update = () => {
      const p = panel();
      const top = Math.max(docTop(), p?.scrollTop ?? 0);
      setShown(top > window.innerHeight * 1.2);
    };
    update();
    const p = panel();
    window.addEventListener("scroll", update, {
      passive: true,
      capture: true,
    });
    p?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, { capture: true });
      p?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return (
    <button
      type="button"
      aria-label="回到顶部"
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      onClick={() => {
        const reduce = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
        // 回顶同样双通道：文档滚动者与面板盒都送回顶部，哪条是
        // 真滚动者就由哪条生效，另一条在顶部时是无操作。
        const el = document.scrollingElement ?? document.documentElement;
        el.scrollTo({ top: 0, behavior });
        window.scrollTo({ top: 0, behavior });
        document
          .querySelector<HTMLElement>("[data-scroll-panel]")
          ?.scrollTo({ top: 0, behavior });
      }}
      className={`glass fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[70] px-3.5 py-2 text-[13px] text-[var(--text)] transition-[opacity,visibility] duration-300 ${
        shown ? "visible opacity-100" : "invisible pointer-events-none opacity-0"
      }`}
    >
      ↑ 回到顶部
    </button>
  );
}

function curatedByKey(
  block: Block | null,
  field: "curated" | "items",
): CuratedItem[] {
  if (!block) return [];
  const data = block.data as Record<string, unknown> | null;
  const arr = data?.[field];
  return Array.isArray(arr) ? (arr as CuratedItem[]) : [];
}

function findItem(items: CuratedItem[], key: string): CuratedItem | undefined {
  return items.find((i) => i.key === key);
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate：本地缓存上一份完整载荷，打开页面第一帧先用它
// 立起地球和面板；服务端快照随后校正，后台 refreshData 回来后逐项比对，
// 只有变了的值才就地替换并短暂高亮，整页不重排、视角不被打断。
// ---------------------------------------------------------------------------

const LS_DASH_KEY = "finance-globe:dashboard:v1";

/** 载荷的新鲜度 = 各区块里最晚的 fetchedAt（块自带的取数时刻，不冒充） */
function dashFreshness(d: Dashboard): number {
  let m = 0;
  for (const b of [
    d.fx,
    d.mag7,
    d.rates,
    d.m2,
    d.rents,
    d.volatility,
    d.countryCaps,
  ]) {
    if (b && b.fetchedAt > m) m = b.fetchedAt;
  }
  return m || d.generatedAt;
}

function readLocalDashboard(): Dashboard | null {
  try {
    const raw = window.localStorage.getItem(LS_DASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Dashboard;
    if (
      !parsed ||
      typeof parsed.generatedAt !== "number" ||
      !("fx" in parsed) ||
      !("mag7" in parsed)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalDashboard(d: Dashboard): void {
  try {
    const raw = window.localStorage.getItem(LS_DASH_KEY);
    if (raw) {
      const prev = JSON.parse(raw) as Dashboard;
      if (
        prev &&
        typeof prev.generatedAt === "number" &&
        dashFreshness(prev) >= dashFreshness(d)
      )
        return;
    }
    window.localStorage.setItem(LS_DASH_KEY, JSON.stringify(d));
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃，服务端快照仍是兜底。
  }
}

/** 把载荷里所有面板「值」抽成 key→标量，供新旧逐项比对 */
function collectValues(d: Dashboard): Map<string, string | number | null> {
  const out = new Map<string, string | number | null>();
  const fx = d.fx?.data as { pairs?: FxPair[] } | null | undefined;
  for (const p of fx?.pairs ?? []) out.set(`fx:${p.code}`, p.rate);
  const rates = d.rates?.data as
    | {
        us?: {
          effRate: FredObsT | null;
          dgs2: FredObsT | null;
          dgs10: FredObsT | null;
        };
        curated?: CuratedItem[];
      }
    | null
    | undefined;
  out.set("usr:eff", rates?.us?.effRate?.value ?? null);
  out.set("usr:dgs2", rates?.us?.dgs2?.value ?? null);
  out.set("usr:dgs10", rates?.us?.dgs10?.value ?? null);
  for (const i of rates?.curated ?? []) out.set(`cur:${i.key}`, i.value);
  const mag7 = d.mag7?.data as
    | { rows?: Mag7Row[]; total?: number }
    | null
    | undefined;
  for (const r of mag7?.rows ?? [])
    out.set(
      `m7:${r.symbol}`,
      `${r.price}|${r.marketCap ?? ""}|${r.changeYearPct ?? ""}`,
    );
  out.set("m7:total", mag7?.total ?? null);
  out.set("m7:chg30", d.mag7TotalChange30d);
  const ccaps = d.countryCaps?.data as
    | {
        rows?: CountryCapRow[];
        topTotal?: number;
        topChangePct?: number | null;
        topDecomp?: CountryCapDecomp | null;
      }
    | null
    | undefined;
  for (const r of ccaps?.rows ?? []) {
    out.set(`cc:${r.code}`, r.marketCap ?? null);
    out.set(`ccr:${r.code}`, r.decomp?.residualUsd ?? null);
  }
  out.set("cc:topTotal", ccaps?.topTotal ?? null);
  out.set("cc:topChg", ccaps?.topChangePct ?? null);
  out.set("cc:topResid", ccaps?.topDecomp?.residualUsd ?? null);
  const m2 = d.m2?.data as { countries?: M2Country[] } | null | undefined;
  for (const c of m2?.countries ?? [])
    out.set(`m2:${c.code}`, `${c.latestYear ?? ""}|${c.latestValue ?? ""}`);
  const rents = d.rents?.data as { items?: CuratedItem[] } | null | undefined;
  for (const i of rents?.items ?? []) out.set(`rent:${i.key}`, i.value);
  const vol = d.volatility?.data as
    | { vix: { value: number } | null; indices: IndexRow[] }
    | null
    | undefined;
  out.set("vix", vol?.vix?.value ?? null);
  for (const idx of vol?.indices ?? []) out.set(`idx:${idx.name}`, idx.price);
  return out;
}

function diffDashboards(prev: Dashboard, next: Dashboard): Set<string> {
  const a = collectValues(prev);
  const b = collectValues(next);
  const changed = new Set<string>();
  for (const [k, v] of b) {
    if (!a.has(k) || a.get(k) !== v) changed.add(k);
  }
  return changed;
}

/** 刷新进行时的小转圈：14px 细环，只在 updating 时挂载，刷新一停立刻消失。 */
function RefreshSpinner({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`refresh-spinner ${className}`} />;
}

/**
 * 顶栏右上角唯一的数据状态元素（状态与刷新合并，用户定）：正常态
 * （数据新鲜）只显示一枚圆形绿色对勾徽章（用户定，2026-11-13），
 * 「数据截至 HH:MM」/ 刚刷新完短暂「已更新 HH:MM」的全文保留在
 * aria-label 与 title 里供朗读与悬停查看；数据超过 2 小时变琥珀色
 * 文字药丸「显示的是 HH:MM 的数据」，超过 24 小时带日期；刷新失败
 * 同样变色标注文字，旧数据保留不冒充最新——警告态不用对勾，避免
 * 把旧数据标成正常。后台自动更新进行中时，徽章内的对勾换成一枚
 * 转圈，不带任何「更新中…」文字。没有手动刷新按钮：打开页面走
 * SWR + 后台自动刷新，另有每日刷新兜底。
 */
function DataStatus({
  data,
  updating,
  failed,
  updatedAt,
}: {
  data: Dashboard | null;
  updating: boolean;
  failed: boolean;
  updatedAt: number | null;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const pill =
    "pointer-events-auto inline-flex min-h-[30px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[rgba(4,10,22,0.62)] px-3 py-1 text-[11px] whitespace-nowrap backdrop-blur-sm";
  if (!data) {
    return (
      <p
        className="pointer-events-auto grid h-[30px] w-[30px] place-items-center rounded-full border border-[var(--border)] bg-[rgba(4,10,22,0.62)] backdrop-blur-sm"
        role="status"
        aria-label="数据加载中"
      >
        <RefreshSpinner className="text-[var(--gold)]" />
      </p>
    );
  }
  const fetchedAt = dashFreshness(data);
  const hm = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const age = Date.now() - fetchedAt;
  let text: string;
  let warn = false;
  if (failed) {
    // 短版文案：与左上角时钟同排时手机宽度放得下；含义不变——
    // 失败时保留的就是截至这个时间的数据，不冒充最新。
    text = `数据截至 ${hm.format(fetchedAt)} · 更新失败`;
    warn = true;
  } else if (updatedAt && Date.now() - updatedAt < 12_000 && !updating) {
    text = `已更新 ${hm.format(updatedAt)}`;
  } else if (age > 24 * 3600_000) {
    const md = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    text = `显示的是 ${md.format(fetchedAt)} 的数据`;
    warn = true;
  } else if (age > 2 * 3600_000) {
    text = `显示的是 ${hm.format(fetchedAt)} 的数据`;
    warn = true;
  } else {
    text = `数据截至 ${hm.format(fetchedAt)}`;
  }
  if (warn) {
    // 警告态（过时 / 更新失败）：保留琥珀色文字药丸把具体时间说清，
    // 不用对勾徽章——旧数据不能标成正常。
    return (
      <p
        className={`${pill} text-[#ffc45e]`}
        role="status"
        aria-label={updating ? `${text}，正在更新` : text}
      >
        {updating && <RefreshSpinner className="text-[var(--gold)]" />}
        <span>{text}</span>
      </p>
    );
  }
  // 正常态：圆形绿色对勾徽章（30px，与旧药丸同高，顶栏布局不变；
  // 名签顶部安全带的右侧一段已因本徽章横向只占右缘约 42px 而退
  // 役、只余左侧时钟段，见 Globe 的 labelTopSafePx 处注）；全文进
  // aria-label / title。更新进行中时徽章内对勾换成白色转圈，不出
  // 现「更新中…」之类的文字。
  return (
    <p
      className="pointer-events-auto grid h-[30px] w-[30px] place-items-center rounded-full shadow-[0_0_12px_rgba(61,220,151,0.35)]"
      style={{ background: "#22b573" }}
      role="status"
      aria-label={updating ? `${text}，正在更新` : text}
      title={text}
    >
      {updating ? (
        <RefreshSpinner className="text-white" />
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4.5 12.5 10 18 19.5 6.5"
            stroke="#ffffff"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </p>
  );
}

/**
 * 底栏主页星球菜单：按钮只显示当前星球名称（如「地球」「火星」），
 * 不带前缀与箭头，靠它在底栏的位置与按下反馈传达可点。点开名单
 * （太阳、八大行星、月球），当前星球高亮标明，点哪颗直接换哪颗；
 * 地球只是名单里的一项，不再有专属的「换回地球」按钮。点外部
 * （全屏透明背板）关闭。地球与客串两种主页状态下常驻同一入口。
 * 菜单高度只露出约 5–6 项，其余靠内部纵向滚动到达；打开时当前
 * 星球自动滚到可见位置。菜单宽度收窄为 w-32（128px），并在打开
 * 时实测按钮位置把菜单中心钳进视口安全区——锚点贴着按钮，但整
 * 体不许出屏（旧 w-40 居中展开在按钮贴边时会被屏幕边缘切掉）。
 */
function PlanetMenuButton(props: {
  current: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSwitch: (id: string) => void;
}) {
  const { current, open, onToggle, onClose, onSwitch } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 菜单横向钳制偏移（px）：菜单以按钮为锚居中展开，但底栏换行时
   * 按钮可能贴近屏幕边缘，居中展开会把菜单左/右半边推出屏外被切
   * （用户实报）。打开时实测按钮中心，把菜单中心钳进视口安全区
   * （左右各留 8px），偏移经 transform 叠加在 -50% 之上 */
  const [menuShiftX, setMenuShiftX] = useState(0);

  useEffect(() => {
    if (!open) return;
    const MENU_W = 128; // w-32，与下方菜单宽度保持一致
    const clampShift = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const vw = window.innerWidth;
      const minCenter = 8 + MENU_W / 2;
      const maxCenter = vw - 8 - MENU_W / 2;
      const clamped =
        maxCenter < minCenter
          ? vw / 2
          : Math.min(maxCenter, Math.max(minCenter, center));
      setMenuShiftX(clamped - center);
    };
    clampShift();
    window.addEventListener("resize", clampShift);
    return () => window.removeEventListener("resize", clampShift);
  }, [open ]);

  // 打开菜单时把当前星球滚到可见位置：只调菜单容器自身的
  // scrollTop（不用 scrollIntoView，避免带动整页滚动），把当前项
  // 尽量居中到可视区，首尾项则自然贴边。
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const container = menuRef.current;
      const item = currentItemRef.current;
      if (!container || !item) return;
      const cRect = container.getBoundingClientRect();
      const iRect = item.getBoundingClientRect();
      const fullyVisible =
        iRect.top >= cRect.top && iRect.bottom <= cRect.bottom;
      if (fullyVisible) return;
      const delta =
        iRect.top - cRect.top - (cRect.height - iRect.height) / 2;
      container.scrollTop += delta;
    });
    return () => cancelAnimationFrame(raf);
  }, [open, current]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label={`切换主页星球，当前是${BODY_INFO[current]?.name ?? current}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
        className="rounded-full border border-[var(--border)] bg-[rgba(8,25,48,0.65)] px-3 py-1.5 text-[13px] whitespace-nowrap text-[var(--text)] backdrop-blur transition active:scale-95 sm:px-4 sm:text-sm"
      >
        {BODY_INFO[current]?.name ?? current}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="关闭星球菜单"
            onClick={onClose}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label="选择主页星球"
            style={{
              transform: `translateX(calc(-50% + ${menuShiftX}px))`,
            }}
            className="glass absolute bottom-full left-1/2 z-20 mb-2 max-h-[212px] w-32 max-w-[calc(100vw-16px)] touch-pan-y overflow-y-auto overscroll-contain scroll-smooth p-1.5 [-webkit-overflow-scrolling:touch]"
          >
            {HOME_PLANET_MENU.map((id) => {
              const cur = id === current;
              return (
                <button
                  key={id}
                  ref={cur ? currentItemRef : undefined}
                  type="button"
                  role="menuitemradio"
                  aria-checked={cur}
                  aria-label={`把${BODY_INFO[id]?.name ?? id}设为主页星球`}
                  onClick={() => onSwitch(id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-[7px] text-sm whitespace-nowrap ${
                    cur
                      ? "bg-[rgba(255,196,94,0.16)] font-semibold text-[#ffd98f]"
                      : "text-[var(--text)]"
                  }`}
                >
                  <span>{BODY_INFO[id]?.name ?? id}</span>
                  {cur && <span className="text-[11px]">当前</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<CountryCode | null>(null);
  const [selectedCenter, setSelectedCenter] = useState<CenterInfo | null>(
    null,
  );
  const [autoRotate, setAutoRotate] = useState(true);
  const [solarSystem, setSolarSystem] = useState(false);
  /** 太阳系取景（移动端）：near 近览内圈（默认）/ full 全览 */
  const [solarView, setSolarView] = useState<"near" | "full">("near");
  /** 太阳系聚焦观赏的天体 id（点星球飞近）；null = 太阳系总览 */
  const [focusedBody, setFocusedBody] = useState<string | null>(null);
  /** 主页星球：本次浏览内把某天体设为主页大球；只存组件状态，
   * 不写 localStorage——重新打开空间必然回到默认地球 */
  const [homePlanet, setHomePlanet] = useState<string>("earth");
  /** 底栏星球名按钮的菜单开合（点开选星直接换主页星球） */
  const [planetMenuOpen, setPlanetMenuOpen] = useState(false);
  const planetMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 菜单换星：点哪颗就把主页换成哪颗，带与连点送主页同口径的转
   * 场——保持当前星球身份先进太阳系（当前星球按 Globe 的主页星
   * 球轨迹飞回它自己的轨道位，全程不许先复位成地球：旧实现这里
   * 写死 setHomePlanet("earth")，非地球→非地球换星时主页会先被
   * 完整的地球顶替一程、再缩向地球轨道，用户实报），让太阳系组
   * 装到大半程、目标星球在其自己的轨道位置就位后，再把它送回主
   * 页，回程轨迹由 Globe 按该天体自己的太阳系位置飞入。选地球
   * 则直接切回（地球本就是主页默认构图，无需绕太阳系）。主页星
   * 球仍不记忆：只动组件状态，重开空间回地球。
   */
  const switchHomePlanet = (id: string) => {
    setPlanetMenuOpen(false);
    if (id === homePlanet) return;
    if (planetMenuTimer.current) clearTimeout(planetMenuTimer.current);
    if (id === "earth") {
      setHomePlanet("earth");
      return;
    }
    setSelected(null);
    setSelectedCenter(null);
    setSelectedCableId(null);
    setSolarSystem(true);
    planetMenuTimer.current = setTimeout(() => {
      setHomePlanet(id);
      setFocusedBody(null);
      setSolarSystem(false);
    }, 1500);
  };
  /** 底栏/图例的「外壳态」：与 Globe 的 2.3 秒转场对齐——进入太阳
   * 系立即切换，返回主页时等转场接近落位（约 2 秒）才换成主页
   * 外壳。否则连点送主页时底栏会先在太阳系总览画面上跳成主页
   * 外壳，转场看着就是「总览停顿 → 硬切」两段（录屏实证） */
  const [shellSolar, setShellSolar] = useState(false);
  useEffect(() => {
    if (solarSystem) {
      setShellSolar(true);
      return;
    }
    const id = setTimeout(() => setShellSolar(false), 2050);
    return () => clearTimeout(id);
  }, [solarSystem]);
  // 进太阳系时收起星球菜单（底栏随之换成太阳系外壳，菜单不许在
  // 回到主页时自己重新弹开）
  useEffect(() => {
    if (solarSystem) setPlanetMenuOpen(false);
  }, [solarSystem]);
  const [legendOpen, setLegendOpen] = useState(false);

  // 本地缓存的上一份载荷：只读一次，作为查询的 initialData——第一帧
  // 直接用上次数据立起画面，不等任何网络往返（stale-while-revalidate）。
  const [localCache] = useState<Dashboard | null>(() => readLocalDashboard());

  const dash = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.getDashboard({}),
    staleTime: 30_000,
    ...(localCache
      ? {
          initialData: localCache,
          initialDataUpdatedAt: dashFreshness(localCache),
        }
      : {}),
  });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.refreshData({ forceSlow: false }),
    onSuccess: (data) => {
      queryClient.setQueryData(["dashboard"], data);
      setLastUpdatedAt(Date.now());
    },
  });
  const data = dash.data ?? refresh.data;

  // 每次拿到（可能更新的）载荷就回写本地缓存，供下次打开秒出画面。
  useEffect(() => {
    if (dash.data) writeLocalDashboard(dash.data);
  }, [dash.data]);

  // 新载荷与上一份逐项比对：变了的值就地替换并短暂高亮（value-flash），
  // 没变的原样不动；只改面板数字，不碰地球视角与太阳系状态。
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<string>>(new Set());
  const prevDataRef = useRef<Dashboard | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const prev = prevDataRef.current;
    prevDataRef.current = data ?? null;
    if (!prev || !data || prev === data) return;
    const changed = diffDashboards(prev, data);
    if (!changed.size) return;
    setFlashKeys(changed);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashKeys(new Set()), 1500);
  }, [data]);
  const fl = (...keys: string[]) =>
    keys.some((k) => flashKeys.has(k)) ? " value-flash" : "";

  // 画面立起来之后，后台静默刷新一次：不阻塞、不盖加载态；没有
  // 手动刷新按钮，进度只反映在右上角合并状态元素旁的转圈上。
  const autoRefreshFired = useRef(false);
  useEffect(() => {
    if (autoRefreshFired.current) return;
    autoRefreshFired.current = true;
    const id = setTimeout(() => {
      // 已有数据（本地缓存或服务端快照）才后台刷；真·首次加载时
      // getDashboard 已在服务端内联取数，不重复触发。
      if (queryClient.getQueryData(["dashboard"])) refresh.mutate();
    }, 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fxPairs = useMemo<FxPair[]>(() => {
    const d = data?.fx?.data as { pairs?: FxPair[] } | null | undefined;
    return d?.pairs ?? [];
  }, [data]);

  const intensity = useMemo(() => {
    const m = Math.max(
      0,
      ...fxPairs
        .filter((p) => p.code === "USD/CNY" || p.code === "USD/JPY")
        .map((p) => Math.abs(p.changePct ?? 0)),
    );
    return Math.min(1, m / 0.8);
  }, [fxPairs]);

  const curated = useMemo(
    () => curatedByKey(data?.rates ?? null, "curated"),
    [data],
  );
  /** 一行央行利率：有策展值显示值与日期，没核到如实显示「未查到」。 */
  const rateRow = (key: string, label: string) => {
    const item = findItem(curated, key);
    return (
      <div
        key={key}
        className="flex items-baseline justify-between text-sm"
      >
        <span className="text-[var(--dim)]">{label}</span>
        <span className={`num font-medium${fl(`cur:${key}`)}`}>
          {item ? item.value : "未查到"}
          {item && (
            <span className="ml-2 text-[11px] text-[var(--dim)]">
              {item.asOf}
            </span>
          )}
        </span>
      </div>
    );
  };
  const rentItems = useMemo(
    () => curatedByKey(data?.rents ?? null, "items"),
    [data],
  );
  const m2Countries = useMemo<M2Country[]>(() => {
    const d = data?.m2?.data as { countries?: M2Country[] } | null | undefined;
    return d?.countries ?? [];
  }, [data]);
  const mag7Rows = useMemo<Mag7Row[]>(() => {
    const d = data?.mag7?.data as { rows?: Mag7Row[] } | null | undefined;
    return d?.rows ?? [];
  }, [data]);
  const mag7Total = useMemo(() => {
    const d = data?.mag7?.data as { total?: number } | null | undefined;
    return d?.total ?? null;
  }, [data]);
  const countryCapData = useMemo(() => {
    const d = data?.countryCaps?.data as
      | {
          rows?: CountryCapRow[];
          topTotal?: number;
          globalTotal?: number;
          countryCount?: number;
          historyDays?: number;
          historyPoints?: number;
          backfillPoints?: number;
          backfillFrom?: string | null;
          backfillTo?: string | null;
          liveSince?: string | null;
          topChangePct?: number | null;
          topWindowDays?: number;
          topChangeBasis?:
            | "12m"
            | "full"
            | "30d"
            | "sinceStart"
            | "calibrated"
            | "mixed"
            | null;
          calibrationAnchor?: string | null;
          topDecomp?: CountryCapDecomp | null;
        }
      | null
      | undefined;
    return d ?? null;
  }, [data]);

  /** 每行那句「从什么时候开始算」的说明，全用日期和人话：
   *  12m = 近 12 个月（基点日期与实际天数照实标注）/
   *  full = 从最早一条记录开始算 / 30d = 最近 30 天 /
   *  sinceStart = 从开始记录以来 / calibrated = 中国行只从
   *  2025 年 7 月底、名单稳定下来之后开始算 / mixed = 合计行，
   *  其他行从最早记录开始算、中国行从 2025 年 7 月底开始算 */
  const capWindowLabel = (
    basis:
      | "12m"
      | "full"
      | "30d"
      | "sinceStart"
      | "calibrated"
      | "mixed"
      | null
      | undefined,
    days: number | undefined,
    baseDate?: string,
    lastDate?: string,
  ): string =>
    basis === "12m"
      ? baseDate && lastDate
        ? `近 12 个月（${baseDate} 到 ${lastDate}，${days ?? 0} 天）`
        : "近 12 个月"
      : basis === "full"
        ? baseDate && lastDate
          ? `从 ${baseDate} 到 ${lastDate}`
          : `从最早记录到现在（${days ?? 0} 天）`
        : basis === "calibrated"
          ? `从 ${baseDate ?? "2025-07-31"} 开始算（公司名单稳定下来之后）`
          : basis === "mixed"
            ? `合计：其他行从 ${baseDate ?? "2024-12-31"} 开始算，中国从 ${countryCapData?.calibrationAnchor ?? "2025-07-31"} 开始算`
            : basis === "30d"
              ? "最近 30 天"
              : `从开始记录以来（${days ?? 0} 天）`;
  const capWindowShort = (
    basis:
      | "12m"
      | "full"
      | "30d"
      | "sinceStart"
      | "calibrated"
      | "mixed"
      | null
      | undefined,
    days: number | undefined,
    baseDate?: string,
  ): string =>
    basis === "12m"
      ? "近12个月"
      : basis === "full"
        ? baseDate
          ? `${baseDate} 起`
          : "最早记录起"
        : basis === "calibrated"
          ? "2025年7月底起"
          : basis === "mixed"
            ? "各行分开算"
            : basis === "30d"
              ? "近30日"
              : `记录${days ?? 0}日`;
  /** 统计公司变多提醒：数字照常显示，只在后面加一枚琥珀小签，
   *  提醒这段时间统计的公司变多了，涨幅里混着这一块 */
  const coverageBadge = (notes?: string[]) => (
    <span
      className="ml-1.5 inline-block rounded border border-[rgba(255,196,94,0.5)] bg-[rgba(255,196,94,0.12)] px-1 py-px align-middle text-[10px] font-medium text-[#ffd98f]"
      title={notes?.join("；")}
    >
      这段时间统计的公司变多了，涨幅里混着这一块
    </span>
  );
  const countryCapRows = countryCapData?.rows ?? [];
  const usRates = useMemo(() => {
    const d = data?.rates?.data as
      | { us?: { effRate: FredObsT | null; dgs2: FredObsT | null; dgs10: FredObsT | null } }
      | null
      | undefined;
    return d?.us ?? null;
  }, [data]);
  const vol = useMemo(() => {
    const d = data?.volatility?.data as
      | {
          vix: { value: number; date: string; change30d: number | null } | null;
          indices: IndexRow[];
        }
      | null
      | undefined;
    return d ?? null;
  }, [data]);

  // —— 地球上的交易所指数板：与波动率板块同一份快照（volatility.
  // boards，服务端逐板抓 Yahoo chart API + 交易时段推导开市状态），
  // 直接喂 Globe 寄生在金融中心标记上渲染；数据时间沿用波动率
  // 板块的来源/截至标注，不另起口径。
  const indexBoards = useMemo<IndexBoardInfo[]>(() => {
    const d = data?.volatility?.data as
      | { boards?: IndexBoardInfo[] }
      | null
      | undefined;
    return d?.boards ?? [];
  }, [data]);

  // —— 海底光缆状态层（服务端 cables 区块：策展故障记录 + IODA 信号）——
  interface CableIncident {
    cableId: string;
    cable: string;
    date: string;
    detail: string;
    landings: string;
    status: string;
    sourceName: string;
    sourceUrl: string;
  }
  interface IodaEvent {
    code: string;
    country: string;
    start: string;
    datasource: string;
    ongoing: boolean;
  }
  const cableData = useMemo(() => {
    const d = data?.cables?.data as
      | {
          incidents?: CableIncident[];
          signals?: { events?: IodaEvent[]; checkedAt?: string } | null;
          corridorSignals?: Record<
            string,
            {
              countries: string[];
              latestStart: string;
              datasource: string;
            } | null
          >;
          signalsStale?: boolean;
        }
      | null
      | undefined;
    return d ?? null;
  }, [data]);
  /** 走廊信号（信号层）：某缆的监测走廊国家出现 IODA 异常时的标记
   * 数据；与新闻台账严格分层——它不等于这条缆断了 */
  const corridorOf = (id: string) => cableData?.corridorSignals?.[id] ?? null;
  /** IODA 数据源代码 → 可读名（代码是 IODA 接口原样返回的通道名，
   * 裸代码对读者不透明，呈现时一律译名，来源仍是 IODA 本身） */
  const dsLabel = (ds: string): string =>
    ds === "bgp"
      ? "IODA · BGP 路由信号"
      : ds === "gtr"
        ? "IODA · 流量信号"
        : ds === "active"
          ? "IODA · 主动探测信号"
          : `IODA · ${ds} 信号`;
  const cableIncidents = cableData?.incidents ?? [];
  const incidentByCable = useMemo(() => {
    const m = new Map<string, CableIncident>();
    for (const i of cableIncidents) if (!m.has(i.cableId)) m.set(i.cableId, i);
    return m;
  }, [cableIncidents]);
  // 地球仪光缆层与板块共用同一份状态分档（同一数据源、同一口径）：
  // 板块徽标是什么档，球上光带就是什么色，不许两套口径
  const cableStatusById = useMemo(() => {
    const rec: Record<string, CableStatusInfo> = {};
    for (const c of CABLES) {
      rec[c.id] = cableStatusFor(incidentByCable.get(c.id) ?? null);
    }
    return rec;
  }, [incidentByCable]);
  const [selectedCableId, setSelectedCableId] = useState<string | null>(null);
  /** 海缆板块卡默认折叠（2026-11-13，用户：平常收起来，需要时点开）；
   *  状态只在本次打开内保持，不跨次记忆 */
  const [cablesOpen, setCablesOpen] = useState(false);
  /** 租金卡与海缆卡同待遇（2026-11-14 追加）：默认折叠，摘要放
   *  东京、上海两城当前值；状态同样只在本次打开内保持 */
  const [rentsOpen, setRentsOpen] = useState(false);
  const [cableFilter, setCableFilter] = useState<
    "all" | "jp" | CableContinent
  >("all");
  const visibleCables = useMemo(() => {
    const list = CABLES.filter((c) =>
      cableFilter === "all"
        ? true
        : cableFilter === "jp"
          ? c.jp
          : c.continents.includes(cableFilter),
    );
    // 与日本相关的排前面（用户最相关优先），组内保持策展顺序
    return [...list].sort((a, b) => Number(b.jp) - Number(a.jp));
  }, [cableFilter]);
  // 海缆卡收起时的一句状态摘要：有异常直接点名（保住警报功能），
  // 且与卡内同一套分档——公开故障记录和走廊信号异常分开说，不混
  // 成一档；没有就大白话说未见异常，不写「正常」。
  const cableIncidentCables = CABLES.filter((c) =>
    incidentByCable.has(c.id),
  );
  const cableCorridorOnlyCables = CABLES.filter(
    (c) => !incidentByCable.has(c.id) && corridorOf(c.id),
  );
  const cableIodaEvents = cableData?.signals?.events ?? [];
  const cableSummary = (() => {
    const nameList = (list: typeof CABLES) => {
      const names = list.slice(0, 3).map((c) => c.name);
      return `${names.join("、")}${list.length > 3 ? " 等" : ""}`;
    };
    const parts: string[] = [];
    if (cableIncidentCables.length) {
      parts.push(
        `${cableIncidentCables.length} 条有公开故障记录：${nameList(cableIncidentCables)}`,
      );
    }
    if (cableCorridorOnlyCables.length) {
      parts.push(
        `${cableCorridorOnlyCables.length} 条走廊信号异常：${nameList(cableCorridorOnlyCables)}`,
      );
    }
    if (cableIodaEvents.length) {
      parts.push(`IODA 检出 ${cableIodaEvents.length} 条国家级异常信号`);
    }
    if (!parts.length) {
      return cableData?.signalsStale
        ? "未见异常报告 · 信号源本次不可达，沿用上次检查结果"
        : "未见异常报告";
    }
    return parts.join("；");
  })();
  const cableSummaryTone = cableIncidentCables.length
    ? "font-medium text-[#ff9c9c]"
    : cableCorridorOnlyCables.length || cableIodaEvents.length
      ? "font-medium text-[#ffd98f]"
      : "text-[var(--dim)]";
  // 租金卡收起时的一句摘要：东京、上海两城的当前值（值串沿用卡内
  // 现行写法，自带单位口径）；两城都缺时给一句展开提示。
  const rentSummary = (() => {
    const parts: string[] = [];
    const tokyo = rentItems.find((r) => r.key === "rent_tokyo");
    const shanghai = rentItems.find((r) => r.key === "rent_shanghai");
    if (tokyo) parts.push(`东京 ${tokyo.value}`);
    if (shanghai) parts.push(`上海 ${shanghai.value}`);
    return parts.length ? parts.join(" · ") : "点标题展开看各城租金";
  })();

  const tickerItems = useMemo(() => {
    const items: Array<{ label: string; value: string; pct: number | null }> =
      [];
    for (const p of fxPairs)
      items.push({
        label: p.code,
        value: p.rate.toLocaleString("en-US", {
          minimumFractionDigits: p.rate < 10 ? 4 : 3,
          maximumFractionDigits: p.rate < 10 ? 4 : 3,
        }),
        pct: p.changePct,
      });
    for (const idx of vol?.indices ?? [])
      items.push({
        label: idx.name,
        value: idx.price.toLocaleString("en-US", {
          maximumFractionDigits: 1,
        }),
        pct: idx.changePct,
      });
    if (vol?.vix)
      items.push({
        label: "VIX",
        value: vol.vix.value.toFixed(2),
        pct: null,
      });
    if (mag7Total != null)
      items.push({ label: "Mag7 合计市值", value: fmtT(mag7Total), pct: null });
    if (countryCapData?.topTotal != null)
      items.push({
        label: "Cap 7 合计市值",
        value: fmtT(countryCapData.topTotal),
        pct: null,
      });
    return items;
  }, [fxPairs, vol, mag7Total, countryCapData]);

  const fxOf = (code: string) => fxPairs.find((p) => p.code === code);
  const m2Of = (code: string) => m2Countries.find((c) => c.code === code);
  const indexOf = (name: string) => vol?.indices.find((i) => i.name === name);

  const countryCard = (code: CountryCode) => {
    const meta = COUNTRY_META[code];
    const lines: Array<{ k: string; v: string; sub?: string; fk?: string }> =
      [];
    if (code === "US") {
      if (usRates?.effRate)
        lines.push({
          k: "联邦基金有效利率",
          v: `${usRates.effRate.value.toFixed(2)}%`,
          sub: usRates.effRate.date,
          fk: "usr:eff",
        });
      if (usRates?.dgs10)
        lines.push({
          k: "美债 10 年期",
          v: `${usRates.dgs10.value.toFixed(2)}%`,
          sub: usRates.dgs10.date,
          fk: "usr:dgs10",
        });
      const spx = indexOf("标普 500");
      if (spx)
        lines.push({
          k: "标普 500",
          v: spx.price.toLocaleString("en-US", { maximumFractionDigits: 1 }),
          sub: fmtPct(spx.changePct),
          fk: "idx:标普 500",
        });
      if (mag7Total)
        lines.push({
          k: "Mag7 合计市值",
          v: fmtT(mag7Total),
          sub: "七家合计",
          fk: "m7:total",
        });
    }
    if (code === "CN") {
      const repo = findItem(curated, "cn_onrr");
      if (repo)
        lines.push({
          k: "隔夜逆回购利率",
          v: repo.value,
          sub: repo.asOf,
          fk: "cur:cn_onrr",
        });
      const lpr = findItem(curated, "cn_lpr1y");
      if (lpr)
        lines.push({
          k: "1 年期 LPR",
          v: lpr.value,
          sub: lpr.asOf,
          fk: "cur:cn_lpr1y",
        });
      const fx = fxOf("USD/CNY");
      if (fx)
        lines.push({
          k: "USD/CNY",
          v: fx.rate.toFixed(4),
          sub: `日 ${fmtPct(fx.changePct, 3)}`,
          fk: "fx:USD/CNY",
        });
      const sh = indexOf("上证综指");
      if (sh)
        lines.push({
          k: "上证综指",
          v: sh.price.toLocaleString("en-US", { maximumFractionDigits: 1 }),
          sub: fmtPct(sh.changePct),
          fk: "idx:上证综指",
        });
    }
    if (code === "JP") {
      const jp = findItem(curated, "jp_policy");
      if (jp)
        lines.push({
          k: "日银政策利率",
          v: jp.value,
          sub: jp.asOf,
          fk: "cur:jp_policy",
        });
      const fx = fxOf("USD/JPY");
      if (fx)
        lines.push({
          k: "USD/JPY",
          v: fx.rate.toFixed(3),
          sub: `日 ${fmtPct(fx.changePct, 3)}`,
          fk: "fx:USD/JPY",
        });
      const nk = indexOf("日经 225");
      if (nk)
        lines.push({
          k: "日经 225",
          v: nk.price.toLocaleString("en-US", { maximumFractionDigits: 1 }),
          sub: fmtPct(nk.changePct),
          fk: "idx:日经 225",
        });
    }
    const m2 = m2Of(code);
    if (m2 && m2.latestValue != null)
      lines.push({
        k: `${m2.measure ?? "M2"} 年增速`,
        v: `${m2.latestValue.toFixed(2)}%`,
        sub: `${m2.latestYear} 年`,
        fk: `m2:${m2.code}`,
      });
    const rents = rentItems.filter(
      (i) => RENT_CITY[i.key]?.country === code,
    );
    return (
      <div
        className="glass card-pop pointer-events-auto absolute inset-x-3 bottom-16 z-20 max-h-[46%] overflow-y-auto p-4 lg:inset-x-auto lg:right-4 lg:bottom-20 lg:w-[340px]"
        role="dialog"
        aria-label={`${meta.name}小结`}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-display text-base font-semibold">
            <span
              className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: meta.color }}
            />
            {meta.name} · {meta.cities.join(" / ")}
          </h3>
          <button
            type="button"
            aria-label="关闭小结"
            onClick={() => setSelected(null)}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--dim)]"
          >
            关闭
          </button>
        </div>
        {lines.length ? (
          <dl className="divide-y divide-[rgba(94,148,205,0.14)]">
            {lines.map((l) => (
              <div
                key={l.k}
                className="flex items-baseline justify-between gap-3 py-1.5"
              >
                <dt className="text-xs text-[var(--dim)]">{l.k}</dt>
                <dd
                  className={`num text-sm font-medium${l.fk ? fl(l.fk) : ""}`}
                >
                  {l.v}
                  {l.sub && (
                    <span className="ml-2 text-[11px] text-[var(--dim)]">
                      {l.sub}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-[var(--dim)]">数据加载中…</p>
        )}
        {rents.length > 0 && (
          <div className="mt-2 border-t border-[rgba(94,148,205,0.14)] pt-2">
            {rents.map((r) => (
              <p key={r.key} className="py-0.5 text-xs text-[var(--dim)]">
                {RENT_CITY[r.key]?.city}房租：
                <span className={`num text-[var(--text)]${fl(`rent:${r.key}`)}`}>
                  {r.value}
                </span>
                （{r.source} · {r.asOf}）
              </p>
            ))}
          </div>
        )}
      </div>
    );
  };

  const centerCard = (c: CenterInfo) => {
    const idxName = CENTER_INDEX[c.id];
    const idx = idxName ? indexOf(idxName) : undefined;
    return (
      <div
        className="glass card-pop pointer-events-auto absolute inset-x-3 bottom-16 z-20 p-4 lg:inset-x-auto lg:right-4 lg:bottom-20 lg:w-[340px]"
        role="dialog"
        aria-label={`${c.name}金融中心`}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-display text-base font-semibold">
            <span
              className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: regionColorFor(c.country, c.coreCountry) }}
            />
            {c.name}
            <span className="ml-2 text-xs font-normal text-[var(--dim)]">
              {c.en}
            </span>
          </h3>
          <button
            type="button"
            aria-label="关闭金融中心小卡"
            onClick={() => setSelectedCenter(null)}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--dim)]"
          >
            关闭
          </button>
        </div>
        <dl className="divide-y divide-[rgba(94,148,205,0.14)]">
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-xs text-[var(--dim)]">国家 / 地区</dt>
            <dd className="text-sm font-medium">{c.country}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-xs text-[var(--dim)]">级别</dt>
            <dd className="text-sm font-medium">
              {c.tier === 1
                ? "第一梯队 · 全球顶级金融中心"
                : c.tier === 2
                  ? "第二梯队 · 主要金融中心"
                  : "第三梯队 · 区域金融中心"}
            </dd>
          </div>
          {idx && (
            <div className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-xs text-[var(--dim)]">
                市场指数 · {idxName}
              </dt>
              <dd
                className={`num text-sm font-medium${idxName ? fl(`idx:${idxName}`) : ""}`}
              >
                {idx.price.toLocaleString("en-US", {
                  maximumFractionDigits: 1,
                })}
                <span className={`ml-2 text-xs ${pctColor(idx.changePct)}`}>
                  {fmtPct(idx.changePct)}
                </span>
              </dd>
            </div>
          )}
        </dl>
        {!idx && (
          <p className="pt-2 text-[11px] text-[var(--dim)]">
            该市场的主要指数不在本页收录范围内。
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="stars-bg min-h-screen overflow-x-clip text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="#040814" />
      <div className="mx-auto max-w-[1560px] lg:grid lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)]">
        {/* 地球区：页面顶部的普通流式区块，随页面一起滚出屏幕 */}
        <section
          className="relative h-[54svh] lg:h-screen"
          style={{
            background:
              "linear-gradient(180deg, rgba(4,8,20,0.25) 0%, rgba(4,8,20,0) 78%, rgba(4,8,20,0.9) 100%)",
          }}
          aria-label="3D 地球监控区"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:px-5">
            <TokyoClock />
            {/* 右上角只此一处：数据状态与刷新反馈合并（见 DataStatus） */}
            <DataStatus
              data={data ?? null}
              updating={refresh.isPending}
              failed={refresh.isError}
              updatedAt={lastUpdatedAt}
            />
          </div>

          <div className="absolute inset-0">
            <Suspense
              fallback={
                <div
                  className="grid h-full w-full place-items-center"
                  aria-hidden="true"
                >
                  <div
                    className="aspect-square w-[min(62%,380px)] animate-pulse rounded-full"
                    style={{
                      background:
                        "radial-gradient(circle at 62% 38%, rgba(255,217,163,0.28) 0%, rgba(56,120,246,0.20) 42%, rgba(4,10,22,0) 72%)",
                    }}
                  />
                </div>
              }
            >
              <Globe
                intensity={intensity}
                selected={selected}
                autoRotate={autoRotate}
                solarSystem={solarSystem}
                solarView={solarView}
                focusedBody={focusedBody}
                homePlanet={homePlanet}
                indexBoards={indexBoards}
                cableStatusById={cableStatusById}
                onCableSelect={(id) => {
                  setSelected(null);
                  setSelectedCenter(null);
                  setSelectedCableId(id);
                }}
                onSelect={(c) => {
                  setSelectedCenter(null);
                  setSelectedCableId(null);
                  setSelected(c);
                }}
                onCenterSelect={(c) => {
                  setSelected(null);
                  setSelectedCableId(null);
                  setSelectedCenter(c);
                }}
                onSolarSystemChange={(v) => {
                  if (v) {
                    setSelected(null);
                    setSelectedCenter(null);
                  } else {
                    setFocusedBody(null);
                  }
                  setSolarSystem(v);
                }}
                onBodyFocus={(id) => {
                  // 极简切换（用户口径）：点一下天体 = 太阳系内聚焦；
                  // 已聚焦时再点同一颗 = 把它放到主页代替地球，人随即
                  // 回主页。整条链只用「点星球」与「返回太阳系」两个
                  // 动作，不设专门的切换按钮。
                  if (id && focusedBody === id) {
                    setHomePlanet(id);
                    setFocusedBody(null);
                    setSelected(null);
                    setSelectedCenter(null);
                    setSolarSystem(false);
                    return;
                  }
                  setFocusedBody(id);
                }}
              />
            </Suspense>
          </div>

          {/* 极淡暗角：把视觉重心收回球体 */}
          <div
            className="pointer-events-none absolute inset-0 z-10"
            style={{
              background:
                "radial-gradient(ellipse 74% 64% at 50% 46%, transparent 56%, rgba(2,6,16,0.52) 100%)",
            }}
            aria-hidden="true"
          />

          {/* 地域配色图例（可折叠，默认收起）：静止状态只剩一个「图例」
              小钮，不压住地球本体；点开才展开地域色板与说明（连接线
              2026-11-11 起按地域定性色板取色，中/日/美为锚点色）。
              太阳系模式下隐藏（与轨道图无关）。 */}
          {!shellSolar && (
            <div
              className={`absolute left-3 z-10 lg:bottom-16 lg:left-5 ${
                homePlanet === "earth" ? "bottom-24" : "bottom-14"
              }`}
            >
              {legendOpen ? (
                <div className="max-w-[calc(100vw-1.5rem)] rounded-xl bg-[rgba(4,10,22,0.72)] px-2.5 py-1.5 text-[10px] text-[var(--dim)] backdrop-blur-sm sm:max-w-[430px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="shrink-0">线色 · 按地域</span>
                    <button
                      type="button"
                      aria-label="收起图例"
                      aria-expanded={true}
                      onClick={() => setLegendOpen(false)}
                      className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--dim)]"
                    >
                      收起
                    </button>
                  </div>
                  <div
                    className="mt-1 flex items-center gap-2 overflow-x-auto whitespace-nowrap"
                    aria-label="连接线地域配色图例"
                  >
                    {REGION_LEGEND.map(({ code, label, color }) => (
                      <span
                        key={code}
                        className="flex shrink-0 items-center gap-1"
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{ background: color }}
                        />
                        {label}
                      </span>
                    ))}
                  </div>
                  <p className="mt-0.5">
                    跨地域线为两端地域色渐变 · 线越粗越亮、双向粒子越密，金融梯队越高
                  </p>
                  <p className="mt-0.5">
                    明暗按真实太阳走 · 城市名下小字为当地时间
                  </p>
                  <p className="mt-0.5">
                    轨道卫星为示意 · 倾角与相对周期按真实轨道（静止轨道卫星与地球同步）
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label="展开图例"
                  aria-expanded={false}
                  onClick={() => setLegendOpen(true)}
                  className="rounded-full border border-[var(--border)] bg-[rgba(4,10,22,0.55)] px-2.5 py-1 text-[10px] text-[var(--dim)] backdrop-blur-sm"
                >
                  图例
                </button>
              )}
            </div>
          )}

          {selected && countryCard(selected)}
          {selectedCenter && centerCard(selectedCenter)}

          {/* 聚焦观赏信息片：星球名 + 一行真实数据，贴左下角边缘，
              不挡画面中央的星球本体 */}
          {solarSystem && focusedBody && BODY_INFO[focusedBody] && (
            <div
              className="glass card-pop pointer-events-none absolute bottom-16 left-3 z-20 max-w-[76vw] px-3.5 py-2.5 lg:bottom-20 lg:left-5"
              role="status"
              aria-label={`${BODY_INFO[focusedBody]!.name}信息`}
            >
              <p className="font-display text-base font-semibold text-[#eaf3ff]">
                {BODY_INFO[focusedBody]!.name}
                <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                  {BODY_INFO[focusedBody]!.en}
                </span>
              </p>
              <p className="num mt-0.5 text-[11px] text-[var(--dim)]">
                {BODY_INFO[focusedBody]!.facts}
              </p>
              {focusedBody === "earth" && (
                <p className="mt-0.5 text-[11px] text-[var(--dim)]">
                  月球在绕地轨道内 · 盈亏由太阳光照决定
                </p>
              )}
              {focusedBody === "moon" && (
                <p className="mt-0.5 text-[11px] text-[var(--dim)]">
                  月面似乎有访客 · 居民散布在整个月面，绕着看看
                </p>
              )}
              <p className="mt-0.5 text-[11px] text-[#ffd98f]">
                再点一次这颗星球：放到主页
              </p>
              {focusedBody === "saturn" && (
                <p className="mt-0.5 text-[11px] text-[var(--dim)]">
                  环带含卡西尼缝 · 环面倾角约 27°
                </p>
              )}
            </div>
          )}

          {/* 光缆小片：点中球上光带/登陆点时出现，缆名 + 与板块同口径
              的状态文案（同色圆点），关掉或点别处即收 */}
          {!solarSystem && selectedCableId && (
            (() => {
              const c = CABLES.find((x) => x.id === selectedCableId);
              if (!c) return null;
              const st = cableStatusById[c.id] ?? cableStatusFor(null);
              const dot =
                st.tier === "fault"
                  ? "#ff6b5e"
                  : st.tier === "watch"
                    ? "#ffc45e"
                    : "#3ddc97";
              return (
                <div
                  className="glass card-pop pointer-events-auto absolute bottom-16 left-3 z-20 max-w-[76vw] px-3.5 py-2.5 lg:bottom-20 lg:left-5"
                  role="status"
                  aria-label={`海底光缆 ${c.name}：${st.label}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-display text-base font-semibold text-[#eaf3ff]">
                      {c.name}
                    </p>
                    <button
                      type="button"
                      aria-label="关闭光缆信息"
                      onClick={() => setSelectedCableId(null)}
                      className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--dim)]"
                    >
                      关闭
                    </button>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text)]">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: dot }}
                    />
                    {st.label}
                    <span className="text-[var(--dim)]">
                      · {c.status} · {c.year} 投产
                    </span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-[var(--dim)]">
                    {c.route} · 全长 {c.km} km
                  </p>
                  {corridorOf(c.id) && (
                    <p className="mt-0.5 text-[11px] text-[#ffd98f]">
                      走廊信号异常 · 待核实（
                      {corridorOf(c.id)!.countries.join("、")} ·{" "}
                      {corridorOf(c.id)!.latestStart
                        .slice(0, 16)
                        .replace("T", " ")}{" "}
                      UTC · {dsLabel(corridorOf(c.id)!.datasource)}，
                      不等于本缆故障）
                    </p>
                  )}
                </div>
              );
            })()
          )}

          <div className="absolute inset-x-0 bottom-3 z-20 flex flex-wrap items-center justify-center gap-2 px-3">
            {shellSolar ? (
              focusedBody ? (
              <>
              <button
                type="button"
                aria-label="返回太阳系总览"
                onClick={() => setFocusedBody(null)}
                className="rounded-full border border-transparent bg-[#ffc45e] px-4 py-1.5 text-sm font-semibold text-[#04101f] backdrop-blur"
              >
                返回太阳系
              </button>
              </>
              ) : (
              <>
              {/* 太阳系总览回主页走「点星球聚焦 → 再点送主页」的既有
                  链路，不再设「返回地球」按钮（用户口径删除；聚焦态
                  的「返回太阳系」保留不动） */}
              {/* 移动端取景切换：近览框住内圈看得清，全览看八大行星全貌；
                  桌面端恒全览，不显示这两个钮 */}
              <button
                type="button"
                aria-label="近览内圈行星"
                aria-pressed={solarView === "near"}
                onClick={() => setSolarView("near")}
                className={`rounded-full border px-3.5 py-1.5 text-sm backdrop-blur lg:hidden ${
                  solarView === "near"
                    ? "border-transparent bg-[#ffc45e] font-semibold text-[#04101f]"
                    : "border-[var(--border)] bg-[rgba(8,25,48,0.65)] text-[var(--text)]"
                }`}
              >
                近览
              </button>
              <button
                type="button"
                aria-label="全览太阳系"
                aria-pressed={solarView === "full"}
                onClick={() => setSolarView("full")}
                className={`rounded-full border px-3.5 py-1.5 text-sm backdrop-blur lg:hidden ${
                  solarView === "full"
                    ? "border-transparent bg-[#ffc45e] font-semibold text-[#04101f]"
                    : "border-[var(--border)] bg-[rgba(8,25,48,0.65)] text-[var(--text)]"
                }`}
              >
                全览
              </button>
              </>
              )
            ) : (
              <>
            {homePlanet !== "earth" ? (
              <PlanetMenuButton
                current={homePlanet}
                open={planetMenuOpen}
                onToggle={() => setPlanetMenuOpen((v) => !v)}
                onClose={() => setPlanetMenuOpen(false)}
                onSwitch={switchHomePlanet}
              />
            ) : (
            <>
            <PlanetMenuButton
              current={homePlanet}
              open={planetMenuOpen}
              onToggle={() => setPlanetMenuOpen((v) => !v)}
              onClose={() => setPlanetMenuOpen(false)}
              onSwitch={switchHomePlanet}
            />
            {(Object.keys(COUNTRY_META) as CountryCode[]).map((code) => (
              <button
                key={code}
                type="button"
                aria-label={`查看${COUNTRY_META[code].name}小结`}
                aria-pressed={selected === code}
                onClick={() => {
                  setSelectedCenter(null);
                  setSelected(selected === code ? null : code);
                }}
                className={`rounded-full border px-3 py-1.5 text-[13px] whitespace-nowrap backdrop-blur transition sm:px-4 sm:text-sm ${
                  selected === code
                    ? "border-transparent font-semibold text-[#04101f]"
                    : "border-[var(--border)] bg-[rgba(8,25,48,0.65)] text-[var(--text)]"
                }`}
                style={
                  selected === code
                    ? { background: COUNTRY_META[code].color }
                    : undefined
                }
              >
                {COUNTRY_META[code].name}
              </button>
            ))}
            </>
            )}
            <button
              type="button"
              aria-label={
                autoRotate
                  ? "暂停：冻结地球自转（明暗保持此刻真实昼夜）"
                  : "恢复：地球继续自转"
              }
              aria-pressed={autoRotate}
              onClick={() => setAutoRotate(!autoRotate)}
              className="rounded-full border border-[var(--border)] bg-[rgba(8,25,48,0.65)] px-2.5 py-1.5 text-[13px] whitespace-nowrap text-[var(--dim)] backdrop-blur sm:px-3.5 sm:text-sm"
            >
              {autoRotate ? "暂停自转" : "恢复自转"}
            </button>
            <button
              type="button"
              aria-label="进入太阳系视图"
              onClick={() => {
                setSelected(null);
                setSelectedCenter(null);
                setFocusedBody(null);
                setSolarSystem(true);
              }}
              className="rounded-full border border-[rgba(255,196,94,0.5)] bg-[rgba(8,25,48,0.65)] px-2.5 py-1.5 text-[13px] whitespace-nowrap text-[#ffd98f] backdrop-blur sm:px-3.5 sm:text-sm"
            >
              太阳系
            </button>
              </>
            )}
          </div>
        </section>

        {/* 数据面板列：data-scroll-panel 供 BackToTop 定位页面内的
            面板滚动盒（若宿主布局使面板成为实际滚动者）；当前布局下
            它不是滚动盒，标记只是定位锚，样式与滚动模型不变。 */}
        <main
          data-scroll-panel=""
          className="relative z-10 space-y-4 px-3 pt-3 pb-10 lg:px-5 lg:py-6"
        >
          {tickerItems.length > 0 && (
            <div
              className="glass overflow-hidden py-2"
              aria-hidden="true"
            >
              <div className="marquee-track flex w-max items-center">
                {[...tickerItems, ...tickerItems].map((it, i) => (
                  <span
                    key={i}
                    className="mr-9 flex items-baseline gap-2 whitespace-nowrap text-xs"
                  >
                    <span className="text-[var(--dim)]">{it.label}</span>
                    <span className="num font-medium text-[#eaf3ff]">
                      {it.value}
                    </span>
                    {it.pct != null && (
                      <span className={`num ${pctColor(it.pct)}`}>
                        {fmtPct(it.pct)}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {dash.isError && !data && (
            <section className="glass p-5" aria-label="加载失败">
              <p className="text-sm text-[#ff9c9c]">
                数据加载失败，可能是数据源暂时不可用。
              </p>
              <button
                type="button"
                onClick={() => dash.refetch()}
                className="mt-3 rounded-full border border-[rgba(56,225,255,0.45)] px-4 py-1.5 text-sm text-[#aee9ff]"
              >
                重试
              </button>
            </section>
          )}

          {/* 月相：天文算法实时计算，与太阳系 3D 月球同源 */}
          <MoonPhaseCard />

          {/* Cap 7：国家市值排名（按公司是哪国的来算；美国+加拿大、中国+台湾各合并一行） */}
          <BlockShell
            title="Cap 7 市值"
            block={data?.countryCaps ?? null}
            freq="前 7 名 · 走势每年一个点"
            emptyText="国家市值排名尚未就绪，会自动更新，请稍候再看。"
            hideSourceLine
          >
            <p className="-mt-1 mb-3 text-xs text-[var(--dim)]">
              国家市值排名 · 按公司是哪国的来算
            </p>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div>
                <span className="text-xs text-[var(--dim)]">
                  前七合计市值（合并行计七行）
                </span>
                <div
                  className={`num text-2xl font-bold text-[#eaf3ff]${fl("cc:topTotal")}`}
                >
                  {countryCapData?.topTotal != null ? (
                    <AnimNum value={countryCapData.topTotal} format={fmtT} />
                  ) : (
                    "—"
                  )}
                </div>
                {countryCapData?.topDecomp ? (
                  <div
                    className={`num mt-0.5 text-[11px] text-[var(--dim)]${fl("cc:topResid")}`}
                  >
                    {capWindowLabel(
                      countryCapData.topDecomp.basis,
                      countryCapData.topDecomp.windowDays,
                      countryCapData.topDecomp.baseDate,
                      countryCapData.topDecomp.lastDate,
                    )}
                    ；市值变化里剩下的那一块{" "}
                    <span
                      className={`font-semibold ${residualColor(countryCapData.topDecomp.residualUsd)}`}
                    >
                      {fmtUsdSigned(countryCapData.topDecomp.residualUsd)}（
                      {fmtPct(countryCapData.topDecomp.residualPct)}）
                    </span>
                    {countryCapData.topDecomp.coverageChange
                      ? coverageBadge(countryCapData.topDecomp.coverageNotes)
                      : null}
                  </div>
                ) : (
                  <div className="mt-0.5 text-[11px] text-[var(--dim)]">
                    {countryCapData?.backfillPoints
                      ? `过去的走势已从存档补回（共 ${countryCapData.backfillPoints} 个存档月点）· 下面那句账等下一次刷新算出`
                      : `走势和下面那句账还在攒数据 · 已攒 ${countryCapData?.historyDays ?? 0} 天`}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                {countryCapData?.topChangePct != null && (
                  <>
                    <div className="text-xs text-[var(--dim)]">
                      {countryCapData.topChangeBasis === "mixed"
                        ? "合计涨跌（中国从2025年7月底起算）"
                        : countryCapData.topChangeBasis === "12m"
                          ? "合计涨跌（近 12 个月）"
                          : `涨跌（${capWindowShort(countryCapData.topChangeBasis, countryCapData.topWindowDays, countryCapData.topDecomp?.baseDate ?? countryCapData.backfillFrom ?? undefined)} 起算）`}
                    </div>
                    <div
                      className={`num text-base font-semibold ${pctColor(countryCapData.topChangePct)}${fl("cc:topChg")}`}
                    >
                      {fmtPct(countryCapData.topChangePct)}
                    </div>
                  </>
                )}
                {countryCapData?.globalTotal != null &&
                  countryCapData?.topTotal != null && (
                    <div className="mt-1">
                      <div className="text-xs text-[var(--dim)]">
                        占这次统计的各国总和
                      </div>
                      <div className="num text-base font-semibold text-[#eaf3ff]">
                        {(
                          (countryCapData.topTotal /
                            countryCapData.globalTotal) *
                          100
                        ).toFixed(1)}
                        %
                      </div>
                    </div>
                  )}
              </div>
            </div>
            <ul className="divide-y divide-[rgba(94,148,205,0.12)]">
              {countryCapRows.map((r) => (
                <li key={r.code} className="py-2">
                  <div className="flex items-center gap-3">
                    <span className="num w-4 text-xs text-[var(--dim)]">
                      {r.rank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium leading-snug">
                        {r.name}
                        <span className="ml-1.5 text-[11px] text-[var(--dim)]">
                          {r.code}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[rgba(94,148,205,0.15)]">
                        <div
                          className="h-full rounded bg-[#38e1ff]"
                          style={{
                            width: countryCapData?.topTotal
                              ? `${Math.max(2, (r.marketCap / countryCapData.topTotal) * 100)}%`
                              : "0%",
                          }}
                        />
                      </div>
                      <div className="num mt-0.5 text-[10px] text-[var(--dim)]">
                        占全球 {r.sharePct.toFixed(1)}% ·{" "}
                        {r.companies.toLocaleString("en-US")} 家
                      </div>
                    </div>
                    <Spark
                      values={r.spark ?? []}
                      width={54}
                      height={22}
                      splitIndex={(() => {
                        // 虚线分界取两者靠后者：2023 早期点（收录
                        // 太薄、只作参考）与中国行校准锚点之前的
                        // 段落，都不算进涨跌、都以虚线淡色区隔。
                        const earlySplit = r.sparkEarly
                          ? r.sparkEarly.findIndex((e) => !e)
                          : -1;
                        const calibSplit =
                          r.calibrationAnchor && r.sparkDates
                            ? r.sparkDates.findIndex(
                                (d) => d >= r.calibrationAnchor!,
                              )
                            : -1;
                        const s = Math.max(earlySplit, calibSplit);
                        return s > 0 ? s : null;
                      })()}
                    />
                    <div
                      className={`w-[92px] shrink-0 text-right${fl(`cc:${r.code}`)}`}
                    >
                      <div className="num text-sm font-semibold">
                        {fmtT(r.marketCap)}
                      </div>
                      {r.changePct != null ? (
                        <div
                          className={`num text-[11px] ${pctColor(r.changePct)}`}
                        >
                          {fmtPct(r.changePct)}
                          <span className="ml-1 text-[10px] text-[var(--dim)]">
                            {capWindowShort(
                              r.changeBasis,
                              r.windowDays,
                              r.decomp?.baseDate ?? r.sparkDates?.[0],
                            )}
                          </span>
                        </div>
                      ) : (
                        <div className="text-[11px] text-[var(--dim)]">
                          暂时还算不了涨跌
                        </div>
                      )}
                    </div>
                  </div>
                  {r.calibrationAnchor ? (
                    <p className="ml-7 mt-0.5 text-[10px] leading-relaxed text-[var(--dim)]">
                      这一行的涨幅只按 {r.calibrationAnchor}{" "}
                      名单稳定下来之后的数据算；走势线里虚线那一段，统计的公司和后来不一样，不算进涨跌里。
                    </p>
                  ) : null}
                  {r.code === "CN+TW" ? (
                    <div
                      role="note"
                      aria-label="先说清：中国这一行，有一段涨幅是假的"
                      className="ml-7 mt-2 rounded-lg border border-[rgba(255,107,107,0.6)] bg-[rgba(255,107,107,0.10)] px-3 py-2.5"
                    >
                      <p className="text-[13px] font-bold leading-snug text-[#ffb1b1]">
                        ⚠ 先说清：中国这一行，有一段涨幅是假的
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[#f3c1c1]">
                        {"2025 年 7 月，做这张表的数据网站把统计的中国公司从 329 家加到 474 家——多出来的近 2 万亿美元涨幅，大半是名单变长，不是股票涨的，跟上交所、深交所、港交所无关。所以这一行只从 2025 年 7 月底、名单稳定后开始算。"}
                      </p>
                    </div>
                  ) : null}
                  {r.code === "CH" ? (
                    <div
                      role="note"
                      aria-label="提醒一句：瑞士这一行，有将近三分之一不在瑞士交易"
                      className="ml-7 mt-2 rounded-lg border border-[rgba(255,196,94,0.55)] bg-[rgba(255,196,94,0.09)] px-3 py-2.5"
                    >
                      <p className="text-[13px] font-bold leading-snug text-[#ffd98f]">
                        {"⚠ 提醒一句：瑞士这一行，有将近三分之一不在瑞士交易"}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-[#f0dfb8]">
                        {"这一行是按注册地算的，约 3.2 万亿美元，但近三分之一的公司只是在瑞士注册，股票在纽约、伦敦买卖；瑞士自己的交易所总共只有约 2.3 万亿美元。"}
                      </p>
                    </div>
                  ) : null}
                  {r.decomp ? (
                    <p
                      className={`num ml-7 mt-1 text-[11px] leading-relaxed text-[var(--dim)]${fl(`ccr:${r.code}`)}`}
                    >
                      {capWindowLabel(
                        r.decomp.basis,
                        r.decomp.windowDays,
                        r.decomp.baseDate,
                        r.decomp.lastDate,
                      )}
                      ：市值 {fmtUsdSigned(r.decomp.deltaUsd)}（
                      {fmtPct(r.decomp.deltaPct)}），其中跟着大盘和汇率涨的{" "}
                      {fmtUsdSigned(r.decomp.valuationUsd)}，剩下的{" "}
                      <span
                        className={`font-semibold ${residualColor(r.decomp.residualUsd)}`}
                      >
                        {fmtUsdSigned(r.decomp.residualUsd)}（
                        {fmtPct(r.decomp.residualPct)}）
                      </span>
                      {r.decomp.coverageChange
                        ? coverageBadge(r.decomp.coverageNotes)
                        : null}
                      {r.decomp.coverageChange && r.decomp.coverageNotes?.length
                        ? `（${r.decomp.coverageNotes.join("；")}）`
                        : null}
                    </p>
                  ) : null}
                  {r.combined && r.components ? (
                    <div className="ml-7 mt-1.5 space-y-0.5">
                      {r.components.map((c) => (
                        <div key={c.code}>
                          <div className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--dim)]">
                            <span>
                              {c.name}
                              <span className="ml-1 opacity-70">{c.code}</span>
                            </span>
                            <span className="num">
                              {fmtT(c.marketCap)} ·{" "}
                              {c.companies.toLocaleString("en-US")} 家
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--dim)]">
              按公司是哪国的加总（在国外上市的算本国）；美国和加拿大、中国和台湾各并一行，并完取前七。行首涨幅都是近
              12 个月的；中国行的窗口在 2025 年 7 月底之后，见行内说明。
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
              走势每年一个点：2023
              年的点来自 Wayback 存档，那时收录的公司少得多、只作参考；近年的点是把每月记下的数在年底取一个。
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
              每行下面那句账，是先按大盘涨跌和汇率算一遍市值该变多少，实际多出的差额混着新上市、增发回购和大盘之外的涨跌，不能当资金流入流出看。七行合计就是每行变化的加总。
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
              来源：CompaniesMarketCap 各国上市公司市值榜；指数来自 Yahoo
              Finance，汇率来自 Frankfurter / FRED · 截至{" "}
              {data?.countryCaps?.asOf ?? "—"}
            </p>
          </BlockShell>

          {/* Mag7 */}
          <BlockShell
            title="Mag7 市值"
            block={data?.mag7 ?? null}
            freq="日频行情"
            emptyText="Mag7 行情尚未就绪，会自动更新，请稍候再看。"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <div>
                <span className="text-xs text-[var(--dim)]">
                  合计市值（八家公司 · 合并行计七行）
                </span>
                <div
                  className={`num text-2xl font-bold text-[#eaf3ff]${fl("m7:total")}`}
                >
                  {mag7Total != null ? (
                    <AnimNum value={mag7Total} format={fmtT} />
                  ) : (
                    "—"
                  )}
                </div>
              </div>
              {data?.mag7TotalChange30d != null && (
                <div className="text-right">
                  <div className="text-xs text-[var(--dim)]">近 30 日</div>
                  <div
                    className={`num text-base font-semibold ${pctColor(data.mag7TotalChange30d)}${fl("m7:chg30")}`}
                  >
                    {fmtPct(data.mag7TotalChange30d)}
                  </div>
                </div>
              )}
            </div>
            <ul className="divide-y divide-[rgba(94,148,205,0.12)]">
              {mag7Rows.map((r, i) => (
                <li key={r.symbol} className="py-2">
                  <div className="flex items-center gap-3">
                    <span className="num w-4 text-xs text-[var(--dim)]">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium leading-snug">
                        {r.name}
                        <span className="ml-1.5 text-[11px] text-[var(--dim)]">
                          {r.combined ? "TSLA + SPCX" : r.symbol}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-[rgba(94,148,205,0.15)]">
                        <div
                          className="h-full rounded bg-[#38e1ff]"
                          style={{
                            width: mag7Total
                              ? `${Math.max(2, ((r.marketCap ?? 0) / mag7Total) * 100)}%`
                              : "0%",
                          }}
                        />
                      </div>
                    </div>
                    <Spark
                      values={
                        r.combined
                          ? r.sparkM && r.sparkM.length >= 2
                            ? r.sparkM
                            : r.spark
                          : r.sparkY && r.sparkY.length >= 2
                            ? r.sparkY
                            : r.sparkM && r.sparkM.length >= 2
                              ? r.sparkM
                              : r.spark
                      }
                      width={54}
                      height={22}
                    />
                    <div
                      className={`w-[92px] shrink-0 text-right${fl(`m7:${r.symbol}`)}`}
                    >
                      <div className="num text-sm font-semibold">
                        {fmtT(r.marketCap)}
                      </div>
                      {r.changeYearPct != null ? (
                        <>
                          <div
                            className={`num text-[11px] font-medium ${pctColor(r.changeYearPct)}`}
                          >
                            {fmtPct(r.changeYearPct)}
                            <span className="ml-1 text-[9px] font-normal text-[var(--dim)]">
                              {r.combined ? "上市以来" : "近12个月"}
                            </span>
                          </div>
                          <div className="num text-[10px] text-[var(--dim)]">
                            今日{" "}
                            <span className={pctColor(r.changePct)}>
                              {fmtPct(r.changePct)}
                            </span>
                            {r.price != null
                              ? ` · $${r.price.toFixed(2)}`
                              : ""}
                          </div>
                        </>
                      ) : (
                        <div
                          className={`num text-[11px] ${pctColor(r.changePct)}`}
                        >
                          {r.price != null
                            ? `${fmtPct(r.changePct)} · $${r.price.toFixed(2)}`
                            : fmtPct(r.changePct)}
                        </div>
                      )}
                    </div>
                  </div>
                  {r.combined && r.components ? (
                    <div className="ml-7 mt-1.5 space-y-0.5">
                      {r.components.map((c) => (
                        <div
                          key={c.symbol}
                          className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--dim)]"
                        >
                          <span>
                            {c.name}
                            <span className="ml-1 opacity-70">{c.symbol}</span>
                          </span>
                          <span className="num">
                            {fmtT(c.marketCap)}
                            {c.price != null
                              ? ` · $${c.price.toFixed(2)}`
                              : ""}
                            {"  "}
                            <span className={pctColor(c.changePct)}>
                              {fmtPct(c.changePct)}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--dim)]">
              Tesla 与 SpaceX 合并为一行：市值相加，涨跌按市值加权，走势从
              SpaceX 2026 年 6
              月上市起算、行首百分比是上市以来的涨跌。其他行走势线每年一个点（2016
              年起每年年底的收盘，再加上最新收盘），行首百分比是近 12
              个月的涨跌，今日涨跌在它下面小字里。
            </p>
          </BlockShell>

          {/* M2 等广义货币 · 年度增速（各国央行口径，九地与 Cap 7 同步） */}
          <BlockShell
            title="广义货币年增速"
            block={data?.m2 ?? null}
            freq="年度数据"
            emptyText="货币增速数据尚未就绪，会自动更新，请稍候再看。"
          >
            <p className="mb-3 rounded-lg border border-[rgba(255,196,94,0.35)] bg-[rgba(255,196,94,0.08)] px-3 py-2 text-xs text-[#ffd98f]">
              数字来自各国央行。英国公布的是 M4、印度和瑞士是
              M3、法国用欧元区 M3——名字不同，是因为各国公布的口径本来就不一样。最新完整年多为{" "}
              {m2Countries.find((c) => c.latestYear != null)?.latestYear ??
                "—"}{" "}
              年。
            </p>
            <div className="space-y-3">
              {m2Countries.map((c) => (
                <div
                  key={c.code}
                  className="rounded-lg border border-[rgba(94,148,205,0.16)] bg-[rgba(10,24,46,0.5)] p-3"
                >
                  {/* 第一行：国名·口径·年份 左，主数字 右（420 宽实测：
                      左列最长「法国 · M3（欧元区）· 2025 年」约 168px ＋
                      主数字约 92px ＋ 间距，合计远小于 356px 内容宽，
                      不挤压不换行）。来源行移到整行第二行全宽折行，
                      避免旧版塞在左列里把各行撑得参差。 */}
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 text-xs whitespace-nowrap text-[var(--dim)]">
                      {c.name} · {c.measure ?? "M2"} · {c.latestYear ?? "—"} 年
                    </div>
                    <div
                      className={`num shrink-0 text-xl font-semibold${fl(`m2:${c.code}`)}`}
                    >
                      {c.latestValue != null
                        ? `${c.latestValue.toFixed(2)}%`
                        : "未查到"}
                    </div>
                  </div>
                  <div className="mt-1 flex items-end justify-between gap-3">
                    <div className="min-w-0 text-[10px] leading-relaxed text-[var(--dim)]">
                      {c.source ?? ""}
                    </div>
                    <div className="shrink-0 text-right">
                      <Spark
                        values={c.points.map((p) => p.value)}
                        width={104}
                        height={26}
                        color="#ffc45e"
                        labels={
                          c.points.length
                            ? [
                                `${c.points[0]!.year} 年 ${c.points[0]!.value.toFixed(1)}%`,
                                `${c.points[c.points.length - 1]!.year} 年 ${c.points[c.points.length - 1]!.value.toFixed(1)}%`,
                              ]
                            : undefined
                        }
                      />
                    </div>
                  </div>
                  <div className="mt-0.5 text-right text-[10px] text-[var(--dim)]">
                    {c.points.length
                      ? `近 ${c.points.length} 年 · ${c.points[0]!.year}–${c.points[c.points.length - 1]!.year} · ${c.basis === "eop" ? "按年末存量算" : "按年平均存量算"}`
                      : "暂未核到可引用的发布值"}
                  </div>
                </div>
              ))}
            </div>
          </BlockShell>

          {/* 汇率 · 利率 */}
          <BlockShell
            title="汇率 · 利率"
            block={data?.fx ?? null}
            freq="汇率日频 / 利率日频·月频发布"
            emptyText="汇率数据尚未就绪，会自动更新，请稍候再看。"
          >
            <div className="grid grid-cols-2 gap-3">
              {fxPairs.map((p) => (
                <div
                  key={p.code}
                  className="rounded-lg border border-[rgba(94,148,205,0.16)] bg-[rgba(10,24,46,0.5)] p-3"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-[var(--dim)]">{p.code}</span>
                    <span className={`num text-xs ${pctColor(p.changePct)}`}>
                      {fmtPct(p.changePct, 3)}
                    </span>
                  </div>
                  <div
                    className={`num mt-1 text-xl font-semibold${fl(`fx:${p.code}`)}`}
                  >
                    <AnimNum
                      value={p.rate}
                      format={(v) =>
                        v.toLocaleString("en-US", {
                          minimumFractionDigits: v < 10 ? 4 : 3,
                          maximumFractionDigits: v < 10 ? 4 : 3,
                        })
                      }
                    />
                  </div>
                  <div className="mt-1 flex justify-end">
                    <Spark values={p.spark} width={96} height={22} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2 border-t border-[rgba(94,148,205,0.14)] pt-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-[var(--dim)]">
                  美国 · 联邦基金有效利率
                </span>
                <span className={`num font-medium${fl("usr:eff")}`}>
                  {usRates?.effRate
                    ? `${usRates.effRate.value.toFixed(2)}%`
                    : "—"}
                  <span className="ml-2 text-[11px] text-[var(--dim)]">
                    {usRates?.effRate?.date ?? ""}
                  </span>
                </span>
              </div>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-[var(--dim)]">美国 · 国债 2Y / 10Y</span>
                <span
                  className={`num font-medium${fl("usr:dgs2", "usr:dgs10")}`}
                >
                  {usRates?.dgs2 ? `${usRates.dgs2.value.toFixed(2)}%` : "—"}
                  {" / "}
                  {usRates?.dgs10 ? `${usRates.dgs10.value.toFixed(2)}%` : "—"}
                  <span className="ml-2 text-[11px] text-[var(--dim)]">
                    {usRates?.dgs10?.date ?? ""}
                  </span>
                </span>
              </div>
              {rateRow("ca_policy", "加拿大 · 央行隔夜利率目标")}
              {rateRow("cn_onrr", "中国 · 隔夜逆回购利率（主要政策利率）")}
              {findItem(curated, "cn_lpr1y") && (
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-[var(--dim)]">中国 · LPR 1Y / 5Y</span>
                  <span
                    className={`num font-medium${fl("cur:cn_lpr1y", "cur:cn_lpr5y")}`}
                  >
                    {findItem(curated, "cn_lpr1y")!.value}
                    {" / "}
                    {findItem(curated, "cn_lpr5y")?.value ?? "—"}
                    <span className="ml-2 text-[11px] text-[var(--dim)]">
                      {findItem(curated, "cn_lpr1y")!.asOf}
                    </span>
                  </span>
                </div>
              )}
              {rateRow("tw_rediscount", "台湾 · 央行重贴现率")}
              {rateRow("jp_policy", "日本 · 日银政策利率")}
              {rateRow("gb_bank_rate", "英国 · 英格兰银行利率")}
              {rateRow("in_repo", "印度 · 央行回购利率")}
              {rateRow("ch_policy", "瑞士 · 央行政策利率")}
              {rateRow("fr_ecb_df", "法国（欧洲央行）· 存款便利利率")}
              <p className="text-[11px] text-[var(--dim)]">
                美国利率来自 FRED 日频；其余为各国央行官方发布值，央行开会或公布后才变。法国用的是欧洲央行的利率。
              </p>
            </div>
          </BlockShell>

          {/* 房租：默认折叠（与海缆卡同规格），摘要放东京、上海 */}
          <section className="glass p-4 sm:p-5" aria-label="核心城市房租">
            {data?.rents ? (
              <>
                <button
                  type="button"
                  onClick={() => setRentsOpen((v) => !v)}
                  aria-expanded={rentsOpen}
                  aria-label={
                    rentsOpen ? "收起核心城市房租板块" : "展开核心城市房租板块"
                  }
                  className="flex w-full items-baseline justify-between gap-2 text-left"
                >
                  <h2 className="font-display text-lg font-semibold tracking-wide text-[#eaf3ff]">
                    核心城市房租
                  </h2>
                  <span className="flex shrink-0 items-baseline gap-2">
                    <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--dim)]">
                      月频发布
                    </span>
                    <span className="text-[11px] whitespace-nowrap text-[var(--dim)]">
                      {rentsOpen ? "收起 ∧" : "展开 ∨"}
                    </span>
                  </span>
                </button>
                {!rentsOpen && (
                  <p className="mt-2 text-xs text-[var(--dim)]">{rentSummary}</p>
                )}
                <div
                  aria-hidden={!rentsOpen}
                  className={`grid transition-all duration-300 ease-out ${
                    rentsOpen
                      ? "mt-3 grid-rows-[1fr] opacity-100"
                      : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    {rentItems.length ? (
                      <ul className="divide-y divide-[rgba(94,148,205,0.12)]">
                        {rentItems.map((r) => (
                          <li
                            key={r.key}
                            className="flex items-baseline gap-3 py-2"
                          >
                            <span
                              className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full"
                              style={{
                                background: RENT_CITY[r.key]?.color ?? "#7d90ad",
                              }}
                            />
                            <div className="flex-1">
                              <span className="text-sm font-medium">
                                {RENT_CITY[r.key]?.city ?? r.label}
                              </span>
                              {r.detail && (
                                <span className="ml-2 text-[11px] text-[var(--dim)]">
                                  {r.detail}
                                </span>
                              )}
                            </div>
                            <div className="text-right">
                              <div
                                className={`num text-sm font-semibold${fl(`rent:${r.key}`)}`}
                              >
                                {r.value}
                              </div>
                              <div className="text-[10px] text-[var(--dim)]">
                                {r.source} · {r.asOf}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="py-3 text-sm text-[var(--dim)]">
                        本轮核查尚未取得可引用的发布值，下一轮每日刷新会继续核查。
                      </p>
                    )}
                    <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
                      按 80㎡、两房估算，各城市原始口径不同，是估算不是报价；人民币按当日汇率折算。
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--dim)]">
                      来源：{data.rents.source} · 截至 {data.rents.asOf || "—"}
                      {data.rents.status === "stale" && (
                        <span className="text-[#ffc45e]">
                          {" "}
                          · 本次更新失败，显示最近一次可用数据
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h2 className="font-display text-lg font-semibold tracking-wide text-[#eaf3ff]">
                    核心城市房租
                  </h2>
                  <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--dim)]">
                    月频发布
                  </span>
                </div>
                <p className="py-4 text-sm text-[var(--dim)]">
                  房租数据正在由每日刷新核查官方/平台发布值，暂未就绪。
                </p>
              </>
            )}
          </section>

          {/* 波动 */}
          <BlockShell
            title="市场波动"
            block={data?.volatility ?? null}
            freq="日频"
            emptyText="波动数据尚未就绪，会自动更新，请稍候再看。"
          >
            {vol?.vix && (
              <div className="mb-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-[var(--dim)]">
                    VIX 恐慌指数 · {vol.vix.date}
                  </span>
                  <span className="num text-xs text-[var(--dim)]">
                    30 日 {vol.vix.change30d != null ? `${vol.vix.change30d > 0 ? "+" : ""}${vol.vix.change30d.toFixed(2)}` : "—"}
                  </span>
                </div>
                <div
                  className={`num mt-1 text-3xl font-bold text-[#eaf3ff]${fl("vix")}`}
                >
                  <AnimNum
                    value={vol.vix.value}
                    format={(v) => v.toFixed(2)}
                  />
                </div>
                <div
                  className="relative mt-2 h-2.5 overflow-hidden rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg, #3ddc97 0%, #ffc45e 45%, #ff6b6b 75%, #ff5e8a 100%)",
                    opacity: 0.85,
                  }}
                  role="img"
                  aria-label={`VIX ${vol.vix.value.toFixed(2)}，刻度 0 至 50`}
                >
                  <div
                    className="absolute top-0 h-full w-[3px] bg-white"
                    style={{
                      left: `${Math.min(100, (vol.vix.value / 50) * 100)}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-[var(--dim)]">
                  <span>0 平静</span>
                  <span>20 警戒</span>
                  <span>50 恐慌</span>
                </div>
              </div>
            )}
            <ul className="divide-y divide-[rgba(94,148,205,0.12)]">
              {(vol?.indices ?? []).map((idx) => (
                <li
                  key={idx.name}
                  className="flex items-baseline justify-between py-2"
                >
                  <span className="text-sm">
                    {idx.name}
                    {idx.asOf && /^\d{4}-\d{2}-\d{2}/.test(idx.asOf) ? (
                      <span className="num ml-1.5 text-[10px] text-[var(--dim)]">
                        {idx.asOf.slice(5, 10).replace("-", "/")}
                      </span>
                    ) : null}
                  </span>
                  <span className="num text-sm">
                    <span className={`font-semibold${fl(`idx:${idx.name}`)}`}>
                      {idx.price.toLocaleString("en-US", {
                        maximumFractionDigits: 1,
                      })}
                    </span>
                    <span
                      className={`ml-2 text-xs ${pctColor(idx.changePct)}`}
                    >
                      {fmtPct(idx.changePct)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </BlockShell>

          {/* 海底光缆：全球主要系统精选 + 公开异常信号状态层（最后一个内容板块，其后是页脚行） */}
          <section className="glass p-4 sm:p-5" aria-label="全球主要海底光缆">
            <button
              type="button"
              onClick={() => setCablesOpen((v) => !v)}
              aria-expanded={cablesOpen}
              aria-label={
                cablesOpen ? "收起海底光缆板块" : "展开海底光缆板块"
              }
              className="flex w-full items-baseline justify-between gap-2 text-left"
            >
              <h2 className="font-display text-lg font-semibold tracking-wide text-[#eaf3ff]">
                全球主要海底光缆
              </h2>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--dim)]">
                  精选 · 非全量
                </span>
                <span className="text-[11px] whitespace-nowrap text-[var(--dim)]">
                  {cablesOpen ? "收起 ∧" : "展开 ∨"}
                </span>
              </span>
            </button>
            {!cablesOpen && (
              <p className={`mt-2 text-xs ${cableSummaryTone}`}>
                {cableSummary}
              </p>
            )}
            <div
              aria-hidden={!cablesOpen}
              className={`grid transition-all duration-300 ease-out ${
                cablesOpen
                  ? "mt-3 grid-rows-[1fr] opacity-100"
                  : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="min-h-0 overflow-hidden">
            {/* 今日联通异常速览（IODA 国家级信号） */}
            {cableData?.signals ? (
              cableData.signals.events?.length ? (
                <div className="mb-3 rounded-lg border border-[rgba(255,196,94,0.45)] bg-[rgba(255,196,94,0.07)] px-3 py-2">
                  <p className="text-xs font-medium text-[#ffd98f]">
                    IODA 近 48 小时检出异常信号（国家级，非逐缆遥测）：
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {cableData.signals.events.slice(0, 4).map((e, i) => (
                      <li key={i} className="text-xs text-[var(--text)]">
                        {e.country} · {dsLabel(e.datasource)} ·{" "}
                        {e.start.slice(0, 16).replace("T", " ")} UTC 起
                        {e.ongoing ? " · 可能持续中" : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mb-3 rounded-lg border border-[var(--border)] bg-[rgba(61,220,151,0.06)] px-3 py-2 text-xs text-[var(--text)]">
                  主要登陆国未见大范围中断信号（IODA 国家级监测 ·{" "}
                  {cableData.signals.checkedAt?.slice(0, 16).replace("T", " ") ??
                    ""}{" "}
                  UTC 检查）
                  {cableData.signalsStale ? " · 本次信号源不可达，沿用上次检查结果" : ""}
                </p>
              )
            ) : (
              <p className="mb-3 rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--dim)]">
                国家级中断信号（IODA）暂时不可达，本次仅依据下方公开故障记录呈现；不据此断言任何一条缆的状态。
              </p>
            )}

            {/* 大区筛选（用户口径：只按登陆大区，不再按航线分；
                一条缆登陆几个大区就在几个大区下都出现；「与日本
                相关」是用户的特别关注，保留） */}
            <div
              className="mb-2 flex flex-wrap gap-1.5"
              role="group"
              aria-label="按登陆大区筛选海底光缆"
            >
              {(["all", "jp", "asia", "americas", "europe", "africa"] as const).map(
                (k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={cableFilter === k}
                    aria-label={`筛选：${CABLE_CONTINENT_LABEL[k]}`}
                    onClick={() => setCableFilter(k)}
                    className={`rounded-full border px-3 py-1 text-xs backdrop-blur ${
                      cableFilter === k
                        ? "border-transparent bg-[#ffc45e] font-semibold text-[#04101f]"
                        : "border-[var(--border)] bg-[rgba(8,25,48,0.5)] text-[var(--text)]"
                    }`}
                  >
                    {CABLE_CONTINENT_LABEL[k]}
                  </button>
                ),
              )}
            </div>

            {/* 光缆列表 */}
            <ul className="divide-y divide-[rgba(94,148,205,0.12)]">
              {visibleCables.map((c) => {
                const inc = incidentByCable.get(c.id);
                return (
                  <li key={c.id} className="py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-[#eaf3ff]">
                        {c.name}
                      </span>
                      {c.jp && (
                        <span className="rounded border border-[rgba(56,225,255,0.4)] px-1 py-px text-[10px] text-[#aee9ff]">
                          登陆日本
                        </span>
                      )}
                      <span className="text-[11px] text-[var(--dim)]">
                        {c.status} · {c.year} 投产
                      </span>
                      {inc ? (
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#ffc45e]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#ffc45e]" />
                          有公开故障记录（{inc.status}）
                        </span>
                      ) : (
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#3ddc97]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc97]" />
                          未见异常报告
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[13px] text-[var(--text)]">
                      {c.route}
                    </p>
                    <p className="num mt-0.5 text-[11px] text-[var(--dim)]">
                      全长 {c.km} km · 设计容量{" "}
                      {c.tbps ? `${c.tbps} Tbps` : "未查到"} · 业主：{c.owners}
                    </p>
                    {inc && (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--dim)]">
                        最近公开故障：{inc.date} · {inc.landings} · {inc.detail}
                        （
                        <a
                          href={inc.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#aee9ff] underline decoration-dotted"
                        >
                          来源：{inc.sourceName}
                        </a>
                        ）
                      </p>
                    )}
                    {corridorOf(c.id) && (
                      <p className="mt-0.5 text-[11px] leading-relaxed">
                        <span className="rounded border border-[rgba(255,196,94,0.5)] px-1 py-px text-[10px] text-[#ffd98f]">
                          走廊信号异常 · 待核实
                        </span>{" "}
                        <span className="text-[var(--dim)]">
                          监测走廊（{corridorOf(c.id)!.countries.join("、")}）
                          出现 IODA 异常信号 ·{" "}
                          {corridorOf(c.id)!.latestStart
                            .slice(0, 16)
                            .replace("T", " ")}{" "}
                          UTC · {dsLabel(corridorOf(c.id)!.datasource)}
                          （含义见板块末尾说明）
                        </span>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>

            {/* 公开故障记录（历史）：红档格式验证——日期/登陆点/来源齐全 */}
            {cableIncidents.length > 0 && (
              <div className="mt-3 border-t border-[rgba(94,148,205,0.12)] pt-3">
                <p className="text-xs font-medium text-[var(--text)]">
                  公开故障记录（已收录）
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {cableIncidents.map((inc, i) => (
                    <li key={i} className="flex gap-2 text-[11px] leading-relaxed">
                      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff6b6b]" />
                      <span className="text-[var(--dim)]">
                        <span className="text-[var(--text)]">
                          {inc.cable} · {inc.date}
                        </span>{" "}
                        · 影响登陆点：{inc.landings} · {inc.detail} ·{" "}
                        <span className="text-[#ffc45e]">{inc.status}</span>（
                        <a
                          href={inc.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#aee9ff] underline decoration-dotted"
                        >
                          {inc.sourceName}
                        </a>
                        ）
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
              状态口径：没有公开的逐缆实时遥测，本板块只聚合公开信号——故障只收有公开来源的事件（逐条附链接），国家级信号来自
              IODA（佐治亚理工）。「未见异常报告」= 截至{" "}
              {data?.cables?.asOf ?? "2026-11-10"}{" "}
              未查到公开故障报告，不等于健康证明；「走廊信号异常」只说明该走廊联通出了状况、可能与断缆有关，不等于这条缆断了。参数为策展值（TeleGeography、运营商与财团公告，2026-11-10
              核订），精选非全量。
            </p>
              </div>
            </div>
          </section>
<p className="px-1 pt-1 text-[11px] leading-relaxed text-[var(--dim)]">
            汇率·股价·VIX 为日频（交易日更新）；利率随央行发布；货币增速
            为各国央行年度值；房租为月频。弧线亮度随当日汇率波动；昼夜按真实太阳位置；城市小字为当地时间。
          </p>

                  </main>
      </div>
      <BackToTop />
    </div>
  );
}
