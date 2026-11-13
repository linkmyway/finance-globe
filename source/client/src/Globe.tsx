// 3D 地球：真实国家多边形地图纹理（国界 + 美中日高亮）+ 夜间城市灯光
// （人口加权采样，夜侧亮起）+ 缓慢移动的晨昏线 + GFCI 金融中心分级标记
// + 带拖尾的流动光弧。
// three.js 从 npm 包导入（server-backed 构建），不用 CDN。
// 性能克制：像素比封顶、灯光点数封顶（粗指针设备只渲染最亮的前 55%）、
// 无后处理通道，辉光靠精灵贴图/加色混合伪造；地图纹理在移动端降到
// 2048 宽（桌面 4096），地理数据模块为紧凑二进制编码（见各 data 文件头注），
// 地球组件本身由 App 懒加载，不阻塞数据面板首屏。

import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
LAND_COORDS_B64,
LAND_FLAGS_B64,
LAND_POINT_COUNT,
} from "./landData";
import { LIGHTS_B64, LIGHT_POINT_COUNT } from "./lightsData";
import { moonLongitude } from "./moonPhase";
import { SERPO_FRONTS, SERPO_AWAY_URL } from "./serpoArt";
import { MANTIS_FATHER, MANTIS_SON, MANTIS_POLE_HOME } from "./mantisArt";
import {
CABLES,
CABLE_LANDINGS,
CABLE_ROUTES,
type CableStatusInfo,
type CableTier,
} from "./cablesData";

import type { CenterInfo, CountryCode, IndexBoardInfo } from "./globeTypes";
import {
CENTERS,
CITIES,
LABEL_OFFSETS,
LABEL_PRIORITY,
NO_TEXT_LABEL_CENTER_IDS,
NO_TEXT_LABEL_CITY_NAMES,
arcRegionColors,
arcStrength,
centerColor,
type CenterDef,
} from "./globeCities";
import {
PLANET_ELEMENTS,
R,
gmstDeg,
latLonToVec3,
planetLongitude,
solarDecRa,
} from "./globeMath";
import {
makeBoardSprite,
makeDotTexture,
makeEarthTexture,
makeGlowTexture,
makeLabelSprite,
makeRingTexture,
makeTimeSprite,
} from "./globeTextures";

// 类型再导出：App 等外部模块一直从 "./Globe" 导入这三个类型，路径不变。
export type { CenterInfo, CountryCode, IndexBoardInfo } from "./globeTypes";


export interface GlobeProps {
  /** 0..1 — 当日汇率波动幅度映射到弧线亮度/脉冲速度 */
  intensity: number;
  /**
   * 交易所指数板数据（来自 dashboard 的 volatility 快照）：有主要
   * 交易所的金融中心标记升级为迷你指数板贴在球面上，随球自转、
   * 背面淡出、进统一标签避让池。缺省/空数组时无板（诚实缺省，
   * 不编数）。
   */
  indexBoards?: IndexBoardInfo[];
  selected: CountryCode | null;
  autoRotate: boolean;
  /** 太阳系模式开关（App 持有状态，地球点按与「太阳系」钮共用） */
  solarSystem: boolean;
  /** 太阳系取景（移动端）：near=近览内圈（默认）/ full=全览八行星 */
  solarView?: "near" | "full";
  /**
   * 太阳系聚焦观赏的天体 id（sun / mercury … neptune / moon；earth=行星地球）：
   * 非空时镜头 fly-to 到该天体近距离并轻跟随其公转；null=太阳系总览
   */
  focusedBody?: string | null;
  /**
   * 主页星球（本次浏览内有效，不持久化）：非 "earth" 时主页中央大球
   * 换成该天体（sun / mercury … neptune / moon），地球专属图层
   * （地图/灯光/弧线/标签）隐藏；缺省 "earth"。
   */
  homePlanet?: string;
  /**
   * 海底光缆状态表（按缆 id）：与主页光缆板块同一份状态源（服务端
   * cables 区块的公开故障记录经 cableStatusFor 分档），球上光带
   * 颜色随此同步——板块变红，球上必须同红。缺省全部未见异常。
   */
  cableStatusById?: Record<string, CableStatusInfo>;
  /** 点中某条光带/登陆点时回调其缆 id（App 弹小片提示） */
  onCableSelect?: (id: string) => void;
  onSelect: (c: CountryCode) => void;
  onCenterSelect: (c: CenterInfo) => void;
  onSolarSystemChange: (v: boolean) => void;
  /** 点中太阳系天体（本体/放大命中圈/标签）时回调其 id */
  onBodyFocus?: (id: string | null) => void;
}





/**
 * —— 夜空循环（主页流星雨的会话时钟）——
 * 循环长 180 秒、起始相位 55 秒：打开约 +35 秒流星雨开窗（1:30
 * 段）、+95 秒进暴雨峰值段（2:30 段），不必把整个流程走完才看
 * 得到雨（2026-11-12 用户口径）。本循环原与客串彗星的展示循环
 * 共用同一常量（旧 COMET.cycleS）；客串彗星于 2026-11-13 晚整
 * 体下线后，本常量独立保留、数值一字不变——主页流星雨的开
 * 窗/峰值时刻零影响（解耦保原值，用户护栏）。
 */
const NIGHT_CYCLE_S = 180;
/** 夜空循环的会话时钟起点相位（秒），口径见 NIGHT_CYCLE_S 注 */
const NIGHT_START_PHASE_S = 55;
/**
 * —— 彗星舞台轮值（2026-11-13 用户令「彗星不要同时出现」；同
 * 日晚客串彗星整体下线后改四幕）——
 * 太阳系里的四颗具名彗星（哈雷/恩克/潘斯达斯/艾森）共用一条
 * 320 秒舞台时钟、四幕各 80 秒轮流登场、哈雷起场。任一时刻至
 * 多一颗在场——核/彗发/双尾/名卡/轨道线成套算一个「出现」单
 * 位、随幕同进同出；幕内首尾各 8 秒淡入淡出、幕与幕首尾相接
 * 不重叠（包络只活在自己幕内，交界处前一颗已归零后一颗才
 * 起，无交叉淡化）。轨道线随其包络淡变（在场峰值 0.34）。幕
 * 内时间映射到各颗自己的轨道时间：以近日点时刻为幕中点、按
 * 各自活跃跨度缩放（slotScale），使幕边缘活跃度 ≈0——没有谁
 * 亮着脸上下场。舞台相位 30：打开时哈雷位于其幕内 30 秒处；
 * reduced-motion 时舞台冻结在同一相位（只哈雷在场、余三颗隐
 * 去）。
 */
const COMET_STAGE_S = 320;
const COMET_SLOT_S = 80;
const COMET_STAGE_PHASE = 30;
const COMET_ENV_S = 8;
/**
 * AU → 示意轨道半径（orbitR 单位，与 PLANET_ELEMENTS.orbitR 同口
 * 径）：以八行星（真实 a ↔ 示意 orbitR）为锚点在 ln(a) 上分段插值，
 * 保证彗星 0.59 AU 时落在金星圈内侧、1 AU 时与地球圈相交、远日点
 * （≈35 AU）落在海王星圈外侧且仍在全览拟合半径（7.95）之内。
 */
const AU_ANCHORS: Array<[number, number]> = [
  [0.387, 1.15],
  [0.723, 1.75],
  [1.0, 2.45],
  [1.524, 3.25],
  [5.203, 4.35],
  [9.537, 5.55],
  [19.19, 6.55],
  [30.07, 7.45],
];
function auToDisplayR(rAU: number): number {
  const x = Math.log(Math.max(0.05, rAU));
  const first = AU_ANCHORS[0]!;
  const last = AU_ANCHORS[AU_ANCHORS.length - 1]!;
  if (x <= Math.log(first[0])) {
    const [a2, r2] = AU_ANCHORS[1]!;
    const slope = (r2 - first[1]) / (Math.log(a2) - Math.log(first[0]));
    return first[1] + slope * (x - Math.log(first[0]));
  }
  if (x >= Math.log(last[0])) {
    const [a1, r1] = AU_ANCHORS[AU_ANCHORS.length - 2]!;
    const slope = (last[1] - r1) / (Math.log(last[0]) - Math.log(a1));
    return last[1] + slope * (x - Math.log(last[0]));
  }
  for (let i = 0; i < AU_ANCHORS.length - 1; i++) {
    const [a1, r1] = AU_ANCHORS[i]!;
    const [a2, r2] = AU_ANCHORS[i + 1]!;
    if (x >= Math.log(a1) && x <= Math.log(a2)) {
      const t = (x - Math.log(a1)) / (Math.log(a2) - Math.log(a1));
      return r1 + (r2 - r1) * t;
    }
  }
  return last[1];
}

/**
 * —— 主要彗星入列（2026-11-13，用户令：参考国立天文台 NAOJ
 * 「彗星」页 https://www.nao.ac.jp/astro/basic/comet.html 的太阳系
 * 轨道概略图，把主要的那几个彗星做进太阳系、拖尾逐颗有区别、
 * 要有名字的卡片）——
 * 入列四颗 = 该页轨道概略图点名的四颗：哈雷、恩克、潘斯达斯、
 * 艾森。轨道根数取各彗星公开发表值（JPL 小天体数据库标准根数）：
 * 哈雷 1P/Halley a=17.83 AU、e=0.967、i=162.3°（逆行）、q=0.586；
 * 恩克 2P/Encke a=2.21、e=0.848、i=11.8°、q=0.336（远日点 4.09 AU
 * 缩在木星轨道内侧）；潘斯达斯 C/2011 L4 q=0.302、e≈1.0003（近抛
 * 物线，展示取 a=100 AU 的等效长椭圆）、i=84.2°；艾森 C/2012 S1
 * q=0.0124（掠日）、e≈1、i=61.9°（展示取 e=0.99996、a=311 AU）。
 * 轨道形状/倾角/升交点/近日点幅角全按真实根数经 perifocal 基底
 * 换算，位置由真近点角直接定（ν 定义椭圆上的点，与开普勒解等
 * 价，且对 e→1 的近抛物线轨道数值稳定）。
 * 摆位口径（诚实标注，与客串彗星同例）：不按真实日期摆位——按
 * 真位放，哈雷现在在约 35 AU 外无尾、艾森 2013 年过近日点时已
 * 解体，四颗里三颗看不见、「拖尾要有区别」无从谈起。故取活跃展
 * 示：各沿自己轨道慢跑，时间轴同样走正切弯折把过境展开；登场
 * 时机走舞台轮值（见 COMET_STAGE_S 处注：四颗彗星轮流独占舞
 * 台、从不同时出现，各颗只在自己那一幕里在场）；真实周期与下
 * 次回归/解体事实如实写入各自名卡副行，页面提示片同步标注
 * 「彗星为活跃期示意」。
 * —— 全维逐颗分家（2026-11-13 晚用户总纲「这四颗彗星的设计
 * 风格和色彩风格粒子风格要做区分、大小也要有区别」）：不止拖
 * 尾长短宽窄——设计/色彩/粒子/体量各成一套；新海诚式的高明
 * 度辉光质感是共同底味，色相与形态逐颗分家（逐颗色板/描边/
 * 彗发染色/粒子风格全在 def 表）：
 * 哈雷 = 经典主力——体量最大、彗发最亮，蓝（离子）金（尘埃）
 * 正色双尾，粒子晶亮规整、成簇绽放，是「标准答案」；
 * 恩克 = 最小最黯——彗发紧凑、整体小一号，灰蓝离子尾 + 暗金
 * 尘埃的灰旧色，粒子稀疏微弱、慢速小粒，磨老了的彗星；
 * 潘斯达斯 = 宽阔暖金——尘埃大扇面四颗最宽、暖金主导，粒子
 * 是弥漫的金色尘雾、大粒慢飘；
 * 艾森 = 翠绿纤细——借 2013 年实拍的双原子碳绿彗发作签名
 * 色，离子尾极细极长走青绿，粒子翠绿细喷、快而 sharp，靠长
 * 度取胜。原逐颗拖尾形态差异（长/宽/扇面/射线）保留并入各自
 * 风格。近日点粒子喷流逐颗一份（风格档见构建段 sparks
 * 注），过近日点时喷发。
 */
export interface NamedCometDef {
  id: string;
  /** 名卡主名 */
  name: string;
  /** 名卡副行：真实周期/回归/解体信息 */
  info: string;
  a: number;
  e: number;
  inclDeg: number;
  /** 升交点黄经 Ω（°） */
  nodeDeg: number;
  /** 近日点幅角 ω（°） */
  periArgDeg: number;
  /** 活跃度起算日心距（AU）：远于此只剩暗核 */
  onsetAU: number;
  /** 展示循环（秒，尘埃尾历史步长口径）/ 循环内近日点时刻 /
   * 舞台幕内时间缩放（幕半宽 40 秒 ↔ 本颗活跃半跨，见轮值注） */
  cycleS: number;
  periAtS: number;
  slotScale: number;
  /** 彗发尺度系数 / 整体亮度系数 */
  comaK: number;
  brightK: number;
  /** 离子尾：满活跃时的脊线长（组内单位）/ 不透明度 / 幕宽基准 */
  ionLen: number;
  ionOp: number;
  ionWidth: number;
  ionLayers: number[];
  /** 尘埃尾：不透明度 / 幕宽基准 / 历史漂移系数 */
  dustOp: number;
  dustWidth: number;
  dustLayers: number[];
  dustHistK: number;
  /** 轨道线颜色（离子色系淡版，逐颗可辨） */
  orbitColor: string;
  /** 名卡互避优先级（哈雷最高） */
  cardPrio: number;
  /** 逐颗色板（2026-11-13 晚全维分家）：双尾沿程多停点渐变
   * （报告 §3.2 B 级设计建议值骨架 + 逐颗色相偏移）+ 最宽层
   * 外缘描边光，逐颗一套（见各 def 与模块层总纲注） */
  ionPalette: Array<{ o: number; hex: string }>;
  dustPalette: Array<{ o: number; hex: string }>;
  ionRim: string;
  dustRim: string;
  /** 彗发染色（报告 §3.2 B-1 四层：核/内层/外晕内圈/外晕外
   * 圈，逐颗偏移）：艾森绿彗发即走此系 */
  comaCore: string;
  comaInner: string;
  comaHaloMid: string;
  comaHaloOut: string;
  /** 近日点粒子风格：色阶档（1 哈雷冰晶 / 2 恩克灰烬 / 3 潘斯
   * 达斯金尘 / 4 艾森翠绿）/ 粒数 / 速度系数 / 尺寸系数 / 亮
   * 度系数（见 makeCometSparks） */
  sparkMode: number;
  sparkCount: number;
  sparkSpeed: number;
  sparkSize: number;
  sparkBright: number;
}
export const NAMED_COMETS: NamedCometDef[] = [
  {
    id: "halley",
    name: "哈雷彗星",
    info: "周期 75.3 年 · 下次回归 2061 年",
    a: 17.834,
    e: 0.96714,
    inclDeg: 162.26,
    nodeDeg: 58.42,
    periArgDeg: 111.33,
    onsetAU: 3.0,
    cycleS: 260,
    periAtS: 78,
    slotScale: 1.23,
    comaK: 1.3,
    brightK: 1.0,
    ionLen: 2.7,
    ionOp: 0.66,
    ionWidth: 0.32,
    ionLayers: [0.8, 0.54, 0.34],
    dustOp: 0.52,
    dustWidth: 0.98,
    dustLayers: [0.68, 0.47, 0.32, 0.21],
    dustHistK: 0.0045,
    orbitColor: "#7fb2ff",
    cardPrio: 4,
    // 哈雷：报告骨架原值（标准答案，不偏移）——离子 B-2 五停
    // 点、尘埃 B-3 四停点、彗发 B-1 四层；描边取尾梢粉紫
    ionPalette: [
      { o: 0, hex: "#DFF6FF" },
      { o: 0.18, hex: "#7ED6FF" },
      { o: 0.45, hex: "#4A90FF" },
      { o: 0.72, hex: "#7A5CFF" },
      { o: 1, hex: "#B45CFF" },
    ],
    dustPalette: [
      { o: 0, hex: "#FFF6E8" },
      { o: 0.3, hex: "#FCE1E4" },
      { o: 0.62, hex: "#F28AB2" },
      { o: 0.85, hex: "#B48AD3" },
      { o: 1, hex: "#B48AD3" },
    ],
    ionRim: "#B45CFF",
    dustRim: "#F28AB2",
    comaCore: "#FFFFFF",
    comaInner: "#E8F7FF",
    comaHaloMid: "#7A8CFF",
    comaHaloOut: "#C88CFF",
    sparkMode: 1,
    sparkCount: 170,
    sparkSpeed: 1.0,
    sparkSize: 1.0,
    sparkBright: 1.0,
  },
  {
    id: "encke",
    name: "恩克彗星",
    info: "周期 3.30 年 · 短周期彗星",
    a: 2.2147,
    e: 0.84834,
    inclDeg: 11.78,
    nodeDeg: 334.57,
    periArgDeg: 186.55,
    onsetAU: 2.3,
    cycleS: 150,
    periAtS: 45,
    slotScale: 0.95,
    comaK: 0.62,
    brightK: 0.72,
    ionLen: 1.15,
    ionOp: 0.36,
    ionWidth: 0.21,
    ionLayers: [0.72, 0.46, 0.28],
    dustOp: 0.26,
    dustWidth: 0.68,
    dustLayers: [0.6, 0.38, 0.22],
    dustHistK: 0.0035,
    orbitColor: "#9adcff",
    cardPrio: 1,
    // 恩克：报告骨架的灰旧偏移——全停点降饱和、向灰靠，整体
    // 再由 brightK 0.72 压黯；磨老了的彗星
    ionPalette: [
      { o: 0, hex: "#DCE8F0" },
      { o: 0.18, hex: "#A9C6DC" },
      { o: 0.45, hex: "#7E9CC0" },
      { o: 0.72, hex: "#8884BC" },
      { o: 1, hex: "#A08CC0" },
    ],
    dustPalette: [
      { o: 0, hex: "#F3EEE1" },
      { o: 0.3, hex: "#EADCD8" },
      { o: 0.62, hex: "#D8A49E" },
      { o: 0.85, hex: "#AC94B4" },
      { o: 1, hex: "#AC94B4" },
    ],
    ionRim: "#A08CC0",
    dustRim: "#D8A49E",
    comaCore: "#F4F7F9",
    comaInner: "#DCE8EE",
    comaHaloMid: "#93A4C4",
    comaHaloOut: "#B4A4CC",
    sparkMode: 2,
    sparkCount: 95,
    sparkSpeed: 0.55,
    sparkSize: 0.7,
    sparkBright: 0.55,
  },
  {
    id: "panstarrs",
    name: "潘斯达斯彗星",
    info: "长周期彗星 · 2013 年过近日点",
    a: 100,
    e: 0.996985,
    inclDeg: 84.21,
    nodeDeg: 65.67,
    periArgDeg: 333.65,
    onsetAU: 3.2,
    cycleS: 320,
    periAtS: 96,
    slotScale: 1.86,
    comaK: 1.05,
    brightK: 0.95,
    ionLen: 1.05,
    ionOp: 0.3,
    ionWidth: 0.17,
    ionLayers: [0.68, 0.44, 0.26],
    dustOp: 0.62,
    dustWidth: 1.35,
    dustLayers: [0.72, 0.52, 0.36, 0.24],
    dustHistK: 0.0055,
    orbitColor: "#ffd9a0",
    cardPrio: 3,
    // 潘斯达斯：报告骨架的暖金偏移——尘埃停点整体向金走（暖
    // 金主导）、离子退成淡而疏的冷丝；扇宽比 3–5× 在本颗按
    // 「尘埃主导」身份放宽（≈8×，其招牌即大扇面）
    ionPalette: [
      { o: 0, hex: "#EAF6FF" },
      { o: 0.18, hex: "#BFE0F5" },
      { o: 0.45, hex: "#93B4E0" },
      { o: 0.72, hex: "#9A8FD0" },
      { o: 1, hex: "#B49CD0" },
    ],
    dustPalette: [
      { o: 0, hex: "#FFF8E6" },
      { o: 0.3, hex: "#FDEBC0" },
      { o: 0.62, hex: "#F7C873" },
      { o: 0.85, hex: "#E0AA54" },
      { o: 1, hex: "#C9963F" },
    ],
    ionRim: "#BFE0F5",
    dustRim: "#F7C873",
    comaCore: "#FFFFFF",
    comaInner: "#FFF1D6",
    comaHaloMid: "#F5C88F",
    comaHaloOut: "#E8A7C3",
    sparkMode: 3,
    sparkCount: 210,
    sparkSpeed: 0.5,
    sparkSize: 1.9,
    sparkBright: 0.9,
  },
  {
    id: "ison",
    name: "艾森彗星",
    info: "掠日彗星 · 2013 年过近日点时解体",
    a: 311,
    e: 0.99996,
    inclDeg: 61.86,
    nodeDeg: 295.68,
    periArgDeg: 345.58,
    onsetAU: 3.0,
    cycleS: 380,
    periAtS: 114,
    slotScale: 4.6,
    comaK: 0.8,
    brightK: 0.9,
    ionLen: 3.5,
    ionOp: 0.58,
    ionWidth: 0.12,
    ionLayers: [0.8, 0.54, 0.34],
    dustOp: 0.32,
    dustWidth: 0.42,
    dustLayers: [0.6, 0.38, 0.22],
    dustHistK: 0.003,
    orbitColor: "#a8c8ff",
    cardPrio: 2,
    // 艾森：报告骨架的翠绿偏移——离子全程走青绿（近核青绿
    // tint 有真实彗发 C₂ 发光依据，报告 §1.1/裁决）、尘埃转
    // 绿白；绿彗发（双原子碳）签名保留
    ionPalette: [
      { o: 0, hex: "#E4FFF3" },
      { o: 0.18, hex: "#8CF5CD" },
      { o: 0.45, hex: "#2ED6A4" },
      { o: 0.72, hex: "#12A594" },
      { o: 1, hex: "#0E7F8C" },
    ],
    dustPalette: [
      { o: 0, hex: "#F7F9EC" },
      { o: 0.3, hex: "#E6F2DC" },
      { o: 0.62, hex: "#A9D8AE" },
      { o: 0.85, hex: "#84B894" },
      { o: 1, hex: "#84B894" },
    ],
    ionRim: "#5FFFC8",
    dustRim: "#A9D8AE",
    comaCore: "#FFFFFF",
    comaInner: "#E4FFF3",
    comaHaloMid: "#4FE3A1",
    comaHaloOut: "#7FD8C8",
    sparkMode: 4,
    sparkCount: 160,
    sparkSpeed: 1.5,
    sparkSize: 0.8,
    sparkBright: 1.05,
  },
];
/**
 * 彗星轨道面基底（黄道 perifocal → 本场景坐标）：标准根数换算
 * P（近日点方向）/ Q（面内超前 90°）；黄道坐标 (xe, ye, ze) 到
 * 场景坐标的映射与行星黄经口径一致——(xe, ze, −ye)（黄经 λ 处
 * 场景位置 = (cosλ, 0, −sinλ)）。pole = P×Q，与客串彗星的
 * 极轴同定义（离子帘张开向 / 尘埃扇定向都用它）。
 */
function cometBasisFromElements(
  nodeDeg: number,
  inclDeg: number,
  periArgDeg: number,
): { P: THREE.Vector3; Q: THREE.Vector3; pole: THREE.Vector3 } {
  const rad = Math.PI / 180;
  const O = nodeDeg * rad;
  const inc = inclDeg * rad;
  const w = periArgDeg * rad;
  const cO = Math.cos(O);
  const sO = Math.sin(O);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const toThree = (x: number, y: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(x, z, -y);
  const P = toThree(
    cO * cw - sO * sw * ci,
    sO * cw + cO * sw * ci,
    sw * si,
  ).normalize();
  const Q = toThree(
    -cO * sw - sO * cw * ci,
    -sO * sw + cO * cw * ci,
    cw * si,
  ).normalize();
  const pole = new THREE.Vector3().crossVectors(P, Q).normalize();
  return { P, Q, pole };
}
const NAMED_COMET_BASIS = new Map(
  NAMED_COMETS.map((d) => [
    d.id,
    cometBasisFromElements(d.nodeDeg, d.inclDeg, d.periArgDeg),
  ]),
);
export interface NamedCometState {
  /** 太阳系组本地坐标（示意半径映射 × solarS） */
  pos: THREE.Vector3;
  rAU: number;
  /** 活跃度 0..1（onsetAU 外为 0、近日点为 1） */
  activity: number;
}
/**
 * 具名彗星在展示循环 localT 秒处的状态（纯函数，尘埃尾历史轨迹
 * 回算同用此函数）。真近点角走与客串彗星同一条正切弯折时间轴
 * （过境展开、两端在远日点附近饱和衔接）；位置由 ν 直接定点；
 * 艾森 q=0.0124 AU 经 auToDisplayR 外推会得负半径，故展示半径
 * 下限钳在 0.68（组内 ≈0.42，太阳盘面外沿）——掠日彗星贴着太
 * 阳表面掠过，正是它的真实招牌。
 */
function namedCometStateAt(
  def: NamedCometDef,
  localT: number,
  solarS: number,
): NamedCometState {
  const basis = NAMED_COMET_BASIS.get(def.id)!;
  const s = localT - def.periAtS;
  const tau = def.cycleS * 0.2;
  const nu = 3.06 * Math.tanh(s / tau);
  const p = def.a * (1 - def.e * def.e);
  const rAU = p / (1 + def.e * Math.cos(nu));
  const dir = basis.P.clone()
    .multiplyScalar(rAU * Math.cos(nu))
    .addScaledVector(basis.Q, rAU * Math.sin(nu))
    .normalize();
  const dispR = Math.max(0.68, auToDisplayR(rAU));
  const pos = dir.multiplyScalar(dispR * solarS);
  const q = def.a * (1 - def.e);
  const activity = Math.pow(
    THREE.MathUtils.clamp((def.onsetAU - rAU) / (def.onsetAU - q), 0, 1),
    1.25,
  );
  return { pos, rAU, activity };
}

/**
 * 月球地心黄道经度 moonLongitude 已抽到 ./moonPhase 与主页月相卡
 * 共用同一定义（2026-11-13）：它定月球起始黄经，盈亏由太阳点光
 * 源真实照亮月球球体得到；月相卡则用同一黄经算日月距角——卡上
 * 画的相位与球上月亮同源同口径，不许在此另立一份公式。
 */

/** 确定性伪随机（按种子）：纹理斑点每次构建一致，不闪烁不跳变 */
function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 太阳系精修标签：细字重纯文字 + 极轻描边（2026-11-13 用户：
 * 「太阳系星星和星球的名片旁边的圆点可以去掉」——画布左侧的
 * 行星色小圆点退役，文字回画布正中），比监控球标签更小更静，
 * 衬托行星本体而不是抢它。
 * 遮挡口径（同日稳定性改判）：材质关 GPU 深度测试、renderOrder
 * 抬到场景透明层最末——旧制靠深度测试逐像素硬裁，行星擦过标
 * 签时裁切边界逐帧翻转、名字来回跳动；现行遮挡改由太阳系标
 * 签避让段的解析判定（双阈值迟滞 + 持续性确认 + 平滑淡变）
 * 全权决定，GPU 不再参与显隐。
 */
function makeSolarLabel(
  text: string,
  color: string,
  scale = 0.44,
): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 72;
  const g = c.getContext("2d")!;
  g.font = "500 30px 'Noto Sans SC', system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 6;
  g.lineJoin = "round";
  g.strokeStyle = "rgba(3,8,18,0.85)";
  g.strokeText(text, 128, 38);
  g.shadowColor = color;
  g.shadowBlur = 5;
  g.fillStyle = "#eef4fc";
  g.fillText(text, 128, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
  );
  sprite.renderOrder = 11;
  sprite.scale.set(scale, scale * (72 / 256), 1);
  return sprite;
}

/**
 * 星体纹理共用工具（2026-11-12 精修轮）：全部行星/太阳/月球纹理统一在
 * 2048×1024「设计空间」里按真实经纬落特征，再由画布缩放落到实际像素。
 * 档位口径：太阳/月球/木星/土星/火星双档都走 2048×1024（主要星球不许
 * 因移动端降档）；水星/金星/天王星/海王星移动端 1024×512、桌面 2048；
 * 高度图（月球/水星/火星）恒 1024×512。内存账见 DATA-PLAN 本轮条目。
 * 绘制原语都处理 ±W 绕卷：贴到球面上经度接缝处不许有断茬。
 * 纹理按（星名，档位）缓存：太阳系本体与主页客串星球共用同一张，
 * 不再各画一份（内存与生成耗时都减半）。
 */
const texCache = new Map<string, THREE.Texture>();
function cachedTex(key: string, make: () => THREE.Texture): THREE.Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const tex = make();
  texCache.set(key, tex);
  return tex;
}
/** 经度（东经 0–360 或西经负数皆可）→ 设计空间 x */
function llx(lon: number): number {
  const m = ((lon % 360) + 360) % 360;
  return (((m + 180) % 360) / 360) * 2048;
}
/** 纬度 → 设计空间 y（北极 0、南极 1024） */
function lly(lat: number): number {
  return ((90 - lat) / 180) * 1024;
}
type Ctx2D = CanvasRenderingContext2D;
/** 椭圆柔斑（径向渐变），自动在 ±W 处补画绕卷副本 */
function blobW(
  g: Ctx2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  col: string,
  alpha: number,
): void {
  for (const ox of [0, -2048, 2048]) {
    const cx = x + ox;
    if (cx < -rx || cx > 2048 + rx) continue;
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    rg.addColorStop(0, col);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.save();
    g.translate(cx, y);
    g.scale(1, ry / rx);
    g.globalAlpha = alpha;
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, rx, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.globalAlpha = 1;
}
/** 细粒覆盖层：随机小点（亮/暗双色），给表面「牙口」——没有它再大的画布也是糊墙 */
function grainW(
  g: Ctx2D,
  rand: () => number,
  n: number,
  cols: string[],
  aMax: number,
  rMax: number,
): void {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.03 + rand() * aMax;
    g.fillStyle = cols[Math.floor(rand() * cols.length)]!;
    g.beginPath();
    g.arc(rand() * 2048, rand() * 1024, 0.6 + rand() * rMax, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}
/**
 * 环形山（颜色画布 + 可选的高度画布同步落坑）：暗碗 + 一侧高光环缘 +
 * 中央峰（大坑）。高度画布上是亮环 + 暗心，作 bumpMap 时凹凸方向正确。
 */
function craterW(
  g: Ctx2D,
  bump: Ctx2D | null,
  rand: () => number,
  x: number,
  y: number,
  r: number,
  strength: number,
  dark: string,
  light: string,
): void {
  for (const ox of [0, -2048, 2048]) {
    const cx = x + ox;
    if (cx < -r * 1.4 || cx > 2048 + r * 1.4) continue;
    g.globalAlpha = (0.1 + rand() * 0.1) * strength;
    g.fillStyle = dark;
    g.beginPath();
    g.arc(cx, y, r, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = (0.1 + rand() * 0.09) * strength;
    g.strokeStyle = light;
    g.lineWidth = Math.max(0.8, r * 0.26);
    g.beginPath();
    g.arc(cx, y, r * 0.88, Math.PI * 0.82, Math.PI * 1.92);
    g.stroke();
    if (r > 7) {
      g.globalAlpha = 0.12 * strength;
      g.fillStyle = light;
      g.beginPath();
      g.arc(cx, y, r * 0.16, 0, Math.PI * 2);
      g.fill();
    }
    if (bump) {
      const bg = bump.createRadialGradient(cx, y, r * 0.1, cx, y, r);
      bg.addColorStop(0, "rgba(40,40,40,0.85)");
      bg.addColorStop(0.72, "rgba(110,110,110,0.55)");
      bg.addColorStop(0.9, "rgba(235,235,235,0.9)");
      bg.addColorStop(1, "rgba(128,128,128,0)");
      bump.globalAlpha = Math.min(1, 0.55 * strength);
      bump.fillStyle = bg;
      bump.beginPath();
      bump.arc(cx, y, r, 0, Math.PI * 2);
      bump.fill();
      bump.globalAlpha = 1;
    }
  }
  g.globalAlpha = 1;
}
/**
 * 湍流横带：上下边缘由多组整周期正弦叠加位移（整周期 ⇒ 经度接缝无缝），
 * 带界不再是直尺平行线。ph 由调用方按带错开。
 */
function turbBand(
  g: Ctx2D,
  yTop: number,
  yBot: number,
  col: string,
  alpha: number,
  amp: number,
  ph: number,
): void {
  const edge = (x: number, base: number, sgn: number): number =>
    base +
    sgn *
      amp *
      (0.55 * Math.sin((x / 2048) * Math.PI * 2 * 3 + ph) +
        0.3 * Math.sin((x / 2048) * Math.PI * 2 * 7 + ph * 1.7 + 1.3) +
        0.22 * Math.sin((x / 2048) * Math.PI * 2 * 13 + ph * 2.3 + 4.1));
  g.globalAlpha = alpha;
  g.fillStyle = col;
  g.beginPath();
  for (let x = 0; x <= 2048; x += 16) {
    const y = edge(x, yTop, 1);
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  for (let x = 2048; x >= 0; x -= 16) g.lineTo(x, edge(x, yBot, -1));
  g.closePath();
  g.fill();
  g.globalAlpha = 1;
}

/**
 * 太阳表面纹理（2026-11-12 精修）：SDO 影像的分层法再上一档——
 * ① 超米粒大尺度亮度场垫底；② 米粒组织两层尺度（暗巷网络 + 亮芯，
 * 上万颗、扁平填色不用逐颗渐变）；③ 黑子群落在 ±8°–32° 活跃纬度带：
 * 本影黑核 + 半影放射丝 + 邻近光斑（faculae）；④ 细噪收尾。
 * 临边昏暗与盘缘辉光在 makeSunMaterial 着色器里，不进纹理。
 */
function makeSunTexture(hi = true): THREE.Texture {
  void hi;
  // 太阳是总览的视觉中心：双档都走 2048×1024（精修口径——主要星球
  // 不许因移动端降档），档位参数只保留给日冕等次要纹理用
  return cachedTex("sun:2", () => {
    const W = 2048;
    const H = W / 2;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.scale(W / 2048, H / 1024);
    const grad = g.createLinearGradient(0, 0, 0, 1024);
    grad.addColorStop(0, "#f7b95c");
    grad.addColorStop(0.5, "#ffc45e");
    grad.addColorStop(1, "#f7ab4a");
    g.fillStyle = grad;
    g.fillRect(0, 0, 2048, 1024);
    const rand = seededRand(20261110);
    const palette = ["#ffe9b0", "#ffdf8a", "#ffb35c", "#ff9e3f", "#fff3c4"];
    // 超米粒组织：大尺度对流元胞调制整体亮度
    for (let i = 0; i < 420; i++) {
      blobW(
        g,
        rand() * 2048,
        rand() * 1024,
        26 + rand() * 90,
        20 + rand() * 60,
        palette[Math.floor(rand() * palette.length)]!,
        0.05 + rand() * 0.08,
      );
    }
    // 米粒组织两层：先铺暗色「巷」网络，再在巷间落亮芯
    for (let oct = 0; oct < 2; oct++) {
      const n = oct === 0 ? 5200 : 2400;
      const rBase = oct === 0 ? 3.4 : 6.4;
      for (let i = 0; i < n; i++) {
        const x = rand() * 2048;
        const y = rand() * 1024;
        const r = rBase * (0.6 + rand() * 0.8);
        for (const ox of [0, -2048, 2048]) {
          const cx = x + ox;
          if (cx < -r || cx > 2048 + r) continue;
          g.globalAlpha = 0.16 + rand() * 0.16;
          g.fillStyle = "#dd7f28";
          g.beginPath();
          g.arc(cx, y, r, 0, Math.PI * 2);
          g.fill();
          g.globalAlpha = 0.2 + rand() * 0.22;
          g.fillStyle = rand() > 0.4 ? "#fff0bc" : "#ffd98a";
          g.beginPath();
          g.arc(cx - r * 0.14, y - r * 0.14, r * 0.62, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    g.globalAlpha = 1;
    // 黑子群：活跃纬度带内成簇出现，本影 + 半影放射丝 + 光斑
    const spotGroups = 5;
    for (let s = 0; s < spotGroups; s++) {
      const gx = rand() * 2048;
      const glat = (8 + rand() * 24) * (s % 2 === 0 ? 1 : -1);
      const gy = lly(glat);
      const gr = 16 + rand() * 16;
      for (const ox of [0, -2048, 2048]) {
        const cx = gx + ox;
        if (cx < -gr * 3 || cx > 2048 + gr * 3) continue;
        // 半影：不规则暗橙斑 + 放射状细丝
        g.globalAlpha = 0.4;
        g.fillStyle = "#c97a30";
        g.beginPath();
        g.arc(cx, gy, gr, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "rgba(150,70,20,0.5)";
        g.lineWidth = 1.4;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + rand() * 0.3;
          g.globalAlpha = 0.25 + rand() * 0.25;
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * gr * 0.45, gy + Math.sin(a) * gr * 0.45);
          g.lineTo(cx + Math.cos(a) * gr * 1.15, gy + Math.sin(a) * gr * 1.15);
          g.stroke();
        }
        // 本影：1–3 个近黑核
        const cores = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < cores; k++) {
          g.globalAlpha = 0.78;
          g.fillStyle = "#571f04";
          g.beginPath();
          g.arc(
            cx + (rand() - 0.5) * gr * 0.8,
            gy + (rand() - 0.5) * gr * 0.8,
            gr * (0.22 + rand() * 0.2),
            0,
            Math.PI * 2,
          );
          g.fill();
        }
        // 光斑（faculae）：黑子群邻近的亮丝网
        for (let k = 0; k < 7; k++) {
          blobW(
            g,
            cx + (rand() - 0.5) * gr * 4,
            gy + (rand() - 0.5) * gr * 2.4,
            8 + rand() * 16,
            2.5 + rand() * 4,
            "#fff3c0",
            0.13 + rand() * 0.1,
          );
        }
      }
    }
    g.globalAlpha = 1;
    grainW(g, rand, 5200, ["#fff7dd", "#e8892e"], 0.06, 1.5);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  });
}

/**
 * 太阳材质（shader）：参考 Planetarium 类 three.js 太阳实现的三件套——
 * ① 表面纹理双采样错位混合出缓慢「沸腾」感（低成本伪 FBM，移动端只
 * 多一次纹理采样）；② limb darkening 按 Neckel & Labs 口径：盘面亮度
 * I = 1 − u(1 − cosθ)，u≈0.62，边缘自然变暗发红；③ Fresnel 边缘辉光
 * 把盘缘推出一圈橙金亮边，与外层日冕壳衔接。自发光不吃场景灯光。
 */
function makeSunMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uTime: { value: 0 },
    },
    vertexShader: [
      "varying vec2 vUv;",
      "varying vec3 vWN;",
      "varying vec3 vWP;",
      "void main() {",
      "  vUv = uv;",
      "  vWN = normalize(mat3(modelMatrix) * normal);",
      "  vec4 wp = modelMatrix * vec4(position, 1.0);",
      "  vWP = wp.xyz;",
      "  gl_Position = projectionMatrix * viewMatrix * wp;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D uMap;",
      "uniform float uTime;",
      "varying vec2 vUv;",
      "varying vec3 vWN;",
      "varying vec3 vWP;",
      "void main() {",
      "  vec3 V = normalize(cameraPosition - vWP);",
      "  float ndv = clamp(dot(normalize(vWN), V), 0.0, 1.0);",
      // 沸腾感：同一纹理以极小偏移、不同尺度再采一次，慢速流动混合
      "  vec2 uv2 = vUv * 1.7 + vec2(uTime * 0.006, uTime * 0.0022);",
      "  vec3 base = texture2D(uMap, vUv).rgb;",
      "  vec3 boil = texture2D(uMap, uv2).rgb;",
      "  vec3 col = mix(base, boil, 0.34);",
      // limb darkening（Neckel & Labs 线性律，u = 0.62）
      "  float limb = 1.0 - 0.62 * (1.0 - ndv);",
      "  col *= limb * 1.22;",
      // 边缘略偏红（真实盘缘色温更低）
      "  col = mix(col * vec3(1.06, 0.82, 0.58), col, smoothstep(0.0, 0.55, ndv));",
      // Fresnel 盘缘亮边
      "  float fres = pow(1.0 - ndv, 2.6);",
      "  col += vec3(1.0, 0.55, 0.16) * fres * 0.85;",
      "  gl_FragColor = vec4(col, 1.0);",
      "}",
    ].join("\n"),
  });
}

/**
 * 盘缘辉光纹理（行星大气 limb haze）：透明盘心 → 盘缘峰值 → 向外
 * 平滑衰减。精灵边长取行星直径 ×2.5，盘缘落在半径比 0.40，峰值
 * 站就钉在 0.40——光只从盘缘透出，不糊盘面。
 */
function makeLimbGlowTexture(rgb: string, wide = false): THREE.Texture {
  return cachedTex(`limb:${rgb}:${wide ? "w" : "n"}`, () => {
    const S = 256;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(0.3, `rgba(${rgb},0)`);
    grad.addColorStop(0.4, `rgba(${rgb},0.55)`);
    // wide 型（金星厚大气专用）：峰后衰减拉长、余辉更厚——散射感
    grad.addColorStop(0.55, `rgba(${rgb},${wide ? 0.34 : 0.22})`);
    grad.addColorStop(0.78, `rgba(${rgb},${wide ? 0.13 : 0.05})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

interface FlowPointSpec {
  lon: number;
  lat: number;
  /** 轨道半径（行星本地单位，与父网格几何同系） */
  rad: number;
  /** 经度漂移速度 rad/s（0 = 只闪烁不漂移） */
  speed: number;
  /** 光点世界直径（父级满缩放时） */
  size: number;
  phase: number;
  freq: number;
  /** 逐点亮度权重（缺省 1）：成串流光的拖尾衰减靠它——头亮尾淡 */
  amp?: number;
}

/**
 * 行星个性粒子（2026-11-12）：位置全在顶点着色器里由球面坐标
 * （经/纬/半径 + 逐点漂移速度）算出，CPU 逐帧零开销；逐点相位/
 * 频率做闪烁调制。frustumCulled 必须关——几何 position 只是占位，
 * 包围球不在真实位置上，开着会被视锥误杀整层。
 */
function makeFlowPoints(
  specs: FlowPointSpec[],
  opts: { color: string; opacity: number; twinkleAmp: number },
): { points: THREE.Points; mat: THREE.ShaderMaterial } {
  const n = specs.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(n * 3), 3),
  );
  const put = (name: string, get: (s: FlowPointSpec) => number) => {
    const arr = new Float32Array(n);
    specs.forEach((s, i) => {
      arr[i] = get(s);
    });
    geo.setAttribute(name, new THREE.BufferAttribute(arr, 1));
  };
  put("aLon", (s) => s.lon);
  put("aLat", (s) => s.lat);
  put("aRad", (s) => s.rad);
  put("aSpeed", (s) => s.speed);
  put("aSize", (s) => s.size);
  put("aPhase", (s) => s.phase);
  put("aFreq", (s) => s.freq);
  put("aAmp", (s) => s.amp ?? 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uScaleH: { value: 800 },
      uColor: { value: new THREE.Color(opts.color) },
      uOpacity: { value: opts.opacity },
      uTwkAmp: { value: opts.twinkleAmp },
    },
    vertexShader: [
      "attribute float aLon;",
      "attribute float aLat;",
      "attribute float aRad;",
      "attribute float aSpeed;",
      "attribute float aSize;",
      "attribute float aPhase;",
      "attribute float aFreq;",
      "attribute float aAmp;",
      "uniform float uTime;",
      "uniform float uScaleH;",
      "uniform float uTwkAmp;",
      "varying float vA;",
      "void main() {",
      "  float lon = aLon + uTime * aSpeed;",
      "  float cl = cos(aLat);",
      "  vec3 p = vec3(cl * cos(lon), sin(aLat), cl * sin(lon)) * aRad;",
      "  vec4 mv = modelViewMatrix * vec4(p, 1.0);",
      "  vA = aAmp * (1.0 - uTwkAmp + uTwkAmp * (0.5 + 0.5 * sin(uTime * aFreq + aPhase)));",
      "  gl_PointSize = clamp(aSize * uScaleH / max(0.05, -mv.z), 1.0, 42.0);",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform vec3 uColor;",
      "uniform float uOpacity;",
      "uniform float uFade;",
      "varying float vA;",
      "void main() {",
      "  float d = length(gl_PointCoord - 0.5);",
      "  float m = smoothstep(0.5, 0.06, d);",
      "  gl_FragColor = vec4(uColor, 1.0) * (m * uOpacity * uFade * vA);",
      "}",
    ].join("\n"),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return { points, mat };
}

/**
 * 极光卵环（2026-11-12 光效升级）：贴球面的连续环带，不是散点——
 * 一段球面带（SphereGeometry 的 theta 切片）绕极区成环，着色器以
 * 经度角做双频帘幕波动、带内横向做「下缘亮、上缘散」的极光帘剖面，
 * 颜色在两色之间随经度缓慢游走。真实极光卵就是这个形态：绕磁极的
 * 连续卵环 + 垂落的帘幕。南北各一枚（south 时带心镜像到南极）。
 * uFade 由行星的 orbitFade 驱动，与本体同拍淡入淡出。
 */
function makeAuroraOval(
  radius: number,
  opts: {
    colorA: string;
    colorB: string;
    /** 卵环带心距极点的角距（弧度，真实卵环约在纬度 65–72°） */
    polarRad: number;
    /** 带半宽（弧度） */
    halfWidth: number;
    south?: boolean;
    opacity: number;
  },
): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const c = opts.polarRad;
  const w = opts.halfWidth;
  const thetaC = opts.south ? Math.PI - c : c;
  const geo = new THREE.SphereGeometry(
    radius,
    96,
    20,
    0,
    Math.PI * 2,
    Math.max(0.01, thetaC - w * 1.9),
    w * 3.8,
  );
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uColorA: { value: new THREE.Color(opts.colorA) },
      uColorB: { value: new THREE.Color(opts.colorB) },
      uThetaC: { value: thetaC },
      uThetaW: { value: w },
      uOpacity: { value: opts.opacity },
    },
    vertexShader: [
      "varying vec3 vPos;",
      "void main() {",
      "  vPos = position;",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform float uTime;",
      "uniform float uFade;",
      "uniform vec3 uColorA;",
      "uniform vec3 uColorB;",
      "uniform float uThetaC;",
      "uniform float uThetaW;",
      "uniform float uOpacity;",
      "varying vec3 vPos;",
      "void main() {",
      "  vec3 n = normalize(vPos);",
      "  float theta = acos(clamp(n.y, -1.0, 1.0));",
      "  float ang = atan(n.x, n.z);",
      // 带剖面：带心最亮、向两侧平滑收（分母 0.35 让边缘留一截软尾）
      "  float band = smoothstep(1.0, 0.3, abs(theta - uThetaC) / uThetaW);",
      // 帘幕波动：双频经度波 + 缓慢行波，像垂落的光帘在摆
      "  float curtain = 0.70 + 0.30 * sin(ang * 7.0 - uTime * 1.35) + 0.16 * sin(ang * 17.0 + uTime * 2.3);",
      // 帘的纵向剖面：靠极一侧（带内缘）更锐更亮，向外散开
      "  float prof = 0.75 + 0.45 * smoothstep(1.0, -1.0, (theta - uThetaC) / uThetaW);",
      "  vec3 col = mix(uColorA, uColorB, 0.5 + 0.5 * sin(ang * 3.0 + uTime * 0.55));",
      "  float a = band * curtain * prof * uOpacity * uFade;",
      "  gl_FragColor = vec4(col, 1.0) * a;",
      "}",
    ].join("\n"),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return { mesh, mat };
}

/**
 * 暗斑涡旋贴片（海王星大暗斑专用）：贴在球面切平面上的一枚小圆盘，
 * 着色器画三臂螺旋——旋流是「成形的流」，不是点云。圆盘随行星自转
 * 钉在暗斑经纬上，螺旋相位自转出涡感。uFade 同 orbitFade 口径。
 */
function makeVortexPatch(
  radius: number,
  opts: { color: string; opacity: number },
): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const geo = new THREE.CircleGeometry(radius, 40);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uColor: { value: new THREE.Color(opts.color) },
      uOpacity: { value: opts.opacity },
    },
    vertexShader: [
      "varying vec2 vUv;",
      "void main() {",
      "  vUv = uv;",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform float uTime;",
      "uniform float uFade;",
      "uniform vec3 uColor;",
      "uniform float uOpacity;",
      "varying vec2 vUv;",
      "void main() {",
      "  vec2 q = vUv - 0.5;",
      "  float r = length(q) * 2.0;",
      "  float a = atan(q.y, q.x);",
      "  float spiral = 0.5 + 0.5 * sin(a * 3.0 - r * 9.0 - uTime * 2.2);",
      "  float disk = smoothstep(1.0, 0.12, r);",
      "  float alpha = disk * (0.22 + 0.62 * spiral * smoothstep(0.05, 0.45, r)) * uOpacity * uFade;",
      "  gl_FragColor = vec4(uColor, 1.0) * alpha;",
      "}",
    ].join("\n"),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return { mesh, mat };
}

/**
 * 月球纹理 + 高度图（2026-11-12 精修）：月海按真实位置落——正面以
 * 雨海/澄海/静海/丰饶海/危海/云海/湿海组成的「兔形」大势为准，
 * 酒海、冷海、东方海（环形山系）、背面莫斯科海点到为止；第谷、
 * 哥白尼、开普勒三大射纹系统按真实长度比例放射；环形山三层尺度，
 * 南部高地更密。高度图与颜色图同笔落坑，bump 让晨昏线附近有真实
 * 地貌起伏而不是一张灰纸。坐标：经纬 → llx/lly（设计空间 2048×1024）。
 */
function makeMoonMaps(hi = true): { map: THREE.Texture; bump: THREE.Texture } {
  void hi;
  // 月球同太阳口径：颜色图双档 2048×1024；高度图 1024×512 足够
  // （bump 是明暗扰动，半分辨率不丢可感细节，省一半高度图内存）
  const key = "moon:2";
  const hit = texCache.get(key);
  if (hit) return { map: hit, bump: texCache.get(`${key}:b`)! };
  const W = 2048;
  const H = W / 2;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.scale(W / 2048, H / 1024);
  const bc = document.createElement("canvas");
  bc.width = 1024;
  bc.height = 512;
  const bg = bc.getContext("2d")!;
  bg.scale(1024 / 2048, 512 / 1024);
  bg.fillStyle = "#808080";
  bg.fillRect(0, 0, 2048, 1024);
  const rand = seededRand(5150);
  // 高地底：亮灰 + 大尺度反照率斑驳（远古撞击溅射的明暗场）
  g.fillStyle = "#c9ccd1";
  g.fillRect(0, 0, 2048, 1024);
  for (let i = 0; i < 260; i++)
    blobW(g, rand() * 2048, rand() * 1024, 30 + rand() * 90, 22 + rand() * 60,
      rand() > 0.5 ? "#d6d9de" : "#b9bdc4", 0.07 + rand() * 0.07);
  // 月海：[经度, 纬度, 半径(设计px), 透明度] —— 多圆叠出不规则岸线，
  // 海内再压两层更暗的熔岩平原 + 皱脊弧线
  const maria: Array<[number, number, number, number]> = [
    [-45, 5, 300, 0.5], // 风暴洋（多圆拼形，下方另有补圆）
    [-17, 35.5, 108, 0.55], // 雨海
    [17.5, 27.5, 63, 0.55], // 澄海
    [31, 8.5, 82, 0.55], // 静海
    [52, -7.5, 75, 0.52], // 丰饶海
    [59, 17, 52, 0.58], // 危海（轮廓最完整的一座）
    [-16.5, -21, 68, 0.52], // 云海
    [-39.5, -24, 42, 0.55], // 湿海
    [3.5, 13, 28, 0.5], // 汽海
    [34.5, -15.5, 33, 0.52], // 酒海
    [87.5, 1.5, 35, 0.45], // 史密斯海
    [81, 57, 30, 0.42], // 洪堡海
    [147, 26, 42, 0.45], // 莫斯科海（背面）
    [-30, 60, 30, 0.4], // 冷海西段
    [25, 62, 34, 0.38], // 冷海东段
  ];
  for (const [lon, lat, r, a] of maria) {
    const x = llx(lon);
    const y = lly(lat);
    for (let i = 0; i < 11; i++) {
      const bx = x + (rand() - 0.5) * r * 1.15;
      const by = y + (rand() - 0.5) * r * 0.62;
      const br = r * (0.34 + rand() * 0.42);
      blobW(g, bx, by, br, br * 0.82, "#5d6169", a * (0.55 + rand() * 0.3));
      blobW(bg, bx, by, br, br * 0.82, "#6f6f6f", 0.35); // 海面低于高地
    }
    blobW(g, x, y, r * 0.55, r * 0.45, "#52565e", a * 0.5); // 海心更暗
    // 皱脊：海内 2–3 段低对比亮弧
    g.strokeStyle = "#d8dbe0";
    g.lineWidth = 1.6;
    for (let i = 0; i < 3; i++) {
      g.globalAlpha = 0.1 + rand() * 0.08;
      g.beginPath();
      g.arc(x + (rand() - 0.5) * r, y + (rand() - 0.5) * r * 0.5,
        r * (0.3 + rand() * 0.4), rand() * 2, rand() * 2 + 1.4);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // 风暴洋补圆（向南、向西展开成大片）
  for (const [lon, lat, r] of [[-58, -8, 130], [-38, 22, 120], [-62, 18, 95], [-30, -14, 90]] as Array<[number, number, number]>) {
    for (let i = 0; i < 8; i++)
      blobW(g, llx(lon) + (rand() - 0.5) * r, lly(lat) + (rand() - 0.5) * r * 0.5,
        r * (0.35 + rand() * 0.35), r * 0.3, "#5d6169", 0.3 + rand() * 0.16);
  }
  // 东方海：三环同心环形山系（西缘）
  {
    const x = llx(-95);
    const y = lly(-20);
    for (const rr of [58, 44, 30]) {
      g.globalAlpha = 0.2;
      g.strokeStyle = "#e8eaee";
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.16;
      g.strokeStyle = "#83878e";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, rr - 4, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // 射纹系统：[经度, 纬度, 射线数, 最大长度, 基础亮度]
  const rayCraters: Array<[number, number, number, number, number]> = [
    [-11.2, -43.3, 110, 430, 0.13], // 第谷：射纹最长可达月面 1/4 周长
    [-20, 9.6, 46, 190, 0.11], // 哥白尼
    [-38, 8.1, 26, 120, 0.09], // 开普勒
  ];
  for (const [lon, lat, n, len, a0] of rayCraters) {
    const x = llx(lon);
    const y = lly(lat);
    blobW(g, x, y, len * 0.22, len * 0.22, "#eef0f3", a0 * 0.7); // 溅射毯
    for (let i = 0; i < n; i++) {
      const ang = rand() * Math.PI * 2;
      const L = len * (0.25 + rand() * 0.75);
      const kink = (rand() - 0.5) * 0.14;
      g.strokeStyle = "#f2f4f7";
      g.lineWidth = 0.8 + rand() * 1.8;
      for (const ox of [0, -2048, 2048]) {
        const cx = x + ox;
        if (cx < -L || cx > 2048 + L) continue;
        g.globalAlpha = a0 * (0.4 + rand() * 0.6);
        g.beginPath();
        g.moveTo(cx, y);
        g.lineTo(cx + Math.cos(ang) * L * 0.55, y + Math.sin(ang) * L * 0.55);
        g.lineTo(cx + Math.cos(ang + kink) * L, y + Math.sin(ang + kink) * L);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }
  craterW(g, bg, rand, llx(-11.2), lly(-43.3), 13, 1.5, "#83878e", "#f4f6f9");
  craterW(g, bg, rand, llx(-20), lly(9.6), 17, 1.5, "#83878e", "#f4f6f9");
  craterW(g, bg, rand, llx(-38), lly(8.1), 10, 1.4, "#83878e", "#f4f6f9");
  // 阿里斯塔克：全月最亮点之一
  blobW(g, llx(-47.4), lly(23.7), 15, 13, "#f6f8fa", 0.5);
  craterW(g, bg, rand, llx(-47.4), lly(23.7), 8, 1.4, "#83878e", "#f4f6f9");
  // 环形山三层：大坑（带中央峰）/ 中坑 / 密布小坑；南部高地加密
  for (let i = 0; i < 46; i++)
    craterW(g, bg, rand, rand() * 2048, rand() * 1024, 6 + rand() * 9, 1.1, "#83878e", "#eceef1");
  for (let i = 0; i < 420; i++)
    craterW(g, bg, rand, rand() * 2048, rand() * 1024, 2 + rand() * 3.6, 1, "#83878e", "#eceef1");
  for (let i = 0; i < 1500; i++) {
    const y = rand() < 0.55 ? 512 + rand() * 512 : rand() * 1024; // 南半球加密
    craterW(g, bg, rand, rand() * 2048, y, 0.7 + rand() * 1.6, 0.8, "#83878e", "#eceef1");
  }
  grainW(g, rand, 6000, ["#ffffff", "#9a9ea6"], 0.05, 1.4);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(bc);
  bump.wrapS = THREE.RepeatWrapping;
  texCache.set(key, map);
  texCache.set(`${key}:b`, bump);
  return { map, bump };
}

/**
 * 月面访客（彩蛋）：《胆大党》赛伯星人的「伪装形态」——作品里最具
 * 辨识度的样子（官方软胶套装、动画第 1 话皆以此形态登场）。造型
 * 路线（2026-11-10 用户定）：几何体拼脸的还原度到头了，改为 2D
 * 纸片人——官方人偶抠图贴在永远朝向镜头的 billboard 精灵上。
 * 素材第三路线（用户拍板）：官方人偶图
 * 抠图（serpoArt.ts——MegaHouse 软胶官方正面图，眼色照三体套装
 * 的赤/青/黄点染；无官方背面图，「背离镜头」面用官方侧面图替
 * 补）。
 * 脚踩地口径（2026-11-10 定版，废止一切「半径余量」调法）：平面
 * 精灵永远正对镜头、屏幕直立时，离开盘面中心后地面在脚下是斜
 * 的，调半径只能在悬空与沉底之间二选一——错不在余量，在朝向。
 * 正解三件套：(1) 精灵的「上」对齐所在点的月面法线在屏幕上的
 * 投影（updatePaperFacing 里逐帧算 material.rotation）——身体
 * 轴线在画面上永远沿当地径向朝外，如站在当地地面上直立；
 * (2) 脚底锚点半径 = 精确球面半径，余量归零，鞋底中心点与球面
 * 点重合；(3) 接触感由独立的接触影卖：贴在球面上、按法线朝向
 * 的一小片椭圆暗影（shadow），脚踩在影子中心。步态起伏只做身
 * 体纵向压缩/伸展（绕脚底锚点缩放），脚在起伏周期里钉住不离
 * 地；摇摆是绕脚底的面内倾摆。轮廓附近再叠地平线淡出防半截入
 * 球（fadePaperHorizon）。正/背（侧）面按行进方向相对镜头切
 * 换、转向带横向压扁的纸片翻面（updatePaperFacing）。居民分
 * 散在整个月面（SERPO_HOME_DIRS 五个家点铺满南北半球与不同经
 * 度），各自在家点周边游走、不扎堆。真身形态未建模（仅存档）。
 */
interface PaperWalker {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  /** 接触影：贴球面的椭圆暗影（独立于精灵纹理，按法线朝向） */
  shadow: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  /** 当前倾摆角（绕脚底，步进里算、朝向更新里合成到 rotation） */
  tilt: number;
  /** 「上」对齐法线投影的面内旋转（逐帧平滑趋近，盘面中心退化时保持上值） */
  radialRot: number;
  /** 身体纵向压缩系数（步态起伏，1 = 静止；脚底锚点保证缩放不抬脚） */
  squash: number;
  /** 精灵静止高度（squash 的基准） */
  baseH: number;
  /** 正面纹理（朝镜头方向走时） */
  frontTex: THREE.Texture;
  /** 背离面纹理（背离镜头方向走时；官方侧面图替补） */
  awayTex: THREE.Texture;
  /** 当前显示的面 */
  facing: "front" | "away";
  /** 翻面进度：-1 = 无翻面；0..1 进行中（中点换图、横向压扁） */
  flip: number;
  /** 精灵静止宽度（翻面压扁的基准） */
  baseW: number;
  /** 当前所在点的月面法线（月球本地系） */
  dir: THREE.Vector3;
  /** 家点法线：游走被绳牵回的中心 */
  home: THREE.Vector3;
  /** 行进方向（dir 的切平面内） */
  fwd: THREE.Vector3;
  state: "walk" | "look";
  timer: number;
  stateTime: number;
  phase: number;
  angSpeed: number;
  swingAmt: number;
  seedOff: number;
}

/**
 * 官方人偶抠图 → 纹理：每只居民一对（正面、背离面）。素材画布
 * 统一 360×460、鞋底在 y=444（见 serpoArt.ts 文件头注），与精灵
 * 的宽高比/锚点口径一致。异步加载，就绪前精灵透明、载入即显形。
 */
function makeSerpoTextureSet(): Array<{
  front: THREE.Texture;
  away: THREE.Texture;
}> {
  const loader = new THREE.TextureLoader();
  const load = (url: string): THREE.Texture => {
    const tex = loader.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  };
  const away = load(SERPO_AWAY_URL);
  return SERPO_FRONTS.map((url) => ({ front: load(url), away }));
}

/**
 * 虾蛄星人父子的纹理对（正面官方立绘 / 背离面官方商品侧面图，
 * 出处见 mantisArt.ts）。画布口径与赛伯一致（360×460、鞋底
 * y=444），makePaperWalker 可直接共用。
 */
function makeMantisTextureSet(): {
  father: { front: THREE.Texture; away: THREE.Texture };
  son: { front: THREE.Texture; away: THREE.Texture };
} {
  const loader = new THREE.TextureLoader();
  const load = (url: string): THREE.Texture => {
    const tex = loader.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  };
  return {
    father: { front: load(MANTIS_FATHER.front), away: load(MANTIS_FATHER.away) },
    son: { front: load(MANTIS_SON.front), away: load(MANTIS_SON.away) },
  };
}

/** 极地冰盖 decal 贴图：白心向外柔和淡出（软边，不画硬圆盘） */
function makeIceDiscTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(238,246,253,0.96)");
  grad.addColorStop(0.5, "rgba(224,238,250,0.78)");
  grad.addColorStop(0.82, "rgba(212,232,248,0.28)");
  grad.addColorStop(1, "rgba(212,232,248,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface UfoCraft {
  group: THREE.Group;
  /** 底部光束锥（开口圆台，长度逐帧按高度缩放） */
  beam: THREE.Mesh;
  beamMat: THREE.MeshBasicMaterial;
  /** 碟缘一圈彩光（逐帧按色相追逐闪烁） */
  edgeMats: THREE.MeshBasicMaterial[];
  /** 船体下方的辉光精灵材质 */
  glowMat: THREE.SpriteMaterial;
}

/**
 * UFO（程序建模，用户点名要 3D、要发光）：扁椭球金属碟身 +
 * 顶部玻璃圆顶罩 + 碟缘金属环 + 底部青色发光环 + 碟缘 12 枚
 * 彩光顺序闪烁 + 底部光束锥（加色混合，降落/起飞时才亮）+
 * 船体辉光精灵。本地单位与地球半径同系（碟半径 0.115，落在
 * 停机坪外环 0.118–0.138 之内）；朝向由 animate 按「船位相对
 * 球心的径向」逐帧对齐（本地 +Y = 径向朝外）。
 */
function makeUfo(): UfoCraft {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.SphereGeometry(0.115, 36, 20),
    new THREE.MeshPhongMaterial({
      color: 0xaebdd2,
      specular: 0xdfeaff,
      shininess: 90,
      emissive: 0x11161f,
    }),
  );
  hull.scale.set(1, 0.34, 1);
  group.add(hull);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.112, 0.011, 10, 44),
    new THREE.MeshPhongMaterial({
      color: 0x8fa2ba,
      specular: 0xffffff,
      shininess: 110,
      emissive: 0x0c1016,
    }),
  );
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.052,
      28,
      16,
      0,
      Math.PI * 2,
      0,
      Math.PI / 2,
    ),
    new THREE.MeshPhongMaterial({
      color: 0x9fe8ff,
      emissive: 0x1d5d75,
      transparent: true,
      opacity: 0.92,
      shininess: 120,
      specular: 0xffffff,
    }),
  );
  dome.position.y = 0.024;
  group.add(dome);
  const belly = new THREE.Mesh(
    new THREE.TorusGeometry(0.06, 0.009, 10, 36),
    new THREE.MeshBasicMaterial({ color: 0x64e6ff }),
  );
  belly.rotation.x = Math.PI / 2;
  belly.position.y = -0.03;
  group.add(belly);
  const edgeMats: THREE.MeshBasicMaterial[] = [];
  const lightGeo = new THREE.SphereGeometry(0.0085, 8, 8);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const s = new THREE.Mesh(lightGeo, m);
    const a = (i / 12) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.113, -0.004, Math.sin(a) * 0.113);
    group.add(s);
    edgeMats.push(m);
  }
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xaef3ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(0.095, 1, 32, 1, true),
    beamMat,
  );
  beam.visible = false;
  beam.renderOrder = 5;
  group.add(beam);
  const glowMat = new THREE.SpriteMaterial({
    map: makeGlowTexture(
      "rgba(140,240,255,0.85)",
      "rgba(140,240,255,0.25)",
    ),
    transparent: true,
    opacity: 0.38,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(0.55, 0.55, 1);
  group.add(glow);
  return { group, beam, beamMat, edgeMats, glowMat };
}

/**
 * 居民的家点（月球本地系法线）：铺满整个球面——南北半球、不同
 * 经度各一片，彼此拉开；月球转到哪一面朝向镜头，都能零星看见
 * 一两只在散步（用户口径：不要扎堆）。
 */
const SERPO_HOME_DIRS: Array<[number, number, number]> = [
  [0.35, 0.42, 0.84],
  [-0.78, 0.3, 0.48],
  [0.12, -0.68, 0.66],
  [-0.4, -0.32, -0.85],
  [0.84, -0.24, -0.48],
];

function makePaperWalker(
  texPair: { front: THREE.Texture; away: THREE.Texture },
  homeDir: THREE.Vector3,
  rand: () => number,
  height: number,
  index: number,
): PaperWalker {
  const mat = new THREE.SpriteMaterial({
    map: texPair.front,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  // 锚点钉在脚底：素材鞋底在画布 y=444（自底 (460-444)/460
  // ≈ 0.035），锚点对齐这条线——位置点就是鞋底落点，面内旋转
  // （摇摆/对齐法线）与纵向压缩都绕脚转、都不抬脚。
  sprite.center.set(0.5, 0.035);
  sprite.scale.set(height * (360 / 460), height, 1);
  sprite.renderOrder = 4;
  // 接触影：独立的一小片椭圆暗影，贴在球面上（位置/朝向/尺寸在
  // stepPaperWalker 里按法线逐帧摆正），脚踩在它的中心——接触
  // 感由它卖，精灵本身一步都不许往球里压。
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1, 20),
    shadowMat,
  );
  shadow.renderOrder = 3;
  const dir = homeDir.clone();
  const up =
    Math.abs(dir.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(up, dir).normalize();
  const fwd = t1.applyAxisAngle(dir, rand() * Math.PI * 2).normalize();
  sprite.position.copy(dir);
  return {
    sprite,
    mat,
    shadow,
    shadowMat,
    tilt: 0,
    radialRot: 0,
    squash: 1,
    baseH: height,
    frontTex: texPair.front,
    awayTex: texPair.away,
    facing: "front",
    flip: -1,
    baseW: height * (360 / 460),
    dir,
    home: homeDir.clone(),
    fwd,
    state: index % 2 === 0 ? "walk" : "look",
    timer: 1.5 + rand() * 3.5,
    stateTime: 0,
    phase: rand() * Math.PI * 2,
    angSpeed: 0.05 + rand() * 0.035,
    swingAmt: index % 2 === 0 ? 1 : 0,
    seedOff: rand() * Math.PI * 2,
  };
}

/**
 * 纸片人步进（太阳系月球与主页月球共用）：沿月面大圆游走、走停
 * 交替；离家点超过约 0.55 rad 就被牵回（活动范围放宽，保证分散
 * 后近景里仍有机会遇上）。步态：脚底钉在精确球面半径上一步不
 * 动，起伏改为身体纵向压缩/伸展（squash，绕脚底锚点缩放）+
 * 绕脚底 ±5° 倾摆（tilt，跟步频）；接触影同步贴到脚下球面。
 * 正/背（侧）面的朝向切换与「上」对齐法线的面内旋转不在这里
 * 做——由 updatePaperFacing 逐帧判定/合成（步进是降频的，翻面
 * 与对齐要逐帧顺滑）。停下张望时身体缓缓左右倾。
 */
function stepPaperWalker(
  w: PaperWalker,
  sdt: number,
  rand: () => number,
  radius: number,
  roamMax = 0.55,
): void {
  w.stateTime += sdt;
  w.timer -= sdt;
  if (w.timer <= 0) {
    if (w.state === "walk") {
      w.state = "look";
      w.timer = 1.3 + rand() * 1.6;
    } else {
      w.state = "walk";
      w.timer = 2.6 + rand() * 3.6;
      w.fwd.applyAxisAngle(w.dir, (rand() - 0.5) * 1.8);
      if (w.dir.angleTo(w.home) > roamMax) {
        const toHome = w.home
          .clone()
          .addScaledVector(w.dir, -w.home.dot(w.dir));
        if (toHome.lengthSq() > 1e-6) w.fwd.copy(toHome.normalize());
      }
    }
    w.stateTime = 0;
  }
  w.swingAmt +=
    ((w.state === "walk" ? 1 : 0) - w.swingAmt) * Math.min(1, sdt * 5);
  if (w.state === "walk") {
    if (rand() < sdt * 0.22) {
      w.fwd.applyAxisAngle(w.dir, (rand() - 0.5) * 0.9);
    }
    const walkAxis = new THREE.Vector3()
      .crossVectors(w.dir, w.fwd)
      .normalize();
    const step = w.angSpeed * sdt;
    w.dir.applyAxisAngle(walkAxis, step);
    w.fwd.applyAxisAngle(walkAxis, step);
    w.phase += sdt * 7.5;
  }
  // 脚底落点（全仓统一口径）：精确球面半径，余量归零——鞋底锚点
  // 与球面点重合。起伏不再抬整只（旧 bob 把脚带离地面、旧
  // +5.5% 余量又把人吊空，全是同一个错旋钮的两种拧法）：步行
  // 时身体绕脚底锚点纵向压缩约 5% 再回弹（squash），脚一步不离
  // 地；倾摆同样绕脚底（tilt 在 updatePaperFacing 里与法线对齐
  // 角合成到 material.rotation）。
  w.sprite.position.copy(w.dir).multiplyScalar(radius);
  if (w.state === "walk") {
    w.squash = 1 - 0.05 * Math.abs(Math.sin(w.phase)) * w.swingAmt;
    w.tilt = Math.sin(w.phase) * 0.09 * w.swingAmt;
  } else {
    w.squash += (1 - w.squash) * Math.min(1, sdt * 6);
    w.tilt = Math.sin(w.stateTime * 1.5 + w.seedOff) * 0.1;
  }
  // 接触影贴球面：位置在脚下球面点外侧一丝（防 z-fighting 的亚
  // 像素量，不是站立余量），朝向由法线定——局部 +Z 对齐法线、
  // +X 对齐行进方向，椭圆长轴顺着步伐方向，脚正踩在影心。
  const lift = Math.max(0.0012, radius * 0.002);
  w.shadow.position.copy(w.dir).multiplyScalar(radius + lift);
  const xAxis = w.fwd
    .clone()
    .addScaledVector(w.dir, -w.fwd.dot(w.dir));
  if (xAxis.lengthSq() < 1e-6) {
    xAxis
      .crossVectors(
        w.dir,
        Math.abs(w.dir.y) > 0.9
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 1, 0),
      )
      .normalize();
  } else {
    xAxis.normalize();
  }
  const yAxis = new THREE.Vector3().crossVectors(w.dir, xAxis);
  w.shadow.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(xAxis, yAxis, w.dir),
  );
  w.shadow.scale.set(w.baseW * 0.4, w.baseW * 0.26, 1);
}

/**
 * 日冕辉光纹理（2026-11-12 重做，用户判旧冕「太难看了」）：旧版是
 * 径向核 + 16 条主冕流 + 190 条细冕丝 + 日珥弧的叠加——射线长度
 * 离散成簇，看着像卡通太阳的放射线，是塑料感的主犯。本版射线、
 * 流束、日珥弧全退役，只剩一条多层径向衰减曲线：内冕亮白 →
 * 盘缘暖金 → 中冕橙 → 外冕极淡，近似指数衰减、层间无硬边，就是
 * 恒星照片里「烧出来」的光。另叠 5 团极淡（α≤0.06）的大尺度柔
 * 光斑给冕一点有机不对称——宽到看不出形状，不是射线。外缘由渐
 * 变自身收束到 0（末站 α=0），转场连续性口径不变：冕径只由精灵
 * scale（恒定）与 sunFade 透明度决定，逐帧无阶跃。
 * 盘缘位置：冕精灵边长 = SUN_R×9.5，盘缘落在半径比 ≈0.21 处，
 * 渐变在 0.21 附近正好过暖金拐点，与盘面 Fresnel 亮边衔接。
 */
function makeCoronaTexture(hi = true): THREE.Texture {
  return cachedTex(`corona-soft:${hi ? 2 : 1}`, () => {
    const S = hi ? 1024 : 512;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    g.scale(S / 512, S / 512);
    const core = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    core.addColorStop(0, "rgba(255,246,220,0.95)");
    core.addColorStop(0.1, "rgba(255,233,172,0.82)");
    core.addColorStop(0.21, "rgba(255,208,112,0.58)");
    core.addColorStop(0.32, "rgba(255,176,74,0.33)");
    core.addColorStop(0.48, "rgba(255,148,52,0.155)");
    core.addColorStop(0.66, "rgba(255,130,44,0.06)");
    core.addColorStop(0.84, "rgba(255,120,40,0.018)");
    core.addColorStop(1, "rgba(255,116,38,0)");
    g.fillStyle = core;
    g.fillRect(0, 0, 512, 512);
    // 有机不对称：极少数、极宽、极淡的柔光团（径向渐变圆斑，
    // 拉成椭圆），只让冕的亮度分布不至于完美对称到假
    const rand = seededRand(77031);
    for (let i = 0; i < 5; i++) {
      const a = rand() * Math.PI * 2;
      const dist = 78 + rand() * 62;
      const x = 256 + Math.cos(a) * dist;
      const y = 256 + Math.sin(a) * dist;
      const r = 95 + rand() * 80;
      const blob = g.createRadialGradient(x, y, 0, x, y, r);
      const alpha = 0.035 + rand() * 0.03;
      blob.addColorStop(0, `rgba(255,214,130,${alpha.toFixed(3)})`);
      blob.addColorStop(1, "rgba(255,190,90,0)");
      g.save();
      g.translate(x, y);
      g.scale(1, 0.72 + rand() * 0.4);
      g.translate(-x, -y);
      g.fillStyle = blob;
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.restore();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/**
 * 太阳内层贴体柔光纹理（2026-11-12 随冕重做）：通用 makeGlowTexture
 * 只有 0.35 一个中间站，衰减在盘缘外 abrupt 转平——本纹理多站
 * 平滑衰减（亮白核 → 暖金 → 淡橙 → 0），与外冕同一条曲线语言。
 */
function makeSunGlowTexture(): THREE.Texture {
  return cachedTex("sun-glow", () => {
    const S = 256;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(255,228,164,0.9)");
    grad.addColorStop(0.3, "rgba(255,190,98,0.5)");
    grad.addColorStop(0.55, "rgba(255,156,60,0.21)");
    grad.addColorStop(0.8, "rgba(255,134,44,0.055)");
    grad.addColorStop(1, "rgba(255,126,40,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/**
 * 行星表面纹理（2026-11-12 逐颗精修）：每颗按真实特征档案落笔，
 * 特征位置走经纬坐标（llx/lly，设计空间 2048×1024），不凭想象乱放：
 * 木星条纹带湍流带界 + 大红斑旋纹 + 白卵斑 + 极区蓝灰；火星奥林帕斯
 * 山/塔尔西斯三山/水手谷/大瑟提斯/赫拉斯盆地 + 两极冰冠（北白南浅）；
 * 水星卡洛里盆地 + 三大射纹坑 + 环形山三级；金星奶黄 V 状云带与横纹
 * 羽流（刻意低对比——真实金星云顶就没有硬特征）；土星淡金细带 +
 * 北极六边形暗示；天王星只留甲烷色差的极淡层次（「没特征」是它的
 * 真实特征）；海王星大暗斑 + 白色卷云拉丝。水星/火星同步生成高度图。
 */
const planetBumpCache = new Map<string, THREE.Texture | null>();
/** 主要星球（木/土/火：纹理信息量最大、近景最常被看）双档都走 2 档 */
const MAJOR_PLANETS = new Set(["木星", "土星", "火星"]);
function planetTier(name: string, hi: boolean): number {
  return hi || MAJOR_PLANETS.has(name) ? 2 : 1;
}
function planetMaps(
  name: string,
  base: string,
  hi = true,
): { map: THREE.Texture; bump: THREE.Texture | null } {
  const map = makePlanetTexture(name, base, hi);
  return { map, bump: planetBumpCache.get(`${name}:${planetTier(name, hi)}`) ?? null };
}

/**
 * 星街彗星纹理（2026-11-12 晚改版，用户令「按星街彗星主视觉图上
 * 的原案来」；设计稿 = goal-5 GOAL.md「客串行星设计」改版节）：
 * 以星街すいせい「Once Upon a Stellar」主视觉里那颗球为外观基
 * 准调准程序纹理（原图是透视插画、无现成贴图可搬，仍为程序生
 * 成）：① 大色场纬度渐变按原案停点——顶部深红为主体（深石榴红
 * #8E2F22 一直压到约 38% 纬度带）、中段橙 #C06830、南半球下缘
 * 才收橄榄黄绿 #97A24E；② 斑驳暗纹比初版更密更碎——深褐红
 * #452019 碎斑簇加密、碎斑变小、边缘破碎交错，是签名识别点；
 * ③ 细层云丝颗粒。2048×1024 设计空间，与星体精修同口径缓存、
 * 同档位（桌面 2048×1024 / 移动 1024×512，桌面 GPU 约 +11 MB）。
 */
function makeGuestPlanetTexture(hi = true): THREE.Texture {
  const tier = hi ? 2 : 1;
  return cachedTex(`planet:guest:${tier}`, () => {
    const W = tier === 2 ? 2048 : 1024;
    const H = W / 2;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.scale(W / 2048, H / 1024);
    const rand = seededRand(20261112);
    // ① 大色场：纬度渐变（y=0 为北极；停点按原案：深红主体压到
    // 约 38%、橙在中段、黄绿只收南半球下缘）
    const grad = g.createLinearGradient(0, 0, 0, 1024);
    grad.addColorStop(0, "#5f1d14");
    grad.addColorStop(0.18, "#7c2a1f");
    grad.addColorStop(0.38, "#8e2f22");
    grad.addColorStop(0.52, "#a34d24");
    grad.addColorStop(0.63, "#c06830");
    grad.addColorStop(0.75, "#b57a38");
    grad.addColorStop(0.87, "#a08c46");
    grad.addColorStop(1, "#97a24e");
    g.fillStyle = grad;
    g.fillRect(0, 0, 2048, 1024);
    // 纬向柔带（极淡的明暗起伏，让渐变不是一条直尺渐变）
    for (let i = 0; i < 30; i++) {
      const y = rand() * 1024;
      blobW(
        g,
        rand() * 2048,
        y,
        500 + rand() * 700,
        14 + rand() * 30,
        rand() > 0.5 ? "#f0c088" : "#5e2418",
        0.04 + rand() * 0.04,
      );
    }
    // 中尺度色斑：三色系互相渗透（红/橙/黄绿在各自纬度带外也留痕）
    const blotchCols = ["#8e2f22", "#c06830", "#97a24e", "#b35a28", "#7d8a3e"];
    for (let i = 0; i < 340; i++) {
      blobW(
        g,
        rand() * 2048,
        rand() * 1024,
        22 + rand() * 70,
        10 + rand() * 32,
        blotchCols[Math.floor(rand() * blotchCols.length)]!,
        0.05 + rand() * 0.07,
      );
    }
    // ② 斑驳暗纹：簇状深褐红云斑——每簇由数枚大小不一的碎斑叠成，
    // 边缘破碎、明暗交错（识别签名，不许画成规则圆斑）；改版口径
    // 更密更碎：簇数 30→46、碎斑半径收小、再叠一层细碎斑点
    for (let cl = 0; cl < 46; cl++) {
      const cx = rand() * 2048;
      const cy = 120 + rand() * 800;
      const n = 5 + Math.floor(rand() * 7);
      for (let i = 0; i < n; i++) {
        blobW(
          g,
          cx + (rand() - 0.5) * 150,
          cy + (rand() - 0.5) * 64,
          10 + rand() * 44,
          6 + rand() * 20,
          "#452019",
          0.1 + rand() * 0.17,
        );
      }
      // 簇缘一圈被搅亮的橙色碎光（暗纹与色场的交界不死黑）
      for (let i = 0; i < 3; i++) {
        blobW(
          g,
          cx + (rand() - 0.5) * 190,
          cy + (rand() - 0.5) * 84,
          12 + rand() * 30,
          5 + rand() * 12,
          "#e09a58",
          0.06 + rand() * 0.06,
        );
      }
    }
    // ②+ 细碎斑点层：小而密的深色碎点满铺，让斑驳在近看时仍有
    // 细节、不糊成大块（原案的破碎边缘感主要来自这一层）
    for (let i = 0; i < 1500; i++) {
      blobW(
        g,
        rand() * 2048,
        rand() * 1024,
        3 + rand() * 12,
        2 + rand() * 7,
        rand() > 0.4 ? "#452019" : "#5e2418",
        0.06 + rand() * 0.12,
      );
    }
    // ③ 细云丝：顺纬向的细长亮缕 + 颗粒收尾
    for (let i = 0; i < 700; i++) {
      blobW(
        g,
        rand() * 2048,
        rand() * 1024,
        22 + rand() * 70,
        1.2 + rand() * 2.2,
        rand() > 0.45 ? "#f3d9b0" : "#6e3420",
        0.04 + rand() * 0.05,
      );
    }
    grainW(g, rand, 3200, ["#f3d9b0", "#452019"], 0.05, 1.7);
    // 北极略沉（深红极冠压暗一档，与渐变同向）
    const pol = g.createLinearGradient(0, 0, 0, 150);
    pol.addColorStop(0, "rgba(40,14,10,0.35)");
    pol.addColorStop(1, "rgba(40,14,10,0)");
    g.fillStyle = pol;
    g.fillRect(0, 0, 2048, 150);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  });
}

/**
 * 星街彗星纬度染色大气壳（专属光效②）：Fresnel 边缘辉光，颜色随
 * 本地纬度跟着表面渐变走——北半球红橙、南半球下缘黄绿；壳挂在
 * 本体子级，本地 y 即纬度轴（绕 Y 自转不改纬度读数）。太阳系本
 * 体与主页形态共用同一构建器。uniforms 只用 uTime/uFade，与行星
 * 光效 bandMats 的驱动口径对齐。
 */
function makeSuiseiShell(radius: number): {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
} {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
    },
    vertexShader: [
      "varying vec3 vN;",
      "varying vec3 vV;",
      "varying float vY;",
      "void main() {",
      "  vN = normalize(normalMatrix * normal);",
      "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
      "  vV = normalize(-mv.xyz);",
      "  vY = normalize(position).y;",
      "  gl_Position = projectionMatrix * mv;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform float uFade;",
      "varying vec3 vN;",
      "varying vec3 vV;",
      "varying float vY;",
      "void main() {",
      "  float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);",
      "  vec3 top = vec3(1.0, 0.38, 0.16);",
      "  vec3 mid = vec3(1.0, 0.58, 0.26);",
      "  vec3 bot = vec3(0.72, 0.78, 0.34);",
      "  vec3 col = vY >= 0.0 ? mix(mid, top, smoothstep(0.05, 0.95, vY)) : mix(mid, bot, smoothstep(-0.05, -0.95, vY));",
      "  float a = fr * 0.85 * uFade;",
      "  gl_FragColor = vec4(col * a, 1.0);",
      "}",
    ].join("\n"),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 40, 28),
    mat,
  );
  return { mesh, mat };
}

function makePlanetTexture(name: string, base: string, hi = true): THREE.Texture {
  const tier = planetTier(name, hi);
  return cachedTex(`planet:${name}:${tier}`, () => {
    const W = tier === 2 ? 2048 : 1024;
    const H = W / 2;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.scale(W / 2048, H / 1024);
    const rocky = name === "水星" || name === "火星";
    let bg: Ctx2D | null = null;
    let bc: HTMLCanvasElement | null = null;
    if (rocky) {
      // 高度图恒 1024×512（与颜色图同设计空间落笔，缩放独立）
      bc = document.createElement("canvas");
      bc.width = 1024;
      bc.height = 512;
      bg = bc.getContext("2d")!;
      bg.scale(1024 / 2048, 512 / 1024);
      bg.fillStyle = "#808080";
      bg.fillRect(0, 0, 2048, 1024);
    }
    g.fillStyle = base;
    g.fillRect(0, 0, 2048, 1024);
    const seed = name.split("").reduce((s, ch) => s + ch.charCodeAt(0), 7);
    const rand = seededRand(seed * 131 + 17);
    const band = (y: number, h: number, col: string, alpha: number) => {
      g.globalAlpha = alpha;
      g.fillStyle = col;
      g.fillRect(0, y, 2048, h);
      g.globalAlpha = 1;
    };
    const latBand = (
      latTop: number,
      latBot: number,
      col: string,
      alpha: number,
      amp: number,
    ) => turbBand(g, lly(latTop), lly(latBot), col, alpha, amp, rand() * 6.28);
    /** 火山盾：宽缓的亮盘 + 中央火口群（火星专用，同步进高度图） */
    const shield = (lon: number, lat: number, r: number, a: number) => {
      const x = llx(lon);
      const y = lly(lat);
      blobW(g, x, y, r, r * 0.92, "#e59a6a", a);
      blobW(g, x, y, r * 0.55, r * 0.5, "#eda87c", a * 0.7);
      for (let i = 0; i < 4; i++)
        craterW(g, bg, rand, x + (rand() - 0.5) * r * 0.3, y + (rand() - 0.5) * r * 0.3,
          r * (0.07 + rand() * 0.05), 1.2, "#8a4a2c", "#f0b98e");
      if (bg) blobW(bg, x, y, r, r * 0.92, "#a8a8a8", 0.4);
    };

    if (name === "木星") {
      // 纬向带系统（纬度口径照真实分区）：极区蓝灰 → 温带 → 暗带 →
      // 明亮赤道带 → 南温带大红斑。全部走湍流边缘，无一条直尺界线。
      latBand(90, 63, "#8e9aa6", 0.6, 7);
      latBand(63, 48, "#c9b193", 0.5, 5);
      latBand(48, 40, "#e6d7b8", 0.5, 4);
      latBand(40, 33, "#bb9066", 0.48, 5);
      latBand(33, 24, "#e9dcbc", 0.5, 4);
      latBand(24, 17, "#c49a6b", 0.45, 5);
      latBand(17, 7, "#a96f3e", 0.62, 6); // 北赤道带（暗橙棕）
      latBand(7, -7, "#f0e3c0", 0.6, 5); // 赤道带（最亮）
      latBand(-7, -20, "#bd8250", 0.55, 6); // 南赤道带
      latBand(-20, -27, "#e8d9b4", 0.5, 5); // 南热带（红斑所在）
      latBand(-27, -35, "#bd9263", 0.45, 5);
      latBand(-35, -48, "#e2cda6", 0.5, 4);
      latBand(-48, -63, "#c4ab84", 0.45, 5);
      latBand(-63, -90, "#8795a1", 0.6, 7);
      // 带内拉丝：顺纬向的细长亮/暗缕（风切变质感）
      for (let i = 0; i < 130; i++) {
        const y = rand() * 1024;
        blobW(g, rand() * 2048, y, 26 + rand() * 60, 2.5 + rand() * 3.5,
          rand() > 0.5 ? "#fff2d8" : "#8a6a48", 0.06 + rand() * 0.06);
      }
      // 赤道羽流（festoon）：自北赤道带垂入赤道带的蓝灰小钩
      for (let i = 0; i < 9; i++) {
        const x = 120 + i * 215 + rand() * 60;
        g.strokeStyle = "#7d8aa0";
        g.globalAlpha = 0.35;
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(x, lly(8));
        g.quadraticCurveTo(x + 16, lly(3), x + 44, lly(1));
        g.stroke();
      }
      g.globalAlpha = 1;
      // 大红斑（南纬 22.5°）：晕 → 环缘 → 内芯 → 旋纹弧 → 空心涡核，
      // 外围一圈被搅动的亮色尾流
      {
        const x = 1290;
        const y = lly(-22.5);
        blobW(g, x, y, 108, 48, "#e8d9b4", 0.35); // 尾流亮晕（与带同色系的搅动区）
        blobW(g, x, y, 88, 40, "#b34a30", 0.55);
        blobW(g, x, y, 76, 34, "#c2543a", 0.85);
        blobW(g, x, y, 58, 25, "#d8735a", 0.8);
        blobW(g, x, y, 36, 15, "#e8a183", 0.7);
        g.strokeStyle = "#f0b49a";
        for (let i = 0; i < 3; i++) {
          g.globalAlpha = 0.4 - i * 0.1;
          g.lineWidth = 3.4 - i * 0.8;
          g.beginPath();
          g.ellipse(x, y, 52 - i * 13, 23 - i * 6, 0.12, Math.PI * (0.15 + i * 0.4), Math.PI * (1.25 + i * 0.4));
          g.stroke();
        }
        g.globalAlpha = 1;
        blobW(g, x + 130, y + 14, 30, 9, "#f7ecd4", 0.4); // 红斑东侧小白涡
      }
      // 白卵斑：南纬 33° 一串；棕色驳斑：北纬 15° 带缘几个
      for (let i = 0; i < 5; i++)
        blobW(g, 220 + i * 330 + rand() * 40, lly(-33) + rand() * 8, 17 + rand() * 7, 8 + rand() * 3, "#f7ecd4", 0.55);
      for (let i = 0; i < 4; i++)
        blobW(g, 160 + i * 470 + rand() * 60, lly(15) + rand() * 8, 20 + rand() * 8, 7 + rand() * 3, "#7d5a38", 0.42);
      // 极区斑驳：蓝灰小斑密布两极
      for (let i = 0; i < 240; i++) {
        const y = rand() > 0.5 ? rand() * 130 : 894 + rand() * 130;
        blobW(g, rand() * 2048, y, 8 + rand() * 22, 5 + rand() * 10,
          rand() > 0.5 ? "#a7b4c0" : "#77879a", 0.1 + rand() * 0.12);
      }
      grainW(g, rand, 3600, ["#fff2d8", "#8a6a48"], 0.045, 1.6);
    } else if (name === "土星") {
      // 淡金细带：带多、对比低（真实土星本体远比木星平淡），
      // 靠细密分层而不是强斑说话
      const bands: Array<[number, number, string, number]> = [
        [74, 62, "#dcc493", 0.34], [62, 50, "#e7d6a8", 0.4], [50, 38, "#d9bf8a", 0.34],
        [38, 26, "#ead9ae", 0.4], [26, 13, "#e0c48f", 0.34], [13, -13, "#f0e0b0", 0.42],
        [-13, -26, "#e2c892", 0.32], [-26, -38, "#ead9ae", 0.38], [-38, -50, "#d9bf8a", 0.32],
        [-50, -62, "#e7d6a8", 0.36], [-62, -74, "#dcc493", 0.3],
      ];
      for (const [t, b, col, a] of bands) latBand(t, b, col, a, 2.5);
      // 极细暗线（带内分界的暗示）
      for (let i = 0; i < 26; i++) {
        const lat = -70 + rand() * 140;
        band(lly(lat), 1.6, "#b39b6d", 0.1 + rand() * 0.08);
      }
      band(lly(0) - 1, 2.2, "#a8895a", 0.18); // 赤道暗线
      // 北极：蓝灰极冠 + 六边形暗示——极冠下缘走 6 整周期正弦，
      // 在极投影里正是六边形绕极的形状
      {
        const yEdge = lly(77);
        g.globalAlpha = 0.5;
        g.fillStyle = "#93a7ad";
        g.beginPath();
        for (let x = 0; x <= 2048; x += 16) {
          const y = yEdge + Math.sin((x / 2048) * Math.PI * 2 * 6) * 9;
          if (x === 0) g.moveTo(x, 0), g.lineTo(x, y);
          else g.lineTo(x, y);
        }
        for (let x = 2048; x >= 0; x -= 16) g.lineTo(x, 0);
        g.closePath();
        g.fill();
        g.globalAlpha = 0.4;
        g.strokeStyle = "#7e939c";
        g.lineWidth = 3;
        g.beginPath();
        for (let x = 0; x <= 2048; x += 16) {
          const y = yEdge + Math.sin((x / 2048) * Math.PI * 2 * 6) * 9;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
        g.globalAlpha = 1;
      }
      band(lly(-74), 1024 - lly(-74), "#b3a58c", 0.28); // 南极区略沉
      for (let i = 0; i < 40; i++)
        blobW(g, rand() * 2048, rand() * 1024, 20 + rand() * 44, 3 + rand() * 4, "#f7ecc9", 0.06);
      grainW(g, rand, 2400, ["#f7ecc9", "#b39b6d"], 0.04, 1.4);
    } else if (name === "火星") {
      // 北半球低地偏亮、南半球高地偏暗的大势先行
      blobW(g, 1024, lly(38), 1500, 330, "#cf7a4e", 0.35);
      blobW(g, 1024, lly(-38), 1500, 330, "#9c4c2e", 0.3);
      for (let i = 0; i < 60; i++) // 尘土明暗场
        blobW(g, rand() * 2048, rand() * 1024, 26 + rand() * 70, 14 + rand() * 30,
          rand() > 0.45 ? "#c96a42" : "#a34e30", 0.1 + rand() * 0.1);
      // 大瑟提斯高原：北尖南阔的玄武岩暗楔（东经 70°、北纬 10°）
      {
        const x = llx(70);
        const y = lly(10);
        for (let i = 0; i < 9; i++)
          blobW(g, x + (rand() - 0.5) * 130, y + (rand() - 0.5) * 90,
            46 + rand() * 46, 30 + rand() * 26, "#6e3320", 0.3);
        blobW(g, x - 10, y - 66, 26, 44, "#6e3320", 0.3); // 北尖
      }
      // 南部中纬玄武岩暗带（断续）
      for (let i = 0; i < 8; i++)
        blobW(g, 140 + i * 250 + rand() * 60, lly(-28) + rand() * 30,
          60 + rand() * 50, 18 + rand() * 12, "#7e3a22", 0.26);
      // 赫拉斯盆地：浅色大圆盆（东经 70°、南纬 42.5°）
      blobW(g, llx(70), lly(-42.5), 108, 96, "#e0a878", 0.4);
      blobW(g, llx(70), lly(-42.5), 76, 66, "#d99e6c", 0.3);
      if (bg) blobW(bg, llx(70), lly(-42.5), 108, 96, "#4a4a4a", 0.5);
      // 塔尔西斯火山群 + 奥林帕斯山（东经 226°、北纬 18.6°，最大）
      shield(226.2, 18.65, 44, 0.5);
      shield(239.3, -8.4, 27, 0.42); // 阿尔西亚
      shield(247, 0.8, 26, 0.42); // 帕沃尼斯
      shield(255.9, 11.9, 27, 0.42); // 阿斯克雷乌斯
      shield(250.5, 40.9, 58, 0.2); // 阿尔巴（宽而平）
      shield(213.5, 25, 30, 0.4); // 埃律西昂
      // 水手谷：东经 255°→305°、南纬约 14° 的暗色大裂谷
      {
        const y = lly(-14);
        g.strokeStyle = "#5f2c1a";
        g.lineCap = "round";
        g.globalAlpha = 0.55;
        g.lineWidth = 15;
        g.beginPath();
        g.moveTo(llx(255), y + 6);
        g.quadraticCurveTo(llx(280), y - 8, llx(305), y + 4);
        g.stroke();
        g.globalAlpha = 0.6;
        g.lineWidth = 6;
        g.strokeStyle = "#4a2113";
        g.beginPath();
        g.moveTo(llx(255), y + 6);
        g.quadraticCurveTo(llx(280), y - 8, llx(305), y + 4);
        g.stroke();
        g.globalAlpha = 0.35;
        g.lineWidth = 3;
        g.strokeStyle = "#e8a878";
        g.beginPath();
        g.moveTo(llx(255), y + 16);
        g.quadraticCurveTo(llx(280), y + 2, llx(305), y + 14);
        g.stroke();
        g.globalAlpha = 1;
        if (bg) {
          bg.strokeStyle = "#2e2e2e";
          bg.globalAlpha = 0.7;
          bg.lineWidth = 13;
          bg.beginPath();
          bg.moveTo(llx(255), y + 6);
          bg.quadraticCurveTo(llx(280), y - 8, llx(305), y + 4);
          bg.stroke();
          bg.globalAlpha = 1;
        }
      }
      // 亮尘缕（塔尔西斯以西的阿尔巴亮尘 + 全局细缕）
      for (let i = 0; i < 22; i++)
        blobW(g, rand() * 2048, rand() * 1024, 14 + rand() * 30, 6 + rand() * 10, "#e88a5f", 0.12);
      // 环形山：南半球高地更密
      for (let i = 0; i < 130; i++)
        craterW(g, bg, rand, rand() * 2048, rand() * 1024, 2.4 + rand() * 5, 0.9, "#7e3a22", "#e8a878");
      for (let i = 0; i < 620; i++) {
        const y = rand() < 0.6 ? 512 + rand() * 512 : rand() * 1024;
        craterW(g, bg, rand, rand() * 2048, y, 0.8 + rand() * 2.2, 0.75, "#7e3a22", "#e8a878");
      }
      // 两极冰冠：北冠大而纯白（带暗色裂谷弧暗示）、南冠小而偏旧雪色
      for (let i = 0; i < 16; i++)
        blobW(g, rand() * 2048, rand() * 26, 30 + rand() * 46, 12 + rand() * 10, "#faf5ec", 0.6);
      band(0, lly(80), "#faf5ec", 0.9);
      g.strokeStyle = "#c8b8a4";
      g.globalAlpha = 0.35;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(llx(300), lly(90) + 6, 130, Math.PI * 0.15, Math.PI * 0.75);
      g.stroke();
      g.globalAlpha = 1;
      for (let i = 0; i < 10; i++)
        blobW(g, rand() * 2048, 1000 + rand() * 22, 22 + rand() * 34, 9 + rand() * 7, "#efe4d2", 0.5);
      band(lly(-84), 1024 - lly(-84), "#f1e7d6", 0.75);
      grainW(g, rand, 4200, ["#e88a5f", "#7e3a22"], 0.05, 1.5);
    } else if (name === "金星") {
      // 硫酸云顶：奶黄底 + 横向长纹（超旋转的风带拉丝）+ V 状云带
      // （chevron：顶点朝西、双臂向东张开，UV 影像里金星最标志的形）
      // + 低纬羽流。全部低对比：真实金星没有硬特征，硬造斑点即假。
      const swirl = ["#f2d49a", "#dfb26a", "#eccf8e", "#e3ba76"];
      for (let i = 0; i < 110; i++) {
        const y = rand() * 1024;
        blobW(g, rand() * 2048, y, 60 + rand() * 130, 7 + rand() * 13,
          swirl[i % 4]!, 0.09 + rand() * 0.07);
      }
      // V 状云带：三组，顶点经度错开
      for (const apex of [300, 1150, 1780]) {
        for (const sgn of [-1, 1]) {
          g.strokeStyle = sgn < 0 ? "#f7e3b0" : "#e0b26c";
          g.globalAlpha = 0.16;
          g.lineWidth = 26;
          g.lineCap = "round";
          g.beginPath();
          g.moveTo(apex, 512);
          g.quadraticCurveTo(apex + 260, 512 + sgn * 130, apex + 620, 512 + sgn * 210);
          g.stroke();
          g.globalAlpha = 0.1;
          g.lineWidth = 12;
          g.beginPath();
          g.moveTo(apex, 512);
          g.quadraticCurveTo(apex + 300, 512 + sgn * 190, apex + 700, 512 + sgn * 300);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      // 极区微沉 + 赤道微亮（体积感的底子，剩下的交给光照）
      band(0, 90, "#dbaf66", 0.14);
      band(934, 90, "#dbaf66", 0.12);
      band(lly(14), lly(-14) - lly(14), "#f9ecc2", 0.08);
      for (let i = 0; i < 30; i++) // 细羽缕
        blobW(g, rand() * 2048, rand() * 1024, 30 + rand() * 50, 3 + rand() * 4, "#f9ecc2", 0.09);
      grainW(g, rand, 2600, ["#f9ecc2", "#dfb26a"], 0.04, 1.4);
    } else if (name === "水星") {
      // 灰调先分深浅：平滑平原（略深、偏冷）与撞击高地（略亮、偏暖）
      // 两套斑块场交错——不是均匀水泥灰
      for (let i = 0; i < 15; i++)
        blobW(g, rand() * 2048, rand() * 1024, 90 + rand() * 150, 80 + rand() * 130, "#8f8478", 0.14);
      for (let i = 0; i < 20; i++)
        blobW(g, rand() * 2048, rand() * 1024, 50 + rand() * 100, 44 + rand() * 80, "#c4bba9", 0.12);
      // 卡洛里盆地（东经 162.7°、北纬 30.5°）：同心环脊 + 平滑盆底
      {
        const x = llx(162.7);
        const y = lly(30.5);
        blobW(g, x, y, 104, 96, "#98907f", 0.35);
        blobW(g, x, y, 78, 72, "#a29a89", 0.3);
        for (const rr of [102, 86, 70]) {
          g.globalAlpha = 0.28;
          g.strokeStyle = "#ddd5c4";
          g.lineWidth = 3;
          g.beginPath();
          g.arc(x, y, rr, 0, Math.PI * 2);
          g.stroke();
          g.globalAlpha = 0.2;
          g.strokeStyle = "#6e675c";
          g.lineWidth = 2;
          g.beginPath();
          g.arc(x, y, rr - 5, 0, Math.PI * 2);
          g.stroke();
        }
        g.globalAlpha = 1;
        if (bg) {
          blobW(bg, x, y, 100, 92, "#5a5a5a", 0.5);
          bg.globalAlpha = 0.6;
          bg.strokeStyle = "#e8e8e8";
          bg.lineWidth = 5;
          bg.beginPath();
          bg.arc(x, y, 100, 0, Math.PI * 2);
          bg.stroke();
          bg.globalAlpha = 1;
        }
      }
      // 环形山三级：大坑（中央峰 + 阶地环）/ 中坑 / 密布小坑
      for (let i = 0; i < 34; i++)
        craterW(g, bg, rand, rand() * 2048, rand() * 1024, 8 + rand() * 10, 1.2, "#6e675c", "#e6ded0");
      for (let i = 0; i < 300; i++)
        craterW(g, bg, rand, rand() * 2048, rand() * 1024, 3 + rand() * 4.6, 1.05, "#6e675c", "#e6ded0");
      for (let i = 0; i < 1500; i++)
        craterW(g, bg, rand, rand() * 2048, rand() * 1024, 0.8 + rand() * 2.2, 0.9, "#6e675c", "#e6ded0");
      // 亮射线坑：库伊珀（南纬 11°）、德彪西（南纬 50°）、北斋（北纬 58°）
      const ray = (lon: number, lat: number, n: number, len: number) => {
        const x = llx(lon);
        const y = lly(lat);
        craterW(g, bg, rand, x, y, 6, 1.5, "#6e675c", "#f2ecdf");
        blobW(g, x, y, 26, 24, "#efe8da", 0.22);
        g.strokeStyle = "#efe8da";
        for (let i = 0; i < n; i++) {
          const a = rand() * Math.PI * 2;
          const L = len * (0.35 + rand() * 0.65);
          g.globalAlpha = 0.07 + rand() * 0.09;
          g.lineWidth = 1 + rand() * 1.4;
          for (const ox of [0, -2048, 2048]) {
            const cx = x + ox;
            if (cx < -L || cx > 2048 + L) continue;
            g.beginPath();
            g.moveTo(cx, y);
            g.lineTo(cx + Math.cos(a) * L, y + Math.sin(a) * L * 0.8);
            g.stroke();
          }
        }
        g.globalAlpha = 1;
      };
      ray(331.3, -11.3, 30, 210);
      ray(348.7, -49.6, 24, 170);
      ray(16.8, 57.8, 20, 150);
      grainW(g, rand, 5200, ["#d3c8b8", "#8d8172"], 0.06, 1.5);
    } else if (name === "天王星") {
      // 甲烷青蓝：只做层次不做特征——纵向色差（赤道略深、两极略亮）
      // + 极淡纬带 + 北极亮冠 + 三两缕白云。任何更强的斑都会假。
      const vg = g.createLinearGradient(0, 0, 0, 1024);
      vg.addColorStop(0, "rgba(230,250,247,0.20)");
      vg.addColorStop(0.5, "rgba(120,190,185,0.10)");
      vg.addColorStop(1, "rgba(225,246,243,0.16)");
      g.fillStyle = vg;
      g.fillRect(0, 0, 2048, 1024);
      latBand(52, 34, "#bdeae6", 0.14, 2);
      latBand(10, -14, "#8fd0cc", 0.12, 2);
      latBand(-30, -48, "#aededa", 0.11, 2);
      band(0, lly(66), "#e2f5f2", 0.13); // 北极亮冠
      band(lly(-70), 1024 - lly(-70), "#cfeeea", 0.08);
      for (let i = 0; i < 6; i++)
        blobW(g, rand() * 2048, 200 + rand() * 620, 26 + rand() * 34, 3 + rand() * 3, "#eefaf8", 0.1);
      grainW(g, rand, 1500, ["#e8f7f4", "#7fc4bf"], 0.03, 1.3);
    } else if (name === "海王星") {
      // 深蓝风带：带界波浪 + 高速拉丝；大暗斑（南纬 22°）+ 伴随亮云
      latBand(58, 38, "#5f83e0", 0.36, 4);
      latBand(38, 18, "#3c5cc0", 0.36, 4);
      latBand(18, -6, "#6489e4", 0.3, 4);
      latBand(-6, -30, "#4266c4", 0.34, 5);
      latBand(-30, -52, "#35549f", 0.34, 4);
      latBand(-52, -75, "#5578d4", 0.28, 4);
      // 风带拉丝：细长水平亮/暗缕（甲烷冰晶被高速风扯出的形状）
      for (let i = 0; i < 60; i++)
        blobW(g, rand() * 2048, rand() * 1024, 34 + rand() * 70, 2 + rand() * 2.6,
          rand() > 0.5 ? "#9db9f2" : "#2c4c9e", 0.08 + rand() * 0.07);
      // 大暗斑 + 亮伴云
      {
        const x = 780;
        const y = lly(-22);
        blobW(g, x, y, 62, 30, "#2f4fa8", 0.6);
        blobW(g, x, y, 42, 20, "#223d85", 0.55);
        blobW(g, x - 26, y - 34, 34, 8, "#eef4ff", 0.5);
        blobW(g, x + 40, y + 26, 24, 6, "#dbe8ff", 0.35);
      }
      // 白色卷云缕：高空甲烷冰晶，细、亮、顺纬向
      for (let i = 0; i < 11; i++)
        blobW(g, rand() * 2048, 120 + rand() * 780, 44 + rand() * 56, 3 + rand() * 3.4, "#eaf2ff", 0.34);
      blobW(g, 1330, lly(-38), 26, 13, "#dbe8ff", 0.32); // 亮斑（Scooter 位）
      grainW(g, rand, 2200, ["#9db9f2", "#2c4c9e"], 0.04, 1.4);
    } else {
      for (let i = 0; i < 14; i++)
        blobW(g, rand() * 2048, rand() * 1024, 20 + rand() * 36, 10 + rand() * 16, "#ffffff", 0.07);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    if (rocky && bc) {
      const bt = new THREE.CanvasTexture(bc);
      bt.wrapS = THREE.RepeatWrapping;
      planetBumpCache.set(`${name}:${tier}`, bt);
    } else {
      planetBumpCache.set(`${name}:${tier}`, null);
    }
    return tex;
  });
}

/**
 * 土星环纹理（2026-11-12 精修）：不再是几十条等距圆线，而是按真实
 * 环系剖面逐半径采样——D 环（极淡）→ C 环（半透灰蓝）→ B 环（最亮、
 * 内部还有明暗环带）→ 卡西尼缝（近全透，内含惠更斯亮环）→ A 环
 * （含恩克缝细线）→ 外缘收尾。半径以「占外缘半径的比例」计
 * （RingGeometry 平面 UV 的天然坐标），逐 1px 采样叠加环纹噪声，
 * 再撒方位向的团块（环内物质不均匀是真实照片里的常态）。
 * 同一张纹理供太阳系主环与主页客串土星环共用（两者外缘比例一致）。
 */
function makeSaturnRingTexture(): THREE.Texture {
  return cachedTex("saturn-ring", () => {
    const S = 1024;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    const rand = seededRand(4451);
    /** 半径比例 → [alpha, 颜色]：环系剖面（照 NASA 环带划分比例） */
    const profile = (f: number): [number, string] => {
      if (f < 0.55) return [0, "#000000"];
      if (f < 0.615) return [0.05, "#b9b0a0"]; // D 环
      if (f < 0.715) return [0.17, "#b5ac9c"]; // C 环（偏灰）
      if (f < 0.885) {
        // B 环：最亮，内部以正弦分出宽窄不一的子带
        const sub = 0.78 + 0.22 * Math.sin(f * 210) * Math.sin(f * 47 + 1.2);
        return [0.92 * sub, "#e8d5a5"];
      }
      if (f < 0.912) {
        if (f > 0.887 && f < 0.891) return [0.5, "#e2cfa0"]; // 惠更斯环
        return [0.03, "#000000"]; // 卡西尼缝
      }
      if (f < 0.985) {
        if (f > 0.953 && f < 0.959) return [0.04, "#000000"]; // 恩克缝
        return [0.52, "#d9c69c"]; // A 环
      }
      if (f < 1) return [0.2 * (1 - f) / 0.015, "#d9c69c"]; // 外缘渐隐
      return [0, "#000000"];
    };
    for (let r = 274; r < 512; r++) {
      const f = r / 512;
      const [a0, col] = profile(f);
      if (a0 <= 0) continue;
      // 环纹细噪：每像素半径一条独立亮度（哈希种子 ⇒ 稳定不闪）
      const nRand = seededRand(r * 7919);
      const a = a0 * (0.82 + nRand() * 0.3);
      g.strokeStyle = col;
      g.globalAlpha = Math.min(1, a);
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(512, 512, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    // 方位团块：B/A 环里短弧段的明暗斑（物质聚集/稀疏）
    for (let i = 0; i < 650; i++) {
      const f = 0.72 + rand() * 0.26;
      const r = f * 512;
      const a0 = rand() * Math.PI * 2;
      const span = 0.02 + rand() * 0.09;
      g.strokeStyle = rand() > 0.5 ? "#f4e7c2" : "#8a7a58";
      g.globalAlpha = 0.04 + rand() * 0.05;
      g.lineWidth = 1 + rand() * 2.4;
      g.beginPath();
      g.arc(512, 512, r, a0, a0 + span);
      g.stroke();
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  });
}

/**
 * 天王星环纹理：近全透明底上两三条细线——ε 环（最外、最亮）+ 内侧
 * 两条弱环。真实环系又细又暗，这里只求「有、且细」，不许喧宾夺主。
 */
function makeUranusRingTexture(): THREE.Texture {
  return cachedTex("uranus-ring", () => {
    const S = 512;
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const g = c.getContext("2d")!;
    const ring = (f: number, alpha: number, w: number) => {
      g.strokeStyle = "#d8f2ee";
      g.globalAlpha = alpha;
      g.lineWidth = w;
      g.beginPath();
      g.arc(256, 256, f * 256, 0, Math.PI * 2);
      g.stroke();
    };
    ring(0.9, 0.22, 2);
    ring(0.945, 0.4, 2.4);
    ring(0.985, 0.85, 3); // ε 环
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/** 亮星十字芒纹理：中心亮点 + 水平/垂直细芒，只给极少数亮星用 */
function makeCrossStarTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  const core = g.createRadialGradient(64, 64, 0, 64, 64, 30);
  core.addColorStop(0, "rgba(255,255,255,0.95)");
  core.addColorStop(0.4, "rgba(210,230,255,0.35)");
  core.addColorStop(1, "rgba(210,230,255,0)");
  g.fillStyle = core;
  g.fillRect(0, 0, 128, 128);
  const bar = (horizontal: boolean) => {
    const lg = horizontal
      ? g.createLinearGradient(0, 0, 128, 0)
      : g.createLinearGradient(0, 0, 0, 128);
    lg.addColorStop(0, "rgba(200,225,255,0)");
    lg.addColorStop(0.5, "rgba(235,245,255,0.75)");
    lg.addColorStop(1, "rgba(200,225,255,0)");
    g.fillStyle = lg;
    if (horizontal) g.fillRect(0, 62.5, 128, 3);
    else g.fillRect(62.5, 0, 3, 128);
  };
  bar(true);
  bar(false);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function Globe({
  intensity,
  selected,
  autoRotate,
  solarSystem,
  solarView = "near",
  focusedBody = null,
  homePlanet = "earth",
  indexBoards,
  cableStatusById,
  onCableSelect,
  onSelect,
  onCenterSelect,
  onSolarSystemChange,
  onBodyFocus,
}: GlobeProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    intensity,
    selected,
    autoRotate,
    solarSystem,
    solarView,
    focusedBody,
    homePlanet,
    indexBoards,
    cableStatusById,
    onCableSelect,
    onSelect,
    onCenterSelect,
    onSolarSystemChange,
    onBodyFocus,
  });
  stateRef.current = {
    intensity,
    selected,
    autoRotate,
    solarSystem,
    solarView,
    focusedBody,
    homePlanet,
    indexBoards,
    cableStatusById,
    onCableSelect,
    onSelect,
    onCenterSelect,
    onSolarSystemChange,
    onBodyFocus,
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;
    // 像素比封顶 2（2026-11-12 由移动端 1.6 上调）：1.6 在 3x 密度
    // 屏上等于整幅画布放大近一倍显示，是移动端卡片/标签发虚的主
    // 因之一，用户两次以模糊为主诉。2 是锐度与发热/帧率的折中，
    // 不直冲原生 3；桌面口径同为 2 不变。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    const el = renderer.domElement;
    el.style.display = "block";
    // 竖向滑动永远优先滚页面：浏览器接管纵向平移（并以 pointercancel 通知），
    // 画布只消费横向拖拽做旋转。绝不能用 none —— 那会把页面滚动一起吞掉。
    el.style.touchAction = "pan-y";

    // —— 主页流星星幕的 2D 覆盖画布（2026-11-12 晚改版，JI 定）——
    // 主页流星雨不再走地球夜半球薄壳的池化着色器 Mesh（真机上用户
    // 两轮实报看不见），改成「星辰坠落」式前景星幕：与 WebGL 画布
    // 同尺寸的 2D 画布贴在最上层，流星自画面上缘成幕降下，按构造
    // 不可能被球体/背面/昼夜遮挡。2D canvas 是真机实证可见的渲染
    // 栈；指针全穿透，拖拽/点选仍落在 WebGL 画布上。尺寸在 resize
    // 里与渲染器同步；绘制逻辑在 animate 的流星段（curtain 变量组）。
    if (getComputedStyle(mount).position === "static") {
      mount.style.position = "relative";
    }
    const curtainCanvas = document.createElement("canvas");
    curtainCanvas.style.position = "absolute";
    curtainCanvas.style.inset = "0";
    curtainCanvas.style.width = "100%";
    curtainCanvas.style.height = "100%";
    curtainCanvas.style.pointerEvents = "none";
    curtainCanvas.style.zIndex = "5";
    curtainCanvas.setAttribute("aria-hidden", "true");
    mount.appendChild(curtainCanvas);
    const curtainCtx = curtainCanvas.getContext("2d");
    // —— 背景八星名签的矢量 DOM 层（2026-11-12 深夜立项：名签
    // 不走位图精灵纹理——固定分辨率画布贴图在高 DPR 真机上发
    // 糊，与当初指数板同病——改真实 DOM 文字：浏览器文字引擎
    // 按设备像素原生渲染，DPR 3 与任意缩放下字边锐利；2026-11-13
    // 晚格式统一：玻璃卡外壳退役，改与太阳系行星名签（makeSolar
    // Label）同款的裸排版——纯文字、无底色无边框无内边距（文字
    // 前的星色小圆点同日晚按用户口径与行星签一并退役），紧贴星
    // 点正上方居中锚定，见 addNamedStar 处注）——
    // 八枚名签由 animate 背景八星段逐帧直锚星点投影定位（同源
    // 投影、零缓存）。指针穿透。层级（2026-11-13 用户：「图层
    // 优先级要最高」）：z 6 居挂载点内最高——压过星幕画布
    // （z 5）与 WebGL 画布，名签永不被任何场景层盖住（星幕只
    // 在主页、名签只在太阳系，两者本不同场，抬层级是纯保险、
    // 不产生新的叠压关系）。
    const starLabelLayer = document.createElement("div");
    starLabelLayer.style.position = "absolute";
    starLabelLayer.style.inset = "0";
    // 必须裁剪（2026-11-13 用户实报「移动端横向不锁定、整个界面能
    // 被横向拖动」的出界者就是本层）：名卡靠 transform 定位，星点
    // 转到相机背后/视锥外时投影坐标可飞到视口外数千 px，变换后的
    // 盒子仍计入页面可滚动溢出——本层不裁剪就会把整个页面撑宽。
    // 定位段另有背面/离屏剔除（见 animate 名签段），本处裁剪是该
    // 层自己的边界纪律，不靠全局 overflow-x 硬压。
    starLabelLayer.style.overflow = "hidden";
    starLabelLayer.style.pointerEvents = "none";
    starLabelLayer.style.zIndex = "6";
    starLabelLayer.setAttribute("aria-hidden", "true");
    mount.appendChild(starLabelLayer);
    // —— 名签顶部安全带（2026-11-13，用户实报移动端近距下最上方
    // 的星名被顶栏左右的时间/状态标签挡住）：App 顶栏悬浮在地球
    // 区之上（左上角东京时钟药丸 + 右上角数据状态，顶距 =
    // max(12px, 安全区顶) + 药丸约 30px），本层名签只按层内 2px
    // 贴边翻转时，签面正好落进这条悬浮带里被药丸盖住。粗指针下
    // 把名签（八星 + 彗星卡共用本层）的纵向翻转线抬到悬浮带下
    // 沿之下：实测 env(safe-area-inset-top) 后按顶栏同口径算带
    // 高（max(12, 实测) + 药丸 32 + 余量 8）；桌面维持原 2px。
    // —— 右侧一段退役（2026-11-13 晚，用户：「安全带右侧可以不
    // 用了，换图标了」）：右上角数据状态已由宽幅文字药丸换成
    // 30px 圆形对勾徽章（见 App 的 DataStatus），横向只占顶栏
    // 右缘约 42px，不再构成需要整行让位的遮挡——安全带自此只
    // 护左侧时钟药丸的横向跨度：签面横向与时钟跨度相交才用带
    // 高作翻转线，其余位置（中部与右侧）一律回到层顶 2px，近
    // 距下右侧顶部的星名不再被无谓的翻转推离星点。时钟跨
    // 度口径：顶栏左距 12px + 药丸实测宽约 176px（「东京
    // HH:MM:SS + 日期」一行、字号定版）+ 呼吸缝 8px ≈ 196px。
    const satProbe = document.createElement("div");
    satProbe.style.cssText =
      "position:absolute;top:env(safe-area-inset-top, 0px);width:0;height:0;visibility:hidden;pointer-events:none";
    mount.appendChild(satProbe);
    const satPx = satProbe.offsetTop || 0;
    satProbe.remove();
    const labelTopSafePx = isCoarse ? Math.max(12, satPx) + 40 : 2;
    const labelTopSafeLeftW = isCoarse ? 196 : 0;
    /** 按签面横向跨度取本签的顶部翻转线：与左侧时钟跨度相交
     * 才抬到安全带下沿，否则层顶 2px（桌面恒 2px） */
    const topSafeForSpan = (spanL: number, spanR: number): number =>
      isCoarse && spanL < labelTopSafeLeftW && spanR > 0
        ? labelTopSafePx
        : 2;
    let curtainW = 0;
    let curtainH = 0;
    // —— 星幕画布自有像素比（2026-11-13 修复，用户实报移动端流
    // 星「马赛克、变大了」）：旧制星幕与 WebGL 画布共用渲染器像
    // 素比（封顶 2，为 3D 场景的发热/帧率折中）——在 3× 密度的
    // iPhone 上整层只以 2× 渲染、再被合成器放大 1.5× 显示，流
    // 星的细斜线与 1–2px 星点全成块状阶梯。2D 覆盖层绘制便宜、
    // 不必陪绑这个折中：星幕改用设备原生像素比（封顶 3），备
    // 援分辨率在 resize 里按本值定、绘制变换同值（绘制坐标仍
    // 是 CSS 像素，尺寸口径一字不变）；WebGL 侧封顶 2 不动。
    let curtainPr = Math.min(window.devicePixelRatio || 1, 3);
    // —— 星幕配色变体表（2026-11-13 00:08 定版，用户拍板「按这
    // 套配色施工」，取代 23:50 的单纯白紫换色）：每颗坠星生成时
    // 按权重抽一档、整段生命用该档渐变——① 月白紫 55%（主力）：
    // 芯 #FFFFFF、头微染 #EDE9FF、尾 →#C4B5FD、光晕 #B8A9FF；
    // ② 蓝白 27%（分给最快最细的那批）：头微染 #E0EAFF、尾
    // →#A9C2FF、光晕 #93B4FF；③ 钙紫粉 13%（分给较慢较粗的那
    // 批、四档中最艳、靠稀少控场）：头微染 #FBE9FF、尾 →#E9B8FF
    // →#C99BF5、光晕 #D8A7F5；④ 镁绿白 5%：头微染 #E6FFF2、尾
    // →#B9E8D2（高度降饱和的薄荷白）。另约 3% 任意档叠加火流星
    // 放大（同色系、尺寸/亮度 1.6–2×、不换色，取代旧的火流星分
    // 段概率 4%/8%）。纪律：同档内只许 ±6° 色相 / ±5% 明度微抖
    // （生成时逐通道 ±5% 预抖、不许跨档乱变）；禁金/黄主导、禁
    // 青/蓝绿实色（撞光缆）、禁实心满饱和 #A78BFA/#5F83FF（撞
    // 金融弧——流星紫更淡、带渐变、瞬时、低 α 光晕）、禁橙红
    // （撞彗星燃烧段）。stops = [偏移, rgb, alpha 系数]，尾端
    // alpha 归零渐隐；haloA = 光晕中段 alpha（低 α 口径）。
    type CurtainVariantDef = {
      stops: Array<{ o: number; rgb: [number, number, number]; a: number }>;
      halo: [number, number, number];
      haloA: number;
      // 变体承载（2026-11-13 09:28 改判）：白磷烟迹退役后，档色
      // 改由轨身渐变（stops）+ 头部星芒染色（halo）承载，星芯近白
    };
    // —— 可见度再定标（2026-11-13，用户实报「3 好像没什么变化」）：
    // 首版变体 hex/权重无误，但渲染口径把色洗没了——尾段 alpha 只
    // 0.5–0.6 还一路渐隐、宽晕层仅 16%、亮头光晕近纯白（haloA
    // 0.18–0.25），1.5px 细线加色混合后四档全读成「白」。本轮 hex
    // 与权重（55/27/13/5）一字不动，只提色的交付强度：尾段主色
    // alpha 提到 0.85–0.9 并在中段平台保持（不再一过半就衰减）、
    // haloA 近翻倍、绘制段另加一条中色鞘层（见 animate 流星段）。
    const CURTAIN_VARIANTS: CurtainVariantDef[] = [
      {
        // 月白紫（主力；2026-11-13 晚尾色向新海诚蓝紫再靠一档：
        // 尾段紫加深、光晕紫意加重，与彗尾同语系）
        stops: [
          { o: 0, rgb: [255, 255, 255], a: 1 },
          { o: 0.22, rgb: [237, 233, 255], a: 0.92 },
          { o: 0.62, rgb: [176, 154, 252], a: 0.88 },
          { o: 1, rgb: [176, 154, 252], a: 0 },
        ],
        halo: [168, 148, 255],
        haloA: 0.4,
      },
      {
        // 蓝白（快而细；尾色同轮向蓝紫靠）
        stops: [
          { o: 0, rgb: [255, 255, 255], a: 1 },
          { o: 0.25, rgb: [224, 234, 255], a: 0.92 },
          { o: 0.7, rgb: [156, 176, 255], a: 0.88 },
          { o: 1, rgb: [156, 176, 255], a: 0 },
        ],
        halo: [138, 164, 255],
        haloA: 0.36,
      },
      {
        // 钙紫粉（慢而粗、最艳）
        stops: [
          { o: 0, rgb: [255, 255, 255], a: 1 },
          { o: 0.22, rgb: [251, 233, 255], a: 0.92 },
          { o: 0.55, rgb: [233, 184, 255], a: 0.9 },
          { o: 0.85, rgb: [201, 155, 245], a: 0.62 },
          { o: 1, rgb: [201, 155, 245], a: 0 },
        ],
        halo: [216, 167, 245],
        haloA: 0.46,
      },
      {
        // 镁绿白（薄荷白、稀少）
        stops: [
          { o: 0, rgb: [255, 255, 255], a: 1 },
          { o: 0.3, rgb: [230, 255, 242], a: 0.92 },
          { o: 0.75, rgb: [185, 232, 210], a: 0.85 },
          { o: 1, rgb: [185, 232, 210], a: 0 },
        ],
        halo: [205, 242, 224],
        haloA: 0.34,
      },
    ];
    // 亮头柔光点（按档离线预渲染 4 张，逐帧 drawImage 盖印，避
    // 免 shadowBlur）：近白炽芯 + 该档光晕色（haloA 低 α）渐隐。
    // 预渲染分辨率 64 → 256（2026-11-13 马赛克修复）：旧 64px
    // 源图被 drawImage 到 42 CSS px（火流星 68）在高像素比下
    // 需 84–204 备援 px、等于先放大 1.3–3.2× 再显示，全幕最亮
    // 的头部恰恰最糊；256 源图覆盖星幕原生像素比（封顶 3）下
    // 的最大盖印尺寸（68×3=204），恒为缩小盖印、边缘干净。
    const curtainGlows: HTMLCanvasElement[] = CURTAIN_VARIANTS.map(
      (v) => {
        const cv = document.createElement("canvas");
        cv.width = 256;
        cv.height = 256;
        const g = cv.getContext("2d");
        if (g) {
          const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
          grad.addColorStop(0, "rgba(255,255,255,0.9)");
          // 晕色段内收 + 补一段中途晕（2026-11-13 可见度再定标）：
          // 旧版晕色只在 0.35 处以低 α 出现一次、随即渐隐，亮头
          // 读作纯白；现晕色自 0.3 起以 haloA 交付、0.62 处仍留
          // 四成，让每颗的头都带得住本档颜色
          grad.addColorStop(
            0.3,
            `rgba(${v.halo[0]},${v.halo[1]},${v.halo[2]},${v.haloA})`,
          );
          grad.addColorStop(
            0.62,
            `rgba(${v.halo[0]},${v.halo[1]},${v.halo[2]},${(v.haloA * 0.4).toFixed(3)})`,
          );
          grad.addColorStop(
            1,
            `rgba(${v.halo[0]},${v.halo[1]},${v.halo[2]},0)`,
          );
          g.fillStyle = grad;
          g.fillRect(0, 0, 256, 256);
        }
        return cv;
      },
    );
    // —— 陨石精灵组（2026-11-13 新增，用户：「流星雨里面极小概
    // 率出现的最大尺寸的流星直接改成陨石」；当日终令再收紧为无
    // 条件直替：「你还不如直接把最大尺寸的火流星用陨石代替，不
    // 然概率太低了」——0.35 概率与每循环一颗硬顶同日作废）：最
    // 大尺寸档（火流
    // 星档）以普通流星形态出现时个头过大、不够美观，改陨石正是
    // 为收掉那份臃肿——本体按实心岩石读法设计：直径 20–26 CSS
    // px（≈火流星星芒核的量级、明显小于其 68px 柔光盖印的视觉
    // 占位），靠质感而非体积压场，不许比原最大档更臃肿。三款岩
    // 体 512px 离线预渲染（种子固定、岩形恒定；高像素比下恒为
    // 缩小盖印，不重蹈旧 64px 糊头覆辙）：不规则轮廓 + 陨石坑 +
    // 斑驳 + 前缘（精灵底缘）熔带与熔蚀裂纹，绘制时熔边恒朝坠
    // 向（整圈翻滚会让烤死的熔边穿帮，只许小幅摇摆）。余烬辉
    // 光与尘烟各一张预渲染小图，口径同亮头柔光点。本组橙红只
    // 服务这一颗实心天体（用户点名的熔边/燃烧语汇），与四档流
    // 星的禁橙红纪律互不相干（那条禁的是流星拖尾撞彗星色）。
    const rockSprites: HTMLCanvasElement[] = [];
    {
      const mkRand = (seed: number) => {
        let s = seed >>> 0;
        return () => {
          s = (s * 1664525 + 1013904223) >>> 0;
          return s / 4294967296;
        };
      };
      for (let vi = 0; vi < 3; vi++) {
        const rnd = mkRand(1234 + vi * 777);
        const cv = document.createElement("canvas");
        cv.width = 512;
        cv.height = 512;
        const g = cv.getContext("2d");
        if (g) {
          const cx = 256;
          const cy = 256;
          const R = 186;
          const NV = 14;
          const verts: Array<[number, number]> = [];
          for (let i = 0; i < NV; i++) {
            const a = (i / NV) * Math.PI * 2;
            const rr = R * (0.84 + rnd() * 0.26);
            verts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
          }
          const midOf = (
            p: [number, number],
            q: [number, number],
          ): [number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          const path = new Path2D();
          const m0 = midOf(verts[NV - 1]!, verts[0]!);
          path.moveTo(m0[0], m0[1]);
          for (let i = 0; i < NV; i++) {
            const vtx = verts[i]!;
            const m = midOf(vtx, verts[(i + 1) % NV]!);
            path.quadraticCurveTo(vtx[0], vtx[1], m[0], m[1]);
          }
          path.closePath();
          const bodyGrad = g.createRadialGradient(
            cx - R * 0.35,
            cy - R * 0.42,
            R * 0.1,
            cx,
            cy,
            R * 1.18,
          );
          bodyGrad.addColorStop(0, "#6E5B49");
          bodyGrad.addColorStop(0.45, "#453729");
          bodyGrad.addColorStop(0.8, "#241B16");
          bodyGrad.addColorStop(1, "#120D0B");
          g.fillStyle = bodyGrad;
          g.fill(path);
          g.save();
          g.clip(path);
          // 陨石坑：暗色径向洼 + 坑沿一线受光弧
          for (let i = 0; i < 8; i++) {
            const a = rnd() * Math.PI * 2;
            const d = rnd() * R * 0.62;
            const kx = cx + Math.cos(a) * d;
            const ky = cy + Math.sin(a) * d;
            const kr = 10 + rnd() * 30;
            const cg = g.createRadialGradient(kx, ky, kr * 0.2, kx, ky, kr);
            cg.addColorStop(0, "rgba(0,0,0,0.5)");
            cg.addColorStop(0.8, "rgba(0,0,0,0.28)");
            cg.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = cg;
            g.beginPath();
            g.arc(kx, ky, kr, 0, Math.PI * 2);
            g.fill();
            g.strokeStyle = "rgba(255,226,190,0.10)";
            g.lineWidth = 2.5;
            g.beginPath();
            g.arc(kx, ky, kr * 0.92, Math.PI * 1.05, Math.PI * 1.55);
            g.stroke();
          }
          // 岩面斑驳
          for (let i = 0; i < 420; i++) {
            const a = rnd() * Math.PI * 2;
            const d = Math.sqrt(rnd()) * R * 0.98;
            g.fillStyle =
              rnd() > 0.5 ? "rgba(255,235,210,0.05)" : "rgba(0,0,0,0.09)";
            g.beginPath();
            g.arc(
              cx + Math.cos(a) * d,
              cy + Math.sin(a) * d,
              1 + rnd() * 2.6,
              0,
              Math.PI * 2,
            );
            g.fill();
          }
          // 前缘熔带：底部（局部 +y = 坠落前缘）热渐变覆膜
          const melt = g.createLinearGradient(0, cy + R * 0.25, 0, cy + R * 1.02);
          melt.addColorStop(0, "rgba(255,90,30,0)");
          melt.addColorStop(0.62, "rgba(255,84,26,0.28)");
          melt.addColorStop(0.88, "rgba(255,138,54,0.55)");
          melt.addColorStop(1, "rgba(255,196,110,0.75)");
          g.fillStyle = melt;
          g.fillRect(cx - R, cy + R * 0.2, R * 2, R * 0.85);
          // 熔蚀裂纹：前缘附近的短折线亮纹
          for (let i = 0; i < 5; i++) {
            let px2 = cx + (rnd() - 0.5) * R * 1.1;
            let py2 = cy + R * (0.45 + rnd() * 0.35);
            g.strokeStyle = "rgba(255,120,48,0.75)";
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(px2, py2);
            const segs = 3 + Math.floor(rnd() * 3);
            for (let sgi = 0; sgi < segs; sgi++) {
              px2 += (rnd() - 0.5) * 26;
              py2 -= 10 + rnd() * 16;
              g.lineTo(px2, py2);
            }
            g.stroke();
          }
          g.restore();
          g.strokeStyle = "rgba(8,5,4,0.85)";
          g.lineWidth = 3;
          g.stroke(path);
        }
        rockSprites.push(cv);
      }
    }
    // 余烬辉光（陨石身后辉 / 碎块辉 / 闪爆核共用）：暖橙径向
    const rockGlowSprite = (() => {
      const cv = document.createElement("canvas");
      cv.width = 256;
      cv.height = 256;
      const g = cv.getContext("2d");
      if (g) {
        const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
        grad.addColorStop(0, "rgba(255,205,130,0.95)");
        grad.addColorStop(0.3, "rgba(255,130,55,0.5)");
        grad.addColorStop(0.62, "rgba(215,64,20,0.2)");
        grad.addColorStop(1, "rgba(180,45,12,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 256);
      }
      return cv;
    })();
    // 尘烟团（陨石尾后尘烟专用，source-over 低 α 盖印）
    const smokeSprite = (() => {
      const cv = document.createElement("canvas");
      cv.width = 128;
      cv.height = 128;
      const g = cv.getContext("2d");
      if (g) {
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgba(172,164,184,0.42)");
        grad.addColorStop(0.55, "rgba(150,142,164,0.18)");
        grad.addColorStop(1, "rgba(140,132,158,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
      }
      return cv;
    })();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 3.1);
    camera.lookAt(0, 0, 0);

    const earth = new THREE.Group();
    earth.rotation.z = 0.12;
    // 初始视角：太平洋中心（约 168°E）+ 约 27.5° 俯角——主要城市都在北半球
    // 中高纬，俯角加大后北美/欧洲/东亚城市带落在画面中上部到中央，
    // 不贴球顶边缘；南半球少露一些无妨。选中聚焦时也回到这个俯角基调。
    // 东亚（东京/上海/北京）落在画面左侧、北美西岸（旧金山）在右侧，
    // 跨太平洋弧线横贯画面、隆起弧度可见；纽约在背面，其弧线自球缘探出。
    // 注：Ry(ry) 下把点转到正面的条件是 ry = atan2(-x, z)；
    // Rx(+HOME_TILT_X) 让画面中心对准约 27°N，等效相机高于赤道俯视。
    const HOME_TILT_X = 0.48;
    const home = latLonToVec3(20, 168, 1);
    earth.rotation.y = Math.atan2(-home.x, home.z);
    earth.rotation.x = HOME_TILT_X;
    scene.add(earth);

    const dotTex = makeDotTexture();

    // 光照（只作用于实体内球）：暖金色太阳光是唯一主光，方向 = 真实
    // 太阳方向（见下方昼夜系统：本地系太阳向随球体姿态变换）。
    // 环境光压得很低、补光只剩一丝冷青勾边，夜半球真正沉下去，
    // 明暗对比靠压暗夜侧拉开（主光仍暖金不改冷白）。
    const keyLight = new THREE.DirectionalLight(0xffd9a3, 1.55);
    keyLight.position.set(5, 2.0, 0.9);
    scene.add(keyLight);
    // —— 展示自转 ——
    // 地球以肉眼可见的展示转速自转（0.096 rad/s ≈ 65 秒一圈，即
    // GMST 真实朝向改造之前 0.0016 rad/帧 @60fps 的老速度），与真实
    // 时间脱钩；暂停时冻结、恢复时从冻结点继续。明暗的真实性不靠
    // 朝向对齐，而靠「太阳钉在地理上」（见下方昼夜系统）：太阳向先
    // 按真实时间算出它在地球本地系中的方向，再随球体当前姿态一同
    // 变换到世界系——球转到哪里，此刻真实白天的那片地理就亮到哪里。
    // 开场构图仍是太平洋中心（上方 home 偏航即 displayYaw 初值）。
    const loadDate = new Date();
    let displayYaw = earth.rotation.y;
    const DISPLAY_SPIN = 0.096; // rad/s
    const ambientLight = new THREE.AmbientLight(0x40382c, 0.5);
    scene.add(ambientLight);
    const rimLight = new THREE.DirectionalLight(0x3d7dc2, 0.32);
    rimLight.position.set(-4, -1.5, -2.5);
    scene.add(rimLight);

    // 球体本体：实体内球（遮挡背面点阵）+ 真实地图纹理（国家多边形填充、
    // 国界线、美中日高亮），地理形状以贴图为准，点阵只作其上的微光层
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.985, 64, 64),
      new THREE.MeshPhongMaterial({
        map: makeEarthTexture(
          renderer.capabilities.getMaxAnisotropy(),
          isCoarse ? 2048 : 4096,
        ),
        emissive: 0x02060d, // 自发光压到近黑：夜侧不再被均匀提亮
        specular: 0x2e2008, // 镜面只留极弱暗金（海洋无粗糙度变化，高光易成大光斑）
        shininess: 60,
      }),
    );
    earth.add(sphere);

    // 经纬网（淡线，强化球体的立体转折感）
    const gratPts: number[] = [];
    const gratSeg = 96;
    for (let lat = -75; lat <= 75; lat += 15) {
      const phi = (lat * Math.PI) / 180;
      const rr = Math.cos(phi) * R * 0.99;
      const y = Math.sin(phi) * R * 0.99;
      for (let i = 0; i < gratSeg; i++) {
        const a0 = (i / gratSeg) * Math.PI * 2;
        const a1 = ((i + 1) / gratSeg) * Math.PI * 2;
        gratPts.push(
          Math.cos(a0) * rr, y, Math.sin(a0) * rr,
          Math.cos(a1) * rr, y, Math.sin(a1) * rr,
        );
      }
    }
    for (let lon = 0; lon < 180; lon += 15) {
      const theta = (lon * Math.PI) / 180;
      for (let i = 0; i < gratSeg; i++) {
        const a0 = (i / gratSeg) * Math.PI * 2;
        const a1 = ((i + 1) / gratSeg) * Math.PI * 2;
        const p = (a: number): [number, number, number] => [
          Math.sin(a) * Math.cos(theta) * R * 0.99,
          Math.cos(a) * R * 0.99,
          Math.sin(a) * Math.sin(theta) * R * 0.99,
        ];
        const [x0, y0, z0] = p(a0);
        const [x1, y1, z1] = p(a1);
        gratPts.push(x0, y0, z0, x1, y1, z1);
      }
    }
    const gratGeo = new THREE.BufferGeometry();
    gratGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(gratPts, 3),
    );
    const gratLines = new THREE.LineSegments(
      gratGeo,
      new THREE.LineBasicMaterial({
        color: 0x3d7dc2,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
      }),
    );
    earth.add(gratLines);

    // 确定性伪随机（星点等装饰采样用）
    let seed = 42;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    // 大陆点阵：Natural Earth 陆地多边形 0.72° 网格采样（landData.ts，构建期生成）。
    // 按纬度做色温分层（低纬偏暖青绿 → 高纬偏冷亮蓝），海岸点单独成层、
    // 更大更亮，形成海岸线描边；内陆点略沉，突出轮廓。
    const landPosIn: number[] = [];
    const landColIn: number[] = [];
    const landPosCo: number[] = [];
    const landColCo: number[] = [];
    {
      const bin = atob(LAND_COORDS_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const coords = new Int16Array(bytes.buffer);
      const fbin = atob(LAND_FLAGS_B64);
      const fbytes = new Uint8Array(fbin.length);
      for (let i = 0; i < fbin.length; i++) fbytes[i] = fbin.charCodeAt(i);
      const warm = new THREE.Color(0.52, 0.99, 0.8);
      const mid = new THREE.Color(0.45, 0.85, 1.0);
      const cold = new THREE.Color(0.72, 0.84, 1.0);
      const tmp = new THREE.Color();
      for (let i = 0; i < LAND_POINT_COUNT; i++) {
        const lat = coords[i * 2]! / 100;
        const lon = coords[i * 2 + 1]! / 100;
        const v = latLonToVec3(lat, lon, R * 1.002);
        const a = Math.abs(lat);
        if (a < 30) tmp.lerpColors(warm, mid, a / 30);
        else tmp.lerpColors(mid, cold, Math.min(1, (a - 30) / 40));
        if (((fbytes[i >> 3]! >> (i & 7)) & 1) === 1) {
          landPosCo.push(v.x, v.y, v.z);
          landColCo.push(
            Math.min(1, tmp.r * 1.45 + 0.28),
            Math.min(1, tmp.g * 1.45 + 0.28),
            Math.min(1, tmp.b * 1.45 + 0.32),
          );
        } else {
          landPosIn.push(v.x, v.y, v.z);
          landColIn.push(tmp.r * 0.88, tmp.g * 0.88, tmp.b * 0.88);
        }
      }
    }
    const mkLandPoints = (
      pos: number[],
      col: number[],
      size: number,
      opacity: number,
    ) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      return new THREE.Points(
        g,
        new THREE.PointsMaterial({
          size,
          map: dotTex,
          vertexColors: true,
          transparent: true,
          opacity,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      );
    };
    // 微光点阵浮在地图纹理之上（只作光尘质感，不再承担地理形状）：
    // 海岸层比内陆略大略亮，内陆更淡，让贴图的国界与三国高亮透出来。
    const landIn = mkLandPoints(landPosIn, landColIn, 0.0105, 0.34);
    landIn.renderOrder = 2;
    earth.add(landIn);
    const landCo = mkLandPoints(landPosCo, landColCo, 0.0145, 0.5);
    landCo.renderOrder = 3;
    earth.add(landCo);

    // 海洋微光点（均匀球面采样，给球体体积感）
    const oceanPositions: number[] = [];
    const N_OCEAN = isCoarse ? 1500 : 2400;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N_OCEAN; i++) {
      const y = 1 - (i / (N_OCEAN - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      oceanPositions.push(
        Math.cos(theta) * rad * R * 0.995,
        y * R * 0.995,
        Math.sin(theta) * rad * R * 0.995,
      );
    }
    const oceanGeo = new THREE.BufferGeometry();
    oceanGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(oceanPositions, 3),
    );
    const oceanPoints = new THREE.Points(
      oceanGeo,
      new THREE.PointsMaterial({
        size: 0.012,
        map: dotTex,
        color: 0x2f68a3,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      }),
    );
    earth.add(oceanPoints);

    // —— 昼夜系统：太阳钉在地理上（地球本地系）+ 夜幕 + 夜光层 ——
    // 直射点按当前真实时间算（赤纬、直射经度 = 赤经 − 真实 GMST），
    // 得到太阳在「地球本地系」中的方向：它只随真实时间缓慢移动
    // （一天一圈），与球在屏幕上转到什么角度无关。每帧再把这个
    // 本地向量乘上球体当前姿态的四元数得到世界太阳向——光源视觉
    // 上随地球一起转，明暗永远盖住此刻真实世界里是白天的那片
    // 地理：东京此刻是白天，东京那块在球上就是亮的，球转过去、
    // 用户拖过去也一样亮；夜侧的城市灯光同理只在真实夜里亮。
    // 同一向量同时驱动主方向光、夜幕 shader、夜光 shader 与大气
    // shader（uSunDir 共用一个 uniform 对象），光照即太阳。
    const sunLocalFor = (date: Date): THREE.Vector3 => {
      const { dec, ra } = solarDecRa(date);
      let lon = ra - gmstDeg(date);
      lon = ((lon + 540) % 360) - 180;
      return latLonToVec3(dec, lon, 1);
    };
    const sunLocal = sunLocalFor(loadDate);
    const sunTarget = sunLocal.clone().applyQuaternion(earth.quaternion);
    const sunUniform = { value: sunTarget.clone() };
    keyLight.position.copy(sunUniform.value).multiplyScalar(6);
    // 点大小换算（世界直径 → 像素），resize 时按视口高度更新
    const scaleUniform = { value: 600 };

    // 夜幕：贴在地图纹理之上的半透明暗罩，夜侧变暗、昼侧透明，
    // 与 Phong 球的明暗叠加出可移动的晨昏线
    const nightVeil = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.9915, 48, 48),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: sunUniform },
        vertexShader: [
          "varying vec3 vWN;",
          "void main() {",
          "  vWN = normalize(mat3(modelMatrix) * normal);",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uSunDir;",
          "varying vec3 vWN;",
          "void main() {",
          "  float d = dot(normalize(vWN), normalize(uSunDir));",
          // 明暗分界收到极窄（点积 0.025 → -0.025，接近硬边）：干净利落，
          // 不再有暖橙镶边带；夜侧罩深 0.82、底色近深蓝黑，灯光因此跳得出来
          "  float night = smoothstep(0.025, -0.025, d);",
          "  vec3 col = vec3(0.002, 0.006, 0.020);",
          "  float alpha = night * 0.82;",
          "  gl_FragColor = vec4(col, alpha);",
          "}",
        ].join("\n"),
        transparent: true,
        depthWrite: false,
      }),
    );
    nightVeil.renderOrder = 1;
    earth.add(nightVeil);

    // 夜间城市灯光：lightsData 的人口加权采样点（都会区密而亮、内陆稀而暗）。
    // 自定义 shader 按太阳向逐点计算夜侧权重：夜侧全亮、昼侧只剩 3% 微光，
    // 暖金色、核心白亮边缘橙暗（解析径向衰减）；极轻微的逐点闪烁防死板。
    // 粗指针（移动端）只取最亮的前 55%（数据已按亮度降序，取前缀切片）。
    // 存储为 7 字节定长记录（见 lightsData.ts 头注），在此解码。
    let lightsMat: THREE.ShaderMaterial | null = null;
    let lightsPoints: THREE.Points | null = null;
    {
      const bin = atob(LIGHTS_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const i16At = (o: number): number => {
        const v = bytes[o]! | (bytes[o + 1]! << 8);
        return v > 32767 ? v - 65536 : v;
      };
      const count = isCoarse
        ? Math.floor(LIGHT_POINT_COUNT * 0.55)
        : LIGHT_POINT_COUNT;
      const pos = new Float32Array(count * 3);
      const bright = new Float32Array(count);
      const size = new Float32Array(count);
      const phase = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const o = i * 7;
        const v = latLonToVec3(i16At(o) / 100, i16At(o + 2) / 100, R * 1.004);
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
        bright[i] = bytes[o + 4]! / 255;
        size[i] = (bytes[o + 5]! | (bytes[o + 6]! << 8)) / 10000;
        phase[i] = (i * 0.61803) % 1;
      }
      const gLights = new THREE.BufferGeometry();
      gLights.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      gLights.setAttribute("aBright", new THREE.BufferAttribute(bright, 1));
      gLights.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
      gLights.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
      lightsMat = new THREE.ShaderMaterial({
        uniforms: {
          uSunDir: sunUniform,
          uScale: scaleUniform,
          uTime: { value: 0 },
        },
        vertexShader: [
          "attribute float aBright;",
          "attribute float aSize;",
          "attribute float aPhase;",
          "uniform vec3 uSunDir;",
          "uniform float uScale;",
          "uniform float uTime;",
          "varying float vA;",
          "void main() {",
          "  vec3 wn = normalize(mat3(modelMatrix) * normalize(position));",
          "  float d = dot(wn, normalize(uSunDir));",
          // 与夜幕同口径的近硬边过渡；昼侧残光压到 3%，灯只在夜里亮
          "  float night = smoothstep(0.05, -0.07, d);",
          "  float tw = 0.92 + 0.08 * sin(uTime * (0.5 + aPhase * 0.6) + aPhase * 23.0);",
          "  vA = aBright * mix(0.03, 1.0, night) * tw;",
          "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
          "  gl_PointSize = aSize * uScale / max(0.1, -mv.z);",
          "  gl_Position = projectionMatrix * mv;",
          "}",
        ].join("\n"),
        fragmentShader: [
          "varying float vA;",
          "void main() {",
          "  vec2 uv = gl_PointCoord - 0.5;",
          "  float r2 = dot(uv, uv) * 4.0;",
          "  float fall = exp(-r2 * 3.4);",
          "  vec3 col = mix(vec3(1.0, 0.60, 0.22), vec3(1.0, 0.88, 0.62), fall);",
          "  gl_FragColor = vec4(col, 1.0) * fall * vA;",
          "}",
        ].join("\n"),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      const lights = new THREE.Points(gLights, lightsMat);
      lights.renderOrder = 4;
      lightsPoints = lights;
      earth.add(lights);
    }

    // 大气层（Fresnel 辉光壳）：受光侧偏暖金、背光侧保持冷青，冷暖过渡
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.16, 48, 48),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: sunUniform },
        vertexShader: [
          "varying vec3 vNormal;",
          "varying vec3 vWN;",
          "void main() {",
          "  vNormal = normalize(normalMatrix * normal);",
          "  vWN = normalize(position);",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uSunDir;",
          "varying vec3 vNormal;",
          "varying vec3 vWN;",
          "void main() {",
          "  float i = pow(0.68 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.2);",
          "  float warm = smoothstep(-0.35, 0.75, dot(normalize(vWN), normalize(uSunDir)));",
          "  vec3 col = mix(vec3(0.25, 0.62, 1.0), vec3(1.0, 0.72, 0.38), warm * 0.8);",
          "  gl_FragColor = vec4(col, 1.0) * i * 0.92;",
          "}",
        ].join("\n"),
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    scene.add(atmosphere);

    // 大气外层：更大更淡的一层晕，把辉光向外晕开（双层大气的「晕」层）
    const atmosphereOuter = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.34, 48, 48),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: sunUniform },
        vertexShader: [
          "varying vec3 vNormal;",
          "varying vec3 vWN;",
          "void main() {",
          "  vNormal = normalize(normalMatrix * normal);",
          "  vWN = normalize(position);",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uSunDir;",
          "varying vec3 vNormal;",
          "varying vec3 vWN;",
          "void main() {",
          "  float i = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.6);",
          "  float warm = smoothstep(-0.35, 0.75, dot(normalize(vWN), normalize(uSunDir)));",
          "  vec3 col = mix(vec3(0.22, 0.5, 1.0), vec3(1.0, 0.68, 0.34), warm * 0.75);",
          "  gl_FragColor = vec4(col, 1.0) * i * 0.42;",
          "}",
        ].join("\n"),
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    scene.add(atmosphereOuter);

    // 内层边缘辉光（贴着球缘的一圈 fresnel 光晕，让球体边缘发亮、有厚度）
    const rimShell = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.015, 64, 64),
      new THREE.ShaderMaterial({
        vertexShader: [
          "varying vec3 vNormal;",
          "void main() {",
          "  vNormal = normalize(normalMatrix * normal);",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
          "}",
        ].join("\n"),
        fragmentShader: [
          "varying vec3 vNormal;",
          "void main() {",
          "  float d = dot(normalize(vNormal), vec3(0.0, 0.0, 1.0));",
          "  float i = pow(1.0 - abs(d), 3.5);",
          "  gl_FragColor = vec4(0.35, 0.68, 1.0, 1.0) * i * 0.55;",
          "}",
        ].join("\n"),
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    earth.add(rimShell);

    // 外层光晕
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture("rgba(90,170,255,0.38)", "rgba(50,110,255,0.14)"),
        transparent: true,
        depthWrite: false,
      }),
    );
    halo.scale.set(4.0, 4.0, 1);
    halo.position.z = -0.4;
    scene.add(halo);

    // 星云色晕：球后两团极淡的蓝紫/青色晕，缓慢漂移，给深空一点色彩纵深
    const nebulaA = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture("rgba(104,70,200,0.32)", "rgba(64,42,168,0.13)"),
        transparent: true,
        depthWrite: false,
        opacity: 0.5,
      }),
    );
    nebulaA.scale.set(6.6, 6.6, 1);
    nebulaA.position.set(-1.15, 0.55, -1.7);
    scene.add(nebulaA);
    const nebulaB = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture("rgba(28,158,196,0.30)", "rgba(20,110,180,0.12)"),
        transparent: true,
        depthWrite: false,
        opacity: 0.42,
      }),
    );
    nebulaB.scale.set(5.8, 5.8, 1);
    nebulaB.position.set(1.35, -0.75, -1.9);
    scene.add(nebulaB);

    // 星空（两层：密而细的底星 + 少量亮星，给深空纵深）
    const makeStars = (count: number): number[] => {
      const pos: number[] = [];
      for (let i = 0; i < count; i++) {
        const r = 14 + rand() * 22;
        const phi = Math.acos(2 * rand() - 1);
        const theta = rand() * Math.PI * 2;
        pos.push(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi) * 0.6,
          -Math.abs(r * Math.sin(phi) * Math.sin(theta)) - 2,
        );
      }
      return pos;
    };
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        makeStars(isCoarse ? 900 : 1400),
        3,
      ),
    );
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        size: 0.09,
        map: dotTex,
        color: 0xbdd7ff,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }),
    );
    scene.add(stars);
    const brightGeo = new THREE.BufferGeometry();
    brightGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(makeStars(220), 3),
    );
    const brightStars = new THREE.Points(
      brightGeo,
      new THREE.PointsMaterial({
        size: 0.17,
        map: dotTex,
        color: 0xeaf4ff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    scene.add(brightStars);
    // 星空层次精修：再补一层更远更暗的暖色微星垫底（纵深），以及极少数
    // 带十字芒的亮星点睛——数量克制，场景整体仍然留黑、留呼吸感
    const farGeo = new THREE.BufferGeometry();
    farGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(makeStars(isCoarse ? 500 : 800), 3),
    );
    const farStars = new THREE.Points(
      farGeo,
      new THREE.PointsMaterial({
        size: 0.055,
        map: dotTex,
        color: 0xffe3c0,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    farStars.position.z = -7;
    scene.add(farStars);
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(makeStars(14), 3),
    );
    const crossStars = new THREE.Points(
      crossGeo,
      new THREE.PointsMaterial({
        size: 0.62,
        map: makeCrossStarTexture(),
        color: 0xffffff,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(crossStars);

    // —— 背景八星（夜空四单 · 太阳系背景，2026-11-12 移师、深夜
    // 3D 化；设计稿 = goal-5 GOAL.md「背景星空冬夏大三角设计」位
    // 置条修订 + 色板节）——
    // 冬日大三角（参宿四/天狼星/南河三，近等边）+ 夏日大三角（天津
    // 四/牛郎星/织女星，瘦长）+ 天鹅座β星（Albireo：一金一蓝双点紧
    // 挨永不重合，置天津四近旁同属一只天鹅）+ 角宿一（独立、不连
    // 线）。初版挂在主页地球身后，用户实报主页放不下——整组移师太
    // 阳系；主页不再渲染这一层（星点/连线/名签全无，组 visible 关
    // 掉即零绘制）。显隐与卫星层正好互换：卫星层主页专属、进太阳
    // 系淡出；八星进太阳系随 sunFade 淡入、回主页淡出。
    // 3D 化（用户：「大三角那几个星星要从 2D 平面变成 3D 维度、
    // 直线要变成曲线，因为多了深度；那个太阳系不是一个平面」）：
    // ⑤ 的视角锚定平面板（相机子级、固定深度 40、全员共面、连线
    // 是直线段）作废——八星改落太阳系后上方深空中的真实世界坐
    // 标，逐星深度各不相同（按真实距离座次排，见落位处），世界
    // 坐标一次算定恒定（layoutStarWorld），相机在总览/聚焦/平移
    // 间移动时近星与远星表观位移不同、视差由此而来，不做任何屏
    // 幕锚定补偿。深度仍足够远（系统后方 15–38 世界单位，行星系
    // 半径 ≲5.2），恒为最底层背景，不飘进行星轨道之间、也不与
    // 星街彗星的最外圈轨道争位。默认总览构图按构造守恒：落位以
    // 默认总览机位为参考视角、沿各星 (nx, ny) 视线方向放到各自
    // 深度上，参考视角下投影与旧平面板严丝合缝——上方宽缓弧带、
    // 冬近等边/夏瘦长的形状识别度原样。两组三角的连线改空间曲
    // 线（二次贝塞尔、控制点沿深度方向外推弓起，见布局函数），
    // 角宿一仍不连线。
    // 星色按光谱真色（色板 hex），光晕同色低透明、饱和克制，不做
    // 彩色灯泡；亮度按真实星等排座次（天狼星最亮）。季节轮值按真
    // 实日期：组权重走年内平滑曲线（冬三角峰值约 1 月下旬、角宿一
    // 约 4 月下旬–5 月、夏组约 7 月下旬–8 月），当令全显、非当令退
    // 微光（星点尚在）；名签透明度 = 权重 × 0.85、权重 <0.25 整组
    // 隐藏（角宿一名签破例全年常驻，口径见 animate 背景八星段）。
    // 名签恒最高优先级（2026-11-13 用户：「图层优先级要最高」）：
    // 不再与太阳系数据标签相遇让位淡出——旧让位规则本轮撤销，名签
    // 透明度只由季节权重决定；名签之间互避扇开（同日「不要扎
    // 堆」）：投影后签面矩形相撞时低优先一张沿最小穿透轴推出留
    // 缝（锚仍钉星点、偏移封顶平滑跟随），实在推不开才淡出，见
    // animate 背景八星段的每 6 帧判定。名签格式 2026-11-13 晚与
    // 行星名签统一为裸排版（星色圆点 + 文字、紧贴锚定），见
    // addNamedStar 处注。绘制账：辉光精灵 9 + 核心点 9 + 连线 2
    // = 20 次 WebGL 绘制 + 名签 8 枚矢量 DOM（见 starLabelLayer
    // 处注），共享 1 张小纹理、零粒子。
    type StarGroupId = "winter" | "summer" | "spica";
    interface NamedStar {
      group: StarGroupId;
      glow: THREE.Sprite;
      core: THREE.Sprite;
      glowMat: THREE.SpriteMaterial;
      coreMat: THREE.SpriteMaterial;
      /** 矢量名签 DOM（行星名签同款裸排版：星色圆点 + 文字，
       * 无卡面；无名签的天鹅座β蓝点为 null） */
      labelEl: HTMLDivElement | null;
      /** 名签中心相对星点屏幕投影的像素偏移（互避判定用）：
       * 新格式全员统一锚定——横向居中（恒 0）、纵向在星点上方
       * 固定 6px 间隙（= −(6 + 实测半高)），由实测宽高推导，
       * 见 labelW/labelH。玻璃卡时代的逐颗偏好侧（织女星放左
       * 侧）/ 偏好下方（参宿四/天津四/天鹅座β挂下方）是卡面体
       * 积逼出来的补丁，新格式紧贴锚定后一并作废（2026-11-13
       * 晚用户定版「式样统一、定位更精准、不占地方」） */
      labelCx: number;
      labelCy: number;
      /** 名签实测宽高（px）：登记时按字数估算占位，进太阳系后由
       * 每 6 帧判定段回读 offsetWidth/Height 校正——字体加载完
       * 成、字宽变化都自动跟上，贴边收进与互避矩形全用实测值，
       * 不许估算值长期冒充（2026-11-13「位置要准确」定版） */
      labelW: number;
      labelH: number;
      /** 归一化方位（±1 = 参考总览机位视锥半宽/半高），恒在上方带 */
      nx: number;
      ny: number;
      /** 世界深度：太阳系原点后方多少世界单位（z = −depth），逐星各异 */
      depth: number;
      /** 登记尺度（布局时按各星的距离因子换算成精灵世界尺度） */
      size: number;
      /** 慢闪周期（秒）与相位：逐星定表 STAR_TW_TABLE（两两不同、
       * 避整数比谐波、相位黄金角错开；当令组才闪） */
      twPeriod: number;
      twPhase: number;
      /** 辉光基础尺度（闪烁时随亮度同步胀缩的基准） */
      glowBase: number;
      /** 星核基础尺度（布局时按距离因子算定；呼吸时随亮度同相
       * 小幅胀缩，见 animate 背景八星段） */
      coreScaleBase: number;
      /** 核心基础色（天狼星色温微闪的基准，其余星不改色） */
      coreBase: THREE.Color;
      /** 是否天狼星（唯一允许色温微闪的星） */
      sirius: boolean;
      /** 真实星等座次的相对亮度（天狼星 = 1） */
      base: number;
      /** 名签当前淡化值（逐帧平滑趋近目标） */
      labelFade: number;
      labelFadeT: number;
      /** 卡间扇开偏移（px）：互避判定推出的卡面位移，当前值逐帧
       * 平滑趋近目标值；锚点恒钉星点投影、只挪卡面，封顶 48px
       * （见 animate 背景八星段的扇开判定） */
      labelShiftX: number;
      labelShiftY: number;
      labelShiftTX: number;
      labelShiftTY: number;
    }
    const namedStars: NamedStar[] = [];
    // —— 慢闪定表（2026-11-13 用户三报：「好像没有呼吸变化」+
    // 「闪动频率要错开」）——
    // 旧口径之病：周期由 LCG 种子 90210+序×131 生成，首输出近线
    // 性 → 周期成等差数列 3.59/3.74/3.90/4.05/4.20/4.35/4.51/
    // 4.66/4.81（步长 ≈0.15s、相邻比 ≈1.04），相位同为线性递减
    // ——九星近同频、长时间保持近同步，真机读作「没有各自呼吸」。
    // 改逐星定死下表（登记序：参宿四/天狼星/南河三/天津四/织女
    // 星/牛郎星/天鹅座β金/天鹅座β蓝/角宿一）：周期两两不同，
    // 排序后最小间隔 0.24s；任意两星周期比距 1.5 与 2.0 均
    // ≥0.05（无整数比谐波对齐）；屏幕相邻星（两组三角边 + 天鹅
    // 座β双点 + 角宿一↔天狼星）周期比 ≥1.16。相位按黄金角
    // 2.399963 rad 逐星递进取模，九个相位在圆周上散开（最小间
    // 隔 ≈0.57 rad），峰值时刻互不对齐。
    const STAR_TW_TABLE: Array<{ period: number; phase: number }> = [
      { period: 5.9, phase: 0.0 },
      { period: 4.07, phase: 2.4 },
      { period: 4.91, phase: 4.8 },
      { period: 5.66, phase: 0.917 },
      { period: 3.14, phase: 3.317 },
      { period: 4.55, phase: 5.717 },
      { period: 3.65, phase: 1.834 },
      { period: 4.31, phase: 4.234 },
      { period: 5.18, phase: 0.35 },
    ];
    // 星体整体放大（2026-11-13 用户：「再大一些，背景板还有空
    // 间」）：星核与光晕在布局换算时同乘此系数（≈×1.38），逐星
    // size 座次（天狼星最大、参宿四次之……）原样保留；名卡尺寸
    // 不跟涨（卡小是同日定版），锚点逐帧直锚星点投影、不受影响
    const STAR_SIZE_K = 1.38;
    const namedStarTex = makeGlowTexture(
      "rgba(255,255,255,0.95)",
      "rgba(255,255,255,0.30)",
    );
    // starBoard 现为场景级组（不再是相机子级）：星体世界坐标由
    // layoutStarWorld 在首次进太阳系时一次算定、之后恒定。精灵/
    // 名签在登记时只用占位尺度因子（旧板口径 40/15），布局那一
    // 帧即按各星真实深度覆写，占位值永不出现在可见帧里。
    const STAR_INIT_K = 40 / 15;
    const starBoard = new THREE.Group();
    starBoard.visible = false;
    scene.add(starBoard);
    const addNamedStar = (
      name: string,
      group: StarGroupId,
      nx: number,
      ny: number,
      depth: number,
      colorHex: string,
      size: number,
      base: number,
      withLabel = true,
    ): NamedStar => {
      const col = new THREE.Color(colorHex);
      const glowMat = new THREE.SpriteMaterial({
        map: namedStarTex,
        color: col,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(size * STAR_INIT_K, size * STAR_INIT_K, 1);
      starBoard.add(glow);
      const coreMat = new THREE.SpriteMaterial({
        map: dotTex,
        // 提色（2026-11-13 用户：「色彩要明显一些」）：旧口径星核
        // 向白 lerp 0.45 + 光晕用低饱和色，在明亮行星旁被衬得发
        // 白发淡；星核提亮混合降到 0.22，光晕直接用登记的提色后
        // 星色（颜色主要由光晕面积承载），名卡字光晕同取 colorHex
        color: col.clone().lerp(new THREE.Color("#ffffff"), 0.22),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const core = new THREE.Sprite(coreMat);
      core.scale.set(size * 0.3 * STAR_INIT_K, size * 0.3 * STAR_INIT_K, 1);
      starBoard.add(core);
      let labelEl: HTMLDivElement | null = null;
      let labelCx = 0;
      let labelCy = 0;
      let labelW = 0;
      let labelH = 0;
      if (withLabel) {
        // 矢量名签 = 行星名签同款裸排版（2026-11-13 晚格式统一，
        // 用户：「星星的名片改成太阳系星球名字标签那样的格式，
        // 式样统一、定位更精准、不占地方」）：玻璃卡外壳（底色/
        // 边框/阴影/内边距/圆角）整套退役；同日晚再按用户「圆点
        // 可以去掉」把文字前的星色小圆点一并退役——现与
        // makeSolarLabel 完全同构：只剩细字重浅色文字一件（深色
        // 描边影保可读，与行星标签 strokeText 的 DOM 等价口
        // 径）。载体仍是真实 DOM 文字（矢量锐利，见
        // starLabelLayer 处注），不回退位图精灵。
        // 锚定改紧贴：全员统一——名签横向居中对星点、底边距星
        // 点 6px（行星标签悬在行星上方同语义），逐帧直锚星点投
        // 影、同源零缓存，拖动/漂移/3D 视差下都不脱位。玻璃卡
        // 时代的逐颗落位补丁（织女星偏左、参宿四/天津四/天鹅
        // 座β偏下）随卡面体积消失一并作废，落位判定只剩全员通
        // 用的贴边收进 + 移动端顶部安全带（见 animate 名签定位
        // 段与 labelTopSafePx 处注）。字号维持注记档 11px（桌
        // 面）/ 10px（粗指针）——清楚靠矢量渲染本身。尺寸登记
        // 改实测口径：此处 approx 只作首帧占位（字宽 + 2px），
        // 进场后由每 6 帧判定段回读真实 offsetWidth/Height 覆
        // 写 labelW/labelH 并重推 labelCx/labelCy，贴边收进/互
        // 避全用实测。
        const fs = isCoarse ? 10 : 11;
        const approxW = name.length * fs + 2;
        const approxH = Math.round(fs * 1.25);
        labelW = approxW;
        labelH = approxH;
        labelCx = 0;
        labelCy = -(6 + approxH / 2);
        labelEl = document.createElement("div");
        labelEl.style.position = "absolute";
        labelEl.style.left = "0";
        labelEl.style.top = "0";
        labelEl.style.whiteSpace = "nowrap";
        labelEl.style.pointerEvents = "none";
        labelEl.style.display = "flex";
        labelEl.style.alignItems = "center";
        labelEl.style.opacity = "0";
        labelEl.style.visibility = "hidden";
        labelEl.style.willChange = "transform, opacity";
        const textEl = document.createElement("span");
        textEl.textContent = name;
        textEl.style.fontFamily = "'Noto Sans SC', system-ui, sans-serif";
        textEl.style.fontWeight = "500";
        textEl.style.fontSize = `${fs}px`;
        textEl.style.lineHeight = "1.25";
        textEl.style.letterSpacing = "0.03em";
        textEl.style.color = "#eef4fc";
        textEl.style.textShadow =
          `0 0 6px ${colorHex}, 0 0 3px rgba(3,8,18,0.9), ` +
          "1px 0 2px rgba(3,8,18,0.85), -1px 0 2px rgba(3,8,18,0.85), " +
          "0 1px 2px rgba(3,8,18,0.85), 0 -1px 2px rgba(3,8,18,0.85)";
        labelEl.appendChild(textEl);
        starLabelLayer.appendChild(labelEl);
      }
      // 慢闪参数逐星定表（STAR_TW_TABLE 按登记序取，见该表处
      // 注：旧 LCG 生成的等差周期列已废）——慢呼吸式明暗，不许
      // 同频齐闪、不许整组同步（幅度口径见 animate 背景八星段）
      const twSpec = STAR_TW_TABLE[namedStars.length] ?? {
        period: 4.33,
        phase: 1.1,
      };
      const rec: NamedStar = {
        group,
        glow,
        core,
        glowMat,
        coreMat,
        labelEl,
        labelCx,
        labelCy,
        labelW,
        labelH,
        nx,
        ny,
        depth,
        size,
        twPeriod: twSpec.period,
        twPhase: twSpec.phase,
        glowBase: size * STAR_INIT_K,
        coreScaleBase: size * 0.3 * STAR_INIT_K,
        coreBase: (coreMat.color as THREE.Color).clone(),
        sirius: name === "天狼星",
        base,
        labelFade: 0,
        labelFadeT: 0,
        labelShiftX: 0,
        labelShiftY: 0,
        labelShiftTX: 0,
        labelShiftTY: 0,
      };
      namedStars.push(rec);
      return rec;
    };
    // —— 落位（2026-11-12 深夜 3D 化）：(nx, ny) 仍是参考总览视
    // 角下的归一化方位——整组沿一条宽缓的弧排布（弧度呼应轨道环
    // 的曲率，像最外圈轨道再往外放大的远侧弧），呈一道弧形背景
    // 带压在系统后上方；组间距比初版拉宽约两成，组内边长比与形
    // 状（冬近等边/夏瘦长）原样，ny 已含弧线弯沉（中段微抬、两
    // 翼缓降）。新增第五参 depth = 世界深度（原点后方、世界单
    // 位）：按各星真实距离的座次排（光年数只取序、压进 15–38 的
    // 可感知视差带）——天狼星 8.6 ly 最近、次南河三 11.5、牛郎
    // 星 17、织女星 25，再跳到角宿一 ~250、天鹅座β ~430、参宿
    // 四 ~550，天津四 ~2600 ly 独占最远。深度全 ≥15，恒在行星
    // 系（半径 ≲5.2）与星街彗星轨道之后，不与之争位。
    // 星色提色对照（2026-11-13，色相身份不变、饱和上调到明显
    // 档；旧 → 新）：参宿四 #ff9e45 → #ff7d2a（橙红读得出橙红）、
    // 天狼星 #dcebff → #a9c9ff（蓝白读得出蓝）、南河三 #fff2d4 →
    // #ffe396（淡黄白加重黄意）、天津四 #f5f8ff → #eef4ff（干净
    // 白不发灰）、织女星 #d9e7ff → #a3c2ff、牛郎星 #ffffff 不变
    // （本就纯白）、天鹅座β金 #ffc44d → #ffab1a（更金）、天鹅座
    // β蓝 #6fa8ff → #4a86ff（更蓝，金蓝对比拉开）、角宿一
    // #dce9ff → #9db4ff。饱和守上限：无霓虹荧光、不过曝成色块
    // 冬日大三角（近等边）：参宿四橙红是红超巨星的签名，不漂白
    const wBetelgeuse = addNamedStar("参宿四", "winter", -0.62, 0.74, 33, "#ff7d2a", 0.78, 0.9);
    const wSirius = addNamedStar("天狼星", "winter", -0.86, 0.24, 15, "#a9c9ff", 0.88, 1.0);
    const wProcyon = addNamedStar("南河三", "winter", -0.36, 0.28, 17.5, "#ffe396", 0.68, 0.8);
    // 夏日大三角（瘦长）。名签落位已全员统一为紧贴锚定（星点
    // 正上方居中）：玻璃卡时代给织女星定的偏左、给天津四/天鹅
    // 座β/参宿四定的偏下都是卡面体积的补丁，新格式下一并作
    // 废，此处不再有任何逐颗落位参数
    const sDeneb = addNamedStar("天津四", "summer", 0.64, 0.75, 38, "#eef4ff", 0.7, 0.78);
    const sVega = addNamedStar("织女星", "summer", 0.36, 0.6, 22.5, "#a3c2ff", 0.8, 0.88);
    const sAltair = addNamedStar("牛郎星", "summer", 0.7, 0.22, 20, "#ffffff", 0.72, 0.8);
    // 天鹅座β星（Albireo）：天津四近旁，一金一蓝双点紧挨永不重合
    // （组间距拉宽不拆这对「一尾一嘴」）；名签按定名写「天鹅座β
    // 星」，只挂在金点上；蓝点无名签不受影响
    const albireo = addNamedStar("天鹅座β星", "summer", 0.56, 0.66, 31, "#ffab1a", 0.52, 0.66);
    {
      // 蓝点：沿天津四→金点方向再错开一线间隙（归一化 0.038，与旧
      // 版 0.13 世界单位 @ 星距≈13.5 的角间隙相当）；深度与金点
      // 同为 31——这对双星在 3D 里也是紧挨的一对，任意视角下间
      // 隙不胀不缩、永不重合；蓝点无名签，核心色走与金点同一套
      // 「光谱色向白提亮」构造
      const dirx = albireo.nx - sDeneb.nx;
      const diry = albireo.ny - sDeneb.ny;
      const dl = Math.hypot(dirx, diry) || 1;
      addNamedStar(
        "",
        "summer",
        albireo.nx + (dirx / dl) * 0.038,
        albireo.ny + (diry / dl) * 0.038,
        31,
        "#4a86ff",
        0.38,
        0.5,
        false,
      );
    }
    // 角宿一：独立成星、不连线，季节自成一档（春季峰值）；落在弧
    // 带左翼外端——与冬三角拉开组间距、仍在上方带内，不许贴近画
    // 面中线，免得聚焦近景时侵入星体主体区域。
    // 身份注（2026-11-13 用户问「冬季大三角左侧的星星怎么没标
    // 签，是 spica 吗」——答：是，就是角宿一）：它贴在天狼星左
    // 上方（归一化距 ≈0.146）。名签口径已经用户同日晚间改判
    // （见 animate 背景八星段）：角宿一名签破例全年常驻（淡季
    // 压暗地板 0.42），只有星光仍走季节曲线——淡季是微光星点
    // 带着一张压暗的名签，春季连光带名一起回来。本轮格式统
    // 一后常驻口径平移不变，只是换成行星标签同款小标签
    addNamedStar("角宿一", "spica", -0.9, 0.38, 28, "#9db4ff", 0.72, 0.82);
    // 组内连线：极细淡线，现为空间曲线——每边一条二次贝塞尔、
    // 每边 TRI_EDGE_SEGS 段折线逼近；顶点由 layoutStarWorld 按
    // 星体世界坐标一次算定（星位恒定，逐帧零重写），透明度仍
    // 由组权重驱动
    const TRI_EDGE_SEGS = 24;
    interface StarTriangle {
      geo: THREE.BufferGeometry;
      mat: THREE.LineBasicMaterial;
      stars: [NamedStar, NamedStar, NamedStar];
    }
    const makeTriangleLines = (
      stars: [NamedStar, NamedStar, NamedStar],
    ): StarTriangle => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(
          new Float32Array(3 * TRI_EDGE_SEGS * 2 * 3),
          3,
        ),
      );
      const mat = new THREE.LineBasicMaterial({
        color: 0xaebfe0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      starBoard.add(new THREE.LineSegments(geo, mat));
      return { geo, mat, stars };
    };
    const winterTri = makeTriangleLines([wBetelgeuse, wSirius, wProcyon]);
    const summerTri = makeTriangleLines([sDeneb, sVega, sAltair]);
    // —— 3D 布局（首次进太阳系时一次算定，之后恒定）：以默认总览
    // 机位为参考视角（取景拟合距离 zRef + 当下宽高比，与 resize
    // 的 solarFitZ 同式），把每颗星沿其 (nx, ny) 视线方向放到各
    // 自深度 depth 上：x = nx·(zRef+depth)·tanV·aspect、
    // y = ny·(zRef+depth)·tanV、z = −depth。参考视角下投影与旧
    // 平面板的 (nx, ny) 严丝合缝（上方弧带构图、两组三角的屏幕
    // 形状原样），但世界坐标从此固定——相机移动时视差自然产
    // 生。表观尺寸按角直径守恒换算：精灵尺度 ∝ (zRef+depth)/15
    // （15 = 旧主页口径的星距参考），参考视角下与旧板同大；聚
    // 焦视角下近星自然略大、远星略小，是深度的一部分，不做屏
    // 幕锚定补偿。名签不设世界锚点：卡片逐帧直锚星点本身的投
    // 影 + 固定屏幕间隙（见 addNamedStar 与 animate 名签段）。
    // 连线曲线：每边一条二次贝塞尔——控制点 = 边中点沿径向
    // （离原点方向）外推 0.10×边长、再向深处沉 0.16×边长，曲线
    // 因此既顺着深度弓起、又微微向外张开；从参考视角看弓幅温
    // 和（约为边长的百分之几），不抢三角的形状识别度。
    let starWorldReady = false;
    const layoutStarWorld = (): void => {
      const tanV = Math.tan(THREE.MathUtils.degToRad(21));
      const zRef =
        solarNarrow && stateRef.current.solarView === "near"
          ? solarNearZ
          : solarFullZ;
      for (const ns of namedStars) {
        const distCam = zRef + ns.depth;
        const distK = distCam / 15;
        const x = ns.nx * distCam * tanV * camera.aspect;
        const y = ns.ny * distCam * tanV;
        ns.glow.position.set(x, y, -ns.depth);
        ns.core.position.copy(ns.glow.position);
        ns.glowBase = ns.size * distK * STAR_SIZE_K;
        ns.glow.scale.set(ns.glowBase, ns.glowBase, 1);
        const coreS = ns.size * 0.3 * distK * STAR_SIZE_K;
        ns.coreScaleBase = coreS;
        ns.core.scale.set(coreS, coreS, 1);
      }
      const pt = new THREE.Vector3();
      const prev = new THREE.Vector3();
      for (const tri of [winterTri, summerTri]) {
        const attr = tri.geo.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        let o = 0;
        const [ta, tb, tc] = tri.stars;
        const edges: Array<[NamedStar, NamedStar]> = [
          [ta, tb],
          [tb, tc],
          [tc, ta],
        ];
        for (const [p, q] of edges) {
          const pa = p.glow.position;
          const pb = q.glow.position;
          const len = pa.distanceTo(pb);
          const ctrl = pa.clone().add(pb).multiplyScalar(0.5);
          const radial = Math.hypot(ctrl.x, ctrl.y) || 1;
          ctrl.x += (ctrl.x / radial) * len * 0.1;
          ctrl.y += (ctrl.y / radial) * len * 0.1;
          ctrl.z -= len * 0.16;
          prev.copy(pa);
          for (let sIdx = 1; sIdx <= TRI_EDGE_SEGS; sIdx++) {
            const u = sIdx / TRI_EDGE_SEGS;
            const w0 = (1 - u) * (1 - u);
            const w1 = 2 * (1 - u) * u;
            const w2 = u * u;
            pt.set(
              w0 * pa.x + w1 * ctrl.x + w2 * pb.x,
              w0 * pa.y + w1 * ctrl.y + w2 * pb.y,
              w0 * pa.z + w1 * ctrl.z + w2 * pb.z,
            );
            arr[o++] = prev.x;
            arr[o++] = prev.y;
            arr[o++] = prev.z;
            arr[o++] = pt.x;
            arr[o++] = pt.y;
            arr[o++] = pt.z;
            prev.copy(pt);
          }
        }
        attr.needsUpdate = true;
      }
    };
    /** 季节权重（年内平滑余弦曲线；峰值日序：冬 25 / 夏 208 / 角宿一 119） */
    const seasonWeight = (peakDoy: number, date: Date): number => {
      const doy =
        (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
          Date.UTC(date.getFullYear(), 0, 0)) /
        86400000;
      const d = (((doy - peakDoy) % 365.25) + 365.25) % 365.25;
      return 0.5 + 0.5 * Math.cos((d / 365.25) * Math.PI * 2);
    };
    const starWeights: Record<StarGroupId, number> = {
      winter: seasonWeight(25, new Date()),
      summer: seasonWeight(208, new Date()),
      spica: seasonWeight(119, new Date()),
    };
    let starWeightDay = new Date().getDate();

    // —— 太阳系模式：太阳 + 八大行星 + 轨道圈 ——
    // 位置按当前真实日期的开普勒近似（planetLongitude）定起始黄道经度，
    // 之后按开普勒第三定律的相对角速度运行（地球公转一周 = 90 秒，
    // 其余行星周期 = 90 × a^1.5 秒，相对快慢真实）。轨道半径与行星
    // 大小为压缩示意（页面有标注）。行星用低面数球体、轨道线静态
    // LineLoop，移动端帧率优先。地球不另造：监控球本体在过渡动画里
    // 缩小并移动到 earthAnchor 处，成为太阳系里的地球。
    const SOLAR_S = 0.62;
    // 移动端行星/太阳/标签放大（小屏可读性）；本轮 planetScale 2.35→2.0：
    // 与拉开后的轨道间距、压低的月轨半径联立解出的安全组合（见
    // MOON_ORBIT_R 推导），点选聚焦功能会把单颗行星飞近放大，总览
    // 尺寸略让位于「互不相撞」
    const planetScale = isCoarse ? 2.0 : 1;
    const solarLabelScale = isCoarse ? 1.75 : 1;
    const solarGroup = new THREE.Group();
    solarGroup.rotation.x = 0.55;
    solarGroup.visible = false;
    scene.add(solarGroup);
    // 太阳系点选命中表：本体外再挂放大命中圈与标签精灵，移动端不要求
    // 精准点中几像素。userData.bodyId 标明天体 id（见 PLANET_ELEMENTS.id
    // 与 sun / moon）
    const solarHitList: THREE.Object3D[] = [];
    // 按天体分组的命中表：已聚焦天体的第二下点按走优先判定（见
    // handleTap），不许被别的天体的标签/命中圈抢走、也不许落空
    const solarHitByBody = new Map<string, THREE.Object3D[]>();
    const addSolarHit = (obj: THREE.Object3D, bodyId: string) => {
      obj.userData.bodyId = bodyId;
      solarHitList.push(obj);
      const arr = solarHitByBody.get(bodyId);
      if (arr) arr.push(obj);
      else solarHitByBody.set(bodyId, [obj]);
    };
    const SUN_R = isCoarse ? 0.58 : 0.34;
    const sunMat = makeSunMaterial(makeSunTexture(!isCoarse));
    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R, 40, 40),
      sunMat,
    );
    solarGroup.add(sunMesh);
    {
      // 命中圈只比盘面大一圈（1.08×）：水星轨道半径 0.713 世界单位 <
      // 旧值 1.55×SUN_R=0.90，水星在任何相位都落在太阳命中盘内、且其
      // 本体深度永远浅于命中球前表面 → 永远点不中（实测推演）。盘面
      // 本身已足够大，不需要放大命中圈来抢邻近天体的点按。
      const sunHit = new THREE.Mesh(
        new THREE.SphereGeometry(SUN_R * 1.08, 10, 10),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      solarGroup.add(sunHit);
      addSolarHit(sunHit, "sun");
    }
    // 日冕壳（2026-11-12 重做）：1.45× 球壳，亮度是一条以盘缘为峰
    // 的高斯带——壳面 ndv 在盘缘投影处 ≈0.72（sqrt(1−(1/1.45)²)），
    // 带心钉在那里：向内贴着盘面 Fresnel 亮边收尾、向外平滑衰减
    // 到壳边归零。旧版的丝缕纹理调制 + 菲涅尔硬幂次已退役：那层
    // 条纹正是「贴纸光圈」感的来源。无纹理、无时间项，静止发光。
    const coronaShellMat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
      },
      vertexShader: [
        "varying vec3 vWN;",
        "varying vec3 vWP;",
        "void main() {",
        "  vWN = normalize(mat3(modelMatrix) * normal);",
        "  vec4 wp = modelMatrix * vec4(position, 1.0);",
        "  vWP = wp.xyz;",
        "  gl_Position = projectionMatrix * viewMatrix * wp;",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform float uOpacity;",
        "varying vec3 vWN;",
        "varying vec3 vWP;",
        "void main() {",
        "  vec3 V = normalize(cameraPosition - vWP);",
        "  float ndv = abs(dot(normalize(vWN), V));",
        "  float band = exp(-pow((ndv - 0.72) / 0.23, 2.0));",
        "  vec3 col = mix(vec3(1.0, 0.58, 0.15), vec3(1.0, 0.83, 0.45), band);",
        "  gl_FragColor = vec4(col, 1.0) * (band * 0.55 * uOpacity);",
        "}",
      ].join("\n"),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const coronaShell = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_R * 1.45, 40, 40),
      coronaShellMat,
    );
    solarGroup.add(coronaShell);
    // 多层光晕：内层贴体柔光 + 外层柔冕（纯径向衰减，见
    // makeCoronaTexture）；两层 scale 恒定、透明度只由过渡进度
    // 驱动（中段渐显），初始 0——无呼吸、无自转（2026-11-12 重做）
    const sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeSunGlowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    sunGlow.scale.set(isCoarse ? 2.5 : 1.6, isCoarse ? 2.5 : 1.6, 1);
    solarGroup.add(sunGlow);
    const sunCorona = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeCoronaTexture(!isCoarse),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    const coronaScale = SUN_R * (isCoarse ? 8.6 : 9.5);
    sunCorona.scale.set(coronaScale, coronaScale, 1);
    solarGroup.add(sunCorona);
    const sunLabel = makeSolarLabel("太阳", "#ffc45e", 0.5 * solarLabelScale);
    (sunLabel.material as THREE.SpriteMaterial).opacity = 0;
    sunLabel.position.set(0, SUN_R + 0.26, 0);
    solarGroup.add(sunLabel);
    addSolarHit(sunLabel, "sun");
    // 太阳点光源：位置就放在太阳本体处（场景原点 = 太阳系组原点 =
    // 太阳中心），过渡时渐入。它是太阳系模式的场景光源——八大行星
    // 与地球的亮面由位置光照天然朝向太阳，地球绕行时明暗随其与
    // 太阳的相对位置自动变化，不给地球贴任何假明暗。
    const sunLight = new THREE.PointLight(0xffe0b0, 0, 0, 0);
    sunLight.position.set(0, 0, 0);
    scene.add(sunLight);
    let earthAnchor: THREE.Object3D | null = null;
    interface PlanetVis {
      def: (typeof PLANET_ELEMENTS)[number];
      mesh: THREE.Mesh | null;
      label: THREE.Sprite | null;
      /** 标签在行星上方的偏移（按放大后的半径算） */
      labelY: number;
      /** 标签避让附加偏移（实际值，逐帧平滑趋近 labelDyT） */
      labelDy: number;
      /** 标签避让淡化系数（实际值，1 = 全显；逐帧平滑趋近 labelFadeT） */
      labelFade: number;
      /** 标签避让目标偏移（避让 pass 以双阈值滞回写入，见太阳系标签避让段） */
      labelDyT: number;
      /** 标签避让目标淡化系数（避让 pass 写入；实际值平滑跟随，禁硬跳） */
      labelFadeT: number;
      /** 天体盘面遮挡状态（避让 pass 解析判定：双阈值迟滞 + 连续
       * 2 次判定确认才翻转，防临界处来回跳；见避让段遮挡判定） */
      labelOcc: boolean;
      /** 遮挡原始判定与现状态不一致的连续计数（持续性确认用） */
      labelOccStreak: number;
      lon0: number;
      omega: number;
      /** 个性效应逐帧驱动（粒子时间/淡入 + 精灵透明度）；无效应为 null */
      fxTick: ((t: number, fade: number) => void) | null;
    }
    /** 监控球在太阳系模式里的目标缩放（成为行星地球的半径） */
    const EARTH_PLANET_SCALE = isCoarse ? 0.14 : 0.076;
    const planetVis: PlanetVis[] = [];
    /** 轨道圈材质登记（按 PLANET_ELEMENTS 顺序 = 由内到外）：过渡时逐个淡入 */
    const orbitMats: THREE.LineDashedMaterial[] = [];
    /** 月球轨道圈材质（随地球一同在行星序列里淡入） */
    let moonOrbitMat: THREE.LineBasicMaterial | null = null;
    // —— 月球：绕地小天体，起始位置按当前真实日期的月球黄经
    // （moonLongitude），之后按真实相对周期运行（月球周期 = 地球年
    // ×27.32/365.25，场景里 = 90 秒 ×0.0748 ≈ 6.7 秒一圈）。盈亏由太阳
    // 点光源真实照明，亮面天然朝向太阳，不贴任何假月相纹理。
    // 【月轨安全上限推导（移动端，世界单位）】轨道间距（拉开后）：
    // 地–金 = (2.45−1.75)×0.62 = 0.434，地–火 = (3.25−2.45)×0.62 = 0.496。
    // 不撞条件（同经度最坏相位）：月轨 + 月半径 + 邻星半径 < 间距，
    // 且月轨 − 月半径 > 地球行星半径（不贴地球盘面）。
    // 金星侧：0.21 + 0.042 + 0.144 = 0.396 < 0.434 ✓（余量 0.038）；
    // 火星侧：0.21 + 0.042 + 0.116 = 0.368 < 0.496 ✓；
    // 向内：0.21 − 0.042 = 0.168 > 地球半径 0.14 ✓（余量 0.028）。
    // 桌面端同理成立（月轨 0.22 + 月 0.024 + 金星 0.072 = 0.316 < 0.434）。
    // 旧值月轨 0.52 整个横穿金/火轨道圈，已废弃。
    const MOON_ORBIT_R = isCoarse ? 0.21 : 0.22;
    const MOON_R = isCoarse ? 0.042 : 0.024;
    let moonGroup: THREE.Group | null = null;
    let moonMesh: THREE.Mesh | null = null;
    let moonLabel: THREE.Sprite | null = null;
    /** 月球标签避让状态（与行星标签同一套避让 pass 写入） */
    let moonLabelFade = 1;
    let moonLabelDy = 0;
    /** 月球标签避让目标（滞回判定写目标、实际值逐帧平滑跟随） */
    let moonLabelFadeT = 1;
    let moonLabelDyT = 0;
    /** 月球标签遮挡状态（与行星同一套迟滞 + 持续性判定） */
    let moonLabelOcc = false;
    let moonLabelOccStreak = 0;
    let moonLon0 = 0;
    const MOON_OMEGA = (Math.PI * 2) / (90 * (27.32 / 365.25));
    /** 月尘微光粒子材质（animate 月球段逐帧喂 uTime/uFade） */
    let moonDustMat: THREE.ShaderMaterial | null = null;
    /** 地球极光卵环着色器材质（挂地球组两极；fxTick 按 orbitFade 驱动） */
    const earthAuroraMats: THREE.ShaderMaterial[] = [];
    // —— 月面访客（彩蛋）：赛伯星人纸片人，挂在月球本体（moonMesh）
    // 的本地系里安家——月球公转/自转怎么动，它们都钉在月面上，不会
    // 被甩飞也不会陷进月面。居民分散在整个月面（SERPO_HOME_DIRS 五
    // 个家点），各自在家点周边游走；纸片恒朝镜头（Sprite），位置走
    // 月面弧面、姿态靠起伏/摇摆/正背面切换，见 stepPaperWalker。
    const serpoWalkers: PaperWalker[] = [];
    let serpoRand: (() => number) | null = null;
    const serpoTexSet = makeSerpoTextureSet();
    /** 月球自转角状态（恒定慢速推进，居民散布全月面、不再对齐某片区域） */
    let moonSpin = 0;
    // —— 行星个性效应构建器（2026-11-12 二轮，用户令：上一轮按
    // 「优先级最低」做得太收，真机看不见/像碎点；本轮往「看得见
    // 的优雅」提一档——形态从散点升级成成形的光：成带、成环、
    // 成流）——逐颗病灶与处方：
    // 水星钠尾：4 枚柔光拉长成彗尾（头浓尾淡、背日 + 略偏轨道
    // 后方 = 太阳风 + 辐射压的真实方向感），仍是全场最克制；
    // 金星：盘缘霾提亮加厚（wide 剖面 + 外层裙各一枚），云顶微粒
    // 反而降存在感——它输在闷，不输在点；
    // 火星：尘粒提亮半档、尺度略大、收进近连续的淡尘环带（低闪
    // 烁，看不见「一颗一颗」）；
    // 木星：64 颗极光散粒退役 → 两极各一条极光卵环（连续环带 +
    // 帘幕波动着色器，蓝紫）；云带微粒落到离散纬带上成细流线
    // （速度随纬差、近乎不闪），与纹理带流同向；
    // 土星：环闪点 130 → 200，按真实环带剖面采样（B 环最密、
    // 卡西尼缝近空、C 环稀、A 环中），高频短闪、峰值更亮、零拖尾；
    // 天王星：霾与竖环闪点各提半档，性子淡不过提；
    // 海王星：卷云改「列车式」成串同速流（头亮尾淡的拖尾靠逐点
    // amp），大暗斑另做一枚螺旋涡旋贴片（旋流成形）+ 一层极淡
    // 蓝霾；地球极光同步卵环口径压到极淡（见地球段）。
    // 粒子总账：金星 56 + 火星 110 + 木星 90（流线）+ 土星 200 +
    // 天王星 34 + 海王星 91 = 581 颗（+ 月尘 30，见月球段），另有
    // 木星/地球极光卵环 4 枚着色器带面、海王星涡旋贴片 1 枚——都
    // 是单次绘制的面片，不是粒子堆量。全走 GPU 着色器、CPU 零逐
    // 帧开销（水星尾/涡旋的 extra 除外，每帧几次三角函数）；透明
    // 度一律由 orbitFade 驱动，转场随本体同拍淡入淡出。
    const buildPlanetFx = (
      def: (typeof PLANET_ELEMENTS)[number],
      mesh: THREE.Mesh,
      lon0: number,
      omega: number,
    ): ((t: number, fade: number) => void) | null => {
      const Rp = def.size * planetScale;
      const rand = seededRand(4100 + def.orbitR * 100);
      const mats: THREE.ShaderMaterial[] = [];
      /** 成形光带面（极光卵环/涡旋贴片）的着色器：只有 uTime/uFade */
      const bandMats: THREE.ShaderMaterial[] = [];
      const glowSprites: Array<{
        mat: THREE.SpriteMaterial;
        base: number;
        shimmer: number;
      }> = [];
      const addFlow = (
        specs: FlowPointSpec[],
        opts: { color: string; opacity: number; twinkleAmp: number },
        rotX = 0,
        rotY = 0,
      ) => {
        const { points, mat } = makeFlowPoints(specs, opts);
        if (rotX) points.rotation.x = rotX;
        if (rotY) points.rotation.y = rotY;
        mesh.add(points);
        mats.push(mat);
      };
      const spec = (
        lon: number,
        lat: number,
        radF: number,
        speed: number,
        sizeF: number,
        freq: number,
      ): FlowPointSpec => ({
        lon,
        lat,
        rad: Rp * radF,
        speed,
        size: Rp * sizeF,
        phase: rand() * Math.PI * 2,
        freq,
      });
      const addLimb = (
        rgb: string,
        base: number,
        scaleF = 5,
        wide = false,
      ) => {
        const mat = new THREE.SpriteMaterial({
          map: makeLimbGlowTexture(rgb, wide),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        });
        const sp = new THREE.Sprite(mat);
        sp.scale.set(Rp * scaleF, Rp * scaleF, 1);
        sp.renderOrder = 2;
        mesh.add(sp);
        glowSprites.push({ mat, base, shimmer: 0 });
      };
      const addAurora = (
        colorA: string,
        colorB: string,
        opacity: number,
      ) => {
        for (const south of [false, true]) {
          const oval = makeAuroraOval(Rp * 1.035, {
            colorA,
            colorB,
            polarRad: 0.42,
            halfWidth: 0.13,
            south,
            opacity,
          });
          mesh.add(oval.mesh);
          bandMats.push(oval.mat);
        }
      };
      const addGlowSprite = (
        inner: string,
        outer: string,
        pos: THREE.Vector3,
        scale: number,
        base: number,
        shimmer: number,
      ) => {
        const mat = new THREE.SpriteMaterial({
          map: makeGlowTexture(inner, outer),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        });
        const sp = new THREE.Sprite(mat);
        sp.position.copy(pos);
        sp.scale.set(scale, scale, 1);
        sp.renderOrder = 2;
        mesh.add(sp);
        glowSprites.push({ mat, base, shimmer });
      };
      let extra: ((t: number, fade: number) => void) | null = null;
      switch (def.id) {
        case "mercury": {
          // 钠尾：4 枚柔光拉长成彗尾（头浓尾淡的渐变收尾），逐帧在
          // extra 里按行星当前轨道角定位——方向 = 背日 + 向轨道后
          // 方偏 0.38 rad（太阳风并非纯径向，尾巴带一点扫掠角）
          const tail: THREE.Sprite[] = [];
          const tailCfg = [
            { off: 1.5, size: 2.6, op: 0.34 },
            { off: 3.4, size: 4.4, op: 0.19 },
            { off: 6.0, size: 6.4, op: 0.095 },
            { off: 8.8, size: 8.6, op: 0.04 },
          ];
          for (const cfg of tailCfg) {
            void cfg;
            const mat = new THREE.SpriteMaterial({
              map: makeGlowTexture(
                "rgba(255,176,84,0.55)",
                "rgba(255,120,40,0.16)",
              ),
              transparent: true,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
              opacity: 0,
            });
            const sp = new THREE.Sprite(mat);
            sp.renderOrder = 2;
            solarGroup.add(sp);
            tail.push(sp);
          }
          extra = (t, fade) => {
            const ang = lon0 + omega * t;
            const px = Math.cos(ang) * def.orbitR * SOLAR_S;
            const pz = -Math.sin(ang) * def.orbitR * SOLAR_S;
            const inv = 1 / Math.max(0.001, Math.hypot(px, pz));
            const ux = px * inv;
            const uz = pz * inv;
            // 背日向绕 Y 轴偏转 −0.38 rad：尾巴扫向轨道后方
            const ca = Math.cos(-0.38);
            const sa = Math.sin(-0.38);
            const dx = ux * ca - uz * sa;
            const dz = ux * sa + uz * ca;
            const rNow = Rp * (0.55 + 0.45 * fade);
            tail.forEach((sp, i) => {
              const cfg = tailCfg[i]!;
              sp.position.set(
                px + dx * cfg.off * rNow,
                0,
                pz + dz * cfg.off * rNow,
              );
              const s = cfg.size * rNow;
              sp.scale.set(s, s * 0.55, 1);
              (sp.material as THREE.SpriteMaterial).opacity =
                cfg.op * fade;
            });
          };
          break;
        }
        case "venus": {
          // 厚大气：盘缘霾提亮 + wide 剖面加厚一层柔边，外面再罩
          // 一层更大的极淡裙——散射感靠两层叠，不靠单层加亮
          addLimb("255,205,130", 0.85, 5.2, true);
          addLimb("255,190,110", 0.3, 7.2, true);
          // 云顶微粒降存在感：更少、更小、更暗，只留闷厚的暗示
          const specs: FlowPointSpec[] = [];
          for (let i = 0; i < 56; i++) {
            specs.push(
              spec(
                rand() * Math.PI * 2,
                (rand() - 0.5) * 2.0,
                1.06,
                -(0.02 + rand() * 0.02),
                0.11 + rand() * 0.08,
                0.3 + rand() * 0.5,
              ),
            );
          }
          addFlow(specs, {
            color: "#ffdca8",
            opacity: 0.17,
            twinkleAmp: 0.15,
          });
          break;
        }
        case "mars": {
          addLimb("232,140,90", 0.45);
          // 尘带：粒径略大、半径收紧成薄壳、闪烁压低——单颗化作
          // 尘雾，整体读作一条近乎连续的淡尘环带绕行
          const specs: FlowPointSpec[] = [];
          for (let i = 0; i < 110; i++) {
            specs.push(
              spec(
                rand() * Math.PI * 2,
                Math.asin(rand() * 2 - 1) * 0.78,
                1.1 + rand() * 0.3,
                0.04 + rand() * 0.05,
                0.26 + rand() * 0.2,
                0.25 + rand() * 0.4,
              ),
            );
          }
          addFlow(specs, {
            color: "#e8956d",
            opacity: 0.21,
            twinkleAmp: 0.16,
          });
          break;
        }
        case "jupiter": {
          // 极光卵环（成形）：两极各一条连续环带 + 帘幕波动，蓝紫；
          // 极区柔光保留作卵环的底晕，提半档托住环带
          addAurora("#6f9dff", "#b07fff", 0.9);
          for (const sgn of [1, -1]) {
            addGlowSprite(
              "rgba(140,170,255,0.7)",
              "rgba(150,90,255,0.25)",
              new THREE.Vector3(0, sgn * Rp * 0.93, 0),
              Rp * 1.2,
              0.36,
              0.9,
            );
          }
          // 云带流线：粒子只落在离散纬带上（与纹理带界同纬），
          // 同带同速、速度随纬度递减、几乎不闪——读作细流线，
          // 不是随机漂的点
          const bandLats = [
            -1.0, -0.72, -0.48, -0.24, 0, 0.24, 0.48, 0.72, 1.0,
          ];
          const band: FlowPointSpec[] = [];
          for (let i = 0; i < 90; i++) {
            const lat =
              bandLats[Math.floor(rand() * bandLats.length)]! +
              (rand() - 0.5) * 0.07;
            band.push(
              spec(
                rand() * Math.PI * 2,
                lat,
                1.045,
                0.17 * (1 - 0.45 * Math.abs(lat)) + rand() * 0.02,
                0.08 + rand() * 0.05,
                0.4 + rand() * 0.5,
              ),
            );
          }
          addFlow(band, {
            color: "#ffd9ae",
            opacity: 0.3,
            twinkleAmp: 0.12,
          });
          break;
        }
        case "saturn": {
          // 碎钻闪点按真实环带剖面采样：radF 与主环纹理同口径
          // （1.45–2.2）——C 环（1.47–1.62）稀、B 环（1.62–1.95）
          // 最密、卡西尼缝（1.95–2.03）近空、A 环（2.03–2.17）
          // 中等；拒采样让疏密跟环结构走。高频短闪（freq 2.2–5、
          // twinkleAmp 1.0 = 亮度可冲满又骤灭）、零拖尾
          const ringDensity = (r: number): number =>
            r < 1.62 ? 0.25 : r < 1.95 ? 1.0 : r < 2.03 ? 0.05 : 0.55;
          const specs: FlowPointSpec[] = [];
          let guard = 0;
          while (specs.length < 200 && guard++ < 4000) {
            const radF = 1.47 + rand() * 0.7;
            if (rand() > ringDensity(radF)) continue;
            specs.push(
              spec(
                rand() * Math.PI * 2,
                (rand() - 0.5) * 0.03,
                radF,
                0.035 * Math.pow(1.8 / radF, 1.5),
                0.055 + rand() * 0.065,
                2.2 + rand() * 2.8,
              ),
            );
          }
          // 环面与主环同倾角：粒子球面系的赤道面 = 环平面
          addFlow(
            specs,
            { color: "#fff1cf", opacity: 0.78, twinkleAmp: 1.0 },
            -Math.PI / 2 + 0.38,
          );
          break;
        }
        case "uranus": {
          // 各提半档为止：霾 0.28→0.42、竖环闪点 26→34 颗/0.45→0.6
          addLimb("150,230,220", 0.42);
          const specs: FlowPointSpec[] = [];
          for (let i = 0; i < 34; i++) {
            specs.push(
              spec(
                rand() * Math.PI * 2,
                (rand() - 0.5) * 0.04,
                1.56 + rand() * 0.2,
                0.02,
                0.08 + rand() * 0.05,
                1.0 + rand() * 2.0,
              ),
            );
          }
          addFlow(
            specs,
            { color: "#cfeee8", opacity: 0.6, twinkleAmp: 0.8 },
            -Math.PI / 2 + 1.15,
            0.35,
          );
          break;
        }
        case "neptune": {
          addLimb("110,165,255", 0.3);
          // 卷云成「流」：列车式成串——同串同纬、同速、等间距，
          // 亮度沿串 amp 衰减（头亮尾淡 = 白亮核心 + 淡拖尾）。
          // 13 串 × 7 颗 = 91 颗，其中 3 串走大暗斑纬度带（南纬
          // 约 22°）、更快更亮
          const streaks: FlowPointSpec[] = [];
          const pushTrain = (
            lat: number,
            speed: number,
            amp0: number,
            size0: number,
          ) => {
            const lon0 = rand() * Math.PI * 2;
            for (let k = 0; k < 7; k++) {
              const s = spec(
                lon0 - k * 0.055,
                lat + (rand() - 0.5) * 0.02,
                1.05,
                speed,
                size0 * (1 - k * 0.07),
                0.6 + rand() * 0.6,
              );
              s.amp = amp0 * Math.pow(0.8, k);
              streaks.push(s);
            }
          };
          for (let i = 0; i < 10; i++) {
            pushTrain(
              -0.9 + rand() * 1.5,
              0.5 + rand() * 0.4,
              0.85,
              0.1 + rand() * 0.05,
            );
          }
          for (let i = 0; i < 3; i++) {
            pushTrain(-0.42 + rand() * 0.12, 0.9 + rand() * 0.25, 1.0, 0.13);
          }
          addFlow(streaks, {
            color: "#e8f1ff",
            opacity: 0.55,
            twinkleAmp: 0.22,
          });
          // 大暗斑旋流：螺旋涡旋贴片钉在暗斑经纬（南纬 22°），
          // 与上方亮伴云列车同纬呼应——旋流是成形的环流
          {
            const vortex = makeVortexPatch(Rp * 0.34, {
              color: "#cfe2ff",
              opacity: 0.75,
            });
            const latR = (-22 * Math.PI) / 180;
            const lonR = 0.8;
            const p = new THREE.Vector3(
              Math.cos(latR) * Math.cos(lonR),
              Math.sin(latR),
              Math.cos(latR) * Math.sin(lonR),
            ).multiplyScalar(Rp * 1.02);
            vortex.mesh.position.copy(p);
            vortex.mesh.lookAt(p.clone().multiplyScalar(2));
            mesh.add(vortex.mesh);
            bandMats.push(vortex.mat);
          }
          break;
        }
        case "suisei": {
          // —— 星街彗星专属光效（2026-11-12 晚升格，用户令「要发
          // 光、特效要足」；①本体自发光在构建循环的材质上：
          // emissiveMap = 本体纹理、夜面不死黑、像内里透光的宝
          // 石）——
          // ② 纬度染色大气壳：Fresnel 辉光，颜色随纬度跟着表面
          // 渐变走（上红橙、下黄绿）
          const shell = makeSuiseiShell(Rp * 1.16);
          mesh.add(shell.mesh);
          bandMats.push(shell.mat);
          // ③ 外层柔光晕：暖红橙大晕、极轻微呼吸（shimmer 相位
          // 驱动 ±12% 摆动）；总览形态光晕必须在——收一档只靠与
          // 本体同拍的 fade，不另压
          addGlowSprite(
            "rgba(255,150,80,0.55)",
            "rgba(255,90,40,0.16)",
            new THREE.Vector3(0, 0, 0),
            Rp * 6.4,
            0.5,
            1.1,
          );
          // 盘缘暖辉：贴本体的一层，托住大气壳的根
          addLimb("255,130,70", 0.38, 4.6);
          // ④ 表面流光：发光云丝贴球面缓慢旋绕——琥珀丝全纬
          // 度、黄绿丝偏南半球（与纹理的纬度分工同构）
          const amber: FlowPointSpec[] = [];
          for (let i = 0; i < 64; i++) {
            amber.push(
              spec(
                rand() * Math.PI * 2,
                (rand() - 0.5) * 1.9,
                1.05,
                0.05 + rand() * 0.05,
                0.3 + rand() * 0.22,
                0.25 + rand() * 0.4,
              ),
            );
          }
          addFlow(amber, {
            color: "#ffc46b",
            opacity: 0.5,
            twinkleAmp: 0.2,
          });
          const olive: FlowPointSpec[] = [];
          for (let i = 0; i < 40; i++) {
            olive.push(
              spec(
                rand() * Math.PI * 2,
                -0.25 - rand() * 1.05,
                1.05,
                0.04 + rand() * 0.04,
                0.28 + rand() * 0.2,
                0.25 + rand() * 0.4,
              ),
            );
          }
          addFlow(olive, {
            color: "#d7e28a",
            opacity: 0.42,
            twinkleAmp: 0.2,
          });
          // ④+ 稀疏星尘微粒：近旁漂浮闪烁（半径收在聚焦取景之
          // 内，聚焦/主页形态也看得见）
          const dust: FlowPointSpec[] = [];
          for (let i = 0; i < 40; i++) {
            dust.push(
              spec(
                rand() * Math.PI * 2,
                Math.asin(rand() * 2 - 1),
                1.3 + rand() * 0.45,
                0.008 + rand() * 0.014,
                0.09 + rand() * 0.07,
                0.8 + rand() * 1.6,
              ),
            );
          }
          addFlow(dust, {
            color: "#ffd9a8",
            opacity: 0.55,
            twinkleAmp: 1.0,
          });
          break;
        }
        default:
          break;
      }
      if (
        mats.length === 0 &&
        bandMats.length === 0 &&
        glowSprites.length === 0 &&
        !extra
      ) {
        return null;
      }
      return (t, fade) => {
        const uH = renderer.domElement.height * 1.302;
        for (const m of mats) {
          m.uniforms.uTime!.value = t;
          m.uniforms.uFade!.value = fade;
          m.uniforms.uScaleH!.value = uH;
        }
        for (const m of bandMats) {
          m.uniforms.uTime!.value = t;
          m.uniforms.uFade!.value = fade;
        }
        for (const s of glowSprites) {
          s.mat.opacity =
            s.base *
            fade *
            (s.shimmer
              ? 0.88 + 0.12 * Math.sin(t * s.shimmer + 1.7)
              : 1);
        }
        extra?.(t, fade);
      };
    };
    // —— 星街彗星轨道（第十一号天体）：海王星圈 ×1.12、倾角 6°；
    // 相位按真实日期驱动（与行星同一星历基准：历元相位 + 自
    // J2000 天数 × 210 年周期平黄经率；角速度由构建循环按
    // a=35.3 的通用公式给出，与旧客串口径恒等、往返不漂移）
    const GUEST_ORBIT_R = 7.45 * 1.12;
    const GUEST_INCL = (6 * Math.PI) / 180;
    const guestPosAt = (ang: number, out: THREE.Vector3): THREE.Vector3 =>
      out.set(
        Math.cos(ang) * GUEST_ORBIT_R * SOLAR_S,
        Math.sin(ang) * GUEST_ORBIT_R * SOLAR_S * Math.sin(GUEST_INCL),
        -Math.sin(ang) * GUEST_ORBIT_R * SOLAR_S * Math.cos(GUEST_INCL),
      );
    /** 历元相位 4.40 rad（选定使 2026-11 打开总览时它在前侧易见位） */
    const SUISEI_LON0 =
      4.4 +
      (Date.now() / 86400000 - 10957.5) * ((Math.PI * 2) / (210 * 365.25));
    const suiseiPosTmp = new THREE.Vector3();
    {
      const nowForPlanets = new Date();
      const orbitSeg = 128;
      for (const p of PLANET_ELEMENTS) {
        const lon0 =
          p.id === "suisei"
            ? SUISEI_LON0
            : planetLongitude(p, nowForPlanets);
        const omega = (Math.PI * 2) / (90 * Math.pow(p.el[0], 1.5));
        const orbitPts: THREE.Vector3[] = [];
        for (let i = 0; i < orbitSeg; i++) {
          const a = (i / orbitSeg) * Math.PI * 2;
          if (p.id === "suisei") {
            // 倾角轨道圈（其余行星的圈在组平面内，星街彗星的圈
            // 按 guestPosAt 带 6° 倾角走，两者同为虚线圈同拍淡入）
            orbitPts.push(guestPosAt(a, suiseiPosTmp).clone());
          } else {
            orbitPts.push(
              new THREE.Vector3(
                Math.cos(a) * p.orbitR * SOLAR_S,
                0,
                -Math.sin(a) * p.orbitR * SOLAR_S,
              ),
            );
          }
        }
        const orbitMat = new THREE.LineDashedMaterial({
          color: new THREE.Color(p.id === "suisei" ? "#c06830" : p.color),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          dashSize: 0.16,
          gapSize: 0.11,
        });
        orbitMats.push(orbitMat);
        const orbit = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(orbitPts),
          orbitMat,
        );
        orbit.computeLineDistances();
        solarGroup.add(orbit);
        if (p.name === "地球") {
          earthAnchor = new THREE.Object3D();
          solarGroup.add(earthAnchor);
          const eLabel = makeSolarLabel(
            p.name,
            p.color,
            0.44 * solarLabelScale,
          );
          (eLabel.material as THREE.SpriteMaterial).opacity = 0;
          solarGroup.add(eLabel);
          addSolarHit(eLabel, "earth");
          planetVis.push({
            def: p,
            mesh: null,
            label: eLabel,
            labelY: EARTH_PLANET_SCALE + 0.16 * solarLabelScale,
            labelDy: 0,
            labelFade: 1,
            labelDyT: 0,
            labelFadeT: 1,
            labelOcc: false,
            labelOccStreak: 0,
            lon0,
            omega,
            // 地球极光：只驱动挂在地球组两极的卵环着色器（创建在
            // 行星循环之后），主页模式此 tick 不运行、恒不可见
            fxTick: (t, fade) => {
              for (const m of earthAuroraMats) {
                m.uniforms.uTime!.value = t;
                m.uniforms.uFade!.value =
                  fade * (0.9 + 0.1 * Math.sin(t * 0.7 + 0.6));
              }
            },
          });
          continue;
        }
        const isSuisei = p.id === "suisei";
        const suiseiTex = isSuisei
          ? makeGuestPlanetTexture(!isCoarse)
          : null;
        const pMaps = isSuisei
          ? null
          : planetMaps(p.name, p.color, !isCoarse);
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(p.size * planetScale, isCoarse ? 32 : 48, isCoarse ? 24 : 36),
          isSuisei
            ? new THREE.MeshPhongMaterial({
                map: suiseiTex!,
                // ① 本体自发光：纹理颜色自带发光分量（emissiveMap
                // = 本体纹理 × 0.42 灰），夜面不死黑、整颗像内里
                // 透光的宝石，总览距离就认得出在发光
                emissiveMap: suiseiTex!,
                emissive: new THREE.Color(0.42, 0.42, 0.42),
                shininess: 8,
              })
            : new THREE.MeshPhongMaterial({
                map: pMaps!.map,
                bumpMap: pMaps!.bump ?? undefined,
                bumpScale: pMaps!.bump ? 0.6 : undefined,
                emissive: new THREE.Color(p.color).multiplyScalar(0.05),
                shininess: 14,
              }),
        );
        solarGroup.add(mesh);
        // 放大命中圈（不可见）：半径至少 0.17 世界单位、约为本体 2.4 倍，
        // 水星这种小个子在手机上也一指命中；标签精灵同样可点（下方登记）
        {
          const hit = new THREE.Mesh(
            new THREE.SphereGeometry(
              Math.max(p.size * planetScale * 2.4, 0.17),
              8,
              8,
            ),
            new THREE.MeshBasicMaterial({ visible: false }),
          );
          mesh.add(hit);
          addSolarHit(hit, p.id);
          addSolarHit(mesh, p.id);
        }
        if (p.name === "土星") {
          // 环分三层：内侧细环（淡）+ 主环（同心带纹理，含暗隙）+
          // 外侧极淡宽环，半透叠出层次，不再是一块平涂圆环
          const ringTilt = -Math.PI / 2 + 0.38;
          const innerRing = new THREE.Mesh(
            new THREE.RingGeometry(p.size * planetScale * 1.28, p.size * planetScale * 1.43, 48),
            new THREE.MeshBasicMaterial({
              color: 0xcbb586,
              transparent: true,
              opacity: 0.38,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          );
          innerRing.rotation.x = ringTilt;
          mesh.add(innerRing);
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(p.size * planetScale * 1.45, p.size * planetScale * 2.2, 64),
            new THREE.MeshBasicMaterial({
              map: makeSaturnRingTexture(),
              transparent: true,
              opacity: 0.95,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          );
          ring.rotation.x = ringTilt;
          mesh.add(ring);
          const outerRing = new THREE.Mesh(
            new THREE.RingGeometry(p.size * planetScale * 2.24, p.size * planetScale * 2.58, 64),
            new THREE.MeshBasicMaterial({
              color: 0xd8c491,
              transparent: true,
              opacity: 0.18,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          );
          outerRing.rotation.x = ringTilt;
          mesh.add(outerRing);
        }
        if (p.name === "天王星") {
          // 天王星的细窄环系：真实环又细又暗，且因其 98° 轴倾角近乎
          // 「竖着」套在行星上——一圈极淡细环、倾角与土星明显不同即可
          const uRing = new THREE.Mesh(
            new THREE.RingGeometry(p.size * planetScale * 1.55, p.size * planetScale * 1.78, 48),
            new THREE.MeshBasicMaterial({
              map: makeUranusRingTexture(),
              color: 0xbfe8e2,
              transparent: true,
              opacity: 0.55,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          );
          uRing.rotation.x = -Math.PI / 2 + 1.15;
          uRing.rotation.y = 0.35;
          mesh.add(uRing);
        }
        const label = makeSolarLabel(p.name, p.color, 0.44 * solarLabelScale);
        (label.material as THREE.SpriteMaterial).opacity = 0;
        solarGroup.add(label);
        addSolarHit(label, p.id);
        planetVis.push({
          def: p,
          mesh,
          label,
          labelY: p.size * planetScale + 0.17 * solarLabelScale,
          labelDy: 0,
          labelFade: 1,
          labelDyT: 0,
          labelFadeT: 1,
          labelOcc: false,
          labelOccStreak: 0,
          lon0,
          omega,
          fxTick: buildPlanetFx(p, mesh, lon0, omega),
        });
      }
    }
    // —— 客串彗星（夜空四单 · 太阳系故事层，2026-11-12；设计稿 =
    // goal-5 GOAL.md「客串彗星设计」）——
    // 只活在太阳系模式：不挂标签、不可点选（不进 solarHitList、
    // 不进 planetVis 矩阵），过渡/相机代码零改动；淡入随 sunFade。
    // 2026-11-12 晚视觉重做（用户真机判「太难看了、接近太阳时没
    // 看见冒火」）：带状尾巴（纸片/布幅感）退役——双尾改走层叠柔
    // 粒点云 + 着色器噪声蚀边（边缘溶进背景、无硬轮廓）；彗发改
    // 三层柔光（紧致白核/内彗发/外层光晕，白→近白青向外渐变）；
    // 近日点「冒火」：火因子随日心距非线性升腾，核心转暖白金、
    // 彗发膨胀、火花粒子喷流（逐帧口径见 animate 彗星段）。
    // 2026-11-12 深夜精修（JI 五连令）：① 进出场过渡并入统一包络
    // （接缝拉长至 6 秒 smootherstep + 活跃度平滑段，见 animate）；
    // ② 拖尾柔化——沿程衰减改无拐点幂曲线、蚀边再放宽、尘埃扇
    // 散开改平滑增长，像烟收尾；③ 色彩绚丽——骨架不变、饱和与
    // 亮度上调：离子尾透亮蓝 #6EA9FF、彗发青白更晶、尘埃尾暖金
    // #F0DCB4；④ 火花喷流 70→180 粒、速度/尺寸/亮度同升一档；
    // ⑤ 变红燃烧（☄️ 式）——颜色随日心距连续烧：远态白青 →
    // 暖金渐入 → 近日点彗头橙红火球，彗发缘火焰舌 flicker、火
    // 花由白经橙转深红、双尾近头段染焰色，远离逐段退回。绘制
    // 账不变：核球 1 + 彗发精灵 3 + 双尾点云 2 + 火花点云 1 = 7，
    // 粒子 110+170+180 = 460，纹理共享辉光图 1 张。
    // —— 客串彗星整体下线（2026-11-13 晚，用户明言「直接去
    // 掉」）：虚构客串的本体/彗发/双尾/燃烧喷流/根数/舞台第 0
    // 幕全部移除，彗星轮值改由四颗具名彗星承担（哈雷起场）。
    // 此处只留具名彗星彗发三层共用的辉光纹理（逐颗染色见 def
    // 的 comaCore/comaInner/comaHaloMid/comaHaloOut）。
    const cometGlowTex = makeGlowTexture(
      "rgba(255,255,255,0.95)",
      "rgba(190,220,255,0.35)",
    );
    // —— 双尾「极光光帘」（2026-11-13 换形态，用户真机否决柔粒
    // 点云：「最好做成极光的效果」）——
    // 形态学：每条尾是一张沿脊线展开的光幕——脊线 = 亮边（近头
    // 最亮），幕面自脊线张开（position 只存脊线点，幕宽向逐站存
    // aWDir、宽在顶点着色器内按 aV 展开；张开方向按 NAOJ 模式图
    // 分工：离子尾沿轨道极轴成窄直帘、尘埃尾在轨道面内铺成宽
    // 扇，见 fillCurtainSpine 注），片元给出极光三件套：① 纵
    // 向射线——亮度只随沿程 aU 变化的细密噪声条纹，光丝自亮边
    // 向外贯穿幕面、疏密由噪声场定（非规则条纹）；② 亮边衰减
    // ——exp(−3v) 贴边最亮 + (1−v)² 幕身托底，外缘羽化无硬界；
    // ③ 活的波浪——顶点着色器内两列正弦波沿幕传播、摆幅随 aV
    // 增长（幕梢摆得最开，像光帘下摆被风吹）。多层叠合（离子
    // 2 层 / 尘埃 3 层）：层间以幕法向微偏 + 波相位错开 + 不透
    // 明度递减拉出纵深，不是单张面片。
    // 双尾质感分工：离子尾幕窄（宽 ≈0.17）、射线细密（噪声尺度
    // 150）、波幅小而稳、淡冰蓝白 #bfd9ff；尘埃尾幕宽（≈0.45）、
    // 射线疏柔（尺度 64、低对比）、波幅大而飘卷、淡暖白
    // #f7efdc。
    // 颜色只借极光的形态不借色：绿不引入（那是地球极光层语
    // 言）；近头焰色染尾（uFlame × (1−aU)²）与变红燃烧口径保
    // 留。几何方向规则不变：离子脊线直指背阳、尘埃脊线沿历史
    // 轨迹弯（animate 段逐帧喂脊线采样，与旧点云同脊线）。
    // —— 尾色减深（2026-11-13 用户令「拖尾颜色还是太深了」，客
    // 串与四颗具名共用本工厂、一并改）：旧色离子 #6ea9ff / 尘埃
    // #f0dcb4 饱和偏高、读起来像彩色带子，现整体降饱和、提明
    // 度、向白靠（离子只留一层薄蓝、尘埃近月光白只留一丝暖）；
    // 焰色同步减深一档（离子焰 #ff9a4d→#ffc38f、尘埃焰
    // #ffb877→#ffd3a3，不许比帘体还浓）；帘体不透明度经
    // uBodyK 0.6 单降（幕身托底项 ×0.6）、贴脊线亮边原样保留
    // ——光感靠亮度不靠色深。射线/波动/逐颗形态差异不动。
    // 性能账：每尾 1 张几何（49 站 × 7 跨 = 343 顶点、576 三角
    // 形）被其各层共享，层只换材质 uniform；合计 5 次绘制
    // （2+3），CPU 逐帧只写 2×343 个脊线点/法向。
    const TAIL_STATIONS = 49;
    const TAIL_ACROSS = 7;
    interface TailCurtain {
      group: THREE.Group;
      mats: THREE.ShaderMaterial[];
      pos: Float32Array;
      nor: Float32Array;
      wdir: Float32Array;
      geo: THREE.BufferGeometry;
      /** 幕宽基准（世界单位，animate 段按活跃度逐帧写 uniform） */
      baseWidth: number;
    }
    // 尾色完全重置（2026-11-13 用户三报后定版：「彗星那两条长
    // 尾巴颜色也太难看了，参考新海诚的电影完全重置一下」）：
    // 旧病 = 单色平涂的半透帘（离子一色 #bfd9ff、尘埃一色
    // #f7efdc 平铺全尾），读作一条发灰的绸带——减深一轮仍被判
    // 难看，病根在「平」不在「深」。新海诚式彗尾（《你的名
    // 字。》彗星 Tiamat 的签名）= 沿程三段辉光渐变 + 尾面星屑：
    // 近头白炽 → 中段明亮天蓝 → 尾梢深宝石蓝（离子）/ 暖白 →
    // 柔金（尘埃），颜色随长度流动、靠亮度差立体；再嵌一层会
    // 眨眼的细碎星点（片着色器内网格星屑，见 fragment 注），
    // 尾巴是「光做的、里面有星星在闪」，不是染色的布。本工厂
    // 因此改收多停点色板（现行版见本段末「报告 §3 落地」注：
    // uCols/uOffs 5 停点、逐颗偏移），全四颗具名彗星同语
    // 系、逐颗差异仍走宽度/不透明度/射线/波幅参数。
    // —— 真机黑带根因与渲染路径重置（2026-11-13 用户真机实
    // 报：潘斯达斯尘埃尾在 iPhone Air 上是一条纯黑、遮挡轨道
    // 线的弯带；iOS 修复同日）——旧输出 = 预乘式
    // gl_FragColor = vec4(col * a, 1.0) + AdditiveBlending：
    // 亮度全压进 RGB、alpha 恒钉 1.0，靠帧缓冲内的加色混合
    // 成光。渲染器是 alpha:true 画布，iOS WebKit 的合成路径
    // 把 alpha=1 的像素按不透明处理——预乘后的暗色（a 沿尾
    // 程衰减、尾梢趋 0）被当作不透明暗带直接盖住背景：尾梢
    // 最黑、轨道线被整段遮断，与真机截图逐项吻合；桌面探针
    // 的软件 GL 走另一条合成路径、显示为暖金扇面，所以历轮
    // 审计都没抓到。另有一处 smoothstep(0.30, 0.03, …) 边序
    // 反转，GLSL ES 规范下 edge0 ≥ edge1 属未定义行为，
    // ANGLE→Metal 与桌面驱动可给出不同结果，已改写为
    // 1.0 − smoothstep(0.03, 0.30, …)。现行契约 = 稳健路径：
    // 颜色不预乘、衰减全走真实 alpha（vec4(col, a)）+ 普通
    // alpha 混合——与同屏在真机已验证正常的轨道线/辉光精灵
    // 同一条路径；a→0 处结构上只会透明，黑带不可能重现。
    // 四颗具名彗星共用本工厂；近日点喷流（makeCometSparks）
    // 同为预乘 + alpha 1 写法，同轮一并换契约。
    // —— 本轮（2026-11-13 晚，用户三度判尾：「颜色能参考新海
    // 诚了吗 / 拖尾还是太单调了和细了」+ 逐颗分家总纲）：
    // ① 色板逐颗入 def：新海诚式高明度辉光为共同底味——哈雷
    // 离子 #f2f8ff→#6fa8ff（电蓝）→#5a48e0（紫罗兰梢）、尘埃
    // 暖金；恩克灰蓝/暗金；潘斯达斯浓金尘埃；艾森青绿离子 +
    // 绿彗发。旧「五颗共用一板」与更早的平涂/减深口径全废，
    // uFlame 焰色通道随客串下线移除。② 加宽加层：基准幕宽逐
    // 颗 ×~1.7（def.ionWidth/dustWidth）、每尾 +1 层（层透明
    // 度递减补回总量），治「细」。③ 治「单调」三件：横贯幕面
    // 的缓流噪声（亮度成片漂移）、最宽层外缘逐颗签名描边光
    // （uRim/uRimColor，羽化带内侧亮起）、尾面星屑加密
    // （340×40 网格、命中率 7%→10%、亮度 ×1.5）。渲染契约
    // 不变：真实 alpha + 普通混合（黑带红线）。
    // —— 报告 §3 落地（2026-11-13 深夜，深研报告
    // shinkai-comet-color-design-20261113-0227 §3 施工规格）：
    // 上段①的自创三段色值已被报告 B 级骨架取代——离子 5 停
    // 点 #DFF6FF→#7ED6FF→#4A90FF→#7A5CFF→#B45CFF、尘埃 4
    // 停点 #FFF6E8→#FCE1E4→#F28AB2→#B48AD3（均为【设计建议
    // 值 B】，非官方色值；A 级分析值只作色域校准不入渐变），
    // 哈雷用骨架原值、恩克/潘斯达斯/艾森按身份偏移（见 def
    // 表逐颗注）。渐变经 uCols/uOffs 5 停点数组在片元内逐段
    // 平滑混合；报告的逐停点 alpha 由既有沿程衰减曲线
    // (1−u)^1.35 × uOpacity × 层透明度承载同等峰值量级（离
    // 子主段 ≈0.62、尘埃根部 ≈0.55）。比例：尘埃/离子宽比
    // 3–5×（哈雷 3.1 / 恩克 3.2 / 艾森 3.5；潘斯达斯按尘埃主
    // 导身份 ≈8× 例外）；尾长上调（ionLen 逐颗 +40% 上下、
    // 尘埃历史步长 0.0064→0.0085）取「冲出画框感」；双尾夹
    // 角由尘埃历史轨迹的真实曲率给出（近近日点约 8–14° 量
    // 级），不做合成角度——保 NAOJ 脊线纪律。报告的 bloom/
    // anamorphic streak 等后期手法不引入：渲染路径铁律只走
    // 真机验证过的普通混合路径，辉光靠多层光幕＋彗发四层叠
    // 出（等效实现）。
    const makeTailCurtain = (
      // 沿程多停点色板（报告 §3.2 B 级设计建议值骨架 + 逐颗色
      // 相偏移，见 def 表）：{o = 沿程位置 0..1, hex}，工厂内补
      // 齐 5 停点喂 uCols/uOffs
      palette: Array<{ o: number; hex: string }>,
      rimHex: string,
      layerOpacities: number[],
      rayScale: number,
      rayAmt: number,
      waveAmp: number,
      waveSpeed: number,
      baseWidth: number,
      // 挂载组（各颗具名彗星自己的彗星组）
      parent: THREE.Group,
    ): TailCurtain => {
      const nv = TAIL_STATIONS * TAIL_ACROSS;
      const pos = new Float32Array(nv * 3);
      const nor = new Float32Array(nv * 3);
      const wdir = new Float32Array(nv * 3);
      const aU = new Float32Array(nv);
      const aV = new Float32Array(nv);
      let k = 0;
      for (let i = 0; i < TAIL_STATIONS; i++) {
        for (let j = 0; j < TAIL_ACROSS; j++) {
          aU[k] = i / (TAIL_STATIONS - 1);
          aV[k] = j / (TAIL_ACROSS - 1);
          k++;
        }
      }
      const idx: number[] = [];
      for (let i = 0; i < TAIL_STATIONS - 1; i++) {
        for (let j = 0; j < TAIL_ACROSS - 1; j++) {
          const a = i * TAIL_ACROSS + j;
          const b = a + TAIL_ACROSS;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aNorm", new THREE.BufferAttribute(nor, 3));
      geo.setAttribute("aWDir", new THREE.BufferAttribute(wdir, 3));
      geo.setAttribute("aU", new THREE.BufferAttribute(aU, 1));
      geo.setAttribute("aV", new THREE.BufferAttribute(aV, 1));
      geo.setIndex(idx);
      const group = new THREE.Group();
      const mats: THREE.ShaderMaterial[] = [];
      layerOpacities.forEach((opMul, li) => {
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uCols: {
              value: (() => {
                const stops = palette.slice(0, 5);
                while (stops.length < 5) {
                  stops.push({ o: 1, hex: stops[stops.length - 1]!.hex });
                }
                return stops.map((s) => new THREE.Color(s.hex));
              })(),
            },
            uOffs: {
              value: (() => {
                const stops = palette.slice(0, 5);
                while (stops.length < 5) {
                  stops.push({ o: 1, hex: stops[stops.length - 1]!.hex });
                }
                return stops.map((s) => s.o);
              })(),
            },
            // 外缘描边光：只给最宽层（li=0），色逐颗走 def 签名色
            uRimColor: { value: new THREE.Color(rimHex) },
            uRim: { value: li === 0 ? 1 : 0 },
            uOpacity: { value: 0 },
            uTime: { value: 0 },
            uWidth: { value: baseWidth },
            uWidthK: { value: 1 - li * 0.16 },
            uWaveAmp: { value: waveAmp * (1 + li * 0.3) },
            uWaveSpeed: { value: waveSpeed },
            uPhase: { value: li * 2.13 },
            uLayerN: { value: (li - (layerOpacities.length - 1) / 2) * 0.022 },
            uRayScale: { value: rayScale },
            uRayAmt: { value: rayAmt },
            uOpMul: { value: opMul },
            // 帘体（幕身托底项）不透明度系数：减深口径 0.6、亮边不乘
            uBodyK: { value: 0.6 },
          },
          vertexShader: [
            "attribute vec3 aNorm;",
            "attribute vec3 aWDir;",
            "attribute float aU;",
            "attribute float aV;",
            "uniform float uTime;",
            "uniform float uWidth;",
            "uniform float uWidthK;",
            "uniform float uWaveAmp;",
            "uniform float uWaveSpeed;",
            "uniform float uPhase;",
            "uniform float uLayerN;",
            "varying float vU;",
            "varying float vV;",
            "varying float vWave;",
            "void main() {",
            "  vU = aU;",
            "  vV = aV;",
            // 幕面自脊线沿逐站幕宽向 aWDir 张开：宽随程渐开
            // （近头收拢、向尾舒展）。aWDir 由 CPU 逐站定：离子
            // 尾恒为轨道极轴（窄直帘立于轨道面外），尘埃尾为轨
            // 道面内垂直脊线向（在轨道面内铺开成扇，见落位注）
            "  vec3 p = position + aWDir * (aV * uWidth * uWidthK * (0.22 + 0.78 * aU));",
            // 活的波浪：两列波沿幕传播，摆幅随 aV 增长（幕梢最飘）
            "  float w1 = sin(aU * 9.0 - uTime * uWaveSpeed + uPhase + aV * 2.4);",
            "  float w2 = sin(aU * 5.0 - uTime * uWaveSpeed * 0.63 + uPhase * 1.7 + aV * 1.3);",
            "  p += aNorm * (w1 * uWaveAmp * (0.25 + 0.75 * aV) + w2 * uWaveAmp * 0.5 * (0.3 + 0.7 * aV));",
            "  p += aWDir * w2 * uWaveAmp * 0.35 * aV;",
            "  p += aNorm * uLayerN;",
            "  vWave = 0.5 + 0.5 * w1;",
            "  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);",
            "}",
          ].join("\n"),
          fragmentShader: [
            "uniform vec3 uCols[5];",
            "uniform float uOffs[5];",
            "uniform vec3 uRimColor;",
            "uniform float uRim;",
            "uniform float uOpacity;",
            "uniform float uOpMul;",
            "uniform float uRayScale;",
            "uniform float uRayAmt;",
            "uniform float uBodyK;",
            "uniform float uTime;",
            "varying float vU;",
            "varying float vV;",
            "varying float vWave;",
            "float hash21(vec2 p) {",
            "  p = fract(p * vec2(234.34, 435.345));",
            "  p += dot(p, p + 34.23);",
            "  return fract(p.x * p.y);",
            "}",
            "float vnoise(vec2 p) {",
            "  vec2 i = floor(p);",
            "  vec2 f = fract(p);",
            "  f = f * f * (3.0 - 2.0 * f);",
            "  float a = hash21(i);",
            "  float b = hash21(i + vec2(1.0, 0.0));",
            "  float c = hash21(i + vec2(0.0, 1.0));",
            "  float d = hash21(i + vec2(1.0, 1.0));",
            "  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);",
            "}",
            "void main() {",
            // 纵向射线：亮度只随沿程坐标变的细密噪声光丝，自亮
            // 边向外贯穿整个幕面（对 vV 恒定 = 光丝沿幕宽方向）
            "  float rayN = vnoise(vec2(vU * uRayScale, 3.7)) * 0.62 + vnoise(vec2(vU * uRayScale * 2.63, 9.1)) * 0.38;",
            "  float rays = mix(1.0, 0.45 + 0.85 * rayN, uRayAmt);",
            // 横贯幕面的缓流（2026-11-13 晚加层）：第二噪声场同
            // 时随沿程与横向缓慢漂移，亮度成片起伏流动——尾巴
            // 是活的光，不是钉死的渐变带（单调感的主修）
            "  float flowN = vnoise(vec2(vU * 22.0 - uTime * 0.32, vV * 4.5 + uTime * 0.11));",
            "  float flow = 0.8 + 0.42 * flowN;",
            // 亮边：贴脊线（v=0）最亮、向外 exp 衰减（原样保留）
            // + 幕身托底（×uBodyK 减深，光感靠亮边不靠色深）
            "  float bodyF = exp(-vV * 3.0) * 0.95 + pow(1.0 - vV, 2.0) * 0.30 * uBodyK;",
            // 外缘羽化：无硬界
            "  float feather = 1.0 - smoothstep(0.62, 1.0, vV);",
            // 沿程衰减沿旧口径：近头饱满、尾端连续收尽（头口
            // 0.05 淡入防硬切）
            "  float fall = pow(1.0 - vU, 1.35) * smoothstep(0.0, 0.05, vU);",
            "  float shimmer = 0.88 + 0.12 * vWave;",
            // 外缘描边带（仅最宽层）：羽化带内侧的一线签名色
            "  float rimBand = uRim * smoothstep(0.52, 0.82, vV) * (1.0 - smoothstep(0.82, 0.99, vV));",
            "  float a = bodyF * feather * fall * rays * shimmer * flow * uOpacity * uOpMul + rimBand * 0.12 * uOpacity * uOpMul * fall;",
            // 尾面星屑（新海诚式彗尾的签名层）：沿程×横向细网格
            // 里约 7% 的格点是星屑，逐格随机相位/频率各自眨眼
            // （pow5 脉冲 = 大部分时间暗、短暂闪亮），亮度叠进
            // alpha 并把当地颜色拉向冰白——尾面因此是「光里面
            // 有星星在闪」，近头最密、向尾梢渐稀、外缘羽化带不
            // 出屑（与 feather 同界）
            "  vec2 spCell = vec2(vU * 340.0, vV * 40.0);",
            "  vec2 spId = floor(spCell);",
            "  float spH = hash21(spId + 7.7);",
            "  vec2 spF = fract(spCell) - 0.5;",
            "  float spD = length(spF * vec2(1.0, 1.7));",
            "  float spBlink = pow(0.5 + 0.5 * sin(uTime * (1.6 + spH * 3.4) + spH * 41.0), 5.0);",
            "  float spEnv = (1.0 - vU * 0.55) * smoothstep(0.0, 0.05, vU) * (1.0 - smoothstep(0.62, 1.0, vV));",
            "  float sp = (1.0 - smoothstep(0.03, 0.30, spD)) * step(0.90, spH) * spBlink * spEnv;",
            "  a += sp * uOpacity * uOpMul * 1.5;",
            "  a = clamp(a * 1.25, 0.0, 1.0);",
            // 沿程多停点辉光渐变（报告 §3.2 B 级骨架 + 逐颗偏
            // 移，停点在 def 表）：离子 青白→天蓝→电蓝→紫罗兰
            // →粉紫淡出；尘埃 暖白→浅粉→粉→薰衣草紫淡出（黄
            // 昏染尾）。色随长度流动；旧单色/三段平涂废止
            "  vec3 grad = uCols[0];",
            "  for (int gi = 1; gi < 5; gi++) {",
            "    float gSpan = max(uOffs[gi] - uOffs[gi - 1], 0.001);",
            "    float gk = clamp((vU - uOffs[gi - 1]) / gSpan, 0.0, 1.0);",
            "    gk = gk * gk * (3.0 - 2.0 * gk);",
            "    grad = mix(grad, uCols[gi], gk);",
            "  }",
            // 外缘描边光上色：签名色在羽化带内侧亮起（哈雷粉
            // 紫 / 艾森翠绿 / 潘斯达斯金粉 / 恩克淡灰紫），到真
            // 边缘前收住——是光晕的边，不是描出来的硬线
            "  vec3 col = mix(grad, uRimColor, rimBand * 0.6);",
            "  col = mix(col, vec3(0.93, 0.98, 1.0), clamp(sp * 1.4, 0.0, 1.0));",
            // 输出契约（2026-11-13 真机黑带修复，根因见工厂头注）：
            // 颜色不预乘、衰减全走真实 alpha——a→0 处只会透明，
            // 任何驱动/合成路径下都不可能再盖出不透明黑带
            "  gl_FragColor = vec4(col, a);",
            "}",
          ].join("\n"),
          // 普通 alpha 混合（与同屏已验证的轨道线/标签路径同路）；
          // 旧 AdditiveBlending + 预乘输出在 iOS WebKit 上失效为
          // 不透明暗带，见工厂头注
          blending: THREE.NormalBlending,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        group.add(mesh);
        mats.push(mat);
      });
      group.visible = false;
      parent.add(group);
      return { group, mats, pos, nor, wdir, geo, baseWidth };
    };
    // 尾色板已逐颗入 def（2026-11-13 晚全维分家：哈雷蓝金 /
    // 恩克灰旧 / 潘斯达斯暖金 / 艾森翠绿，见 NAMED_COMETS 表与
    // 具名彗星构建段）；旧五颗共用色板与客串双尾实例随客串下
    // 线一并移除。
    /** 脊线采样 → 光幕几何：49 站脊线点 + 逐站幕宽向/法向写入共
     * 享属性（跨向顶点同站同点，幕宽在着色器内展开）。
     * 幕宽向按宏观结构分工（国立天文台 NAOJ「彗星」页模式图口
     * 径：https://www.nao.ac.jp/astro/basic/comet.html ）：
     * "pole"（离子尾）= 轨道极轴恒定——窄直帘；"fan"（尘埃尾）
     * = 轨道面内垂直于脊线切向、朝该站径向（背阳漂移侧）——幕
     * 在轨道面内自轨迹脊线向背阳侧铺开成扇，与离子帘同宽化的
     * 做法被该图否决。法向 = 切向 × 幕宽向（波浪位移向） */
    const fillCurtainSpine = (
      tail: TailCurtain,
      spinePts: THREE.Vector3[],
      mode: "pole" | "fan",
      // 幕面基准极轴（各颗具名彗星传入各自轨道极轴）
      pole: THREE.Vector3,
    ): void => {
      const tan = new THREE.Vector3();
      const nrm = new THREE.Vector3();
      const wd = new THREE.Vector3();
      for (let i = 0; i < TAIL_STATIONS; i++) {
        const p = spinePts[i]!;
        const pa = spinePts[Math.max(0, i - 1)]!;
        const pb = spinePts[Math.min(TAIL_STATIONS - 1, i + 1)]!;
        tan.subVectors(pb, pa);
        if (tan.lengthSq() < 1e-10) tan.set(1, 0, 0);
        tan.normalize();
        if (mode === "pole") {
          wd.copy(pole);
        } else {
          wd.crossVectors(pole, tan);
          if (wd.lengthSq() < 1e-6) wd.copy(pole);
          wd.normalize();
          // 扇面朝背阳侧铺开：该站径向即其背阳漂移方向
          const radial = p.clone().normalize();
          if (wd.dot(radial) < 0) wd.negate();
        }
        nrm.crossVectors(tan, wd);
        if (nrm.lengthSq() < 1e-6) nrm.set(0, 0, 1);
        nrm.normalize();
        for (let j = 0; j < TAIL_ACROSS; j++) {
          const vi = (i * TAIL_ACROSS + j) * 3;
          tail.pos[vi] = p.x;
          tail.pos[vi + 1] = p.y;
          tail.pos[vi + 2] = p.z;
          tail.nor[vi] = nrm.x;
          tail.nor[vi + 1] = nrm.y;
          tail.nor[vi + 2] = nrm.z;
          tail.wdir[vi] = wd.x;
          tail.wdir[vi + 1] = wd.y;
          tail.wdir[vi + 2] = wd.z;
        }
      }
      (
        tail.geo.getAttribute("position") as THREE.BufferAttribute
      ).needsUpdate = true;
      (
        tail.geo.getAttribute("aNorm") as THREE.BufferAttribute
      ).needsUpdate = true;
      (
        tail.geo.getAttribute("aWDir") as THREE.BufferAttribute
      ).needsUpdate = true;
    };
    // —— 近日点粒子喷流（GPU 全动画：位置由种子 + uTime 在顶点
    // 着色器内算出，CPU 每帧只喂彗核位置/反太阳向/强度因子）：
    // 窄束汇入离子尾、宽锥成近核喷流扇。精修④⑤：70→180 粒，
    // 喷速/尺寸/亮度同升一档。
    // 工厂化（2026-11-13，用户实报「彗星接近太阳的粒子效果怎
    // 么没了」）：旧账这层喷流只长在客串彗星身上、且被火因子
    // 锁在会话开场约 30 秒的窗口（用户多半还在主页读数据，进
    // 太阳系时窗口已过），四颗具名彗星则明文「无火花喷流」
    // ——五颗彗星 400 秒轮值里约 87% 的时间近日点根本没有粒
    // 子，观感即「效果没了」。本轮改工厂：五颗各一份、逐颗种
    // 子；色阶两版——客串恒燃烧版（白炽→橙→深红余烬，其专属
    // 幻想层不变），具名彗星走冰晶版（白→冰青→深蓝，与新海
    // 诚式尾色同语系），强度由各自近日因子驱动（客串 = 火因
    // 子、具名 = 日心距近日因子，见 animate 两段）。
    interface CometSparks {
      points: THREE.Points;
      mat: THREE.ShaderMaterial;
    }
    // —— 近日点粒子喷流（2026-11-13 晚「再漂亮点」+ 逐颗分家
    // 重做）：旧版是均匀撒点的功能粒子，现按「绽放的晶尘」做：
    // ① 成簇呼吸——粒子按随机数分 6 簇，簇门（gate）随时间错峰
    // 开合，喷速与亮度随门起伏，近日点最盛时成团绽开再飘散，
    // 不是恒速撒点；② 辉光拖尾——每粒在点精灵内沿运动方向
    // （视空间投影 vDirS）前置亮核、身后拖一条渐隐光，另有宽
    // 晕托底，单粒即是一颗微型彗星；③ 闪点——逐粒相位的高频
    // 闪烁（pow3 锐化）；④ 色阶逐颗分家（uMode，def.sparkMode）：
    // 1 哈雷冰晶 白→冰青→深蓝（晶莹规整）/ 2 恩克灰烬 白灰→
    // 灰蓝→暗板岩（黯淡慢小）/ 3 潘斯达斯金尘 奶白→金→琥珀
    // （大粒慢飘的尘雾）/ 4 艾森翠绿 白绿→翠绿→深青绿（快而
    // sharp）；速度/尺寸/亮度系数逐颗走 def。绘制账：每颗 1
    // 次 Points 绘制、粒数 95–210（def.sparkCount），顶点着色
    // 器内全程序化、CPU 逐帧只写 6 个 uniform。
    const makeCometSparks = (
      parent: THREE.Group,
      seed: number,
      style: {
        mode: number;
        count: number;
        speedMul: number;
        sizeMul: number;
        bright: number;
      },
    ): CometSparks => {
      const count = style.count;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(count * 3), 3),
      );
      const aRnd = new Float32Array(count * 4);
      const rand = seededRand(seed);
      for (let i = 0; i < count * 4; i++) aRnd[i] = rand();
      geo.setAttribute("aRnd", new THREE.BufferAttribute(aRnd, 4));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOrigin: { value: new THREE.Vector3() },
          uDir: { value: new THREE.Vector3(1, 0, 0) },
          uOpacity: { value: 0 },
          uScaleH: { value: 1 },
          uIntensity: { value: 0 },
          uMode: { value: style.mode },
          uBright: { value: style.bright },
          uSpeedMul: { value: style.speedMul },
          uSizeMul: { value: style.sizeMul },
        },
        vertexShader: [
          "attribute vec4 aRnd;",
          "uniform float uTime;",
          "uniform vec3 uOrigin;",
          "uniform vec3 uDir;",
          "uniform float uScaleH;",
          "uniform float uIntensity;",
          "uniform float uSpeedMul;",
          "uniform float uSizeMul;",
          "varying float vAge;",
          "varying float vPh;",
          "varying float vGate;",
          "varying vec2 vDirS;",
          "void main() {",
          "  float life = mix(0.5, 1.15, aRnd.z);",
          // 成簇呼吸：6 簇错峰开合（黄金角错相），门开时喷速与
          // 亮度同涨——绽放感来自簇的节律，不是单粒随机
          "  float cl = floor(aRnd.w * 6.0);",
          "  float gate = 0.5 + 0.5 * sin(uTime * (0.55 + 0.11 * cl) + cl * 2.399);",
          "  gate = pow(gate, 2.0);",
          "  vGate = gate;",
          "  float age = fract(uTime / life + aRnd.x * 7.31 + cl * 0.618);",
          "  vAge = age;",
          "  vPh = aRnd.y * 39.0;",
          "  float cone = mix(0.16, 0.8, step(0.62, aRnd.w));",
          "  vec3 jit = (vec3(aRnd.y, aRnd.z, aRnd.x) - 0.5) * 2.0;",
          "  vec3 dir = normalize(uDir + jit * cone);",
          "  float speed = mix(0.7, 2.1, aRnd.y) * (0.8 + 0.55 * uIntensity) * uSpeedMul * (0.55 + 0.75 * gate);",
          "  vec3 p = uOrigin + dir * (speed * age * life);",
          "  vec4 mv = modelViewMatrix * vec4(p, 1.0);",
          // 运动方向的视空间投影：片元里沿它排核与拖尾
          "  vec3 vd = (modelViewMatrix * vec4(dir, 0.0)).xyz;",
          "  vDirS = length(vd.xy) > 0.001 ? normalize(vd.xy) : vec2(0.0, 1.0);",
          "  float sz = mix(0.02, 0.048, aRnd.x) * (1.0 - age * 0.45) * uSizeMul;",
          "  gl_PointSize = sz * uScaleH / max(0.1, -mv.z);",
          "  gl_Position = projectionMatrix * mv;",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform float uTime;",
          "uniform float uOpacity;",
          "uniform float uIntensity;",
          "uniform float uMode;",
          "uniform float uBright;",
          "varying float vAge;",
          "varying float vPh;",
          "varying float vGate;",
          "varying vec2 vDirS;",
          "void main() {",
          "  vec2 pc = gl_PointCoord - 0.5;",
          // 辉光拖尾：亮核沿运动方向前置（+0.16），身后沿反向
          // 拖一条窄渐隐光，宽晕托底——单粒自带彗形
          "  float along = dot(pc, vDirS);",
          "  float side = length(pc - vDirS * along);",
          "  float headD = length(pc - vDirS * 0.16);",
          "  float core = 1.0 - smoothstep(0.02, 0.30, headD);",
          "  float trail = smoothstep(-0.5, 0.02, along) * (1.0 - smoothstep(0.02, 0.18, along)) * (1.0 - smoothstep(0.0, 0.14, side));",
          "  float halo = 1.0 - smoothstep(0.05, 0.5, length(pc));",
          // 闪点：逐粒相位闪烁、pow3 锐化成倏亮倏暗
          "  float tw = 0.72 + 0.5 * pow(0.5 + 0.5 * sin(uTime * (5.0 + fract(vPh) * 4.0) + vPh), 3.0);",
          "  float a = (core * 0.95 + trail * 0.4 + halo * 0.30) * (1.0 - vAge) * smoothstep(0.0, 0.12, vAge) * (0.35 + 0.65 * vGate) * tw * uOpacity;",
          // 逐颗色阶（uMode）：新粒近白 → 中段本色 → 老粒沉入
          // 深境；强度越高本色越透（与旧冰晶口径同构）
          "  vec3 cNew = vec3(1.0, 1.0, 1.0);",
          "  vec3 cMid = vec3(0.55, 0.83, 1.0);",
          "  vec3 cOld = vec3(0.14, 0.34, 0.95);",
          "  if (uMode > 1.5 && uMode < 2.5) { cNew = vec3(0.96, 0.97, 0.96); cMid = vec3(0.58, 0.65, 0.73); cOld = vec3(0.33, 0.40, 0.49); }",
          "  else if (uMode > 2.5 && uMode < 3.5) { cNew = vec3(1.0, 0.98, 0.90); cMid = vec3(1.0, 0.85, 0.55); cOld = vec3(0.78, 0.56, 0.24); }",
          "  else if (uMode > 3.5) { cNew = vec3(0.94, 1.0, 0.96); cMid = vec3(0.25, 0.91, 0.68); cOld = vec3(0.04, 0.56, 0.43); }",
          "  vec3 col = mix(cNew, cMid, smoothstep(0.05, 0.45, vAge));",
          "  col = mix(col, cOld, smoothstep(0.45, 1.0, vAge) * (0.35 + 0.65 * uIntensity));",
          "  col *= (1.0 + 0.6 * uIntensity) * uBright;",
          // 输出契约与光帘同版（2026-11-13 黑带修复）：不预乘、
          // alpha 承载衰减 + 普通混合，见 makeTailCurtain 头注
          "  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));",
          "}",
        ].join("\n"),
        blending: THREE.NormalBlending,
        transparent: true,
        depthWrite: false,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.visible = false;
      parent.add(points);
      return { points, mat };
    };
    // —— 具名彗星构建（2026-11-13；根数/分工/摆位口径见模块层
    // NAMED_COMETS 处注）——
    // 与客串彗星同为太阳系故事层：只活在太阳系模式、不进点选命
    // 中表、淡入随 sunFade；但与客串不同，它们各有真实轨道线与
    // 名卡（用户令「要有名字的卡片」）。本体绘制账逐颗 = 核球 1
    // + 彗发精灵 3 + 双尾光幕（离子 2 层 + 尘埃 2–3 层、共享 1 张
    // 几何）+ 近日点冰晶喷流 1 + 轨道线 1，四颗合计 ≈30 次绘
    // 制；无变红燃烧（物理色口径，见模块层注），但近日点粒子
    // 喷流已补回（2026-11-13，冰晶版，见下方 sparks 处注）。
    // 名卡与背景八星同层（starLabelLayer、z 6 最高层级），但
    // 款式独立：彗星名卡带真实信息副行（周期/下次回归/解体），
    // 保留自己的小玻璃卡式样——2026-11-13 晚八星名签改行星标
    // 签同款裸排版时彗星名卡不在改判范围（独立实现、双行信
    // 息），原样不动。逐帧直锚彗头投影、互避口径见 animate
    // 具名彗星名卡段（八星签面矩形仍作其互避障碍，坐标同源）。
    interface NamedCometRt {
      def: NamedCometDef;
      group: THREE.Group;
      nucleus: THREE.Mesh;
      nucleusMat: THREE.MeshBasicMaterial;
      core: THREE.Sprite;
      inner: THREE.Sprite;
      halo: THREE.Sprite;
      haloOut: THREE.Sprite;
      coreMat: THREE.SpriteMaterial;
      innerMat: THREE.SpriteMaterial;
      haloMat: THREE.SpriteMaterial;
      haloOutMat: THREE.SpriteMaterial;
      ion: TailCurtain;
      dust: TailCurtain;
      /** 近日点粒子喷流（过近日点时喷发，animate 具名段按日心
       * 距 prox 驱动；风格逐颗分家，见 def.spark*） */
      sparks: CometSparks;
      orbitMat: THREE.LineBasicMaterial;
      pole: THREE.Vector3;
      /** 本帧组内本地坐标（名卡段经 solarGroup 矩阵转世界投影） */
      localPos: THREE.Vector3;
      /** 本帧活跃度 / 本帧总淡化（sunFade × 接缝包络） */
      act: number;
      fadeNow: number;
      cardEl: HTMLDivElement;
      cardW: number;
      cardH: number;
      cardFade: number;
      cardFadeT: number;
      /** 互避判定推不开时置真（本轮名卡淡出，星体保留） */
      cardBlocked: boolean;
      cardShiftX: number;
      cardShiftY: number;
      cardShiftTX: number;
      cardShiftTY: number;
    }
    const namedCometRts: NamedCometRt[] = [];
    for (const def of NAMED_COMETS) {
      const basis = NAMED_COMET_BASIS.get(def.id)!;
      const group = new THREE.Group();
      solarGroup.add(group);
      const nucleusMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
      });
      const nucleus = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 12, 10),
        nucleusMat,
      );
      group.add(nucleus);
      const makeNamedComa = (colorHex: string): THREE.Sprite => {
        const m = new THREE.SpriteMaterial({
          map: cometGlowTex,
          color: new THREE.Color(colorHex),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        });
        const sp = new THREE.Sprite(m);
        group.add(sp);
        return sp;
      };
      // 彗发四层逐颗染色（报告 §3.2 B-1：烧白核/青白内层/蓝
      // 紫外晕内圈/粉紫外晕外圈，逐颗偏移见 def.coma*）：哈雷
      // 报告原值 / 恩克灰黯 / 潘斯达斯暖金粉 / 艾森绿彗发
      const core = makeNamedComa(def.comaCore);
      const inner = makeNamedComa(def.comaInner);
      const halo = makeNamedComa(def.comaHaloMid);
      const haloOut = makeNamedComa(def.comaHaloOut);
      // 双尾光帘：同一工厂、逐颗全套参数分家（见 def 表）——尾
      // 色走各自色板（def.ionPalette/dustPalette）+ 各自描边色；
      // 射线密度/波幅按性格给：哈雷标准、恩克弱化、潘斯达斯尘
      // 埃射线更疏更飘、艾森离子射线最密最稳（极细长直帘）
      const ion = makeTailCurtain(
        def.ionPalette,
        def.ionRim,
        def.ionLayers,
        def.id === "ison" ? 190 : 150,
        0.55,
        def.id === "ison" ? 0.008 : 0.012,
        def.id === "ison" ? 1.3 : 1.15,
        def.ionWidth,
        group,
      );
      const dust = makeTailCurtain(
        def.dustPalette,
        def.dustRim,
        def.dustLayers,
        def.id === "panstarrs" ? 48 : 64,
        0.32,
        def.id === "panstarrs" ? 0.06 : 0.045,
        def.id === "panstarrs" ? 0.6 : 0.7,
        def.dustWidth,
        group,
      );
      // 近日点粒子喷流：逐颗风格档（def.spark*：色阶/粒数/速
      // 度/尺寸/亮度），种子逐颗错开。驱动在 animate 具名段
      // （近日因子 prox）
      const sparks = makeCometSparks(group, 5000 + namedCometRts.length * 977, {
        mode: def.sparkMode,
        count: def.sparkCount,
        speedMul: def.sparkSpeed,
        sizeMul: def.sparkSize,
        bright: def.sparkBright,
      });
      // 轨道线：真实椭圆采样（ν 直采、近头密远端疏由 r 公式自
      // 然成形）。远日点 ≤48 AU 的（哈雷/恩克）画整圈闭合；近抛
      // 物线的两颗只画 r ≤48 AU 的弧段（再远在全览取景外，画出
      // 去只是离屏长线），与 NAOJ 概略图「长轨伸出图外」同构图。
      const aphelion = def.a * (1 + def.e);
      const closed = aphelion <= 48;
      const pSemi = def.a * (1 - def.e * def.e);
      let nuLim = Math.PI;
      if (!closed) {
        nuLim = Math.acos(
          THREE.MathUtils.clamp(((pSemi / 48 - 1) / def.e), -1, 1),
        );
      }
      const ORBIT_SEGS = 220;
      const orbitPts: THREE.Vector3[] = [];
      for (let i = 0; i <= ORBIT_SEGS; i++) {
        const nu = closed
          ? -Math.PI + (i / ORBIT_SEGS) * Math.PI * 2
          : -nuLim + (i / ORBIT_SEGS) * nuLim * 2;
        const rAU = pSemi / (1 + def.e * Math.cos(nu));
        const pt = basis.P
          .clone()
          .multiplyScalar(rAU * Math.cos(nu))
          .addScaledVector(basis.Q, rAU * Math.sin(nu));
        const dispR = Math.max(0.68, auToDisplayR(rAU));
        orbitPts.push(
          pt.normalize().multiplyScalar(dispR * SOLAR_S),
        );
      }
      const orbitMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(def.orbitColor),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPts);
      const orbitLine = closed
        ? new THREE.LineLoop(orbitGeo, orbitMat)
        : new THREE.Line(orbitGeo, orbitMat);
      solarGroup.add(orbitLine);
      // 名卡：与八星名签同层，款式自理（深色微底 + 细边 + 小
      // 内边距的小玻璃卡——八星名签已改裸排版，彗星卡带副行
      // 信息不在那轮改判内，保持本式样），主行星名 + 副行真
      // 实信息；尺寸先按字数估算占位，名卡段每 6 帧回读实测
      // 覆写（与八星同口径）
      const cardEl = document.createElement("div");
      const fsN = isCoarse ? 10 : 11;
      const fsI = 9;
      cardEl.style.position = "absolute";
      cardEl.style.left = "0";
      cardEl.style.top = "0";
      cardEl.style.whiteSpace = "nowrap";
      cardEl.style.pointerEvents = "none";
      cardEl.style.fontFamily = "'Noto Sans SC', system-ui, sans-serif";
      cardEl.style.padding = "3px 6px";
      cardEl.style.borderRadius = "6px";
      cardEl.style.background = "rgba(9,17,32,0.62)";
      cardEl.style.border = "1px solid rgba(148,196,255,0.32)";
      cardEl.style.boxShadow =
        "inset 0 1px 0 rgba(160,210,255,0.10), 0 2px 8px rgba(2,6,16,0.35)";
      cardEl.style.opacity = "0";
      cardEl.style.visibility = "hidden";
      cardEl.style.willChange = "transform, opacity";
      const cardName = document.createElement("div");
      cardName.textContent = def.name;
      cardName.style.fontSize = `${fsN}px`;
      cardName.style.fontWeight = "500";
      cardName.style.lineHeight = "1.25";
      cardName.style.letterSpacing = "0.03em";
      cardName.style.color = "rgba(234,242,253,0.97)";
      cardName.style.textShadow =
        "0 0 6px rgba(140,190,255,0.8), 0 1px 2px rgba(3,8,18,0.85)";
      const cardInfo = document.createElement("div");
      cardInfo.textContent = def.info;
      cardInfo.style.fontSize = `${fsI}px`;
      cardInfo.style.lineHeight = "1.3";
      cardInfo.style.marginTop = "1px";
      cardInfo.style.color = "rgba(158,184,219,0.88)";
      cardEl.appendChild(cardName);
      cardEl.appendChild(cardInfo);
      starLabelLayer.appendChild(cardEl);
      namedCometRts.push({
        def,
        group,
        nucleus,
        nucleusMat,
        core,
        inner,
        halo,
        haloOut,
        coreMat: core.material as THREE.SpriteMaterial,
        innerMat: inner.material as THREE.SpriteMaterial,
        haloMat: halo.material as THREE.SpriteMaterial,
        haloOutMat: haloOut.material as THREE.SpriteMaterial,
        ion,
        dust,
        sparks,
        orbitMat,
        pole: basis.pole,
        localPos: new THREE.Vector3(),
        act: 0,
        fadeNow: 0,
        cardEl,
        cardW: Math.max(def.name.length * fsN, def.info.length * fsI) + 14,
        cardH: Math.round(fsN * 1.25 + fsI * 1.3) + 9,
        cardFade: 0,
        cardFadeT: 0,
        cardBlocked: false,
        cardShiftX: 0,
        cardShiftY: 0,
        cardShiftTX: 0,
        cardShiftTY: 0,
      });
    }
    // —— 星街彗星本体已升格为第十一号天体：构建/轨道/逐帧全
    // 部并入行星构建循环与 planetVis 逐帧段（见 PLANET_ELEMENTS
    // 的 suisei 条目与构建循环前的轨道口径），此处不再有独立
    // 客串行星对象。取景核对沿用旧账：轨道半径 8.344（orbitR
    // 单位）< 全览拟合的可见半径 7.95×1.05 ≈ 8.35，未动任何取
    // 景常数。

    // —— 地球极光（太阳系模式限定，2026-11-12 二轮）：与木星同口径
    // 的极光卵环（连续环带 + 帘幕波动），但压到极淡（opacity 0.16，
    // 绿→青蓝是地球极光的真实色）。分离口径不变：只往地球组加两枚
    // 带面，不碰球体材质与任何数据层；uFade 由地球的 fxTick 按
    // orbitFade(2) 驱动（主页模式 tick 不运行、恒 0 不可见），进出
    // 太阳系随地球本体同拍淡入淡出。
    {
      for (const south of [false, true]) {
        const oval = makeAuroraOval(R * 1.015, {
          colorA: "#5fffb0",
          colorB: "#37c8ff",
          polarRad: 0.4,
          halfWidth: 0.11,
          south,
          opacity: 0.16,
        });
        earth.add(oval.mesh);
        earthAuroraMats.push(oval.mat);
      }
    }
    // —— 月球组：细绕地轨道圈 + 月球本体 + 标签，随地球一同绕日 ——
    // 挂在 solarGroup 下、逐帧钉到地球轨道位（earthAnchor）；组平面带
    // 约 5° 倾角（月球轨道对黄道的真实倾角量级）。月球材质只留极弱的
    // 自发光模拟地照，盈亏完全由太阳点光源的真实照明决定。
    {
      moonLon0 = moonLongitude(new Date());
      moonGroup = new THREE.Group();
      moonGroup.rotation.x = 0.09;
      const moonOrbitPts: THREE.Vector3[] = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        moonOrbitPts.push(
          new THREE.Vector3(
            Math.cos(a) * MOON_ORBIT_R,
            0,
            -Math.sin(a) * MOON_ORBIT_R,
          ),
        );
      }
      moonOrbitMat = new THREE.LineBasicMaterial({
        color: 0xcfd8e6,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const moonOrbit = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(moonOrbitPts),
        moonOrbitMat,
      );
      moonGroup.add(moonOrbit);
      const moonMaps = makeMoonMaps(!isCoarse);
      moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(MOON_R, isCoarse ? 28 : 40, isCoarse ? 20 : 28),
        new THREE.MeshPhongMaterial({
          map: moonMaps.map,
          bumpMap: moonMaps.bump,
          bumpScale: 0.5,
          emissive: 0x23272d,
          shininess: 6,
        }),
      );
      moonGroup.add(moonMesh);
      {
        // 月尘微光（2026-11-12）：月球无大气，不编大气效应——只有
        // 静电悬浮月尘的地平线微光（LADEE 观测到的真实现象）：
        // 30 颗极淡光点贴月面 1.02–1.07 倍半径缓闪，是全场最克制
        // 的一层。依据不足宁可更淡，不许加厚。
        const dustRand = seededRand(602210);
        const dustSpecs: FlowPointSpec[] = [];
        for (let i = 0; i < 30; i++) {
          dustSpecs.push({
            lon: dustRand() * Math.PI * 2,
            lat: Math.asin(dustRand() * 2 - 1),
            rad: MOON_R * (1.02 + dustRand() * 0.05),
            speed: 0.008,
            size: MOON_R * (0.14 + dustRand() * 0.1),
            phase: dustRand() * Math.PI * 2,
            freq: 0.3 + dustRand() * 0.5,
          });
        }
        const dust = makeFlowPoints(dustSpecs, {
          color: "#d9dee6",
          opacity: 0.36,
          twinkleAmp: 0.55,
        });
        moonMesh.add(dust.points);
        moonDustMat = dust.mat;
      }
      {
        const moonHit = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(MOON_R * 3.4, 0.15), 8, 8),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        moonMesh.add(moonHit);
        addSolarHit(moonHit, "moon");
        addSolarHit(moonMesh, "moon");
      }
      // —— 访客安家：纸片人居民分散在整个月面（移动端 4 只、桌面
      // 5 只），个体区分靠官方三色眼版本（赤/青/黄，见 serpoArt）；
      // 个头是「飞近能认出脸」的示意比例（约 0.66 个月球半径高——
      // 真实比例下这个距离根本看不见人）。精灵恒朝镜头，位置走弧面。
      {
        const count = isCoarse ? 4 : 5;
        serpoRand = seededRand(987123);
        const rand = serpoRand;
        for (let i = 0; i < count; i++) {
          const homeDef = SERPO_HOME_DIRS[i] ?? SERPO_HOME_DIRS[0]!;
          const home = new THREE.Vector3(
            homeDef[0],
            homeDef[1],
            homeDef[2],
          ).normalize();
          const walker = makePaperWalker(
            serpoTexSet[i] ?? serpoTexSet[0]!,
            home,
            rand,
            MOON_R * 0.66,
            i,
          );
          walker.sprite.position
            .copy(walker.dir)
            .multiplyScalar(MOON_R);
          moonMesh.add(walker.sprite);
          moonMesh.add(walker.shadow);
          serpoWalkers.push(walker);
        }
      }
      moonLabel = makeSolarLabel("月球", "#cfd8e6", 0.4 * solarLabelScale);
      (moonLabel.material as THREE.SpriteMaterial).opacity = 0;
      moonGroup.add(moonLabel);
      addSolarHit(moonLabel, "moon");
      solarGroup.add(moonGroup);
    }
    // 太阳系镜头距离（resize 时按视口宽高比拟合）：
    // full=海王星轨道全览；near=只框太阳到木星一带（移动端默认近览，
    // 内圈行星与标签可辨认，外圈靠双指缩放/平移或切全览去看）
    let solarFullZ = 11;
    let solarNearZ = 7;
    /**
     * 「窄屏取景」判定：粗指针（触屏）或挂载宽度 <1024（与近览/全览按钮
     * 的 lg 以下可见范围一致）。旧版在 animate 里用画布宽高比 <0.9 判定，
     * 而地球区是 54svh 高的横长矩形，手机上宽高比常在 0.9–1.1 之间，
     * 判定不成立 → 永远按全览距离渲染，近览按钮点了等于没点（用户实报）。
     * resize 时按真实宽度刷新此标志，animate 只读它。
     */
    let solarNarrow = isCoarse;
    /** 双指捏合缩放倍率（1=当前取景拟合距离，>1 拉近）与平移偏移 */
    let solarZoom = 1;
    const solarPan = { x: 0, y: 0 };
    /** animate 每帧算出的实际太阳系镜头距离（捏合平移换算用） */
    let currentSolarZ = 11;

    // 城市当地时间标签的纹理更新器注册表（animate 里周期调用）
    const timeUpdaters: Array<() => void> = [];

    // 城市节点（保存材质引用，逐帧按朝向淡入淡出，背面节点不透出球缘）
    interface NodeVis {
      base: THREE.Vector3;
      mats: THREE.Material[];
      hit: THREE.Mesh;
    }
    interface NodeRing {
      sprite: THREE.Sprite;
      phase: number;
    }
    const nodeHitMeshes: THREE.Mesh[] = [];
    const nodeVis: NodeVis[] = [];
    const nodeRings: NodeRing[] = [];
    // 核心城市标签纳入统一避让池（与金融中心标签同规则竞争显隐）
    interface CoreLabel {
      sprite: THREE.Sprite;
      base: THREE.Vector3;
      priority: number;
      target: number;
      offX: number;
      offY: number;
      /** 名称下方当地时间小标签（跟随名称标签的位置与显隐） */
      timeSprite: THREE.Sprite;
      timeTarget: number;
      timeVis: number;
    }
    const coreLabels: CoreLabel[] = [];
    const burstRings: Array<{ mat: THREE.SpriteMaterial; sprite: THREE.Sprite }> = [];
    const ringTex = makeRingTexture();
    const cityVecs = CITIES.map((c) => latLonToVec3(c.lat, c.lon, R * 1.01));
    CITIES.forEach((city, i) => {
      const pos = cityVecs[i]!;
      const coreMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(city.color),
        transparent: true,
      });
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 12), coreMat);
      core.position.copy(pos);
      earth.add(core);
      const glowMat = new THREE.SpriteMaterial({
        map: makeGlowTexture(city.color, "rgba(0,0,0,0)"),
        color: new THREE.Color(city.color),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const glowSprite = new THREE.Sprite(glowMat);
      glowSprite.scale.set(0.27, 0.27, 1);
      glowSprite.position.copy(pos);
      earth.add(glowSprite);
      // 呼吸光环：持续向外扩散的一圈光，逐帧在 animate 里缩放
      const ringMat = new THREE.SpriteMaterial({
        map: makeGlowTexture(city.color, "rgba(0,0,0,0)"),
        color: new THREE.Color(city.color),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      ringMat.userData.baseOpacity = 0.5;
      const ring = new THREE.Sprite(ringMat);
      ring.position.copy(pos);
      earth.add(ring);
      nodeRings.push({ sprite: ring, phase: i * 0.37 });
      // 命中涟漪：选中该国时从节点扩散出一圈亮环（animate 里按起始时间驱动）
      const burstMat = new THREE.SpriteMaterial({
        map: ringTex,
        color: new THREE.Color(city.color),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const burst = new THREE.Sprite(burstMat);
      burst.position.copy(pos);
      burst.scale.set(0.1, 0.1, 1);
      earth.add(burst);
      burstRings.push({ mat: burstMat, sprite: burst });
      // 无文字标签名单内的城市（大阪）跳过名称+时间标签的生成与
      // 入池：上方节点/辉光/光环/命中体已建好，照常保留。
      if (!NO_TEXT_LABEL_CITY_NAMES.has(city.name)) {
        const labelOff = LABEL_OFFSETS[city.name] ?? { dLat: 2, dLon: 0 };
        const label = makeLabelSprite(city.name, city.color, 0.34, 34, true);
        label.position.copy(
          latLonToVec3(
            city.lat + labelOff.dLat,
            city.lon + labelOff.dLon,
            R * 1.1,
          ),
        );
        (label.material as THREE.SpriteMaterial).opacity = 0;
        label.renderOrder = 8; // 标签压在弧线/辉光之上，文字不被光流冲淡
        earth.add(label);
        const timeLbl = makeTimeSprite(city.color, city.tz);
        earth.add(timeLbl.sprite);
        timeUpdaters.push(timeLbl.update);
        coreLabels.push({
          sprite: label,
          base: label.position.clone(),
          priority: LABEL_PRIORITY[city.name] ?? 75,
          target: 0,
          offX: 0,
          offY: 0,
          timeSprite: timeLbl.sprite,
          timeTarget: 0,
          timeVis: 0,
        });
      }
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.copy(pos);
      hit.userData.country = city.country;
      earth.add(hit);
      nodeHitMeshes.push(hit);
      nodeVis.push({
        base: pos,
        mats: [coreMat, glowMat, ringMat],
        hit,
      });
    });

    // 金融中心标记（与核心六城重合的中心共用上面的国家节点，不重复画）：
    // 第一梯队更大更亮，第二梯队略小；标签由 animate 里的碰撞避让系统
    // 决定显隐（正面 + 不重叠才显示），背面随朝向淡出。
    interface CenterVis {
      def: CenterDef;
      base: THREE.Vector3;
      mats: THREE.Material[];
      /** 名称标签；无文字标签名单（香港）为 null——不生成、不入避让池 */
      label: THREE.Sprite | null;
      labelBase: THREE.Vector3;
      labelTarget: number;
      labelOffX: number;
      labelOffY: number;
      facing: number;
      /** 当地时间小标签：第一梯队常显、第二梯队仅不拥挤时显、第三梯队无 */
      timeSprite: THREE.Sprite | null;
      timeTarget: number;
      timeVis: number;
    }
    const centerVis: CenterVis[] = [];
    const centerHitMeshes: THREE.Mesh[] = [];
    const centerVecs = CENTERS.map((c) =>
      latLonToVec3(c.lat, c.lon, R * 1.01),
    );
    CENTERS.forEach((c, i) => {
      if (c.coreCountry) return;
      const pos = centerVecs[i]!;
      const color = centerColor(c);
      const coreMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
      });
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(
          c.tier === 1 ? 0.0105 : c.tier === 2 ? 0.0075 : 0.006,
          10,
          10,
        ),
        coreMat,
      );
      core.position.copy(pos);
      earth.add(core);
      const glowMat = new THREE.SpriteMaterial({
        map: makeGlowTexture(color, "rgba(0,0,0,0)"),
        color: new THREE.Color(color),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.Sprite(glowMat);
      const gs = c.tier === 1 ? 0.17 : c.tier === 2 ? 0.11 : 0.085;
      glow.scale.set(gs, gs, 1);
      glow.position.copy(pos);
      earth.add(glow);
      const noText = NO_TEXT_LABEL_CENTER_IDS.has(c.id);
      const label = noText
        ? null
        : makeLabelSprite(
            c.name,
            color,
            c.tier === 1 ? 0.27 : c.tier === 2 ? 0.215 : 0.19,
            c.tier === 1 ? 32 : c.tier === 2 ? 30 : 28,
            c.tier === 1,
          );
      if (label) {
        label.position.copy(pos.clone().multiplyScalar(1.09));
        label.position.y += 0.04;
        (label.material as THREE.SpriteMaterial).opacity = 0;
        label.renderOrder = 8;
        earth.add(label);
      }
      let timeSprite: THREE.Sprite | null = null;
      if (!noText && c.tier !== 3) {
        const timeLbl = makeTimeSprite(color, c.tz);
        timeSprite = timeLbl.sprite;
        earth.add(timeSprite);
        timeUpdaters.push(timeLbl.update);
      }
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.copy(pos);
      hit.userData.centerId = c.id;
      earth.add(hit);
      centerHitMeshes.push(hit);
      centerVis.push({
        def: c,
        base: pos,
        mats: [coreMat, glowMat],
        label,
        labelBase: label
          ? label.position.clone()
          : pos.clone().multiplyScalar(1.09),
        labelTarget: 0,
        labelOffX: 0,
        labelOffY: 0,
        facing: 0,
        timeSprite,
        timeTarget: 0,
        timeVis: 0,
      });
    });

    // 弧线网络（2026-11-11 拓扑稀疏化，用户：「线多了很多」）：
    // 第一梯队不再两两全连（旧 28 条）——每城只连最近的 3 个一线
    // 同伴（弦距 kNN，去重后 13 条），再显式补 2 条洲际主干保骨架
    // 连通（伦敦–新加坡欧亚干线、旧金山–上海跨太平洋第二通道），
    // 一线骨架共 15 条；其余梯队仍只连最近的第一梯队枢纽（19 条），
    // 另补上海–大阪、北京–上海（后者与枢纽规则重合、被去重吃掉）。
    // 全网 48 → 35 条。每条通道按两端梯队组合算连续强度
    // （arcStrength，只管粗细/亮度/弧度/粒子密度），颜色按两端城市
    // 的地域走渐变（arcRegionColors：A 地域色 → B 地域色，同地域
    // 纯色；地域定性色板见 nationColors.ts）。
    // 线身双层 —— 底层宽管作光晕、顶层细管作芯线（芯线顶点色在两端
    // 压暗，形成渐变透明的虚实感，逐帧再叠一层呼吸）；隆起弧度随
    // 强度走（顶级最高、尾部最低）。顶级通道（强度 ≥ 0.85，即
    // 一线↔一线）再加一层柔光鞘（已收窄至光晕管 1.6 倍），让主干
    // 在盘面上压得住场。
    // 流动由统一的流动点云驱动：每条脉冲 = 1 个亮头 + 8 个拖尾点
    // （彗星尾），全部弧线共用一个 Points。
    // 激光轮（2026-11-11）：芯线换激光着色器（双扫光带巡游 + 随机
    // 闪烁爆闪，见建网处 matCore）；脉冲按序号交替方向双向对流、
    // 亮头带频闪爆亮（见逐帧流动段）；再加一层沿弧静态火花点在
    // GPU 内尖峰闪烁（见 sparkPoints）。三层同属一个「信息在闪、
    // 在交换」的语言，光缆层不参与（它已有自己的硬边流光）。
    interface FlowArc {
      curve: THREE.QuadraticBezierCurve3;
      matHalo: THREE.MeshBasicMaterial;
      matCore: THREE.ShaderMaterial;
      matGlow: THREE.MeshBasicMaterial | null;
      haloMesh: THREE.Mesh;
      coreMesh: THREE.Mesh;
      glowMesh: THREE.Mesh | null;
      /** 连续强度 0..1（arcStrength），及由它在建网时算好的逐帧参数 */
      strength: number;
      bright: number;
      speedF: number;
      headBase: number;
      headSize: number;
      speed: number;
      pulses: number;
      phase: number;
      mid: THREE.Vector3;
      src: THREE.Vector3;
      dest: THREE.Vector3;
      fade: number;
      colA: THREE.Color;
      colB: THREE.Color;
    }
    // 激光着色器共享时钟：芯线扫光带与沿弧火花共用一个 uniform 对象，
    // 逐帧只写一次（动画循环里 laserTime.value = t），零额外 CPU 曲线活
    const laserTime = { value: 0 };
    const flowArcs: FlowArc[] = [];
    {
      const t1 = CENTERS.map((c, i) => (c.tier === 1 ? i : -1)).filter(
        (i) => i >= 0,
      );
      const seen = new Set<string>();
      const defs: Array<{ a: number; b: number }> = [];
      const addArc = (a: number, b: number) => {
        if (a < 0 || b < 0 || a === b) return;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) return;
        seen.add(key);
        defs.push({ a, b });
      };
      const idxOf = (id: string) => CENTERS.findIndex((c) => c.id === id);
      // 一线骨架：kNN-3（每城连最近的 3 个一线同伴，addArc 去重）
      for (const i of t1) {
        const near = t1
          .filter((j) => j !== i)
          .sort(
            (x, y) =>
              centerVecs[i]!.distanceTo(centerVecs[x]!) -
              centerVecs[i]!.distanceTo(centerVecs[y]!),
          )
          .slice(0, 3);
        for (const j of near) addArc(i, j);
      }
      // 洲际主干：kNN 连不上的跨洲通道显式补齐，保全球骨架连通
      addArc(idxOf("ldn"), idxOf("sin")); // 伦敦–新加坡（欧亚）
      addArc(idxOf("sfo"), idxOf("sha")); // 旧金山–上海（跨太平洋）
      CENTERS.forEach((c, i) => {
        if (c.tier === 1) return;
        let best = -1;
        let bd = Infinity;
        for (const h of t1) {
          const d = centerVecs[i]!.distanceTo(centerVecs[h]!);
          if (d < bd) {
            bd = d;
            best = h;
          }
        }
        if (best >= 0) addArc(i, best);
      });
      addArc(idxOf("sha"), idxOf("osa"));
      addArc(idxOf("pek"), idxOf("sha"));

      for (const d of defs) {
        const p0 = centerVecs[d.a]!;
        const p1 = centerVecs[d.b]!;
        const t = arcStrength(CENTERS[d.a]!, CENTERS[d.b]!);
        const dist = p0.distanceTo(p1);
        // 隆起弧度随强度走：顶级 0.58 → 尾部 0.22（× 弦长），
        // 主干航线般高高抬起，弱通道贴地掠过
        const lift = 0.22 + 0.36 * t;
        const mid = p0
          .clone()
          .add(p1)
          .multiplyScalar(0.5)
          .normalize()
          .multiplyScalar(R + dist * lift);
        const curve = new THREE.QuadraticBezierCurve3(p0, mid, p1);
        const [ca, cb] = arcRegionColors(CENTERS[d.a]!, CENTERS[d.b]!);
        // 双层管身：halo 宽而淡（光晕），core 细而亮（芯线）。
        // 顶点色沿程在 ca→cb 间渐变；core 额外把两端压暗（加色混合下
        // 暗 = 更透明），线在城市端点处自然收细消失，不硬切。
        const makeTube = (
          radius: number,
          endFade: number,
        ): { geo: THREE.BufferGeometry } => {
          const geo = new THREE.TubeGeometry(curve, 48, radius, 5, false);
          const posAttr = geo.getAttribute("position");
          const colors = new Float32Array(posAttr.count * 3);
          const tmpC = new THREE.Color();
          for (let vi = 0; vi < posAttr.count; vi++) {
            const u = Math.min(1, Math.floor(vi / 6) / 48);
            tmpC.lerpColors(ca, cb, u);
            const dim =
              1 - endFade * (1 - Math.sin(Math.min(1, Math.max(0, u)) * Math.PI));
            colors[vi * 3] = tmpC.r * dim;
            colors[vi * 3 + 1] = tmpC.g * dim;
            colors[vi * 3 + 2] = tmpC.b * dim;
          }
          geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          return { geo };
        };
        // 管径按强度作指数插值：芯线顶级 0.0060 ↔ 尾部 0.0016
        // （约 3.7 倍），光晕管顶级 0.0155 ↔ 尾部 0.0046（约 3.4 倍；
        // 2026-11-11 收锐：整体 ×0.79，亮度收回芯线、轮廓变利落）；
        // 中间强度（一线↔二线）落在几何中段，不是硬切两档
        const haloR = 0.0046 * Math.pow(3.36, t);
        const coreR = 0.0016 * Math.pow(3.75, t);
        const matHalo = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.14,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(makeTube(haloR, 0.25).geo, matHalo);
        halo.renderOrder = 5;
        earth.add(halo);
        // 芯线 = 激光着色器（2026-11-11，用户：「激光一闪一闪」）：
        // 基础亮度由逐帧写入的 uOpacity 决定（与旧 opacity 同账：背面
        // 淡出 × 强度 × 波动 × 呼吸），着色器在其上叠两样东西——
        // ① 扫光带：两道锐利的高斯亮带沿弧长（TubeGeometry 的 uv.x）
        // 以不同速度巡游，过处颜色提亮并向白热混合，像激光束扫过；
        // ② 随机闪烁：以 1/6 秒为桶做哈希随机，约两成桶在桶首爆出一
        // 次快速衰减的闪光，整线一闪——不规则、不可预测，才像信号
        // 在打闪。全部在 GPU 上算，逐帧 CPU 只写共享时钟与每弧一个
        // opacity uniform；几何、顶点色（地域渐变 + 两端压暗）不变。
        const matCore = new THREE.ShaderMaterial({
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          uniforms: {
            uTime: laserTime,
            uOpacity: { value: 0.55 },
            uPhase: { value: rand() },
            uSpeed: { value: 0.16 + 0.22 * t },
          },
          vertexShader: [
            "varying vec3 vC;",
            "varying vec2 vUv;",
            "void main() {",
            "  vC = color;",
            "  vUv = uv;",
            "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
            "}",
          ].join("\n"),
          fragmentShader: [
            "uniform float uTime;",
            "uniform float uOpacity;",
            "uniform float uPhase;",
            "uniform float uSpeed;",
            "varying vec3 vC;",
            "varying vec2 vUv;",
            "void main() {",
            "  float u = vUv.x;",
            // 扫光带：圆环距离（带首尾相接、巡游无跳变），主带锐、
            // 副带宽半速反向，两道光在弧上交错巡游
            "  float c1 = fract(uTime * uSpeed + uPhase);",
            "  float d1 = abs(u - c1);",
            "  d1 = min(d1, 1.0 - d1);",
            "  float band1 = exp(-d1 * d1 * 260.0);",
            "  float c2 = fract(-uTime * uSpeed * 0.55 + uPhase * 1.7);",
            "  float d2 = abs(u - c2);",
            "  d2 = min(d2, 1.0 - d2);",
            "  float band2 = exp(-d2 * d2 * 90.0) * 0.6;",
            // 随机闪烁：桶哈希决定哪一桶闪，桶内指数衰减成尖峰
            "  float bt = uTime * 6.0 + uPhase * 37.0;",
            "  float bucket = floor(bt);",
            "  float rnd = fract(sin(bucket * 12.9898 + uPhase * 78.233) * 43758.5453);",
            "  float strobe = smoothstep(0.8, 0.97, rnd) * exp(-fract(bt) * 5.0);",
            "  float boost = 1.0 + band1 * 1.9 + band2 * 0.9 + strobe * 1.1;",
            "  vec3 col = mix(vC, vec3(1.0), clamp(band1 * 0.55 + strobe * 0.3, 0.0, 0.8));",
            "  float alpha = uOpacity * (0.82 + band1 * 0.55 + band2 * 0.3 + strobe * 0.45);",
            "  gl_FragColor = vec4(col * boost, clamp(alpha, 0.0, 1.0));",
            "}",
          ].join("\n"),
        });
        const core = new THREE.Mesh(makeTube(coreR, 0.62).geo, matCore);
        core.renderOrder = 5;
        earth.add(core);
        // 顶级通道专属的柔光鞘：半径约光晕管 1.6 倍（2026-11-11
        // 由 2.3 倍收窄——旧鞘是弧线发糊与「线像画了两遍」的主因）、
        // 极淡，只给一线↔一线的主干，让它在盘面上有「压场」的体量感
        let matGlow: THREE.MeshBasicMaterial | null = null;
        let glowMesh: THREE.Mesh | null = null;
        if (t >= 0.85) {
          matGlow = new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          glowMesh = new THREE.Mesh(makeTube(haloR * 1.6, 0.15).geo, matGlow);
          glowMesh.renderOrder = 4;
          earth.add(glowMesh);
        }
        // 粒子密度随强度：顶级 3 颗错峰 ↔ 尾部 1 颗（3 倍）；
        // 粗指针（移动端）顶级减到 2 颗——总量与旧版持平，
        // 强弱差靠权重分配拉开，不靠堆总量
        const pulsesRaw = Math.max(1, Math.round(1 + 2 * t));
        flowArcs.push({
          curve,
          matHalo,
          matCore,
          matGlow,
          haloMesh: halo,
          coreMesh: core,
          glowMesh,
          strength: t,
          // 亮度系数：顶级 1.00 ↔ 尾部 0.30（逐帧乘进双层透明度）
          bright: 0.3 + 0.7 * t,
          // 流速系数：顶级 1.15 ↔ 尾部 0.55
          speedF: 0.55 + 0.6 * t,
          // 粒子头亮度：顶级 1.00 ↔ 尾部 0.42
          headBase: 0.42 + 0.58 * t,
          // 粒子头尺寸：顶级 0.042 ↔ 尾部 0.019（约 2.2 倍）
          headSize: 0.019 * Math.pow(2.2, t),
          speed: 0.055 + rand() * 0.06,
          pulses: isCoarse && pulsesRaw === 3 ? 2 : pulsesRaw,
          phase: rand(),
          mid: curve.getPointAt(0.5),
          src: p0.clone(),
          dest: p1.clone(),
          fade: 1,
          colA: ca,
          colB: cb,
        });
      }
    }

    // 流动点云（亮头 + 彗星拖尾），逐帧在 animate 里沿曲线更新位置/颜色/透明度
    const TRAILS = 8;
    const flowCount =
      flowArcs.reduce((s, a) => s + a.pulses, 0) * (TRAILS + 1);
    const flowPos = new Float32Array(flowCount * 3);
    const flowCol = new Float32Array(flowCount * 3);
    const flowAlpha = new Float32Array(flowCount);
    const flowSize = new Float32Array(flowCount);
    const flowGeo = new THREE.BufferGeometry();
    flowGeo.setAttribute("position", new THREE.BufferAttribute(flowPos, 3));
    flowGeo.setAttribute("aColor", new THREE.BufferAttribute(flowCol, 3));
    flowGeo.setAttribute("aAlpha", new THREE.BufferAttribute(flowAlpha, 1));
    flowGeo.setAttribute("aSize", new THREE.BufferAttribute(flowSize, 1));
    const flowMat = new THREE.ShaderMaterial({
      uniforms: { uScale: scaleUniform },
      vertexShader: [
        "attribute vec3 aColor;",
        "attribute float aAlpha;",
        "attribute float aSize;",
        "uniform float uScale;",
        "varying vec3 vC;",
        "varying float vA;",
        "void main() {",
        "  vC = aColor;",
        "  vA = aAlpha;",
        "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
        "  gl_PointSize = aSize * uScale / max(0.1, -mv.z);",
        "  gl_Position = projectionMatrix * mv;",
        "}",
      ].join("\n"),
      fragmentShader: [
        "varying vec3 vC;",
        "varying float vA;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float r2 = dot(uv, uv) * 4.0;",
        "  float fall = exp(-r2 * 3.0);",
        "  vec3 col = mix(vC, vec3(1.0), fall * 0.5);",
        "  gl_FragColor = vec4(col, 1.0) * fall * vA;",
        "}",
      ].join("\n"),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const flowPoints = new THREE.Points(flowGeo, flowMat);
    flowPoints.renderOrder = 6;
    flowPoints.frustumCulled = false;
    earth.add(flowPoints);

    // 沿弧火花层（2026-11-11，与芯线激光同轮）：每条弧上静态采样
    // 若干火花点，位置/颜色建网时一次算定（颜色取该点处的地域渐变），
    // 闪烁完全在顶点着色器里按各自相位/速度算——pow 10 次方把正弦
    // 压成尖峰，绝大多数时间是暗的、偶尔「啪」地闪一下白热光点，
    // 像数据在线路上打出的火花。逐帧 CPU 零更新，只与芯线共用
    // laserTime 时钟；总量 35 弧 × 8 = 280 点（移动端 5/弧 = 175），
    // 一次绘制。整体不透明度由逐帧 uOpacity 跟 globeFade 走。
    const SPARKS_PER_ARC = isCoarse ? 5 : 8;
    const sparkCount = flowArcs.length * SPARKS_PER_ARC;
    const sparkPos = new Float32Array(sparkCount * 3);
    const sparkCol = new Float32Array(sparkCount * 3);
    const sparkPhase = new Float32Array(sparkCount);
    const sparkSpeed = new Float32Array(sparkCount);
    const sparkSize = new Float32Array(sparkCount);
    {
      const tmpC = new THREE.Color();
      let si = 0;
      for (const a of flowArcs) {
        for (let s = 0; s < SPARKS_PER_ARC; s++) {
          const u = 0.06 + rand() * 0.88;
          const pt = a.curve.getPointAt(u);
          sparkPos[si * 3] = pt.x;
          sparkPos[si * 3 + 1] = pt.y;
          sparkPos[si * 3 + 2] = pt.z;
          tmpC.lerpColors(a.colA, a.colB, u);
          sparkCol[si * 3] = tmpC.r;
          sparkCol[si * 3 + 1] = tmpC.g;
          sparkCol[si * 3 + 2] = tmpC.b;
          sparkPhase[si] = rand();
          sparkSpeed[si] = 1.2 + rand() * 2.6;
          sparkSize[si] = (0.02 + rand() * 0.02) * (0.7 + 0.6 * a.strength);
          si++;
        }
      }
    }
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
    sparkGeo.setAttribute("aColor", new THREE.BufferAttribute(sparkCol, 3));
    sparkGeo.setAttribute("aPhase", new THREE.BufferAttribute(sparkPhase, 1));
    sparkGeo.setAttribute("aSpeed", new THREE.BufferAttribute(sparkSpeed, 1));
    sparkGeo.setAttribute("aSize", new THREE.BufferAttribute(sparkSize, 1));
    const sparkMat = new THREE.ShaderMaterial({
      uniforms: {
        uScale: scaleUniform,
        uTime: laserTime,
        uOpacity: { value: 1 },
      },
      vertexShader: [
        "attribute vec3 aColor;",
        "attribute float aPhase;",
        "attribute float aSpeed;",
        "attribute float aSize;",
        "uniform float uScale;",
        "uniform float uTime;",
        "varying vec3 vC;",
        "varying float vA;",
        "void main() {",
        "  vC = aColor;",
        // 尖峰闪烁：pow 把正弦压窄，闪的占空比小、峰高近满
        "  float tw = pow(0.5 + 0.5 * sin(uTime * aSpeed + aPhase * 6.28318), 10.0);",
        "  vA = tw;",
        "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
        "  gl_PointSize = aSize * (0.55 + 1.1 * tw) * uScale / max(0.1, -mv.z);",
        "  gl_Position = projectionMatrix * mv;",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform float uOpacity;",
        "varying vec3 vC;",
        "varying float vA;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float r2 = dot(uv, uv) * 4.0;",
        "  float fall = exp(-r2 * 5.0);",
        "  vec3 col = mix(vC, vec3(1.0), fall * 0.65);",
        "  gl_FragColor = vec4(col, 1.0) * fall * vA * uOpacity;",
        "}",
      ].join("\n"),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
    sparkPoints.renderOrder = 6;
    sparkPoints.frustumCulled = false;
    earth.add(sparkPoints);

    // 每条脉冲上一帧的相位（到达检测：相位回绕 = 抵达目标城市）
    const pulsePrev = new Float32Array(
      flowArcs.reduce((s, a) => s + a.pulses, 0),
    ).fill(-1);

    // 到达涟漪池：粒子抵达目标城市时在该节点扩散一圈光环（与选中涟漪同语言）
    const ripplePool: Array<{
      mat: THREE.SpriteMaterial;
      sprite: THREE.Sprite;
      start: number;
    }> = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.SpriteMaterial({
        map: ringTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const s = new THREE.Sprite(m);
      s.scale.set(0.07, 0.07, 1);
      s.renderOrder = 7;
      earth.add(s);
      ripplePool.push({ mat: m, sprite: s, start: -10 });
    }
    let rippleIdx = 0;
    const fireRipple = (
      pos: THREE.Vector3,
      color: THREE.Color,
      tNow: number,
    ) => {
      const r = ripplePool[rippleIdx++ % ripplePool.length]!;
      r.sprite.position.copy(pos).multiplyScalar(1.02);
      r.mat.color.copy(color);
      r.start = tNow;
    };

    // 交互：拖拽旋转 + 点按节点
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let dragging = false;
    let moved = 0;
    // 全程最大偏移：手势期间指针离按下点的最大距离（每次 move 更
    // 新）。点按判定用它而非净位移——拖动是弧线行程，绕出去又回
    // 到按下点附近松手时净位移≈0 却已是实打实的拖动（用户实报
    // 「一拖就误触点进某颗星」正是此洞）；最大偏移不累积抖动，
    // 真轻点的指尖微颤始终在小圆内，灵敏度不受影响。
    let maxDisp = 0;
    let lastX = 0;
    let lastY = 0;
    let velY = 0;
    // userHold 只在「正在拖拽 + 松手后的惯性滑行」期间为真，用来压住自转
    // 与选中聚焦；松手/手势取消时必须释放，否则自转会被永久锁死、
    // 「暂停/恢复自转」开关再也进不了动画循环（历史 bug）。
    let userHold = false;
    let downId = -1;
    // 按下点（视口坐标 + 时刻）：最大偏移的原点、cancel 补发用它
    let downX = 0;
    let downY = 0;
    let downT = 0;
    // 手势方向锁定：第一个明确方向定终身 —— 竖向归页面滚动，横向归地球旋转
    let gesture: "none" | "h" | "v" = "none";
    let totalDx = 0;
    let totalDy = 0;
    // 拖拽/聚焦偏移（叠加在展示自转之上，不写进自转角本身）：
    // 拖动改这两个量，松手后在 animate 里缓动回 0（回到自转基线）；
    // 选中国家时缓动到聚焦偏移。太阳永远按真实姿态算，不随偏移走。
    let dragYaw = 0;
    let dragPitch = 0;
    // 双指手势（太阳系模式缩放/平移）：在场触摸点登记表 + 捏合基准
    const touchPts = new Map<number, { x: number; y: number }>();
    let pinching = false;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let pinchStartMid = { x: 0, y: 0 };
    let pinchStartPan = { x: 0, y: 0 };

    /** 模式切换过渡进行中（进度未落位）：禁止一切交互，防误触穿透 */
    const transitionBusy = () =>
      Math.abs((stateRef.current.solarSystem ? 1 : 0) - trans) > 0.02;

    /**
     * 天体世界位置 + 点按包围半径（与聚焦取景同一套口径）：给已聚焦
     * 天体的第二下点按做屏幕圆盘兜底判定用（见 handleTap）。
     */
    const bodyWorldInfo = (
      id: string,
    ): { pos: THREE.Vector3; radius: number } | null => {
      const pos = new THREE.Vector3();
      if (id === "sun") {
        sunMesh.getWorldPosition(pos);
        return { pos, radius: SUN_R * 1.55 };
      }
      if (id === "moon") {
        if (!moonMesh) return null;
        moonMesh.getWorldPosition(pos);
        return { pos, radius: Math.max(MOON_R * 3.4, 0.15) };
      }
      if (id === "earth") {
        earth.getWorldPosition(pos);
        return { pos, radius: 0.24 };
      }
      const pv = planetVis.find((p) => p.def.id === id);
      if (!pv?.mesh) return null;
      pv.mesh.getWorldPosition(pos);
      return {
        pos,
        radius:
          Math.max(pv.def.size * planetScale * 2.4, 0.17) *
          (id === "saturn" ? 1.4 : 1),
      };
    };

    const onDown = (e: PointerEvent) => {
      if (transitionBusy()) return;
      if (e.pointerType === "touch") {
        touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touchPts.size === 2) {
          // 第二指落下：进入捏合，取消单指拖拽/点按语义
          const [p1, p2] = [...touchPts.values()] as [
            { x: number; y: number },
            { x: number; y: number },
          ];
          pinching = true;
          dragging = false;
          userHold = true;
          velY = 0;
          pinchStartDist = Math.max(
            24,
            Math.hypot(p1.x - p2.x, p1.y - p2.y),
          );
          pinchStartZoom = solarZoom;
          pinchStartMid = {
            x: (p1.x + p2.x) / 2,
            y: (p1.y + p2.y) / 2,
          };
          pinchStartPan = { x: solarPan.x, y: solarPan.y };
          return;
        }
      }
      dragging = true;
      moved = 0;
      maxDisp = 0;
      velY = 0; // 清掉上一次拖拽的残留甩速，避免之后被误当惯性重放
      totalDx = 0;
      totalDy = 0;
      gesture = "none";
      lastX = e.clientX;
      lastY = e.clientY;
      downId = e.pointerId;
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
      // 触摸不做指针捕获：捕获会妨碍浏览器按 touch-action: pan-y 接管竖滑。
      // 鼠标/触控笔没有页面平移手势，照常捕获以保证拖出画布也能转。
      if (e.pointerType !== "touch") {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" && touchPts.has(e.pointerId)) {
        touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinching && touchPts.size === 2) {
          // 捏合：指距比 → 缩放；中点位移 → 平移（仅太阳系模式有意义，
          // 地球模式下同样吃掉手势避免误触旋转/点按）
          const [p1, p2] = [...touchPts.values()] as [
            { x: number; y: number },
            { x: number; y: number },
          ];
          const dist = Math.max(24, Math.hypot(p1.x - p2.x, p1.y - p2.y));
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          if (trans > 0.5) {
            solarZoom = THREE.MathUtils.clamp(
              pinchStartZoom * (dist / pinchStartDist),
              0.55,
              3,
            );
            const hPx = mount.clientHeight || 1;
            const wpp =
              (2 * currentSolarZ * Math.tan(THREE.MathUtils.degToRad(21))) /
              hPx;
            solarPan.x = THREE.MathUtils.clamp(
              pinchStartPan.x + (mid.x - pinchStartMid.x) * wpp,
              -3.2,
              3.2,
            );
            solarPan.y = THREE.MathUtils.clamp(
              pinchStartPan.y - (mid.y - pinchStartMid.y) * wpp,
              -2.4,
              2.4,
            );
          }
          return;
        }
      }
      if (!dragging || e.pointerId !== downId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      totalDx += dx;
      totalDy += dy;
      lastX = e.clientX;
      lastY = e.clientY;
      maxDisp = Math.max(
        maxDisp,
        Math.hypot(e.clientX - downX, e.clientY - downY),
      );
      if (e.pointerType === "touch") {
        if (gesture === "none" && moved > 8) {
          gesture =
            Math.abs(totalDy) > Math.abs(totalDx) * 1.15 ? "v" : "h";
        }
        // 竖滑：什么都不做，等浏览器平移页面并以 pointercancel 收尾
        if (gesture !== "h") return;
        if (moved > 4) {
          userHold = true;
          // 太阳系模式下横拖旋转的是太阳系（聚焦态改绕天体环视）；
          // 地球模式改拖拽偏移（姿态在 animate 里合成，偏移不污染自转角）
          if (trans > 0.5) {
            if (stateRef.current.focusedBody) {
              focusYaw += dx * 0.005;
              focusPitch = THREE.MathUtils.clamp(
                focusPitch - dy * 0.003,
                -0.2,
                1.15,
              );
            } else {
              solarGroup.rotation.y += dx * 0.005;
            }
          } else {
            dragYaw += dx * 0.005;
          }
          velY = dx * 0.005;
        }
        return;
      }
      if (moved > 4) {
        userHold = true;
        if (trans > 0.5) {
          if (stateRef.current.focusedBody) {
            focusYaw += dx * 0.005;
            focusPitch = THREE.MathUtils.clamp(
              focusPitch - dy * 0.003,
              -0.2,
              1.15,
            );
          } else {
            solarGroup.rotation.y += dx * 0.005;
          }
        } else {
          dragYaw += dx * 0.005;
          dragPitch = THREE.MathUtils.clamp(
            dragPitch + dy * 0.003,
            -0.65,
            0.65,
          );
        }
        velY = dx * 0.005;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (transitionBusy()) {
        // 过渡中抬手：只复位手势状态，不触发任何点按语义
        if (e.pointerType === "touch") touchPts.delete(e.pointerId);
        dragging = false;
        userHold = false;
        pinching = false;
        return;
      }
      if (e.pointerType === "touch") touchPts.delete(e.pointerId);
      if (pinching) {
        // 捏合收尾：不触发点按，释放保持锁（同拖拽松手规则）
        if (touchPts.size < 2) {
          pinching = false;
          userHold = false;
        }
        return;
      }
      if (e.pointerId !== downId) return;
      dragging = false;
      // 松手即释放 userHold：惯性（velY）在 animate 里衰减，衰减完后
      // 自转按 autoRotate 开关恢复；不释放的话开关永远失效。
      userHold = false;
      // 点按判定（真机实测修复，2026-11-10）：旧口径 moved<=6 用的是
      // pointermove 的累计曼哈顿抖动——真机手指点按会产生多次带抖
      // 动的 move 事件，累计轻松破 6，第二下点按被吞成「拖动未遂」
      // （桌面鼠标几乎不产生 move 事件，所以探针/鼠标验不出来）。
      // 当时改用按下点→抬手点的净位移；2026-11-13 用户实报「一拖
      // 就误触，点进某颗星了」——净位移有个反向的洞：拖动是弧线
      // 行程，绕出去再回到按下点附近松手，净位移≈0 却已转了大半
      // 圈，抬手点下又正好有颗被拖过来的行星，于是误判点按聚焦。
      // 现行口径 = 全程最大偏移 maxDisp（每次 move 更新）：只要手
      // 势中途离开过按下点 16px（触摸）/ 10px（鼠标）以上，无论
      // 终点落回哪里都不是点按；真轻点的微颤始终在阈值圆内、又
      // 不像累计路程那样被抖动吃掉，灵敏度与 2026-11-10 口径一
      // 致。点按语义本体在 handleTap，pointercancel 吞掉的点按也
      // 从那里补发（补发门同样改用 maxDisp，见 onCancel）。
      if (maxDisp <= (e.pointerType === "touch" ? 16 : 10)) {
        handleTap(e.clientX, e.clientY);
      }
    };
    /**
     * 点按语义本体（入参 = 视口 clientX/Y）：太阳系天体聚焦/送主页、
     * 主页星球入太阳系、金融节点选择、点球体入太阳系。调用方
     * （onUp 的最大偏移判定 / onCancel 的被吞补发）已确认这是点按。
     */
    const handleTap = (clientX: number, clientY: number) => {
      {
        const rect = el.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        // 太阳系模式：点中任意天体（太阳/八大行星/月球的本体、放大命中
        // 圈或标签）→ 聚焦飞近观赏；点空处不触发任何事（不误触返回，
        // 返回走 App 的「返回太阳系」钮与点星球链路）。行星地球的本体
        // 是监控球 sphere，单独并入判定。
        if (trans > 0.5) {
          raycaster.camera = camera; // 精灵（标签）射线检测需要
          // 已聚焦天体优先（真机修复之二）：聚焦后相机已飞近，第二下
          // 点按先测这颗天体自己的命中体（本体+命中圈+标签，递归含
          // 子命中圈）；仍落空时再用屏幕投影圆盘兜底——点落在它画面
          // 圆盘（含 52px 最小触摸容差）内就算点中它。别的天体的标
          // 签/命中圈不许抢走这一下，落空也不许把「送主页」吞掉。
          // 点在圆盘之外则落到下方通用判定（点别的天体直接切换）。
          const fid = stateRef.current.focusedBody;
          if (fid) {
            const objs = solarHitByBody.get(fid) ?? [];
            if (
              objs.length &&
              raycaster.intersectObjects(objs, true).length
            ) {
              stateRef.current.onBodyFocus?.(fid);
              return;
            }
            const info = bodyWorldInfo(fid);
            if (info) {
              const v = info.pos.clone().project(camera);
              if (v.z < 1) {
                const sx = ((v.x + 1) / 2) * rect.width;
                const sy = ((1 - v.y) / 2) * rect.height;
                const distW = camera.position.distanceTo(info.pos);
                const rPx =
                  (info.radius /
                    (distW *
                      Math.tan(THREE.MathUtils.degToRad(21)))) *
                  (rect.height / 2);
                const tapPx = Math.hypot(
                  clientX - rect.left - sx,
                  clientY - rect.top - sy,
                );
                if (tapPx <= Math.max(52, rPx * 1.2)) {
                  stateRef.current.onBodyFocus?.(fid);
                  return;
                }
              }
            }
          }
          const hits = raycaster.intersectObjects(solarHitList, false);
          const hit = hits.find(
            (h) => typeof h.object.userData.bodyId === "string",
          );
          if (hit) {
            stateRef.current.onBodyFocus?.(
              hit.object.userData.bodyId as string,
            );
            return;
          }
          if (raycaster.intersectObject(sphere, false).length) {
            stateRef.current.onBodyFocus?.("earth");
          }
          return;
        }
        // 主页星球模式：地球节点图层不存在，只认星球本体——
        // 点中它与点地球一样进入太阳系，其余点按不触发节点选择
        if (homePlanetGroup.visible) {
          if (
            homePlanetMesh &&
            raycaster.intersectObject(homePlanetMesh, false).length
          ) {
            userHold = false;
            stateRef.current.onSolarSystemChange(true);
          }
          return;
        }
        const hits = raycaster.intersectObjects([
          ...centerHitMeshes,
          ...nodeHitMeshes,
        ]);
        // 只接受正面朝向的节点（背面节点会被射线穿透球体命中）
        const camDir = camera.position.clone().normalize();
        const hit = hits.find((h) => {
          const wp = h.object.position
            .clone()
            .applyMatrix4(earth.matrixWorld);
          return wp.normalize().dot(camDir) > 0.12;
        });
        const centerId = hit?.object.userData.centerId as string | undefined;
        if (centerId) {
          const def = CENTERS.find((c) => c.id === centerId);
          if (def) {
            userHold = false;
            stateRef.current.onCenterSelect({
              id: def.id,
              name: def.name,
              en: def.en,
              country: def.country,
              tier: def.tier,
            });
          }
          return;
        }
        const country = hit?.object.userData.country as
          | CountryCode
          | undefined;
        if (country) {
          userHold = false;
          stateRef.current.onSelect(country);
          return;
        }
        // 海底光缆点按（节点之后、点球入太阳系之前）：点中光带粗管
        // 或登陆点 → 回调 App 弹缆名+状态小片；只认正面半球的命中
        if (!hit && cableGroup.visible) {
          const chits = raycaster.intersectObjects(cableHitMeshes, false);
          const chit = chits.find(
            (h) => h.point.clone().normalize().dot(camDir) > 0.05,
          );
          if (chit) {
            userHold = false;
            stateRef.current.onCableSelect?.(
              chit.object.userData.cableId as string,
            );
            return;
          }
        }
        // 没点中任何节点、但点中了球体本身 → 进入太阳系模式
        // （点按判定已由 onUp 的最大偏移守卫把关，不会与拖动混淆；另有
        // 显式的「太阳系」按钮可走，两条路并存防误触）
        if (!hit && raycaster.intersectObject(sphere, false).length) {
          userHold = false;
          stateRef.current.onSolarSystemChange(true);
        }
      }
    };
    // 浏览器接管竖滑时会发 pointercancel：复位状态并释放 userHold
    // （不释放会把自转锁死）。但真机实测：稍带竖向微移的点按也会被
    // pan-y 提前接管成 cancel、连 pointerup 都没有——短时（<400ms）、
    // 全程最大偏移小（≤18px）且非竖向主导、又身处太阳系模式的一次
    // cancel，按点按补发 handleTap（最后已知位置）；真竖滑（位移
    // 大/竖向主导/主页模式）仍旧只复位，绝不误触发。位移判别与
    // onUp 同口径用 maxDisp（2026-11-13）：旧版用最后已知位置的净
    // 位移，弧线拖动绕回起点附近被 cancel 时同样会误补发。
    const onCancel = (e: PointerEvent) => {
      if (e.pointerType === "touch") touchPts.delete(e.pointerId);
      if (pinching) {
        if (touchPts.size < 2) {
          pinching = false;
          userHold = false;
        }
        return;
      }
      if (e.pointerId !== downId) return;
      dragging = false;
      userHold = false;
      if (
        e.pointerType === "touch" &&
        trans > 0.5 &&
        performance.now() - downT < 400 &&
        maxDisp <= 18 &&
        Math.abs(totalDy) <= Math.abs(totalDx) * 1.2 + 6
      ) {
        handleTap(lastX, lastY);
      }
    };
    // 滚轮缩放（太阳系模式，桌面补充；移动端走双指捏合）
    const onWheel = (e: WheelEvent) => {
      if (trans <= 0.5) return;
      e.preventDefault();
      solarZoom = THREE.MathUtils.clamp(
        solarZoom * Math.exp(-e.deltaY * 0.0012),
        0.55,
        3,
      );
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("wheel", onWheel, { passive: false });

    let baseZ = 3.1;
    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      // 星幕覆盖画布同步尺寸：CSS 尺寸与 WebGL 画布同，备援分
      // 辨率走星幕自有像素比 curtainPr（设备原生、封顶 3，见
      // curtainPr 处注——不再陪绑渲染器的封顶 2），绘制坐标用
      // CSS 像素
      curtainW = w;
      curtainH = h;
      curtainPr = Math.min(window.devicePixelRatio || 1, 3);
      curtainCanvas.width = Math.round(w * curtainPr);
      curtainCanvas.height = Math.round(h * curtainPr);
      el.style.width = "100%";
      el.style.height = "100%";
      camera.aspect = w / h;
      // 窄屏（手机竖屏）拉远相机，保证球体与节点标签不被视口边缘裁切
      baseZ = camera.aspect < 0.8 ? 4.15 : camera.aspect < 1.2 ? 3.55 : 3.1;
      camera.updateProjectionMatrix();
      // 太阳系镜头距离（取垂直/水平半视场角中较小者拟合）：
      // full 让海王星轨道（半径 6.15×SOLAR_S）完整入框；
      // near 拟合到木星轨道一带，移动端默认用它；移动端再放大一档：
      // 拟合半径 4.25→3.7（镜头更近，行星/轨道/标签整体更大），
      // 木星轨道（3.3×SOLAR_S）仍在框内，土星以外靠全览或捏合看
      solarNarrow = isCoarse || w < 1024;
      const halfTan = Math.tan(THREE.MathUtils.degToRad(21));
      const minTan = Math.min(halfTan, halfTan * camera.aspect);
      // 全览：海王星轨道（7.45×SOLAR_S）+ 行星与标签边距完整入框
      solarFullZ = THREE.MathUtils.clamp(
        ((7.95 * SOLAR_S) / minTan) * 1.05,
        8.5,
        30,
      );
      // 近览：拟合到火星轨道一带（3.25×SOLAR_S + 边距），水星→火星与
      // 绕地月球在小屏上真正可辨；木星以外靠全览或捏合/点选聚焦去看
      solarNearZ = THREE.MathUtils.clamp(
        (((solarNarrow ? 3.7 : 4.6) * SOLAR_S) / minTan) * 1.03,
        4.2,
        20,
      );
      // 点光大小换算：世界直径 → 设备像素（灯光层/流动点云共用）
      scaleUniform.value =
        (h * renderer.getPixelRatio()) /
        (2 * Math.tan(THREE.MathUtils.degToRad(21)));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const startMs = performance.now();
    let raf = 0;
    let frame = 0;
    let prevSel: CountryCode | null = null;
    let prevAutoRotate = stateRef.current.autoRotate;
    let flashStart = -10;
    const burstStart = new Map<number, number>();
    // 太阳系过渡进度（0=监控球 / 1=太阳系）与帧间计时
    let trans = 0;
    let prevT = 0;
    let globeCamZ = 3.1;
    // —— 天体聚焦（fly-to 观赏）状态 ——
    // 镜头位置/注视点用阻尼平滑向量趋近目标：从总览位飞过去是同一条
    // 平滑曲线（约 1.5–2 秒落位），落位后每帧继续趋近移动中的天体
    // 世界坐标 = 轻跟随其公转，天体自转/公转一刻不停。focusYaw/Pitch
    // 是观赏方位角（拖动环视改它），切换天体时复位到默认机位。
    let focusYaw = 0.55;
    let focusPitch = 0.38;
    let prevFocusId: string | null = null;
    const camSmooth = new THREE.Vector3();
    const lookSmooth = new THREE.Vector3();
    let camSmoothInit = false;
    /** 上一帧平滑相机是否在位渲染：平滑相机（重新）接管的那一帧必须
     * 从当前真实机位重新起步，绝不许拿跨模式残留的旧值顶班（见下方
     * 相机段的接管复位） */
    let focusCamWasActive = false;
    const focusTargetPos = new THREE.Vector3();
    const focusDesiredCam = new THREE.Vector3();
    /** smoothstep（JS 侧）：分层淡入淡出曲线 */
    const sstep = (x: number) => {
      const v = THREE.MathUtils.clamp(x, 0, 1);
      return v * v * (3 - 2 * v);
    };
    /** easeInOutCubic：模式切换的统一缓动（fly-to 案例同款） */
    const easeInOutCubic = (x: number) =>
      x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    /** 太阳系镜头距离的平滑值：近览/全览切换时缓动过去，不硬跳 */
    let smoothSolarZ = 11;
    let prevSolarView = stateRef.current.solarView;
    let lastSunCalc = -99;
    let sunDateCache = new Date();
    const tmpOrbitalSun = new THREE.Vector3();
    const ZERO_V = new THREE.Vector3(0, 0, 0);
    const tmpWorldV = new THREE.Vector3();
    /** 主页星球自有轨迹用：目标天体在太阳系里的世界位置/世界缩放 */
    const tmpGuestPos = new THREE.Vector3();
    const tmpGuestScale = new THREE.Vector3();
    const camUpV = new THREE.Vector3();
    const flowTmpColor = new THREE.Color();
    // —— 主页星球（太阳系里连点同一天体两下设入）：非地球时，主页中央的大球换成
    // 该天体本体——用它自己的程序纹理/颜色、自己的自转周期缓缓转；
    // 地球专属图层（地图球/点阵/灯光/弧线/标签/大气）整体隐藏，绝不
    // 把金融图层套到别的星球上。光照沿用场景既有光源（暖金主光的
    // 方向由真实太阳逻辑逐帧驱动），昼夜自然成立。尺寸 = 监控球
    // 同半径、同位置，替换不引起布局变化。选择只活在 App 的组件
    // 状态里（本次浏览），不写任何存储，重开即回地球。
    const HOME_R = R * 0.985;
    const homePlanetGroup = new THREE.Group();
    homePlanetGroup.visible = false;
    scene.add(homePlanetGroup);
    const homeSpinner = new THREE.Group();
    homePlanetGroup.add(homeSpinner);
    const homeFixed = new THREE.Group();
    homePlanetGroup.add(homeFixed);
    let homePlanetMesh: THREE.Mesh | null = null;
    let homeSunMat: THREE.ShaderMaterial | null = null;
    /** 星街彗星主页形态的专属光效逐帧驱动（构建时登记、换星时清空） */
    let homeSuiseiTick: ((t: number) => void) | null = null;
    let builtHomeId = "earth";
    let hpWasActive = false;
    /** 主页星球为客串时，太阳系地球图层的渐显进度（0=全隐 / 1=全显）：
     * 回太阳系飞行尾段（trans 0.82→1）由 0 斜坡到 1，逐帧驱动球体
     * 透明度与经纬网/城市标签的淡入——代替旧「97% 交接帧整组弹入」。
     * 地球为主页时恒 1（见 animate 内的逐帧计算） */
    let earthRevealNow = 1;
    /** 主页代理的环网格（土星/天王星）与口径对齐系数：代理环外缘
     * 因子 ÷ 太阳系本体环外缘因子（土星 2.58/2.25、天王星
     * 1.78/1.68）；飞行中环按此系数渐变，交接帧环外径与本体恒等 */
    let homeRingMesh: THREE.Mesh | null = null;
    let homeRingMatch = 1;
    /** 主页星球本次激活的起始时刻（入场相位锁的漂移基准） */
    let hpActiveSince = 0;
    /** 相位锁专用的无拖拽基线姿态暂存（倾角 + 展示自转 + 固定滚转，
     * 与 earth.rotation.set 的无偏移部分同式）：相位只准补偿自转
     * 基线、不准吃用户的拖拽偏移——见 animate 主页星球段的公式账 */
    const homeBaseEuler = new THREE.Euler();
    const homeBaseQuat = new THREE.Quaternion();
    const homeBaseQuatInv = new THREE.Quaternion();
    /** 激活帧待执行「上方安家」：等本帧相位锁算完 homeSpin 再落位 */
    let pendingUpperPlace = false;
    let homeSpin = 0;
    /** 各天体在主页的自转周期（秒/圈，负 = 逆行；展示速度，非真实值） */
    const HOME_SPIN_PERIOD: Record<string, number> = {
      sun: 300, mercury: 50, venus: -120, mars: 62, jupiter: 26,
      saturn: 29, uranus: -45, neptune: 48, moon: 90, suisei: 74,
    };
    /**
     * 客串天体在太阳系里的本体引用：网格对象 + 几何半径（未缩放）。
     * 主页星球的进出轨迹按它自己的世界位置/世界半径算（见 animate
     * 末尾的位置同步）——每颗星从它自己在太阳系里的位置进入主页、
     * 也返回它自己的位置，不再借道地球轨道位。
     */
    const guestSolarRef = (
      id: string,
    ): { obj: THREE.Object3D; geoR: number } | null => {
      if (id === "sun") return { obj: sunMesh, geoR: SUN_R };
      if (id === "moon")
        return moonMesh ? { obj: moonMesh, geoR: MOON_R } : null;
      const pv = planetVis.find((p) => p.def.id === id);
      return pv?.mesh
        ? { obj: pv.mesh, geoR: pv.def.size * planetScale }
        : null;
    };
    // —— 海底光缆层（主页地球，常驻显示、无开关）：与金融弧严格
    // 区分——弧是抬升的弧线 + 国别色，光缆是伏在海面（R×1.006）
    // 的深海青色光带：按 CABLE_ROUTES 的登陆点折线逐段大圆插值贴
    // 球面走（不直连、不抬升），同几何叠三层（宽晕 + 芯线 + 光流
    // shader，uv.x 沿缆长跑光点）。状态色与主页光缆板块同一份分
    // 档（cableStatusById）：fault 整条转红 + 警示脉动、watch 转
    // 琥珀、ok 深海青。登陆点小点 + 不可见粗管命中体（点按容差）。
    // 光流必须是肉眼可见的动态：相位由 CPU 按「缆长/秒」推进后取
    // 模 1 喂给 shader（uPhase）——旧实现把 uSpeed≈0.05 直接乘绝对
    // 时间再除以密度，亮点实际速度只有约 0.0017 缆长/秒（10 分钟
    // 才走完一条缆），视觉上等于静止；现速度 0.055–0.10 缆长/秒，
    // 固定一点约每 0.4 秒就有一道光段掠过，盯 2 秒必然确认在动；
    // uPhase 恒在 [0,1)，也避开了绝对时间在移动端 mediump 下的
    // fract 精度崩坏。移动端光流密度减半保帧率。
    interface CableVis {
      id: string;
      coreMat: THREE.MeshBasicMaterial;
      haloMat: THREE.MeshBasicMaterial;
      dotMat: THREE.MeshBasicMaterial;
      flowMat: THREE.ShaderMaterial;
      /** 光流速度（缆长/秒）：亮点沿缆线匀速流动 */
      flowSpeed: number;
      mid: THREE.Vector3;
      tier: CableTier;
      phase: number;
    }
    const CABLE_TIER_COLORS: Record<
      CableTier,
      { core: number; flow: number; dot: number }
    > = {
      ok: { core: 0x14b8a6, flow: 0x5ff5dc, dot: 0x2fe8cf },
      watch: { core: 0xffc45e, flow: 0xffd98a, dot: 0xffc45e },
      fault: { core: 0xff5252, flow: 0xff9a86, dot: 0xff6b5e },
    };
    const cableGroup = new THREE.Group();
    const cableVisList: CableVis[] = [];
    const cableHitMeshes: THREE.Object3D[] = [];
    const applyCableTier = (vis: CableVis, tier: CableTier) => {
      vis.tier = tier;
      const c = CABLE_TIER_COLORS[tier];
      vis.coreMat.color.setHex(c.core);
      vis.haloMat.color.setHex(c.core);
      vis.dotMat.color.setHex(c.dot);
      (vis.flowMat.uniforms.uColor!.value as THREE.Color).setHex(c.flow);
    };
    {
      const CABLE_R = R * 1.006;
      const slerpOnSphere = (
        a: THREE.Vector3,
        b: THREE.Vector3,
        t: number,
      ): THREE.Vector3 => {
        const ang = a.angleTo(b);
        if (ang < 1e-5) return a.clone();
        const s = Math.sin(ang);
        return a
          .clone()
          .multiplyScalar(Math.sin((1 - t) * ang) / s)
          .addScaledVector(b, Math.sin(t * ang) / s);
      };
      const dotGeo = new THREE.SphereGeometry(0.0062, 8, 8);
      CABLES.forEach((c, ci) => {
        const wps = CABLE_ROUTES[c.id];
        if (!wps || wps.length < 2) return;
        const anchors = wps.map(([la, lo]) => latLonToVec3(la, lo, 1));
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < anchors.length - 1; i++) {
          const a = anchors[i]!;
          const b = anchors[i + 1]!;
          const n = Math.max(1, Math.ceil(a.angleTo(b) / 0.05));
          for (let j = 0; j < n; j++) {
            pts.push(
              slerpOnSphere(a, b, j / n).multiplyScalar(CABLE_R),
            );
          }
        }
        pts.push(
          anchors[anchors.length - 1]!.clone().multiplyScalar(CABLE_R),
        );
        const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.08);
        const segs = Math.min(240, pts.length * 2);
        const coreGeo = new THREE.TubeGeometry(curve, segs, 0.0028, 5, false);
        const haloMat = new THREE.MeshBasicMaterial({
          color: CABLE_TIER_COLORS.ok.core,
          transparent: true,
          opacity: 0.1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const halo = new THREE.Mesh(
          new THREE.TubeGeometry(curve, segs, 0.0075, 5, false),
          haloMat,
        );
        halo.renderOrder = 4;
        cableGroup.add(halo);
        const coreMat = new THREE.MeshBasicMaterial({
          color: CABLE_TIER_COLORS.ok.core,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.renderOrder = 4;
        cableGroup.add(core);
        const flowMat = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: {
            uPhase: { value: 0 },
            uColor: { value: new THREE.Color(CABLE_TIER_COLORS.ok.flow) },
            uOpacity: { value: 1 },
            uOffset: { value: (ci * 0.37) % 1 },
            uDensity: { value: isCoarse ? 16 : 30 },
          },
          vertexShader: [
            "varying vec2 vUv;",
            "void main() {",
            "  vUv = uv;",
            "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
            "}",
          ].join("\n"),
          fragmentShader: [
            "uniform float uPhase;",
            "uniform vec3 uColor;",
            "uniform float uOpacity;",
            "uniform float uOffset;",
            "uniform float uDensity;",
            "varying vec2 vUv;",
            "void main() {",
            // uPhase 以缆长为单位：相位每 +1，整幅光段图案沿缆前进一整条缆长
            "  float f = fract(vUv.x * uDensity - uPhase * uDensity + uOffset);",
            // 亮头（窄而亮）+ 拖尾（宽而淡）：一道光段有头有尾地掠过，不是整片闪烁
            "  float head = smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(0.04, 0.26, f));",
            "  float tail = smoothstep(0.0, 0.04, f) * (1.0 - smoothstep(0.04, 0.62, f));",
            "  float pulse = head * 0.9 + tail * 0.32;",
            "  gl_FragColor = vec4(uColor, clamp(pulse, 0.0, 1.0) * uOpacity);",
            "}",
          ].join("\n"),
        });
        const flow = new THREE.Mesh(coreGeo, flowMat);
        flow.renderOrder = 5;
        cableGroup.add(flow);
        const dotMat = new THREE.MeshBasicMaterial({
          color: CABLE_TIER_COLORS.ok.dot,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        for (const [la, lo] of CABLE_LANDINGS[c.id] ?? []) {
          const dot = new THREE.Mesh(dotGeo, dotMat);
          dot.position.copy(latLonToVec3(la, lo, CABLE_R));
          dot.renderOrder = 5;
          cableGroup.add(dot);
          const dotHit = new THREE.Mesh(
            new THREE.SphereGeometry(0.03, 6, 6),
            new THREE.MeshBasicMaterial({ visible: false }),
          );
          dotHit.position.copy(dot.position);
          dotHit.userData.cableId = c.id;
          cableGroup.add(dotHit);
          cableHitMeshes.push(dotHit);
        }
        const hitMesh = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 72, 0.02, 4, false),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        hitMesh.userData.cableId = c.id;
        cableGroup.add(hitMesh);
        cableHitMeshes.push(hitMesh);
        cableVisList.push({
          id: c.id,
          coreMat,
          haloMat,
          dotMat,
          flowMat,
          flowSpeed: 0.055 + (ci % 5) * 0.012,
          mid: curve.getPointAt(0.5),
          tier: "ok",
          phase: (ci * 1.37) % (Math.PI * 2),
        });
      });
      earth.add(cableGroup);
    }
    // —— 交易所指数板：寄生在金融中心标记上（同锚点、同避让池），
    // 不另起元素体系。锚点 = 有主要交易所的中心 id + 两个板专用
    // 锚点：深圳 szx（有大交易所但不在 GFCI 27 中心名单里，只给
    // 一个小节点点 + 板，不升格为金融中心）与纽约第二板 ndx
    // （纳斯达克 100，与标普 500 双板同城，锚点就是纽约中心、
    // 靠 baseOff 抬到标普板上方，不另设节点点）。悉尼/多伦多/
    // 圣保罗三板已按用户口径撤下（2026-11-11，不那么有名的交易
    // 所忽略；中心标记与弧线不动）。数据由 App 经
    // stateRef.indexBoards 喂入（volatility 快照），到位前整板
    // 不出现；到位/刷新后原地重画纹理（syncBoards 比对）。
    interface BoardVis {
      id: string;
      sprite: THREE.Sprite;
      base: THREE.Vector3;
      target: number;
      offX: number;
      offY: number;
      hasData: boolean;
      redraw: (b: IndexBoardInfo | undefined) => void;
      dot: THREE.Sprite | null;
      /** 引线：球面锚点 → 板心，随板逐帧更新终点（见 animate 板循环） */
      line: THREE.Line;
      lineMat: THREE.LineBasicMaterial;
      /** 避让池优先级（板默认 65；纽约第二板 63，让标普占原位） */
      priority: number;
    }
    const boardVis: BoardVis[] = [];
    {
      const centerById = new Map(CENTERS.map((c) => [c.id, c]));
      const extraAnchors: Record<
        string,
        { lat: number; lon: number; dot: boolean }
      > = {
        szx: { lat: 22.54, lon: 114.06, dot: true },
        // ndx 的 lat/lon 就是纽约中心坐标（双板同锚），dot=false：
        // 纽约节点本身就是它的锚点标记
        ndx: { lat: 40.71, lon: -74.01, dot: false },
      };
      const anchorIds = [
        "nyc", "ndx", "ldn", "fra", "par", "sha", "szx", "hkg",
        "tyo", "sel", "bom",
      ];
      // 板基位偏移（度）：板心相对交易所真实锚点的先天错位。
      // 2026-11-13 定版（用户：「回归两行式样、位置准确一些」）：
      // 亚洲六板曾按地理扇形预错位（沪向西北、港向东南……）先天
      // 摊开再进避让池——板心系统性偏离自家锚点、引线斜拉，正是
      // 用户所指「贴位漂移」，随紧凑芯片一并退役。自此亚洲六板
      // 与伦敦/法兰克福/巴黎同规：基位 = 真实锚点正上方（boardR
      // 半径处、零经纬偏移），拥挤时的屏幕错位全交避让池用全场
      // 同一套步长（bw+12 / bh+8）解决，引线起点钉死真实锚点、
      // 终点逐帧跟板心——偏移方向与间距全场一致、引线落点 =
      // 标记节点。仅 ndx 保留偏移：它与标普板同锚纽约、是「同城
      // 双板上下成双」的结构性错位（非地理摊开），抬到纽约北侧。
      const baseOff: Record<string, { dLat: number; dLon: number }> = {
        ndx: { dLat: 4.2, dLon: -1.5 },
      };
      // 全场 11 板同式（2026-11-13）：两行全板、无地区变体——
      // makeBoardSprite 不再有 compact 分流（见该函数处注）。
      // 板锚半径（2026-11-11 修嵌球）：旧 1.02 离球面太近——板是
      // 半对角线约 0.18 的 billboard，偏离盘面中心时朝球心侧的边角
      // 几何上必然沉到球面以下被深度裁掉。抬到 1.19（移动端
      // 1.24）后，最不利朝向下边角仍在球面之上；2026-11-13 全场
      // 板宽 0.27→0.24 后半对角线降至约 0.128（桌面）/0.147（移
      // 动端），最不利边角约 1.06/1.09，余量更大，半径继续不动；
      // 交易所位置由球面小节点 + 短引线标明（与标签浮标语言统
      // 一），避让错位后另有半径钳制（见避让池 clampLen），不
      // 许错位把板拖回球里。
      const boardR = R * (isCoarse ? 1.24 : 1.19);
      for (const id of anchorIds) {
        const c = centerById.get(id);
        const extra = extraAnchors[id];
        const lat = c?.lat ?? extra!.lat;
        const lon = c?.lon ?? extra!.lon;
        const off = baseOff[id] ?? { dLat: 0, dLon: 0 };
        const { sprite, redraw } = makeBoardSprite(
          renderer.capabilities.getMaxAnisotropy(),
          isCoarse,
        );
        const base = latLonToVec3(lat + off.dLat, lon + off.dLon, boardR);
        sprite.position.copy(base);
        earth.add(sprite);
        const surf = latLonToVec3(lat, lon, R * 1.012);
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          surf,
          base,
        ]);
        const lineMat = new THREE.LineBasicMaterial({
          color: 0x8fc6ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        line.renderOrder = 7;
        line.frustumCulled = false;
        earth.add(line);
        let dot: THREE.Sprite | null = null;
        if (!c && extra?.dot) {
          dot = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: dotTex,
              color: 0xbfd4ea,
              transparent: true,
              depthWrite: false,
              opacity: 0,
            }),
          );
          dot.scale.set(0.05, 0.05, 1);
          dot.position.copy(latLonToVec3(lat, lon, R * 1.004));
          dot.renderOrder = 6;
          earth.add(dot);
        }
        boardVis.push({
          id,
          sprite,
          base,
          target: 0,
          offX: 0,
          offY: 0,
          hasData: false,
          redraw,
          dot,
          line,
          lineMat,
          priority: id === "ndx" ? 63 : 65,
        });
      }
    }
    let boardsKey = "";
    const syncBoards = () => {
      const boards = stateRef.current.indexBoards ?? [];
      const key = boards
        .map((b) => `${b.id}:${b.price}:${b.changePct}:${b.open}:${b.asOf}`)
        .join(";");
      if (key === boardsKey) return;
      boardsKey = key;
      const byId = new Map(boards.map((b) => [b.id, b]));
      for (const bv of boardVis) {
        const b = byId.get(bv.id);
        bv.hasData = !!b;
        if (!b) bv.target = 0;
        bv.redraw(b);
      }
    };

    // —— 地球居民（纯氛围彩蛋）：虾蛄星人父子定居北极点旁的冰
    // 面，是北极 UFO 停机坪的地主（素材与落点出处见 mantisArt
    // .ts；原北海道富良野农场已撤，不许两处同时存在——用户改
    // 判：北海道元素太密、父子太小看不清，极地天然全空）。与
    // 赛伯共用纸片人系统，挂地球组本地系——主页地球与太阳系
    // 地球是同一个 earth 组（太阳系里它飞到地球轨道位），双栖
    // 自动成立；客串星球当主页时随地球图层整组隐藏（earth-
    // Content 登记在本块之后，精灵与接触影都在登记范围内）。
    // 无标签、无芯片。体型按用户口径放大约 1.8 倍（父高 0.15
    // 个半径、子 ×0.52 官方比例），极地无竞争元素、仍克制。
    const mantisTex = makeMantisTextureSet();
    const mantisRand = seededRand(20261111);
    const mantisPair: PaperWalker[] = [];
    let mantisFather: PaperWalker;
    let mantisSon: PaperWalker;
    /** 极点方向（地球本地系 +Y）：停机坪心、父子与访客的场地原点 */
    const POLE_DIR = new THREE.Vector3(0, 1, 0);
    /** 子的活动模式：跟随父亲 / 绕停机坪光环跑圈，定时切换 */
    let sonMode: "follow" | "ring" = "follow";
    let sonModeT = 8 + mantisRand() * 8;
    /** 子绕环跑的当前方位角（极面内） */
    let sonRingAz = mantisRand() * Math.PI * 2;
    {
      const home = latLonToVec3(
        MANTIS_POLE_HOME.lat,
        MANTIS_POLE_HOME.lon,
        1,
      ).normalize();
      mantisFather = makePaperWalker(mantisTex.father, home, mantisRand, 0.15, 0);
      mantisFather.angSpeed = 0.0045; // 冰面踱步：从容的巡场速度
      const sonDir = home
        .clone()
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.01);
      mantisSon = makePaperWalker(
        mantisTex.son,
        sonDir,
        mantisRand,
        0.15 * 0.52,
        1,
      );
      mantisSon.angSpeed = 0.009; // 跟随模式的小步速（绕环跑时另调）
      for (const w of [mantisFather, mantisSon]) {
        w.sprite.position.copy(w.dir).multiplyScalar(R);
        earth.add(w.sprite);
        earth.add(w.shadow);
        mantisPair.push(w);
      }
    }
    let mantisJabT = -1;
    let mantisJabWait = 5 + mantisRand() * 7;
    /** 父的日常家点（迎客时家点临时改钉到访客旁，船走后恢复此点） */
    const fatherHomeDaily = mantisFather.home.clone();

    // —— 北极停机坪 + UFO 造访（纯氛围层，与父子同一片场地；
    // 设计定稿见 DATA-PLAN「北极停机坪 + 虾蛄父子改住北极」）——
    // 全部挂 polarGroup（earth 的直接子组，登记进 earthContent
    // 在本块之后）：主页/太阳系双栖自动成立，客串星球当主页时
    // 整组隐藏。全程无标签、无文字，视觉优先级最低，不进任何
    // 命中表、不碰数据层与转场/聚焦逻辑。
    const polarGroup = new THREE.Group();
    earth.add(polarGroup);
    // 冰盖：一层柔和的冰面 decal 盖住极点（顺带盖住等距圆柱贴
    // 图在极点的捏合纹理），径向软边、半径 0.30 个半径（约到
    // 纬度 73°，主要是北冰洋面，不压大陆数据区）。
    const iceDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 40),
      new THREE.MeshBasicMaterial({
        map: makeIceDiscTexture(),
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    );
    iceDisc.rotation.x = -Math.PI / 2;
    iceDisc.position.y = R * 1.0012;
    iceDisc.renderOrder = 2;
    polarGroup.add(iceDisc);
    // 停机坪光环 decal：外环 + 内环 + 环周 6 枚灯点，共用一份
    // 材质统一调光——待机极淡（≈0.10 微呼吸），UFO 接近时渐亮
    // 迎接（animate 的造访段落驱动 padMat.opacity）。
    const padMat = new THREE.MeshBasicMaterial({
      color: 0x7fe8ff,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mkPadFlat = (geo: THREE.BufferGeometry, y: number) => {
      const m = new THREE.Mesh(geo, padMat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = y;
      m.renderOrder = 3;
      polarGroup.add(m);
      return m;
    };
    mkPadFlat(new THREE.RingGeometry(0.118, 0.138, 48), R * 1.0024);
    mkPadFlat(new THREE.RingGeometry(0.052, 0.06, 40), R * 1.0024);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tick = mkPadFlat(
        new THREE.CircleGeometry(0.0075, 10),
        R * 1.0024,
      );
      tick.position.x = Math.cos(a) * 0.128;
      tick.position.z = Math.sin(a) * 0.128;
    }
    // 光束落地光斑（UFO 光束亮时在冰面投下的一圈光）
    const beamSpotMat = new THREE.MeshBasicMaterial({
      map: makeGlowTexture(
        "rgba(170,245,255,0.9)",
        "rgba(170,245,255,0.3)",
      ),
      color: 0xaef3ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const beamSpot = new THREE.Mesh(
      new THREE.CircleGeometry(0.105, 32),
      beamSpotMat,
    );
    beamSpot.rotation.x = -Math.PI / 2;
    beamSpot.position.y = R * 1.0028;
    beamSpot.renderOrder = 3;
    polarGroup.add(beamSpot);
    // UFO 本体（程序建模，见 makeUfo）：初始藏起，造访时才显形
    const ufo = makeUfo();
    ufo.group.visible = false;
    polarGroup.add(ufo.group);
    // 访客赛伯星人（独立个体，不占月球编制——人数口径见 DATA-
    // PLAN：月球常驻 5 只（粗指针 4 只）分毫不动，访客是另派的
    // 出差克隆个体，用黄色眼版本立绘，与月面居民区分）。只在
    // UFO 落冰的 ground 阶段显形、在极圈小范围散步。
    const visitorRand = seededRand(777001);
    const visitorHome = latLonToVec3(79.4, -35, 1).normalize();
    const visitor = makePaperWalker(
      serpoTexSet[2] ?? serpoTexSet[0]!,
      visitorHome,
      visitorRand,
      0.14,
      0,
    );
    visitor.angSpeed = 0.006;
    visitor.sprite.visible = false;
    visitor.shadow.visible = false;
    visitor.sprite.position.copy(visitor.dir).multiplyScalar(R);
    polarGroup.add(visitor.sprite);
    polarGroup.add(visitor.shadow);
    /** 迎客站位：访客家点向极点收 0.075 rad 处——父站到访客与
     * 停机坪之间，访客散步（漫游 0.045）与父巡场（0.02）叠起来
     * 两人始终在同一小片冰面上同场活动 */
    const fatherGreetHome = visitorHome
      .clone()
      .applyAxisAngle(
        new THREE.Vector3()
          .crossVectors(visitorHome, POLE_DIR)
          .normalize(),
        0.075,
      );
    // —— 造访状态机（参数口径，报告同款）——
    // 阶段时长（秒）：approach 13（太阳系=月球→北极 / 主页=极
    // 点上方太空→悬停点）→ descend 5（悬停→落冰，光束亮）→
    // ground 30（访客下船散步、父子迎客）→ takeoff 5（升空，
    // 光束亮）→ depart 8（加速飞回起点方向后隐没）。
    // 触发：开屏约 18 秒后首次造访；之后每次离开后间隔 140–
    // 240 秒随机再来。同时最多一艘（单实例状态机，结构上不可
    // 能有第二艘）。转场中（trans 不在 0/1）与客串主页（hp-
    // Active）时不启动新造访；进行中的造访随地球组走，不打断。
    const VISIT_DUR = {
      approach: 13,
      descend: 5,
      ground: 30,
      takeoff: 5,
      depart: 8,
    } as const;
    type VisitPhase = keyof typeof VISIT_DUR | "idle";
    let visitPhase: VisitPhase = "idle";
    let visitT = 0;
    let nextVisitAt = 18;
    const visitRand = seededRand(13579);
    /** 本程起点（地球本地系）：太阳系模式 = 触发瞬间月球的本地
     * 位置；主页模式 = 极点上方太空点（下方 computeUfoFrom） */
    const ufoFrom = new THREE.Vector3(0.55, 3.0, 0.4);
    const ufoPos = new THREE.Vector3();
    const ufoTmpA = new THREE.Vector3();
    const ufoTmpB = new THREE.Vector3();
    let forceVisit = false;
    const computeUfoFrom = (): THREE.Vector3 => {
      if (trans > 0.5 && moonMesh) {
        const wp = new THREE.Vector3();
        moonMesh.getWorldPosition(wp);
        earth.updateMatrixWorld(true);
        const local = earth.worldToLocal(wp);
        if (local.length() > 1.2 && local.length() < 8) return local;
      }
      return new THREE.Vector3(0.55, 3.0, 0.4);
    };
    // 验收/调试钩子（无 UI、不可见）：强制触发一次完整造访 +
    // 读当前阶段。逐帧诊断仪器不在此列（历轮口径：不带出货）。
    (window as unknown as Record<string, unknown>).__financeGlobeUfo = {
      visitNow: () => {
        forceVisit = true;
      },
      phase: () => visitPhase,
    };

    // —— 地球轨道卫星层（氛围层 L2，2026-11-12；设计稿 = goal-5
    // GOAL.md「地球轨道卫星层设计」，A 示意版）——
    // 轨道参数真实（倾角/相对周期/GEO 同步），位置为编排、轨道半
    // 径为压缩示意（图例已注「示意」；真实 TLE 版是将来升级项）。
    // 只属于主页地球：整层挂 earth 组随球同转——GEO 因此天然与地
    // 表严格同步；客串星球当主页时随 earthContent 整组隐藏（下方
    // 登记包含本组）；太阳系模式由 satInner 随 globeFade 淡出。
    // 形态纪律（图层宪章）：卫星本体语言 = 金色多层隔热膜 + 深
    // 蓝紫光伏板 + 中性银构件，金色只许来自金箔材质本身（不许靠
    // 场景暖金主光染色）；轨道语言 = 冷银白细线 + 沿圈极缓流光 +
    // 本体前方一小段领航光，与金融弧（国别彩色高弧）/海缆（贴面
    // 深海青流光）/灯光（暖金点）明确区分，亮度恒低于金融弧一档；
    // 无文字标签（向日葵 9 号也不挂名——同步静止就是给细心观众
    // 的彩蛋）；背面靠深度测试被球体自然遮挡。总账（2026-11-12
    // 圆柱化轮）：卫星 10 颗（低轨 3 + 中轨 4 + 静止 3）、轨道圈
    // 8 条 + 流光虚线圈 8 条 + 领航光弧 8 段、新增绘制 ≈176（英
    // 雄级整机 30 网格 ×4 含向日葵——圆柱主舱/环箍/greeble 16 +
    // 桁架 2 + 大桨板 2 + 边框梁/主梁 10、导航级 6 网格 ×4、静
    // 止光点 2 网格 ×2、4 枚反光精灵、16 条线/虚线圈、8 段领航
    // 弧）；程序化纹理全层共享 2 张（光伏面 1024×256 + 金箔
    // 256×256，合计 ≈1.25MB），不逐颗生成；光伏着色器按颗实例
    // 化（8 组 uniform，同一程序）供扫光相位逐颗独立。
    const satGroup = new THREE.Group();
    earth.add(satGroup);
    const satInner = new THREE.Group();
    satGroup.add(satInner);
    const satFadeMats: Array<{ mat: { opacity: number }; base: number }> =
      [];
    const satTickers: Array<(ct: number) => void> = [];
    let satClock = 0;
    let satFadeNow = 1;
    const tmpSatDir = new THREE.Vector3();
    const SAT_UP_Y = new THREE.Vector3(0, 1, 0);
    // —— 精细建模（2026-11-12 精修轮）：主体包金色多层隔热膜
    // （MLI 金箔：哑光金属 + 皱褶高光），太阳能板是真实光伏面
    // （深蓝紫底 + 电池片网格 + 银色汇流条）。两者都不用场景光
    // 照材质：场景主光是暖金色，Phong/Standard 会二次染黄（上
    // 轮审计实拍教训——金色必须来自材质本身），故用自带中性白
    // 太阳向（共用 sunUniform 世界向）的 ShaderMaterial：金箔的
    // 皱褶高光与板面的镜面反光都按太阳-法线-相机几何实时算，
    // 卫星绕行到角度对齐时板面自然爆出一道闪（真实过境闪光
    // 感），平时是幽深蓝紫 + Fresnel 极淡虹彩，不是贴一张死图。
    // 板翼还会绕翼轴缓转追日（真实姿控行为），反光几何随之而动。
    const satRand = seededRand(90210);
    const makePanelTexture = (): THREE.CanvasTexture => {
      const c = document.createElement("canvas");
      c.width = 1024;
      c.height = 256;
      const g = c.getContext("2d")!;
      const bg = g.createLinearGradient(0, 0, 0, 256);
      bg.addColorStop(0, "#1d2f6e");
      bg.addColorStop(0.5, "#16255c");
      bg.addColorStop(1, "#121e4e");
      g.fillStyle = bg;
      g.fillRect(0, 0, 1024, 256);
      // 极淡虹彩色斑（紫/青柔斑垫底，着色器里另有一层 Fresnel 虹彩）
      for (const [x, y, r, col] of [
        [210, 60, 300, "rgba(96,64,190,0.13)"],
        [760, 190, 340, "rgba(28,150,190,0.10)"],
        [520, 40, 260, "rgba(50,90,220,0.10)"],
      ] as const) {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, col);
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(0, 0, 1024, 256);
      }
      // 电池片 24×6 分格：逐片色相/明暗微差 + 顶部受光边
      const cols = 24;
      const rows = 6;
      const cw = 1024 / cols;
      const ch = 256 / rows;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const v = satRand();
          g.fillStyle = `hsl(${230 + v * 16}, ${54 + v * 10}%, ${15 + v * 7}%)`;
          g.fillRect(i * cw + 1.5, j * ch + 1.5, cw - 3, ch - 3);
          g.fillStyle = "rgba(196,216,255,0.10)";
          g.fillRect(i * cw + 1.5, j * ch + 1.5, cw - 3, 1.6);
        }
      }
      // 片间网格线（银蓝细线）
      g.strokeStyle = "rgba(170,194,228,0.55)";
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i <= cols; i++) {
        g.moveTo(i * cw + 0.5, 0);
        g.lineTo(i * cw + 0.5, 256);
      }
      for (let j = 0; j <= rows; j++) {
        g.moveTo(0, j * ch + 0.5);
        g.lineTo(1024, j * ch + 0.5);
      }
      g.stroke();
      // 银色汇流条：每 6 列一条纵向亮银带 + 中央一条横向
      for (let k = 0; k <= 4; k++) {
        const x = k * 6 * cw;
        const gr = g.createLinearGradient(x - 2, 0, x + 2, 0);
        gr.addColorStop(0, "#5f718f");
        gr.addColorStop(0.5, "#dde9fa");
        gr.addColorStop(1, "#5f718f");
        g.fillStyle = gr;
        g.fillRect(x - 2, 0, 4, 256);
      }
      const gh = g.createLinearGradient(0, 126, 0, 130);
      gh.addColorStop(0, "#5f718f");
      gh.addColorStop(0.5, "#dde9fa");
      gh.addColorStop(1, "#5f718f");
      g.fillStyle = gh;
      g.fillRect(0, 126, 1024, 4);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(
        8,
        renderer.capabilities.getMaxAnisotropy(),
      );
      return tex;
    };
    const makeGoldFoilTexture = (): THREE.CanvasTexture => {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 256;
      const g = c.getContext("2d")!;
      g.fillStyle = "#a8741f";
      g.fillRect(0, 0, 256, 256);
      // 皱褶色斑：随机旋转小片，逐片金色深浅（箔面分片拼贴感）
      const shades = ["#8a5a14", "#caa13c", "#e8bc5a", "#9c6b1d", "#dcb04e", "#7d5211"];
      for (let i = 0; i < 900; i++) {
        const w = 5 + satRand() * 22;
        const h = 4 + satRand() * 15;
        g.save();
        g.translate(satRand() * 256, satRand() * 256);
        g.rotate(satRand() * Math.PI);
        g.globalAlpha = 0.22 + satRand() * 0.3;
        g.fillStyle = shades[Math.floor(satRand() * shades.length)]!;
        g.fillRect(-w / 2, -h / 2, w, h);
        g.restore();
      }
      g.globalAlpha = 1;
      // 折痕线：亮棱与暗谷交错
      for (let i = 0; i < 150; i++) {
        const x = satRand() * 256;
        const y = satRand() * 256;
        const a = satRand() * Math.PI;
        const len = 8 + satRand() * 30;
        g.strokeStyle =
          satRand() > 0.5
            ? "rgba(245,214,122,0.35)"
            : "rgba(110,71,14,0.30)";
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 2);
      tex.anisotropy = Math.min(
        8,
        renderer.capabilities.getMaxAnisotropy(),
      );
      return tex;
    };
    const satGoldUniforms = {
      uSunDir: sunUniform,
      uFade: { value: 1 },
    };
    // 光伏板：纹理与太阳向全层共享、淡出共用一个 uniform 对象
    // （主循环逐帧喂 globeFade）；扫光相位 uSweep 逐颗独立——
    // 反光缺陷修复轮（2026-11-12）：上一轮双叶镜面只在「太阳-
    // 板面-相机」三点对齐的窄窗口里出现，主页固定视角下板翼追
    // 日又把反射向钉向太阳、几乎不扫过相机，宽叶还只有 0.30，
    // 等于橱窗效果。本轮改为材质按颗实例化 + 扫光带（随绕行相
    // 位横扫板面的柔亮光带，周期十几秒量级，正常观看必然周期
    // 性出现）+ 镜面叶放宽提亮 + 受光/背光基础对比拉开；对齐
    // 爆闪降为加分项保留（窄叶 + 反光精灵）。
    const satPanelFade = { value: 1 };
    const satPanelTex = makePanelTexture();
    const SAT_VERT = [
      "varying vec2 vUv;",
      "varying vec3 vWN;",
      "varying vec3 vWP;",
      "void main() {",
      "  vUv = uv;",
      "  vWN = normalize(mat3(modelMatrix) * normal);",
      "  vec4 wp = modelMatrix * vec4(position, 1.0);",
      "  vWP = wp.xyz;",
      "  gl_Position = projectionMatrix * viewMatrix * wp;",
      "}",
    ].join("\n");
    // 光伏板（按颗实例化）：幽深蓝紫漫反射（受光提亮/背光压暗）
    // + 放宽的冷白镜面叶（宽叶为常态反光主力、窄叶对齐爆闪）
    // + 扫光带（uSweep 逐帧由各星 ticker 喂相位）+ Fresnel 虹彩
    const makeSatPanelMat = (): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: satPanelTex },
          uSunDir: sunUniform,
          uFade: satPanelFade,
          uSweep: { value: -10 },
        },
        vertexShader: SAT_VERT,
        fragmentShader: [
          "uniform sampler2D uMap;",
          "uniform vec3 uSunDir;",
          "uniform float uFade;",
          "uniform float uSweep;",
          "varying vec2 vUv;",
          "varying vec3 vWN;",
          "varying vec3 vWP;",
          "void main() {",
          "  vec3 N = normalize(vWN);",
          "  vec3 V = normalize(cameraPosition - vWP);",
          "  vec3 L = normalize(uSunDir);",
          "  vec3 tex = texture2D(uMap, vUv).rgb;",
          "  float diff = max(dot(N, L), 0.0);",
          "  vec3 col = tex * (0.10 + 1.30 * diff);",
          "  vec3 R = reflect(-L, N);",
          "  float rv = max(dot(R, V), 0.0);",
          "  float spec = pow(rv, 90.0) * 2.0 + pow(rv, 16.0) * 0.60 + pow(rv, 5.0) * 0.10;",
          "  float lit = clamp(diff * 3.0, 0.0, 1.0);",
          "  col += vec3(0.82, 0.90, 1.0) * spec * lit;",
          "  float band = exp(-pow((vUv.x - uSweep) * 4.2, 2.0));",
          "  float facing = smoothstep(0.05, 0.35, abs(dot(N, V)));",
          "  col += vec3(0.78, 0.88, 1.0) * band * 0.95 * lit * facing;",
          "  float fres = pow(1.0 - abs(dot(N, V)), 2.0);",
          "  vec3 irid = 0.5 + 0.5 * cos(6.28318 * (fres * 1.35 + vec3(0.0, 0.33, 0.67)));",
          "  col += irid * fres * 0.09 * (0.3 + 0.7 * diff);",
          "  gl_FragColor = vec4(col, uFade);",
          "}",
        ].join("\n"),
        transparent: true,
      });
    // 金箔：皱褶由 UV 网格哈希逐格扰动高光（功率/强度逐格不同 =
    // 皱面散射感），漫反射走纹理本身的金色，不借场景暖光
    const satGoldMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makeGoldFoilTexture() },
        ...satGoldUniforms,
      },
      vertexShader: SAT_VERT,
      fragmentShader: [
        "uniform sampler2D uMap;",
        "uniform vec3 uSunDir;",
        "uniform float uFade;",
        "varying vec2 vUv;",
        "varying vec3 vWN;",
        "varying vec3 vWP;",
        "void main() {",
        "  vec3 N = normalize(vWN);",
        "  vec3 V = normalize(cameraPosition - vWP);",
        "  vec3 L = normalize(uSunDir);",
        "  vec3 tex = texture2D(uMap, vUv).rgb;",
        "  float diff = max(dot(N, L), 0.0);",
        "  float hash = fract(sin(dot(floor(vUv * vec2(28.0, 20.0)), vec2(12.9898, 78.233))) * 43758.5453);",
        "  vec3 R = reflect(-L, N);",
        "  float rv = max(dot(R, V), 0.0);",
        "  float spec = pow(rv, mix(16.0, 84.0, hash)) * mix(0.22, 1.15, hash);",
        "  vec3 col = tex * (0.20 + 0.92 * diff);",
        "  col += vec3(1.0, 0.96, 0.88) * spec * clamp(diff * 2.5, 0.0, 1.0);",
        "  float fres = pow(1.0 - abs(dot(N, V)), 3.0);",
        "  col += vec3(0.95, 0.75, 0.38) * fres * 0.10 * (0.3 + 0.7 * diff);",
        "  gl_FragColor = vec4(col, uFade);",
        "}",
      ].join("\n"),
      transparent: true,
    });
    // 中性银/暗构件（桁架、天线、喷口、星点小体）：不吃光的基础
    // 材质恒定中性色，与上轮同理防暖光染色
    const satSilverMat = new THREE.MeshBasicMaterial({
      color: 0xb9c9dc,
      transparent: true,
    });
    const satTrussMat = new THREE.MeshBasicMaterial({
      color: 0x7e93ad,
      transparent: true,
    });
    const satDarkMat = new THREE.MeshBasicMaterial({
      color: 0x46586e,
      transparent: true,
    });
    const satPanelBasicMat = new THREE.MeshBasicMaterial({
      color: 0x51648a,
      transparent: true,
    });
    satFadeMats.push(
      { mat: satSilverMat, base: 1 },
      { mat: satTrussMat, base: 1 },
      { mat: satDarkMat, base: 1 },
      { mat: satPanelBasicMat, base: 1 },
    );
    // —— 分件几何（全层共享，按细节级取用）——
    // 本地系约定：+X = 翼轴（轨道法向）、+Y = 径向朝外、+Z = 飞
    // 行方向（切向）；天线锅朝 -Y 对地，仪器舱圆柱沿 Z 伸出
    const satBusGeo = new THREE.BoxGeometry(0.02, 0.016, 0.03);
    const satCylGeo = new THREE.CylinderGeometry(0.0085, 0.0085, 0.037, 20);
    const satCapGeo = new THREE.CylinderGeometry(0.0058, 0.0076, 0.0045, 16);
    const satNozzleGeo = new THREE.CylinderGeometry(0.0028, 0.0046, 0.005, 12);
    const satDishGeo = (() => {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push(new THREE.Vector2(0.0115 * t, 0.0038 * t * t));
      }
      return new THREE.LatheGeometry(pts, 20);
    })();
    const satMastGeo = new THREE.CylinderGeometry(0.0008, 0.0008, 0.009, 6);
    const satFeedGeo = new THREE.SphereGeometry(0.0016, 8, 6);
    const satTrussGeo = new THREE.CylinderGeometry(0.0011, 0.0011, 0.024, 6);
    const satPanelGeo = new THREE.BoxGeometry(0.046, 0.0016, 0.02);
    const satAntennaGeo = new THREE.CylinderGeometry(0.0006, 0.0006, 0.015, 5);
    const satDotBodyGeo = new THREE.BoxGeometry(0.012, 0.009, 0.018);
    const satDotPanelGeo = new THREE.BoxGeometry(0.05, 0.002, 0.014);
    // 英雄级加密几何（圆柱化轮）：粗壮主舱筒 + 后段推进舱 + 舱
    // 段环箍 + 放大一档的大桨板 + 板边框梁/中央主梁 + greeble 件
    const satHullGeo = new THREE.CylinderGeometry(0.0105, 0.0105, 0.034, 24);
    const satAftGeo = new THREE.CylinderGeometry(0.0082, 0.0088, 0.009, 20);
    const satHoopGeo = new THREE.CylinderGeometry(0.0111, 0.0111, 0.0022, 24);
    const satHeroPanelGeo = new THREE.BoxGeometry(0.06, 0.0016, 0.027);
    const satHeroTrussGeo = new THREE.CylinderGeometry(0.0011, 0.0011, 0.03, 6);
    const satRailXGeo = new THREE.BoxGeometry(0.06, 0.0024, 0.0018);
    const satRailZGeo = new THREE.BoxGeometry(0.0018, 0.0024, 0.027);
    const satSparGeo = new THREE.BoxGeometry(0.06, 0.0026, 0.002);
    const satGreebleBoxGeo = new THREE.BoxGeometry(0.007, 0.005, 0.01);
    const satCoverGeo = new THREE.BoxGeometry(0.005, 0.003, 0.006);
    const satPipeGeo = new THREE.CylinderGeometry(0.0013, 0.0013, 0.026, 6);
    const satStubGeo = new THREE.CylinderGeometry(0.0007, 0.0007, 0.008, 5);
    // 板面材质组按颗组装（见 makeSatBody）：±Y 大面挂该颗自己
    // 的光伏着色器材质（盒几何材质序 [+x,-x,+y,-y,+z,-z]），
    // 四条窄边走暗银框料
    interface SatBuilt {
      group: THREE.Group;
      wingL: THREE.Group | null;
      wingR: THREE.Group | null;
    }
    const makeSatBody = (
      detail: "hero" | "nav" | "dot",
      scale: number,
      panelMat?: THREE.ShaderMaterial,
    ): SatBuilt => {
      const g = new THREE.Group();
      if (detail === "dot") {
        const b = new THREE.Mesh(satDotBodyGeo, satSilverMat);
        const p = new THREE.Mesh(satDotPanelGeo, satPanelBasicMat);
        g.add(b);
        g.add(p);
        g.scale.setScalar(scale);
        return { group: g, wingL: null, wingR: null };
      }
      const panelFace: THREE.Material = panelMat ?? satPanelBasicMat;
      const panelMats: THREE.Material[] = [
        satDarkMat,
        satDarkMat,
        panelFace,
        panelFace,
        satDarkMat,
        satDarkMat,
      ];
      let wingL: THREE.Group | null = null;
      let wingR: THREE.Group | null = null;
      if (detail === "hero") {
        // 英雄级主体圆柱化（借《命运石之门》主视觉卫星的造型语
        // 言：粗壮圆柱主舱 + 分舱段环箍 + 表面细节凸起错落；只
        // 借语言与密度，不带任何具体涂装/标识）：金箔主舱筒 +
        // 后段推进舱 + 三道环箍（银/暗交替）压出舱段接缝
        const hull = new THREE.Mesh(satHullGeo, satGoldMat);
        hull.rotation.x = Math.PI / 2;
        g.add(hull);
        const aft = new THREE.Mesh(satAftGeo, satGoldMat);
        aft.rotation.x = Math.PI / 2;
        aft.position.z = -0.0205;
        g.add(aft);
        for (const [hz, hm] of [
          [-0.011, satSilverMat],
          [0.001, satDarkMat],
          [0.012, satSilverMat],
        ] as const) {
          const hoop = new THREE.Mesh(satHoopGeo, hm);
          hoop.rotation.x = Math.PI / 2;
          hoop.position.z = hz;
          g.add(hoop);
        }
        // greeble：顶部设备盒、底部接口盖板、侧面管线、短桩天线
        const equip = new THREE.Mesh(satGreebleBoxGeo, satSilverMat);
        equip.position.set(0, 0.0118, -0.005);
        g.add(equip);
        const cover = new THREE.Mesh(satCoverGeo, satDarkMat);
        cover.position.set(0.0062, -0.0108, 0.009);
        g.add(cover);
        const pipe = new THREE.Mesh(satPipeGeo, satTrussMat);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(0.0098, -0.0048, 0);
        g.add(pipe);
        const stub = new THREE.Mesh(satStubGeo, satTrussMat);
        stub.position.set(-0.005, 0.0135, -0.013);
        g.add(stub);
        const cap = new THREE.Mesh(satCapGeo, satSilverMat);
        cap.rotation.x = Math.PI / 2;
        cap.position.z = 0.0192;
        g.add(cap);
        const nozzle = new THREE.Mesh(satNozzleGeo, satDarkMat);
        nozzle.rotation.x = Math.PI / 2;
        nozzle.position.z = -0.0272;
        g.add(nozzle);
        // 对地抛物面天线：锅口朝 -Y（对地球），支杆 + 馈源小球
        const dish = new THREE.Mesh(satDishGeo, satSilverMat);
        dish.rotation.x = Math.PI;
        dish.position.y = -0.0112;
        g.add(dish);
        const mast = new THREE.Mesh(satMastGeo, satTrussMat);
        mast.position.y = -0.0162;
        g.add(mast);
        const feed = new THREE.Mesh(satFeedGeo, satSilverMat);
        feed.position.y = -0.0202;
        g.add(feed);
        // 全向小天线（背地侧 +Y）
        const ant = new THREE.Mesh(satAntennaGeo, satTrussMat);
        ant.position.y = 0.017;
        g.add(ant);
        const antTip = new THREE.Mesh(satFeedGeo, satSilverMat);
        antTip.position.y = 0.0252;
        g.add(antTip);
      } else {
        const bus = new THREE.Mesh(satBusGeo, satGoldMat);
        g.add(bus);
        const cyl = new THREE.Mesh(satCylGeo, satGoldMat);
        cyl.rotation.x = Math.PI / 2;
        g.add(cyl);
      }
      // 双翼：翼组绕 X（翼轴）旋转追日；桁架在翼组外（不随翼转）。
      // 英雄级板翼放大一档（0.060×0.027）并加边框梁（上下边梁 +
      // 两端梁）与中央主梁——大桨板 + 框架梁是视觉主角；导航级
      // 维持原尺寸原构造
      const isHero = detail === "hero";
      for (const s of [1, -1] as const) {
        const truss = new THREE.Mesh(
          isHero ? satHeroTrussGeo : satTrussGeo,
          satTrussMat,
        );
        truss.rotation.z = Math.PI / 2;
        truss.position.x = s * (isHero ? 0.024 : 0.022);
        g.add(truss);
        const wing = new THREE.Group();
        const pcx = s * (isHero ? 0.066 : 0.057);
        const panel = new THREE.Mesh(
          isHero ? satHeroPanelGeo : satPanelGeo,
          panelMats,
        );
        panel.position.x = pcx;
        wing.add(panel);
        if (isHero) {
          for (const rz of [0.0135, -0.0135] as const) {
            const rail = new THREE.Mesh(satRailXGeo, satTrussMat);
            rail.position.set(pcx, 0, rz);
            wing.add(rail);
          }
          for (const rx of [0.0295, -0.0295] as const) {
            const endRail = new THREE.Mesh(satRailZGeo, satTrussMat);
            endRail.position.set(pcx + rx, 0, 0);
            wing.add(endRail);
          }
          const spar = new THREE.Mesh(satSparGeo, satDarkMat);
          spar.position.set(pcx, 0, 0);
          wing.add(spar);
        }
        g.add(wing);
        if (s > 0) wingR = wing;
        else wingL = wing;
      }
      g.scale.setScalar(scale);
      return { group: g, wingL, wingR };
    };
    const makeSatGlint = (parent: THREE.Group): THREE.SpriteMaterial => {
      const m = new THREE.SpriteMaterial({
        map: makeGlowTexture(
          "rgba(215,232,250,0.85)",
          "rgba(140,180,225,0.25)",
        ),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const sp = new THREE.Sprite(m);
      sp.scale.set(0.15, 0.15, 1);
      sp.renderOrder = 4;
      parent.add(sp);
      return m;
    };
    const makeOrbitRing = (r: number, opacity: number): THREE.LineLoop => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, -Math.sin(a) * r));
      }
      const m = new THREE.LineBasicMaterial({
        color: 0x9fb4cc,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      satFadeMats.push({ mat: m, base: opacity });
      const loop = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        m,
      );
      loop.renderOrder = 1;
      return loop;
    };
    // 轨道流光（第四种光语言）：与实线圈同半径的虚线圈，只留一
    // 段约 9% 圈长的冷银白亮段，其余全空——逐帧缓转虚线圈，亮段
    // 就沿轨道巡游。亮度/速度都压在金融弧之下：这是人造轨道的
    // 「巡航光」，不是数据流
    const makeOrbitFlow = (r: number, opacity: number): THREE.Line => {
      const C = Math.PI * 2 * r;
      const pts: THREE.Vector3[] = [];
      const SEG = 128;
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, -Math.sin(a) * r));
      }
      const m = new THREE.LineDashedMaterial({
        color: 0xd7e6f7,
        dashSize: Math.min(0.6, C * 0.09),
        gapSize: C - Math.min(0.6, C * 0.09),
        transparent: true,
        opacity,
        depthWrite: false,
      });
      satFadeMats.push({ mat: m, base: opacity });
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        m,
      );
      line.computeLineDistances();
      line.renderOrder = 1;
      return line;
    };
    // 领航光：本体前方一小段渐亮→渐隐的加色弧（与板面反光同为
    // 冷银蓝），像卫星拖着的一截航迹光；逐帧按当前轨道角重算
    const LEAD_N = 10;
    const makeLeaderArc = (_r: number): {
      line: THREE.Line;
      pos: Float32Array;
    } => {
      const pos = new Float32Array((LEAD_N + 1) * 3);
      const col = new Float32Array((LEAD_N + 1) * 3);
      for (let i = 0; i <= LEAD_N; i++) {
        const b = (1 - i / LEAD_N) * 0.8;
        col[i * 3] = 0.62 * b;
        col[i * 3 + 1] = 0.74 * b;
        col[i * 3 + 2] = 0.95 * b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const m = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      satFadeMats.push({ mat: m, base: 0.85 });
      const line = new THREE.Line(geo, m);
      line.renderOrder = 2;
      line.frustumCulled = false;
      return { line, pos };
    };
    // 倾斜轨道飞行器：进动组（节点绕极轴缓转 = 轨道面相对地表进动
    // 感）→ 倾角组（轨道面按真实倾角倾斜）→ 轨道圈 + 卫星本体
    const tmpSunIncl = new THREE.Vector3();
    const tmpBasis = new THREE.Matrix4();
    const BAS_X = new THREE.Vector3(0, 1, 0);
    const BAS_Y = new THREE.Vector3();
    const BAS_Z = new THREE.Vector3();
    const addOrbiter = (cfg: {
      r: number;
      inclDeg: number;
      /** 相对地表的绕行周期（展示秒）：低轨明显快于 65 秒自转 */
      period: number;
      phase: number;
      /** 节点进动角速度 rad/s（符号 = 进动方向） */
      precess: number;
      scale: number;
      detail: "hero" | "nav";
      ringOpacity: number;
      flowOpacity: number;
      glint: boolean;
    }) => {
      const prec = new THREE.Group();
      const inclRad = THREE.MathUtils.degToRad(cfg.inclDeg);
      const incl = new THREE.Group();
      incl.rotation.x = inclRad;
      prec.add(incl);
      satInner.add(prec);
      incl.add(makeOrbitRing(cfg.r, cfg.ringOpacity));
      const flow = makeOrbitFlow(cfg.r, cfg.flowOpacity);
      incl.add(flow);
      const panelMat = makeSatPanelMat();
      const built = makeSatBody(cfg.detail, cfg.scale, panelMat);
      const sat = built.group;
      // 扫光周期：与轨道同源异速（半周期一扫、低轨十几秒量级）
      const sweepPeriod = THREE.MathUtils.clamp(cfg.period * 0.5, 10, 22);
      incl.add(sat);
      const glintMat = cfg.glint ? makeSatGlint(sat) : null;
      const lead = makeLeaderArc(cfg.r);
      incl.add(lead.line);
      const inclQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(inclRad, 0, 0),
      );
      const invInclQ = inclQ.clone().invert();
      const flowSpeed = ((Math.PI * 2) / cfg.period) * 0.3;
      let wingTheta = 0;
      satTickers.push((ct) => {
        const precA = ct * cfg.precess;
        prec.rotation.y = precA;
        // 扫光带相位：光带自板根扫向板尖再消失（-0.25→1.25 留
        // 出入场余量），各星按 phase 错开、不同步齐闪
        const sph = (((ct / sweepPeriod + cfg.phase * 0.618) % 1) + 1) % 1;
        panelMat.uniforms.uSweep!.value = -0.25 + 1.5 * sph;
        flow.rotation.y = ct * flowSpeed;
        const a = cfg.phase + (ct * Math.PI * 2) / cfg.period;
        const lx = Math.cos(a) * cfg.r;
        const lz = -Math.sin(a) * cfg.r;
        sat.position.set(lx, 0, lz);
        // 姿态：本地系钉轨道系——X = 轨道法向、Y = 径向朝外、
        // Z = 飞行切向（仪器舱沿飞行向、天线锅对地）
        BAS_Y.set(Math.cos(a), 0, -Math.sin(a));
        BAS_Z.set(-Math.sin(a), 0, -Math.cos(a));
        tmpBasis.makeBasis(BAS_X, BAS_Y, BAS_Z);
        sat.quaternion.setFromRotationMatrix(tmpBasis);
        // 板翼追日：太阳向转回卫星本地系，翼绕翼轴（本地 X）转
        // 到板面法线落在「太阳向 ⊥ 翼轴」分量上；分量太小时保持
        // 上一角度不抖。角度平滑趋近，绕行中反光随之扫动
        if (built.wingL && built.wingR) {
          tmpSunIncl
            .copy(sunLocal)
            .applyAxisAngle(SAT_UP_Y, -precA)
            .applyQuaternion(invInclQ);
          const sy = tmpSunIncl.dot(BAS_Y);
          const sz = tmpSunIncl.dot(BAS_Z);
          if (Math.hypot(sy, sz) > 0.2) {
            const target = Math.atan2(sz, sy);
            let d = target - wingTheta;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            wingTheta += d * 0.1;
          }
          built.wingL.rotation.x = wingTheta;
          built.wingR.rotation.x = wingTheta;
        }
        // 领航光弧：本体前方 0.03→0.19 rad 一段
        for (let i = 0; i <= LEAD_N; i++) {
          const aa = a + 0.03 + (i / LEAD_N) * 0.16;
          lead.pos[i * 3] = Math.cos(aa) * cfg.r;
          lead.pos[i * 3 + 1] = 0;
          lead.pos[i * 3 + 2] = -Math.sin(aa) * cfg.r;
        }
        (lead.line.geometry.getAttribute("position") as THREE.BufferAttribute)
          .needsUpdate = true;
        if (glintMat) {
          // 反光精灵与板面着色器的几何闪互补：板面闪是镜面对齐
          // 的本体高光，精灵是到达峰值时的星芒感——判定沿用本
          // 地系太阳向（位置变换回地球本地系再点乘，同一套几何）
          tmpSatDir
            .set(lx, 0, lz)
            .applyQuaternion(inclQ)
            .applyAxisAngle(SAT_UP_Y, precA)
            .normalize();
          const sunFace = tmpSatDir.dot(sunLocal);
          const flash = Math.pow(
            Math.max(0, Math.sin(ct * 0.9 + cfg.phase * 3.1)),
            24,
          );
          glintMat.opacity =
            0.5 *
            flash *
            THREE.MathUtils.clamp((sunFace - 0.1) / 0.5, 0, 1) *
            satFadeNow;
        }
      });
    };
    // ① 低轨：国际空间站 51.6° / 天宫约 41.5° / 哈勃 28.5°（英
    // 雄级全套细节）。轨道圈本轮提一档：从「凑近才见」到「正常
    // 距离认得出是轨道线」，仍明确低于金融弧一档
    addOrbiter({ r: 1.15, inclDeg: 51.6, period: 24, phase: 0.7, precess: -0.02, scale: 1.4, detail: "hero", ringOpacity: 0.24, flowOpacity: 0.3, glint: true });
    addOrbiter({ r: 1.17, inclDeg: 41.5, period: 29, phase: 2.9, precess: -0.016, scale: 1.2, detail: "hero", ringOpacity: 0.21, flowOpacity: 0.27, glint: true });
    addOrbiter({ r: 1.14, inclDeg: 28.5, period: 26, phase: 4.6, precess: 0.013, scale: 0.85, detail: "hero", ringOpacity: 0.18, flowOpacity: 0.24, glint: true });
    // ② 中轨：导航卫星 4 颗（GPS/北斗式倾角带），更高更慢，简
    // 化版同语言（金箔小舱 + 双板同款板面材质），只点缀
    addOrbiter({ r: 1.38, inclDeg: 55, period: 150, phase: 0.4, precess: -0.004, scale: 0.7, detail: "nav", ringOpacity: 0.11, flowOpacity: 0.15, glint: false });
    addOrbiter({ r: 1.38, inclDeg: 56, period: 172, phase: 2.2, precess: -0.004, scale: 0.7, detail: "nav", ringOpacity: 0.11, flowOpacity: 0.15, glint: false });
    addOrbiter({ r: 1.39, inclDeg: 64, period: 163, phase: 3.9, precess: 0.003, scale: 0.7, detail: "nav", ringOpacity: 0.1, flowOpacity: 0.14, glint: false });
    addOrbiter({ r: 1.37, inclDeg: 55, period: 186, phase: 5.5, precess: -0.003, scale: 0.7, detail: "nav", ringOpacity: 0.11, flowOpacity: 0.15, glint: false });
    // ③ 静止轨道：赤道环带（几不可见）+ 向日葵 9 号钉在东经
    // 140.7°——它是 satInner 的静态子物体、随 earth 组与地表严格
    // 同步，在球上永远停在日本上方（真实物理彩蛋，不挂名）
    {
      const GEO_R = 1.58;
      // GEO 环带同步提一档到「细心看能找到那条线」，流光极缓
      satInner.add(makeOrbitRing(GEO_R, 0.1));
      const geoFlow = makeOrbitFlow(GEO_R, 0.13);
      satInner.add(geoFlow);
      const hPanelMat = makeSatPanelMat();
      const hBuilt = makeSatBody("hero", 1.1, hPanelMat);
      const himawari = hBuilt.group;
      himawari.position.copy(latLonToVec3(0, 140.7, GEO_R));
      const hDir = himawari.position.clone().normalize();
      // 姿态同轨道系：X = 轨道法向（极轴）、Y = 径向、Z = 切向
      // （东向），天线锅对地、板翼沿法向伸展
      const hZ = new THREE.Vector3(hDir.z, 0, -hDir.x).normalize();
      himawari.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 1, 0),
          hDir,
          hZ,
        ),
      );
      satInner.add(himawari);
      const hGlint = makeSatGlint(himawari);
      // 向日葵前方（东向）一小段静态领航光
      const hLead = makeLeaderArc(GEO_R);
      for (let i = 0; i <= LEAD_N; i++) {
        const p = latLonToVec3(0, 140.7 + 0.6 + (i / LEAD_N) * 4.2, GEO_R);
        hLead.pos[i * 3] = p.x;
        hLead.pos[i * 3 + 1] = p.y;
        hLead.pos[i * 3 + 2] = p.z;
      }
      (hLead.line.geometry.getAttribute("position") as THREE.BufferAttribute)
        .needsUpdate = true;
      satInner.add(hLead.line);
      let hWingTheta = 0;
      satTickers.push((ct) => {
        geoFlow.rotation.y = ct * 0.008;
        // 向日葵扫光：16 秒一扫——它钉在日本上方、太平洋视角的
        // 正中，静置 20 秒内必然见到至少一次板面扫光（本轮反
        // 光验收的硬指标锚点）
        const hsph = (((ct / 16 + 0.3) % 1) + 1) % 1;
        hPanelMat.uniforms.uSweep!.value = -0.25 + 1.5 * hsph;
        // 向日葵板翼追日（地球本地系内太阳向近乎不动，角度基本
        // 恒定，仍走同一套平滑逻辑保持口径一致）
        if (hBuilt.wingL && hBuilt.wingR) {
          const sy = sunLocal.dot(hDir);
          const sz = sunLocal.dot(hZ);
          if (Math.hypot(sy, sz) > 0.2) {
            const target = Math.atan2(sz, sy);
            let d = target - hWingTheta;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            hWingTheta += d * 0.1;
          }
          hBuilt.wingL.rotation.x = hWingTheta;
          hBuilt.wingR.rotation.x = hWingTheta;
        }
        const sunFace = hDir.dot(sunLocal);
        const flash = Math.pow(
          Math.max(0, Math.sin(ct * 0.7 + 1.3)),
          24,
        );
        hGlint.opacity =
          0.45 *
          flash *
          THREE.MathUtils.clamp((sunFace - 0.1) / 0.5, 0, 1) *
          satFadeNow;
      });
      // 两颗无名背景静止星（小光点剪影，无圈无闪）
      for (const lon of [62, -138]) {
        const dot = makeSatBody("dot", 0.55).group;
        dot.position.copy(latLonToVec3(0, lon, GEO_R));
        satInner.add(dot);
      }
    }

    // —— 流星雨（夜空四单 · 故事层，2026-11-12；设计稿 = goal-5
    // GOAL.md「流星雨设计」+ 总原则/色板节）——
    // 终局形态（2026-11-12 深夜 JI 两连令）：① 22:51——主页呈
    // 现改「星辰坠落」式前景星幕（2D 覆盖画布，见 animate 内星
    // 幕段与画布创建处注记），取代夜半球薄壳的找星游戏；②
    // 22:55「不要了」——夜半球薄壳系统（挂 earth 组的池化着色
    // 器 Mesh + spawnMeteor 生成整套）彻底移除，主页与太阳系
    // 都不再有贴球面雨。流星雨自此只有主页星幕一种呈现：会话
    // 时钟与速率曲线不变（1:30 前零、1:30–2:30 稀疏渐强
    // 0.12→2.72 颗/秒、2:30–3:00 峰值约 4.2 颗/秒、火流星峰值
    // 段 8%），寿命 <1 秒，reduced-motion 不生成、客串主页不下、
    // 窗口外零痕迹。签名于 23:23 忠实化升级：亮头火焰 flicker +
    // 呼吸光晕、金白星尘交织蓝紫星辉的拖尾（火流星橙红燃烧色
    // 阶）、燃尽星尘散落 + 幕布星尘氛围；23:34 再补闪烁四层（闪
    // 烁是签名）：约 2.6 秒波次调制、170 粒空中闪烁场（一闪一
    // 灭）、沿途脱落星尘（原地闪 0.2–0.4 秒）、落点四角星芒闪
    // 光（逐帧口径见 animate 星幕段）。23:50 再改判换色：整体
    // 白紫系（近白炽头 + 紫色光晕、白→紫拖尾、白紫星尘/星芒，
    // 火流星同色系更亮更满），金/香槟/橙红全撤、机制不变（见
    // animate 星幕拖尾色阶处注）。00:08 再定版为逐颗四档变体
    // 配方（月白紫 55 / 蓝白 27 / 钙紫粉 13 / 镁绿白 5 + 约 3%
    // 火流星放大），23:50 的单色板作废（见 CURTAIN_VARIANTS 处
    // 注）。2026-11-13 晚再添陨石：最大尺寸档（火流星）直接被
    // 实心陨石顶替（无概率、无时段限定、无每循环硬顶——JI 终
    // 令，原话见 curtainRocks 处注）——岩石本体 + 熔边 + 尘烟
    // 尾 + 碎裂火花 + 终末闪爆，设计见 rockSprites / curtainRocks 两处注。彗
    // 星本体与双尾是轨道空间的独立渲染，与此无关。
    // —— 主页星幕状态（2D 覆盖层）——
    type CurtainMeteor = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      len: number;
      w: number;
      fire: boolean;
      /** 配色变体档位（CURTAIN_VARIANTS 下标，生成时按权重抽定） */
      v: number;
      /** 该档渐变各停点的 rgb 串（生成时已按 ±5% 逐通道预抖） */
      cols: string[];
      /** 轨缀星点的 rgb 串（取该档尾段色，同场同色） */
      sparkRgb: string;
      /** 头部闪烁的逐颗相位种子（同批星各闪各的，不齐闪） */
      ph: number;
      /** 轨缀星点的撒点累加器（秒）：沿轨每约 0.028 秒缀一粒 */
      shed: number;
      /** 头部星芒 glint 的逐颗计时器（秒）：头部偶发一闪即过的星芒 */
      glint: number;
    };
    const curtainMeteors: CurtainMeteor[] = [];
    // —— 陨石（2026-11-13 新增，设计口径见 rockSprites 处注）：
    // 最大尺寸档（火流星，约 3%）直接顶替为陨石——无概率、无
    // 时段限定、无每循环硬顶（JI 2026-11-13 终令：「直接把最
    // 大尺寸的火流星用陨石代替，不然概率太低了」；先前 0.35
    // 概率 + 峰值段 + 每循环一颗的口径同日作废）。期望账：整
    // 个流星窗（90–180 秒）约 210 颗坠星 × 3% ≈ 每循环 6 颗上
    // 下陨石，随生成率曲线分布（稀疏段零星、峰值段较密）。陨
    // 石不走四层光轨：实心岩石本体（source-over
    // 压暗成形）+ 前缘熔边 + 身后尘烟与余烬 + 沿途碎裂火花，终
    // 末在落点闪爆。坠速比火流星更沉更慢（寿命 2.6–3.2 秒对火
    // 流星 1.9–2.2 秒），本体直径 20–26px 不超原最大档占位。
    type CurtainRock = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      /** 本体半径（CSS px，10–13） */
      r: number;
      /** 岩体精灵款式下标（0–2） */
      sp: number;
      /** 燃闪逐颗相位种子 */
      ph: number;
      /** 尘烟吐出累加器（秒） */
      smokeAcc: number;
      /** 余烬脱落累加器（秒） */
      emberAcc: number;
      /** 碎裂火花计时器（秒）：每 0.5–1.0 秒崩落一块 */
      fragT: number;
    };
    const curtainRocks: CurtainRock[] = [];
    let rockSpawnedTotal = 0;
    type CurtainPuff = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      /** 初生半径（CSS px），随龄膨胀约 3.6 倍后消散 */
      s0: number;
    };
    const curtainPuffs: CurtainPuff[] = [];
    type CurtainEmber = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      sz: number;
    };
    const curtainEmbers: CurtainEmber[] = [];
    type CurtainFrag = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      sz: number;
      ph: number;
    };
    const curtainFrags: CurtainFrag[] = [];
    type CurtainBoom = {
      x: number;
      y: number;
      age: number;
      life: number;
    };
    const curtainBooms: CurtainBoom[] = [];
    let curtainAcc = 0;
    let curtainDrawn = false;
    // —— 星幕质感层：① 轨缀星点池（2026-11-13 09:29 新口径，
    // CurtainSpark 结构沿用）——沿轨缀入的静止星尘，原地闪
    // 0.35–0.6 秒即灭（封顶 300），嵌在轨身辉光里让拖尾「缀
    // 星」；② 空中星尘闪烁场（主签名）——幕布区域预置 170 粒
    // 微尘（相对坐标存位、resize 安全），各自随机相位独立一闪
    // 一灭（锐化的亮-灭曲线，不是呼吸微光），密度/亮度随窗口
    // 强度包络 curtainDustEnv 走、峰值段最密，窗口外归零无
    // 痕；③ 落点星闪池——坠星到终点炸开的四角星芒小闪光（约
    // 0.3 秒，闪完即灭不留痕）。
    type CurtainSpark = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      /** rgb 串：继承母星变体档的尾段色（同场坠星同色） */
      rgb: string;
      /** 粒径随机因子 0–1 */
      sz: number;
      ph: number;
    };
    const curtainSparks: CurtainSpark[] = [];
    type CurtainFlash = {
      x: number;
      y: number;
      age: number;
      life: number;
      size: number;
    };
    const curtainFlashes: CurtainFlash[] = [];
    // —— 白磷烟迹池与燃烧碎屑池已整层退役（2026-11-13 09:28 改
    // 判，炉石金卡「星辰坠落」卡图口径：干净的星光直坠、无烟无
    // 溅）——烟团精灵/烟池/迸溅燃屑/燃尽散落/烟中亮闪全部删除，
    // 不许残留；沿途质感改由「轨缀星点」承担（见 CurtainSpark
    // 池的新口径：静止缀闪的星尘，不是弹道碎屑）。
    // —— 闪耀层（2026-11-13 追加，用户：「还要加一点闪耀✨的效
    // 果」；09:28 改判后保留，与卡图满天星点呼应）：两源共用一
    // 池——① 场域小闪：幕布内随机位置倏起倏灭的小号四角星芒
    // （与落点星闪同形制、更小），密度随强度包络 curtainDustEnv
    // 走（峰值成场、稀疏段零星、窗口外不生成）；② 头部 glint：
    // 坠星头部偶发一闪星芒（逐颗计时器）。颜色 = 白芯 + 场域档
    // 色淡芒（取附近/当下坠星的档，无坠星时月白紫兜底）。池封
    // 顶 90 粒（单粒寿命 0.2–0.45 秒，峰值稳态约 15–25 粒，帧
    // 成本可忽略）；reduced-motion 下随星幕整体不生成
    type CurtainSparkle = {
      x: number;
      y: number;
      age: number;
      life: number;
      /** 星芒半长（px） */
      size: number;
      /** 外层淡芒的 rgb 串（场域档的 halo 色） */
      rgb: string;
    };
    const curtainSparkles: CurtainSparkle[] = [];
    let sparkleAcc = 0;
    const curtainDust: { fx: number; fy: number; ph: number; sz: number; hue: number }[] = [];
    for (let i = 0; i < 170; i++) {
      curtainDust.push({
        fx: Math.random(),
        fy: Math.pow(Math.random(), 1.3),
        ph: Math.random() * Math.PI * 2,
        sz: 0.8 + Math.random() * 1.5,
        hue: Math.random(),
      });
    }
    let curtainTime = 0;
    let curtainDustEnv = 0;
    /** 夜空四单验收钩子（无 UI、不可见，同 __financeGlobeUfo 口径）：
     * 读当前循环秒 / 季节权重 / 星幕存活数，供审计探针做时间序
     * 列核对，不记录帧数据。meteors() 自薄壳雨移除后即星幕存活
     * 数（curtain() 为其别名）。旧 comet() 读数随客串彗星下线
     * 一并移除。 */
    const nightState = { cycle: 0 };
    (window as unknown as Record<string, unknown>).__financeGlobeNight = {
      cycle: () => nightState.cycle,
      weights: () => ({ ...starWeights }),
      meteors: () => curtainMeteors.length,
      curtain: () => curtainMeteors.length,
      meteorites: () => curtainRocks.length,
      rocks: () => rockSpawnedTotal,
    };

    // 地球图层登记（切换时整组显隐；记录各自的原 visible 以便还原）
    const earthContent = earth.children.map((o) => ({ o, v: o.visible }));
    // —— 主页月球上的访客：与太阳系月球同一套纸片人散步逻辑（共用
    // stepPaperWalker），挂在主页月球本体上（独立实例/独立随机源，
    // 两边互不干扰；同样分散在整个月面）
    let homeWalkers: PaperWalker[] = [];
    let homeRand: (() => number) | null = null;
    const stepHomeWalkers = (sdt: number) => {
      if (!homeRand) return;
      for (const w of homeWalkers) {
        // 主页模式漫游半径收紧（0.34 rad）：居民只在上方家点周边活动，
        // 不许游到盘面下半部去倒立（太阳系月球仍用全表面 0.55）
        stepPaperWalker(w, sdt, homeRand, HOME_R, 0.34);
      }
    };
    /**
     * 主页居民「上方安家」（用户原话要求）：星球回到主页时，居民要
     * 出现在从主页相机看过去的上半盘面——否则按法线站立的纸片人
     * 在下缘整只倒置、在侧缘横躺。做法：按进入主页这一刻的完整姿
     * 态（地球组四元数 × 主页自转相位）把世界系的「前上方」扇区
     * （方位 −32°…+32°、仰角 22°…46°）反算回月球本地系，逐只重
     * 置家点与当前位置；每次主页模式被激活（hpActive 翻 true）都
     * 重新安家一次，保证「返回主页」的第一眼永远是上方、正立或
     * 接近正立的居民。脚踩地（法线站立）不动：变的只是家点位置。
     */
    const placeHomeWalkersUpper = () => {
      if (!homeWalkers.length) return;
      const totalQ = earth.quaternion
        .clone()
        .multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            homeSpin,
          ),
        );
      const invQ = totalQ.clone().invert();
      const azs = [-0.56, -0.28, 0, 0.28, 0.56];
      const els = [0.62, 0.42, 0.8, 0.5, 0.68];
      homeWalkers.forEach((w, i) => {
        const az = azs[i % azs.length]!;
        const el = els[i % els.length]!;
        const worldDir = new THREE.Vector3(
          Math.sin(az) * Math.cos(el),
          Math.sin(el),
          Math.cos(az) * Math.cos(el),
        );
        const local = worldDir.applyQuaternion(invQ).normalize();
        w.home.copy(local);
        w.dir.copy(local);
        const upRef =
          Math.abs(local.y) > 0.9
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 1, 0);
        const t1 = new THREE.Vector3()
          .crossVectors(upRef, local)
          .normalize();
        w.fwd.copy(
          t1.applyAxisAngle(local, (i * 1.7) % (Math.PI * 2)).normalize(),
        );
        w.state = "walk";
        w.timer = 2 + i * 0.7;
        w.sprite.position.copy(w.dir).multiplyScalar(HOME_R);
        w.shadow.position.copy(w.dir).multiplyScalar(HOME_R + 0.002);
      });
    };
    /**
     * 地平线淡出（防「半截沉进轮廓」）：纸片人是平 billboard，走到
     * 球体轮廓附近时平面会与球面相交、下半身被啃。按居民法线与
     * 「球心→镜头」方向的夹角余弦做透明度：正对镜头 = 1，接近轮
     * 廓（余弦 < 0.30）线性淡出、到 0.03 全隐——效果是居民在地平
     * 线处「走下山坡」消失，而不是半截陷在轮廓里。host 为居民所
     * 挂的球体网格（太阳系月球 / 主页月球共用此函数）。
     */
    const fadePaperHorizon = (
      walkers: PaperWalker[],
      host: THREE.Object3D,
      fadeStart = 0.03,
      fadeSpan = 0.27,
    ): void => {
      if (!walkers.length) return;
      const local = host
        .worldToLocal(camera.position.clone())
        .normalize();
      for (const w of walkers) {
        const f = w.dir.dot(local);
        const o = Math.min(1, Math.max(0, (f - fadeStart) / fadeSpan));
        w.mat.opacity = o;
        w.sprite.visible = o > 0.02;
        // 接触影与本体同歩淡出（影在球面上，转过地平线一起消失）
        w.shadowMat.opacity = 0.34 * o;
        w.shadow.visible = o > 0.02;
      }
    };
    /**
     * 「脚踩地」的朝向合成 + 正/背（侧）面切换（逐帧，与步进解耦）：
     * (1) 法线对齐：居民所在点的月面法线 → 世界系 → 相机视图系，
     * 其屏幕投影方向就是「当地的径向朝外」在画面上的方向；精灵的
     * 面内旋转（material.rotation）平滑趋近它（精灵上方向 = 目标
     * 方向时 rotation = atan2(−nx, ny)），身体轴线于是永远沿当地
     * 径向立着——盘面中心处法线正对镜头、投影退化（长度 < 0.12）
     * 时保持上一次的角度，不抖不翻。倾摆（tilt）与步态压缩
     * （squash，绕脚底锚点）在此一并合成。
     * (2) 正/背面：行走时按行进方向在居民切平面内相对镜头的投影
     * 判定——朝镜头这侧走用正面、背离走用背离面（官方侧面图）；
     * 带死区（|投影| < 0.06 不切，横向走时不抖）。切换走 0.24s
     * 翻面：横向压扁 → 中点换图 → 展开，像纸片翻面而不是硬切。
     * 停下张望保持当前面。
     */
    const updatePaperFacing = (
      walkers: PaperWalker[],
      host: THREE.Object3D,
      dt: number,
    ): void => {
      if (!walkers.length) return;
      const local = host
        .worldToLocal(camera.position.clone())
        .normalize();
      const hostQ = new THREE.Quaternion();
      host.getWorldQuaternion(hostQ);
      for (const w of walkers) {
        const nView = w.dir
          .clone()
          .applyQuaternion(hostQ)
          .transformDirection(camera.matrixWorldInverse);
        const projLen = Math.hypot(nView.x, nView.y);
        if (projLen > 0.12 && dt > 0) {
          const target = Math.atan2(-nView.x, nView.y);
          let d = target - w.radialRot;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          w.radialRot += d * Math.min(1, dt * 9);
        }
        w.mat.rotation = w.radialRot + w.tilt;
        w.sprite.scale.y = w.baseH * w.squash;
        if (w.flip >= 0) {
          const prev = w.flip;
          w.flip += dt / 0.24;
          if (prev < 0.5 && w.flip >= 0.5) {
            w.mat.map = w.facing === "front" ? w.frontTex : w.awayTex;
            w.mat.needsUpdate = true;
          }
          if (w.flip >= 1) {
            w.flip = -1;
            w.sprite.scale.x = w.baseW;
          } else {
            w.sprite.scale.x =
              w.baseW * Math.max(0.05, Math.abs(Math.cos(Math.PI * w.flip)));
          }
          continue;
        }
        if (w.state !== "walk") continue;
        const tc = local
          .clone()
          .addScaledVector(w.dir, -local.dot(w.dir));
        if (tc.lengthSq() < 1e-4) continue;
        const toward = w.fwd.dot(tc.normalize());
        const desired =
          toward > 0.06 ? "front" : toward < -0.06 ? "away" : w.facing;
        if (desired !== w.facing) {
          w.facing = desired;
          w.flip = 0;
        }
      }
    };
    const buildHomePlanet = (id: string) => {
      for (const g of [homeSpinner, homeFixed]) {
        while (g.children.length) g.remove(g.children[0]!);
      }
      homeWalkers = [];
      homeRand = null;
      homeSunMat = null;
      homeSuiseiTick = null;
      homePlanetMesh = null;
      homeRingMesh = null;
      homeRingMatch = 1;
      homeSpin = 0;
      if (id === "earth") return;
      let mesh: THREE.Mesh;
      if (id === "sun") {
        homeSunMat = makeSunMaterial(makeSunTexture(!isCoarse));
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(HOME_R, 40, 28),
          homeSunMat,
        );
      } else if (id === "moon") {
        const hMoon = makeMoonMaps(!isCoarse);
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(HOME_R, 40, 28),
          new THREE.MeshPhongMaterial({
            map: hMoon.map,
            bumpMap: hMoon.bump,
            bumpScale: 0.5,
            emissive: 0x11131a,
            shininess: 8,
          }),
        );
      } else if (id === "suisei") {
        // 星街彗星主页形态：同纹理 + 本体自发光 + 专属光效满规格
        // （纬度大气壳/呼吸光晕/盘缘暖辉/表面流光/星尘——与太阳
        // 系本体同一套构建器、按 HOME_R 定尺）；逐帧由
        // homeSuiseiTick 驱动（animate 主页星球段）
        const tex = makeGuestPlanetTexture(!isCoarse);
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(HOME_R, 48, 32),
          new THREE.MeshPhongMaterial({
            map: tex,
            emissiveMap: tex,
            emissive: new THREE.Color(0.42, 0.42, 0.42),
            shininess: 8,
          }),
        );
        const fxMats: THREE.ShaderMaterial[] = [];
        const fxGlows: Array<{
          mat: THREE.SpriteMaterial;
          base: number;
          shimmer: number;
        }> = [];
        const shell = makeSuiseiShell(HOME_R * 1.16);
        mesh.add(shell.mesh);
        fxMats.push(shell.mat);
        const addHomeGlow = (
          map: THREE.Texture,
          scaleF: number,
          base: number,
          shimmer: number,
        ) => {
          const m = new THREE.SpriteMaterial({
            map,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            opacity: 0,
          });
          const sp = new THREE.Sprite(m);
          sp.scale.set(HOME_R * scaleF, HOME_R * scaleF, 1);
          sp.renderOrder = 2;
          mesh.add(sp);
          fxGlows.push({ mat: m, base, shimmer });
        };
        addHomeGlow(
          makeGlowTexture(
            "rgba(255,150,80,0.55)",
            "rgba(255,90,40,0.16)",
          ),
          6.4,
          0.5,
          1.1,
        );
        addHomeGlow(makeLimbGlowTexture("255,130,70", false), 4.6, 0.38, 0);
        const rand = seededRand(777);
        const specH = (
          lon: number,
          lat: number,
          radF: number,
          speed: number,
          sizeF: number,
          freq: number,
        ): FlowPointSpec => ({
          lon,
          lat,
          rad: HOME_R * radF,
          speed,
          size: HOME_R * sizeF,
          phase: rand() * Math.PI * 2,
          freq,
        });
        const amber: FlowPointSpec[] = [];
        for (let i = 0; i < 64; i++) {
          amber.push(
            specH(
              rand() * Math.PI * 2,
              (rand() - 0.5) * 1.9,
              1.05,
              0.05 + rand() * 0.05,
              0.3 + rand() * 0.22,
              0.25 + rand() * 0.4,
            ),
          );
        }
        const f1 = makeFlowPoints(amber, {
          color: "#ffc46b",
          opacity: 0.5,
          twinkleAmp: 0.2,
        });
        mesh.add(f1.points);
        fxMats.push(f1.mat);
        const olive: FlowPointSpec[] = [];
        for (let i = 0; i < 40; i++) {
          olive.push(
            specH(
              rand() * Math.PI * 2,
              -0.25 - rand() * 1.05,
              1.05,
              0.04 + rand() * 0.04,
              0.28 + rand() * 0.2,
              0.25 + rand() * 0.4,
            ),
          );
        }
        const f2 = makeFlowPoints(olive, {
          color: "#d7e28a",
          opacity: 0.42,
          twinkleAmp: 0.2,
        });
        mesh.add(f2.points);
        fxMats.push(f2.mat);
        const dust: FlowPointSpec[] = [];
        for (let i = 0; i < 40; i++) {
          dust.push(
            specH(
              rand() * Math.PI * 2,
              Math.asin(rand() * 2 - 1),
              1.3 + rand() * 0.45,
              0.008 + rand() * 0.014,
              0.09 + rand() * 0.07,
              0.8 + rand() * 1.6,
            ),
          );
        }
        const f3 = makeFlowPoints(dust, {
          color: "#ffd9a8",
          opacity: 0.55,
          twinkleAmp: 1.0,
        });
        mesh.add(f3.points);
        fxMats.push(f3.mat);
        homeSuiseiTick = (t) => {
          const uH = renderer.domElement.height * 1.302;
          for (const m of fxMats) {
            m.uniforms.uTime!.value = t;
            m.uniforms.uFade!.value = 1;
            if (m.uniforms.uScaleH) m.uniforms.uScaleH.value = uH;
          }
          for (const s of fxGlows) {
            s.mat.opacity =
              s.base *
              (s.shimmer
                ? 0.88 + 0.12 * Math.sin(t * s.shimmer + 1.7)
                : 1);
          }
        };
      } else {
        const def = PLANET_ELEMENTS.find((p) => p.id === id);
        if (!def) return;
        const hMaps = planetMaps(def.name, def.color, !isCoarse);
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(HOME_R, 48, 32),
          new THREE.MeshPhongMaterial({
            map: hMaps.map,
            bumpMap: hMaps.bump ?? undefined,
            bumpScale: hMaps.bump ? 0.6 : undefined,
            emissive: new THREE.Color(def.color).multiplyScalar(0.05),
            shininess: 14,
          }),
        );
        if (id === "saturn") {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(HOME_R * 1.32, HOME_R * 2.25, 64),
            new THREE.MeshBasicMaterial({
              map: makeSaturnRingTexture(),
              transparent: true,
              opacity: 0.92,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          );
          ring.rotation.x = -Math.PI / 2 + 0.42;
          homeFixed.add(ring);
          homeRingMesh = ring;
          // 太阳系土星环外缘 2.58R vs 代理环 2.25R（见 homeRingMatch）
          homeRingMatch = 2.58 / 2.25;
        }
        if (id === "uranus") {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(HOME_R * 1.55, HOME_R * 1.68, 64),
            new THREE.MeshBasicMaterial({
              map: makeUranusRingTexture(),
              color: 0xbfe8e2,
              transparent: true,
              opacity: 0.6,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          );
          ring.rotation.x = -Math.PI / 2 + 1.2;
          homeFixed.add(ring);
          homeRingMesh = ring;
          // 太阳系天王星环外缘 1.78R vs 代理环 1.68R
          homeRingMatch = 1.78 / 1.68;
        }
      }
      homePlanetMesh = mesh;
      homeSpinner.add(mesh);
      if (id === "moon") {
        // 赛伯小队在主页月球上安家：纸片人分散在整个月面、同样的
        // 走停逻辑（独立随机源，与太阳系月球互不干扰）
        homeRand = seededRand(515007);
        const rand = homeRand;
        const count = isCoarse ? 4 : 5;
        for (let i = 0; i < count; i++) {
          const homeDef = SERPO_HOME_DIRS[i] ?? SERPO_HOME_DIRS[0]!;
          const home = new THREE.Vector3(
            homeDef[0],
            homeDef[1],
            homeDef[2],
          ).normalize();
          const walker = makePaperWalker(
            serpoTexSet[i] ?? serpoTexSet[0]!,
            home,
            rand,
            0.26,
            i,
          );
          walker.sprite.position
            .copy(walker.dir)
            .multiplyScalar(HOME_R);
          mesh.add(walker.sprite);
          mesh.add(walker.shadow);
          homeWalkers.push(walker);
        }
      }
    };

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = (performance.now() - startMs) / 1000;
      const st = stateRef.current;
      // 夜空会话时钟：以空间打开为零点（t 即会话秒）、起始相
      // 位 0:55（确定性、不掷骰子），主页流星雨的开窗/峰值全
      // 挂这条 180 秒循环；验收钩子同步读数。客串彗星下线后
      // 本时钟只服务流星雨，相位口径一字未动（护栏）
      const nightCycleT = (NIGHT_START_PHASE_S + t) % NIGHT_CYCLE_S;
      nightState.cycle = nightCycleT;
      // 彗星舞台时钟（轮值口径见 COMET_STAGE_S 处注）：四幕轮
      // 值、任一时刻至多一颗彗星在场；stageEnv(u) = 幕内包络
      // （幕外 0、首尾各 8 秒 smoothstep 淡入淡出）
      const stageMt = reducedMotion
        ? COMET_STAGE_PHASE
        : (t + COMET_STAGE_PHASE) % COMET_STAGE_S;
      const stageEnv = (u: number) =>
        u <= 0 || u >= COMET_SLOT_S
          ? 0
          : sstep(u / COMET_ENV_S) *
            sstep((COMET_SLOT_S - u) / COMET_ENV_S);
      frame++;
      const dt = Math.min(0.1, Math.max(0.001, t - prevT));
      // 未钳制的真实帧间隔（上限 0.5 秒）：只给流星生成累加器用
      // ——它对账的是走真实会话秒的窗口时钟，不能吃钳制后的 dt
      const rawDt = Math.min(0.5, Math.max(0, t - prevT));
      prevT = t;

      // —— 太阳系过渡（约 2.3 秒，easeInOutCubic 单一曲线贯穿）——
      // 学 fly-to 类案例的连续镜头运动：进度线性推进、全体元素共用
      // 同一条 cubic 缓动——镜头沿弧线拉远（下方相机段），监控图层
      // （点阵/弧线/标签）先分层淡出，太阳辉光中段渐显，轨道圈按
      // 由内到外顺序逐个淡入、行星随之展开；返回时同一曲线反向。
      // 过渡期间输入被 transitionBusy() 锁住，落位才放开。
      const transGoal = st.solarSystem ? 1 : 0;
      trans += THREE.MathUtils.clamp(transGoal - trans, -dt / 2.3, dt / 2.3);
      trans = THREE.MathUtils.clamp(trans, 0, 1);
      const eTrans = easeInOutCubic(trans);
      // 分层时序（都长在同一条 eTrans 上）：
      // 监控图层淡出 0.02→0.45；太阳渐显 0.30→0.85；轨道 i 淡入
      // 0.28+i×0.05 → +0.30；行星本体/标签随其轨道同拍展开
      const globeFade = 1 - sstep((eTrans - 0.02) / 0.43);
      const sunFade = sstep((eTrans - 0.3) / 0.55);
      const orbitFade = (i: number) =>
        sstep((eTrans - (0.28 + i * 0.05)) / 0.3);
      // —— 主页星球逐帧：替代显示的生效时机是这轮修的根子——
      // 旧逻辑等过渡落位（trans<0.05）才换球：连点火星送主页时，
      // App 在同一帧里把 homePlanet 改成火星、solarSystem 改回
      // false，但球要等 2.3 秒飞回动画跑完才应用，整段回程看到
      // 的都是地球、最后一帧硬切火星（用户实报的闪切 bug）。
      // 现行（双向对称）：只要目标是回主页（transGoal===0）且
      // 主页星球非地球，从转场第一帧就生效，飞回的那颗球从头到
      // 尾就是目标星球，落位即主页构图，无末尾闪切。反向（主页
      // 星球返回太阳系）同理对称：出程全程保持主页星球生效，直
      // 到 trans = 1（飞行严格完成）才交接。
      // —— 落位抽动的根因（本轮实测公式账，用户实报「回太阳系落
      // 位瞬间整个太阳系缩放抽动一下」）：旧交接点在 trans≥0.97
      // （eTrans=0.99989），整场缩放 solarGroup.scale 与相机距离
      // 在该帧前后其实连续（0.99985→0.99993→1.00000），跳的是同
      // 帧发生的两处不对齐：①环口径——代理环几何（土星外缘
      // 2.25R / 天王星 1.68R）与太阳系本体环（2.58R / 1.78R）从
      // 未对齐，插值只对齐球体：交接帧土星环外径 0.630→0.722 世
      // 界单位、一帧跳 +14.6%（天王星 +5.9%）；②地球弹入——地
      // 球图层被 hpActive 压到交接帧才整组恢复，不透明球体（移
      // 动端盘面直径约 23px）在一帧内从无到有，其标签却早在
      // trans≈0.83 已淡入完成。两处跳变同帧叠在落位瞬间，近览
      // 里地球与客串星球又是最大的两颗盘面，看着就是整个系统抽
      // 了一下。球体本身的插值残差只有 (1−eTrans)·(fit−solarScale)
      // ≈0.08%，不是主因。修法：交接推到 trans=1（eTrans 严格
      // =1，代理与本体的 scale/位置在交接帧按公式恒等）；环在
      // 飞行中按 homeRingMatch 渐变到本体口径（见末尾同步段）；
      // 地球图层改走 earthReveal 斜坡（trans 0.82→1 渐显），不
      // 再整组弹入。
      // 进出轨迹走哪条路是另一条根子（用户实报「星球进入主页和
      // 返回太阳系都是从地球那里进出的」）：旧实现把主页星球组
      // 逐帧钉在地球组的位置/缩放上，地球组只会沿原点↔地球轨道
      // 位飞，于是哪颗星当主页都借道地球。现行轨迹见 animate 末
      // 尾的位置同步：按目标天体自己在太阳系里的世界位置/半径
      // 插值——从它自己的轨道位置进、回它自己的轨道位置。
      const hpId = st.homePlanet ?? "earth";
      if (hpId !== builtHomeId) {
        buildHomePlanet(hpId);
        builtHomeId = hpId;
      }
      const hpActive =
        hpId !== "earth" && (transGoal === 0 || trans < 1);
      if (hpActive !== hpWasActive) {
        hpWasActive = hpActive;
        if (hpActive) {
          hpActiveSince = t;
          // 返回主页的第一眼：月球居民重新安家到上半盘面（见
          // placeHomeWalkersUpper），不许以下缘倒置的样子迎接用户；
          // 落位推迟到本帧相位锁算完 homeSpin 之后执行（下方）
          if (hpId === "moon") pendingUpperPlace = true;
        }
        for (const rec of earthContent) rec.o.visible = hpActive ? false : rec.v;
        atmosphere.visible = !hpActive;
        atmosphereOuter.visible = !hpActive;
        halo.visible = !hpActive;
        homePlanetGroup.visible = hpActive;
      }
      // —— 地球图层渐显（earthReveal，客串主页专用）：回太阳系飞
      // 行尾段 trans 0.82→1 之间由 0 斜坡到 1（约 0.41 秒），逐帧
      // 驱动球体透明度、经纬网与城市标签淡入；地球位置/缩放此时
      // 已走完 98% 以上的既有 lerp，渐显与落位同一条曲线完成，
      // 交接帧不再有整颗盘面弹入。回主页/主页停留时恒 0（地球图
      // 层保持隐藏，与旧行为一致）；hpId 切回地球时立即复位材质，
      // 不许把透明状态残留给主页地球。
      if (hpId === "earth") {
        earthRevealNow = 1;
        const sm = sphere.material as THREE.MeshPhongMaterial;
        if (sm.transparent) {
          sm.opacity = 1;
          sm.transparent = false;
        }
        (gratLines.material as THREE.LineBasicMaterial).opacity = 0.13;
      } else {
        earthRevealNow =
          transGoal === 1 ? sstep((trans - 0.82) / 0.18) : 0;
        const showEarth = earthRevealNow > 0.001;
        for (const rec of earthContent) {
          rec.o.visible = rec.v && showEarth;
        }
        const sm = sphere.material as THREE.MeshPhongMaterial;
        if (earthRevealNow < 1) {
          sm.transparent = true;
          sm.opacity = earthRevealNow;
        } else if (sm.transparent) {
          sm.opacity = 1;
          sm.transparent = false;
        }
        (gratLines.material as THREE.LineBasicMaterial).opacity =
          0.13 * earthRevealNow;
      }
      if (hpActive) {
        homePlanetGroup.quaternion.copy(earth.quaternion);
        if (hpId === "sun") {
          // 太阳是自发光 shader，不吃光照，无需相位锁，维持自转推进
          if (st.autoRotate && !reducedMotion) {
            homeSpin += (dt * Math.PI * 2) / (HOME_SPIN_PERIOD[hpId] ?? 65);
          }
        } else {
          // 入场相位锁（客串星球构图/光照修复）：旧逻辑让主页星球
          // 套地球的自转相位进场，真实太阳此刻照在哪片地理全凭运
          // 气——火星/月球上主页时正对镜头的常是暗面（录屏实证：
          // 火星几乎全黑、只剩顶部一线亮）。现行：逐帧解算自转相
          // 位，把直射点经线转到朝向镜头的一侧（亮面迎客），再叠
          // 该天体自身周期的慢漂移——球仍在转，但亮面始终留在镜
          // 头这半边，不拿暗面招待用户。
          // —— 手动拖转被相位锁吃掉的根子（用户实报「星街彗星选
          // 中进主页手动转有 bug」，数值复算坐实）：相位若拿含拖
          // 拽偏移的 earth.quaternion 反解 camLocal，用户横拖
          // dragYaw 多少、相位就反向补多少——朝向镜头的球面经度
          // 变化恒为 0.0000，球面被钉死、横拖完全没反应（俯仰拖
          // 只经 atan2 漏出倾斜，所以症状是「能上下歪、不能左右
          // 转」）。相位锁的职责只是抵消展示自转、把亮面留在镜头
          // 这半边，用户的手不在它的辖区：camLocal 改由无拖拽的
          // 基线姿态（HOME_TILT_X + displayYaw + 0.12，与 earth
          // .rotation.set 的无偏移部分同式）反解——本段运行时
          // displayYaw 尚未被本帧推进段改写，正是 group 本帧
          // copy 的那份 earth.quaternion 的基线分量，同帧对齐。
          // 效果（同式数值验证）：横拖 Δ经度 ≈ 1:1 跟手、俯仰
          // Δ纬度 ≈ 1:1、无拖时自转推进 Δ经度 = 0.0000（亮面迎
          // 客不回退）；松手后 dragYaw 按既有口径缓动回 0，球面
          // 随之平滑回到相位锁姿态，与地球主页的偏移归宿一致。
          homeBaseEuler.set(HOME_TILT_X, displayYaw, 0.12);
          homeBaseQuat.setFromEuler(homeBaseEuler);
          homeBaseQuatInv.copy(homeBaseQuat).invert();
          const camLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(
            homeBaseQuatInv,
          );
          const phase =
            Math.atan2(camLocal.x, camLocal.z) -
            Math.atan2(sunLocal.x, sunLocal.z);
          const drift = st.autoRotate && !reducedMotion
            ? ((t - hpActiveSince) * Math.PI * 2) /
              (HOME_SPIN_PERIOD[hpId] ?? 65)
            : 0;
          homeSpin = phase + drift;
        }
        homeSpinner.rotation.y = homeSpin;
        if (pendingUpperPlace) {
          pendingUpperPlace = false;
          placeHomeWalkersUpper();
        }
        if (homeSunMat) homeSunMat.uniforms.uTime!.value = t;
        if (homeSuiseiTick) homeSuiseiTick(t);
        if (hpId === "moon" && !reducedMotion) stepHomeWalkers(dt);
        if (hpId === "moon" && homePlanetMesh) {
          // 主页模式收紧地平线淡出（起始 0.42 / 全显 0.75，太阳系
          // 月球仍是 0.03 / 0.30）：离盘面中心太远、倾斜太厉害的
          // 居民提前淡出，主页上只留上方接近正立的
          fadePaperHorizon(homeWalkers, homePlanetMesh, 0.42, 0.33);
          updatePaperFacing(homeWalkers, homePlanetMesh, dt);
        }
      }
      // —— 北极场地（虾蛄父子 + 停机坪 + UFO 造访，纯氛围层）：
      // 主页地球与太阳系地球共用同一个 earth 组，步进口径与月面
      // 居民一致（主页/聚焦地球时逐帧，其余每 6 帧一步，远景无
      // 差别）；客串星球当主页时（hpActive）地球图层已整组隐藏、
      // 停步省电。父在停机坪旁冰面巡场踱步（活动半径 0.03 rad），
      // 张望停顿里偶尔出拳（0.38 秒缩放脉冲卖速度感，拳套架势是
      // 官方立绘自带的，不改图、不加特效）；子两种模式定时切换：
      // 跟随父（家点钉父位置、小跑跟上）与绕停机坪光环跑（家点
      // 沿极面 0.185 rad 圆周匀速移动、牵引绳让他追着跑整圈）。
      // UFO 落冰的 ground 阶段父子转入迎客：父的家点改钉到访客
      // 旁的迎客站位、子强制绕环跑；船走后全部恢复日常。
      if (!reducedMotion && !hpActive && mantisPair.length) {
        const polarDetail = trans === 0 || st.focusedBody === "earth";
        const guestHere = visitPhase === "ground";
        mantisFather.home.copy(
          guestHere ? fatherGreetHome : fatherHomeDaily,
        );
        if (polarDetail || frame % 6 === 0) {
          const sdt = polarDetail ? dt : dt * 6;
          stepPaperWalker(mantisFather, sdt, mantisRand, R, 0.03);
          sonModeT -= sdt;
          if (sonModeT <= 0) {
            sonMode = sonMode === "follow" ? "ring" : "follow";
            sonModeT =
              sonMode === "ring"
                ? 9 + mantisRand() * 6
                : 11 + mantisRand() * 8;
          }
          if (guestHere || sonMode === "ring") {
            sonRingAz += sdt * 0.17;
            const rho = 0.185;
            mantisSon.home.set(
              Math.sin(rho) * Math.cos(sonRingAz),
              Math.cos(rho),
              Math.sin(rho) * Math.sin(sonRingAz),
            );
            mantisSon.angSpeed = 0.036;
            stepPaperWalker(mantisSon, sdt, mantisRand, R, 0.016);
          } else {
            mantisSon.home.copy(mantisFather.dir);
            mantisSon.angSpeed = 0.009;
            stepPaperWalker(mantisSon, sdt, mantisRand, R, 0.02);
          }
          if (mantisJabT >= 0) {
            mantisJabT += sdt;
            if (mantisJabT > 0.38) mantisJabT = -1;
          } else if (mantisFather.state === "look") {
            mantisJabWait -= sdt;
            if (mantisJabWait <= 0) {
              mantisJabT = 0;
              mantisJabWait = 6 + mantisRand() * 9;
            }
          }
        }
        fadePaperHorizon(mantisPair, earth);
        updatePaperFacing(mantisPair, earth, dt);
        if (mantisJabT >= 0) {
          const jp = Math.min(1, mantisJabT / 0.38);
          const js = Math.sin(jp * Math.PI);
          mantisFather.sprite.scale.x =
            mantisFather.baseW * (1 + 0.17 * js);
          mantisFather.sprite.scale.y =
            mantisFather.baseH * mantisFather.squash * (1 + 0.1 * js);
        }
        // —— UFO 造访状态机（单实例，同时最多一艘）——
        visitT += dt;
        const curDur =
          visitPhase === "idle"
            ? Number.POSITIVE_INFINITY
            : VISIT_DUR[visitPhase];
        if (visitPhase === "idle") {
          ufo.group.visible = false;
          if (
            (t > nextVisitAt || forceVisit) &&
            (trans === 0 || trans === 1)
          ) {
            forceVisit = false;
            visitPhase = "approach";
            visitT = 0;
            ufoFrom.copy(computeUfoFrom());
            ufo.group.visible = true;
          }
        } else if (visitT >= curDur) {
          visitPhase =
            visitPhase === "approach"
              ? "descend"
              : visitPhase === "descend"
                ? "ground"
                : visitPhase === "ground"
                  ? "takeoff"
                  : visitPhase === "takeoff"
                    ? "depart"
                    : "idle";
          visitT = 0;
          if (visitPhase === "idle") {
            nextVisitAt = t + 140 + visitRand() * 100;
            ufo.group.visible = false;
          }
        }
        if (visitPhase !== "idle") {
          const hoverP = ufoTmpA.set(0, 1 + 0.3, 0);
          const landP = ufoTmpB.set(0, 1 + 0.04, 0);
          let beamK = 0;
          if (visitPhase === "approach") {
            const k = sstep(Math.min(1, visitT / VISIT_DUR.approach));
            ufoPos.lerpVectors(ufoFrom, hoverP, k);
            // 中途外鼓一段弧：不贴着球面直线蹭过去
            const bulge = Math.sin(k * Math.PI) * 0.15;
            ufoPos.addScaledVector(
              ufoPos.clone().normalize(),
              bulge,
            );
          } else if (visitPhase === "descend") {
            const k = sstep(Math.min(1, visitT / VISIT_DUR.descend));
            ufoPos.lerpVectors(hoverP, landP, k);
            beamK = Math.min(1, visitT / 1.2);
          } else if (visitPhase === "ground") {
            ufoPos.copy(landP);
            beamK = Math.max(0, 1 - visitT / 1.5); // 落稳后光束收起
          } else if (visitPhase === "takeoff") {
            const k = sstep(Math.min(1, visitT / VISIT_DUR.takeoff));
            ufoPos.lerpVectors(landP, hoverP, k);
            beamK = Math.min(1, visitT / 1.2);
          } else {
            // depart：加速（k^1.6）飞回本程起点方向，尽头隐没
            const k = Math.pow(
              Math.min(1, visitT / VISIT_DUR.depart),
              1.6,
            );
            ufoPos.lerpVectors(hoverP, ufoFrom, k);
          }
          const airborne = visitPhase !== "ground";
          ufo.group.position.copy(ufoPos);
          if (airborne) {
            // 悬停浮沉：沿径向 ±0.008 缓浮（落冰后静止贴冰）
            ufo.group.position.addScaledVector(
              ufoPos.clone().normalize(),
              Math.sin(t * 1.4) * 0.008,
            );
          }
          ufo.group.quaternion.setFromUnitVectors(
            POLE_DIR,
            ufoPos.clone().normalize(),
          );
          if (airborne) {
            ufo.group.rotateX(Math.sin(t * 0.9) * 0.05);
            ufo.group.rotateZ(Math.cos(t * 0.7) * 0.05);
          }
          // 碟缘彩光追逐闪烁（色相整圈流动）
          for (let i = 0; i < ufo.edgeMats.length; i++) {
            ufo.edgeMats[i]!.color.setHSL(
              (((i / ufo.edgeMats.length - t * 0.45) % 1) + 1) % 1,
              0.85,
              0.62,
            );
          }
          ufo.glowMat.opacity =
            0.3 + 0.12 * Math.sin(t * 2.1);
          // 光束：只在低空（高度 < 0.34）且阶段需要时亮，锥长逐
          // 帧按船底到冰面的真实距离缩放，落地光斑同步
          const alt = ufoPos.length() - 1;
          const beamOn = beamK > 0.01 && alt < 0.34;
          ufo.beam.visible = beamOn;
          if (beamOn) {
            const beamLen = Math.max(0.01, alt - 0.028);
            ufo.beam.scale.set(1, beamLen, 1);
            ufo.beam.position.y = -(0.028 + beamLen / 2);
            ufo.beamMat.opacity = 0.3 * beamK;
            beamSpotMat.opacity = 0.5 * beamK;
          } else {
            beamSpotMat.opacity = 0;
          }
        } else {
          beamSpotMat.opacity = 0;
        }
        // 访客：只在 ground 阶段下船活动——落冰后 1.5 秒内在船边
        // 淡入、起飞前 2 秒淡出回船；其余时间不在冰面上（在船里）
        if (visitPhase === "ground") {
          const vOut = Math.min(
            Math.min(1, visitT / 1.5),
            Math.min(1, Math.max(0, (VISIT_DUR.ground - visitT) / 2)),
          );
          if (polarDetail || frame % 6 === 0) {
            const sdt = polarDetail ? dt : dt * 6;
            stepPaperWalker(visitor, sdt, visitorRand, R, 0.045);
          }
          fadePaperHorizon([visitor], earth);
          visitor.mat.opacity *= vOut;
          visitor.sprite.visible = vOut > 0.02 && visitor.sprite.visible;
          visitor.shadowMat.opacity *= vOut;
          updatePaperFacing([visitor], earth, dt);
        } else {
          visitor.sprite.visible = false;
          visitor.shadow.visible = false;
        }
        // 停机坪亮度：待机极淡微呼吸；飞来途中渐亮迎接；落冰/
        // 停留/起飞全亮；飞离后淡回待机（平滑趋近，不硬跳）
        let padTarget = 0.1 + 0.03 * Math.sin(t * 0.8);
        if (visitPhase === "approach") {
          padTarget =
            0.13 + 0.6 * Math.min(1, visitT / VISIT_DUR.approach);
        } else if (
          visitPhase === "descend" ||
          visitPhase === "ground" ||
          visitPhase === "takeoff"
        ) {
          padTarget = 0.88;
        } else if (visitPhase === "depart") {
          padTarget =
            0.1 +
            0.68 * (1 - Math.min(1, visitT / VISIT_DUR.depart));
        }
        padMat.opacity +=
          (padTarget - padMat.opacity) * Math.min(1, dt * 3);
      }
      solarGroup.visible = trans > 0.01;
      if (solarGroup.visible) {
        solarGroup.scale.setScalar(0.15 + 0.85 * eTrans);
        solarGroup.rotation.y += dt * 0.02 * eTrans;
        // 捏合平移随过渡进度生效，退出时自动归零（下方 else 分支复位）
        solarGroup.position.set(solarPan.x * eTrans, solarPan.y * eTrans, 0);
        sunLight.intensity = 2.6 * sunFade;
        sunLight.position.set(0, 0, 0); // 太阳本体位置，逐帧钉死
        // 太阳：表面 shader 时间推进（沸腾）；三层辉光零呼吸
        // （2026-11-12 重做）——scale 恒定、透明度只随 sunFade，
        // 光晕不再一胀一缩；冕径在转场中只由 solarGroup 整体缩放
        // 与 sunFade 连续决定，逐帧无阶跃（旧冕径阶跃账不许回归）
        sunMat.uniforms.uTime!.value = t;
        coronaShellMat.uniforms.uOpacity!.value = sunFade;
        (sunGlow.material as THREE.SpriteMaterial).opacity = 0.9 * sunFade;
        (sunCorona.material as THREE.SpriteMaterial).opacity =
          0.88 * sunFade;
        (sunLabel.material as THREE.SpriteMaterial).opacity = sunFade;
        for (let i = 0; i < orbitMats.length; i++) {
          orbitMats[i]!.opacity = 0.19 * orbitFade(i);
        }
        if (moonOrbitMat) moonOrbitMat.opacity = 0.34 * orbitFade(2);
        // 标签避让平滑推进：避让 pass 只写目标（labelFadeT/labelDyT，
        // 见下方避让段），实际淡化/让位偏移逐帧指数趋近目标——判定
        // 状态即使翻转，标签也是一次约 0.3 秒的平滑淡变/滑动，绝不
        // 在 1 与 0.15 之间硬跳（旧逻辑硬跳 = 用户实报的标签闪烁）
        const labelEase = 1 - Math.exp(-dt * 9);
        for (const pv of planetVis) {
          pv.labelFade += (pv.labelFadeT - pv.labelFade) * labelEase;
          pv.labelDy += (pv.labelDyT - pv.labelDy) * labelEase;
        }
        moonLabelFade += (moonLabelFadeT - moonLabelFade) * labelEase;
        moonLabelDy += (moonLabelDyT - moonLabelDy) * labelEase;
        for (let i = 0; i < planetVis.length; i++) {
          const pv = planetVis[i]!;
          const ang = pv.lon0 + pv.omega * t;
          // 星街彗星走倾角轨道（guestPosAt，y 随相位起伏），其余行
          // 星在组平面内；标签恒跟本体实际位置走
          let px = Math.cos(ang) * pv.def.orbitR * SOLAR_S;
          let py = 0;
          let pz = -Math.sin(ang) * pv.def.orbitR * SOLAR_S;
          if (pv.def.id === "suisei") {
            guestPosAt(ang, suiseiPosTmp);
            px = suiseiPosTmp.x;
            py = suiseiPosTmp.y;
            pz = suiseiPosTmp.z;
          }
          const pf = orbitFade(i);
          if (pv.mesh) {
            pv.mesh.position.set(px, py, pz);
            pv.mesh.rotation.y =
              pv.def.id === "suisei"
                ? t * 0.085 // 偏快自转（旧客串口径不变）
                : t * 0.05 * (i % 2 === 0 ? 1 : -0.7);
            pv.mesh.scale.setScalar(0.55 + 0.45 * pf);
          }
          if (pv.label) {
            pv.label.position.set(px, py + pv.labelY + pv.labelDy, pz);
            (pv.label.material as THREE.SpriteMaterial).opacity =
              pf * pv.labelFade;
          }
          // 个性效应与本体同拍：fade = 该行星的 orbitFade，转场
          // 期间随本体一起淡入淡出，不留残留闪烁
          pv.fxTick?.(t, pf);
        }
        sunMesh.rotation.y = t * 0.008;
        // —— 具名彗星逐帧（哈雷/恩克/潘斯达斯/艾森）：登场走舞
        // 台轮值第 0–3 幕、哈雷起场（口径见 COMET_STAGE_S 处
        // 注）——各颗只在自己那一幕里在场：幕内时间以其近日点
        // 为幕中点、按 slotScale 缩放映射到其轨道时间，淡化 =
        // sunFade × 幕包络，非本幕恒 0（整组隐去、名卡随
        // fadeNow 同步隐去）；reduced-motion 时舞台冻结在哈雷
        // 幕、余三颗不在场。状态由真实根数的 namedCometStateAt
        // 逐帧算；双尾脊线几何规则全颗同构（离子直指背阳、尘
        // 埃沿自身历史轨迹 + 背阳漂移），质感/色彩/粒子/体量
        // 逐颗分家（见 def 表）；近日点粒子喷流段末 prox 驱
        // 动。名卡的位置/透明度不在此段——见背景八星段之后的
        // 具名彗星名卡段（要借八星卡的落位矩形作互避障碍）。
        for (let nci = 0; nci < namedCometRts.length; nci++) {
          const nc = namedCometRts[nci]!;
          const def = nc.def;
          const u = stageMt - nci * COMET_SLOT_S;
          const localT =
            def.periAtS + (u - COMET_SLOT_S / 2) * def.slotScale;
          const cs = namedCometStateAt(def, localT, SOLAR_S);
          nc.localPos.copy(cs.pos);
          nc.act = cs.activity;
          const ncFade = sunFade * stageEnv(u);
          nc.fadeNow = ncFade;
          // 轨道线同属本颗的「出现」单位、随幕包络同进同出（非
          // 本幕不留线）；在场时略提亮（0.34 vs 旧全程 0.2）补
          // 偿同屏只剩一条轨道线的展示密度
          nc.orbitMat.opacity = 0.34 * ncFade;
          nc.group.visible = ncFade > 0.01;
          if (nc.group.visible) {
            const act = cs.activity;
            const actN = Math.pow(act, 1.3);
            const actEnv = sstep(act / 0.16);
            const bk = def.brightK;
            nc.nucleus.position.copy(cs.pos);
            // 核体量随 comaK 逐颗分家（哈雷最大、恩克最小）；核
            // 色纯白 = 报告 B-1 的针尖烧白核
            nc.nucleus.scale.setScalar(def.comaK);
            nc.nucleusMat.opacity = 0.95 * ncFade;
            // 彗发四层（报告 B-1 近对数衰减：核 1.0 → 内层
            // 0.8 → 外晕内圈 0.42 → 外晕外圈 0.18，尺度逐层放
            // 大、乘 comaK 逐颗分体量）
            nc.core.position.copy(cs.pos);
            nc.core.scale.setScalar(0.085 * def.comaK);
            nc.coreMat.opacity =
              (0.32 + 0.68 * act) * bk * ncFade;
            nc.inner.position.copy(cs.pos);
            nc.inner.scale.setScalar(
              (0.17 + 0.3 * act) * def.comaK,
            );
            nc.innerMat.opacity =
              0.8 * Math.min(1, act * 0.75 + 0.15) * bk * ncFade;
            nc.halo.position.copy(cs.pos);
            nc.halo.scale.setScalar(
              (0.34 + 0.55 * act) * def.comaK,
            );
            nc.haloMat.opacity = 0.42 * act * actEnv * bk * ncFade;
            nc.haloOut.position.copy(cs.pos);
            nc.haloOut.scale.setScalar(
              (0.58 + 0.9 * act) * def.comaK,
            );
            nc.haloOutMat.opacity = 0.18 * act * actEnv * bk * ncFade;
            const antiSun = cs.pos.clone().normalize();
            const ionLen = def.ionLen * Math.pow(act, 1.1);
            nc.ion.group.visible = actEnv > 0.01;
            if (nc.ion.group.visible) {
              const ionSpine: THREE.Vector3[] = [];
              for (let i = 0; i < TAIL_STATIONS; i++) {
                const f = i / (TAIL_STATIONS - 1);
                ionSpine.push(
                  cs.pos.clone().addScaledVector(antiSun, ionLen * f),
                );
              }
              fillCurtainSpine(nc.ion, ionSpine, "pole", nc.pole);
              for (const m of nc.ion.mats) {
                m.uniforms.uTime!.value = t;
                m.uniforms.uOpacity!.value =
                  def.ionOp * actN * actEnv * ncFade;
                m.uniforms.uWidth!.value =
                  nc.ion.baseWidth * (0.35 + 0.65 * act);
              }
            }
            nc.dust.group.visible = actEnv > 0.01;
            if (nc.dust.group.visible) {
              // 尘埃脊线：过去约一成循环的历史轨迹 + 背阳漂移
              // （步长/漂移按各颗循环与 def 系数；步长系数
              // 0.0064→0.0085 是报告「尾长冲出画框感」的尘埃侧
              // 落点：历史采样拉长、扇面随之展开）
              const dustCtrl: THREE.Vector3[] = [];
              const stepS = def.cycleS * 0.0085;
              for (let j = 0; j <= 16; j++) {
                const pastT =
                  (((localT - j * stepS) % def.cycleS) + def.cycleS) %
                  def.cycleS;
                const past = namedCometStateAt(def, pastT, SOLAR_S);
                const drift = past.pos
                  .clone()
                  .normalize()
                  .multiplyScalar(j * j * def.dustHistK);
                dustCtrl.push(past.pos.clone().add(drift));
              }
              const dustCurve = new THREE.CatmullRomCurve3(dustCtrl);
              fillCurtainSpine(
                nc.dust,
                dustCurve.getPoints(TAIL_STATIONS - 1),
                "fan",
                nc.pole,
              );
              for (const m of nc.dust.mats) {
                m.uniforms.uTime!.value = t;
                m.uniforms.uOpacity!.value =
                  def.dustOp * actN * actEnv * ncFade;
                m.uniforms.uWidth!.value =
                  nc.dust.baseWidth * (0.35 + 0.65 * act);
              }
            }
            // 近日点冰晶喷流逐帧：近日因子 prox 自 1.35 AU 起线
            // 性升腾、近日点（r = q）达 1，^1.35 收边。四颗的正
            // 切弯折时间轴把过境展开——prox>0.02 的窗口实测占
            // 各自幕的 53–66 秒（幕长 80 秒），每颗过近日点都
            // 有一场粒子喷发，不再是旧客串喷流那种开场 30 秒
            // 错过即无的窗口。呼吸相位按 cardPrio 错开，四颗
            // 不同步（虽轮值独占、仍守确定性口径）
            const qNc = def.a * (1 - def.e);
            const prox = Math.pow(
              THREE.MathUtils.clamp((1.35 - cs.rAU) / (1.35 - qNc), 0, 1),
              1.35,
            );
            nc.sparks.points.visible = prox > 0.02;
            if (nc.sparks.points.visible) {
              nc.sparks.mat.uniforms.uTime!.value = t;
              (
                nc.sparks.mat.uniforms.uOrigin!.value as THREE.Vector3
              ).copy(cs.pos);
              (
                nc.sparks.mat.uniforms.uDir!.value as THREE.Vector3
              ).copy(antiSun);
              nc.sparks.mat.uniforms.uScaleH!.value =
                renderer.domElement.height * 1.302;
              nc.sparks.mat.uniforms.uIntensity!.value = prox;
              nc.sparks.mat.uniforms.uOpacity!.value =
                prox *
                ncFade *
                1.05 *
                (0.88 + 0.12 * Math.sin(t * 9.0 + def.cardPrio * 1.7));
            }
          }
        }
        if (earthAnchor) {
          const eDef = PLANET_ELEMENTS[2]!;
          const ePv = planetVis[2]!;
          const ang = ePv.lon0 + ePv.omega * t;
          earthAnchor.position.set(
            Math.cos(ang) * eDef.orbitR * SOLAR_S,
            0,
            -Math.sin(ang) * eDef.orbitR * SOLAR_S,
          );
          // 月球：组钉在地球轨道位，本体沿绕地轨道按真实相对周期运行；
          // 标签只在近览（或已捏合放大、或非窄屏）时显示，全览小屏防糊
          if (moonGroup && moonMesh && moonLabel) {
            moonGroup.position.copy(earthAnchor.position);
            const mAng = moonLon0 + MOON_OMEGA * t;
            moonMesh.position.set(
              Math.cos(mAng) * MOON_ORBIT_R,
              0,
              -Math.sin(mAng) * MOON_ORBIT_R,
            );
            // 自转：恒定慢速推进（居民散布整个月面，不再为聚焦月球
            // 特意把某片区域转到正面——转到哪面都可能遇上一两只）
            moonSpin += dt * 0.03;
            moonMesh.rotation.y = moonSpin;
            moonLabel.position.set(
              moonMesh.position.x,
              MOON_R + 0.15 * solarLabelScale + moonLabelDy,
              moonMesh.position.z,
            );
            moonLabel.visible =
              st.solarView === "near" || !solarNarrow || solarZoom > 1.15 ||
              st.focusedBody === "moon" || st.focusedBody === "earth";
            (moonLabel.material as THREE.SpriteMaterial).opacity =
              orbitFade(2) * (moonLabel.visible ? 1 : 0) * moonLabelFade;
            if (moonDustMat) {
              moonDustMat.uniforms.uTime!.value = t;
              moonDustMat.uniforms.uFade!.value = orbitFade(2);
              moonDustMat.uniforms.uScaleH!.value =
                renderer.domElement.height * 1.302;
            }
            // —— 访客散步：纸片人沿月面弧面游走、走停交替（步进逻辑
            // 见 stepPaperWalker）。动画分级：聚焦月球/地球时全速逐
            // 帧；太阳系总览时降频（每 6 帧推一步，远景看不出差别）；
            // 出了太阳系模式整组随月球隐藏。reduced-motion 时静止。
            if (!reducedMotion && serpoRand) {
              const serpoDetail =
                st.focusedBody === "moon" || st.focusedBody === "earth";
              if (serpoDetail || frame % 6 === 0) {
                const sdt = serpoDetail ? dt : dt * 6;
                for (const w of serpoWalkers) {
                  stepPaperWalker(w, sdt, serpoRand, MOON_R);
                }
              }
            }
            if (moonMesh) {
              fadePaperHorizon(serpoWalkers, moonMesh);
              updatePaperFacing(serpoWalkers, moonMesh, dt);
            }
          }
          solarGroup.updateMatrixWorld(true);
          earthAnchor.getWorldPosition(tmpWorldV);
          earth.position.lerpVectors(ZERO_V, tmpWorldV, eTrans);
        }
        // —— 太阳系标签：字号钳制 + 碰撞避让（录屏实证修复）——
        // 巨字病根：标签是固定世界尺寸的精灵，聚焦飞近时镜头距离
        // 从总览的 ~11 缩到 ~1，标签在画面上同比放大十倍（地球聚
        // 焦时「地球/月球」巨字溢出叠压）。钳制法：逐帧按「标签到
        // 镜头距离 / 总览距离」反比缩放精灵——标签的屏幕字号在聚
        // 焦与总览下恒定同档，只许比总览小、不许更大。
        // 避让：总览态每 5 帧做一次屏幕空间碰撞（与地球城市标签同
        // 级）：优先级低的标签让位（上移 + 淡化）；标签压到太阳盘
        // 面上（水星凌日类）同样让位，不许在盘面上带字。判定带双
        // 阈值滞回且只写目标、实际值逐帧平滑跟随（详见避让段注释：
        // 旧版每轮复位硬写是标签闪烁的病根）。
        {
          solarGroup.updateMatrixWorld(true);
          const labelEntries: Array<{
            id: string;
            sprite: THREE.Sprite;
            pv?: PlanetVis;
          }> = [{ id: "sun", sprite: sunLabel }];
          for (const pv of planetVis) {
            if (pv.label) {
              labelEntries.push({ id: pv.def.id, sprite: pv.label, pv });
            }
          }
          if (moonLabel) labelEntries.push({ id: "moon", sprite: moonLabel });
          const tmpLv = new THREE.Vector3();
          for (const e of labelEntries) {
            if (e.sprite.userData.baseSX === undefined) {
              e.sprite.userData.baseSX = e.sprite.scale.x;
              e.sprite.userData.baseSY = e.sprite.scale.y;
            }
            e.sprite.getWorldPosition(tmpLv);
            const dCam = tmpLv.distanceTo(camera.position);
            const ratio = THREE.MathUtils.clamp(
              dCam / Math.max(currentSolarZ, 0.001),
              0.16,
              1,
            );
            e.sprite.scale.set(
              (e.sprite.userData.baseSX as number) * ratio,
              (e.sprite.userData.baseSY as number) * ratio,
              1,
            );
            // —— 同帧锚定校正（2026-11-13 追踪优化，用户实报近距
            // 下名签位置还是有点不对）：标签的 x/z 与纵向基准由
            // 上方逐帧段按本体同帧轨道位写下（同源、无上一帧缓
            // 存），但纵向偏移 labelY 是固定本地单位——字号已被
            // ratio 钳回屏幕恒定，偏移没钳：镜头飞近/聚焦时同一
            // 本地偏移投影成的屏幕间距同比放大，标签视觉上漂离
            // 行星上方（距离越近漂得越远）。本段在本帧实测
            // dCam 与本帧相机上重算纵向落点：本体当前实际半径
            // （含过渡缩放）恒全量，其上的抬升量（建签时定格在
            // labelY 里的约定间隙 + 签半高）与避让偏移同按
            // ratio 收分——任意距离下标签都以同一屏幕间隙悬在
            // 本体正上方；总览 ratio=1 时与原落点恒等，零回归。
            // 锚点输入全部取本帧值（本体同帧位置/缩放、本帧
            // camera），不读上一帧状态。
            if (e.id === "sun") {
              e.sprite.position.y = SUN_R + 0.26 * ratio;
            } else if (e.pv) {
              const pv = e.pv;
              const rBuild = pv.mesh
                ? pv.def.size * planetScale
                : EARTH_PLANET_SCALE;
              const rCur = pv.mesh
                ? rBuild * pv.mesh.scale.x
                : EARTH_PLANET_SCALE;
              const bodyY = pv.mesh ? pv.mesh.position.y : 0;
              e.sprite.position.y =
                bodyY +
                rCur +
                (pv.labelY - rBuild) * ratio +
                pv.labelDy * ratio;
            } else if (e.id === "moon") {
              const bodyY = moonMesh ? moonMesh.position.y : 0;
              e.sprite.position.y =
                bodyY +
                MOON_R +
                0.15 * solarLabelScale * ratio +
                moonLabelDy * ratio;
            }
          }
          if (frame % 5 === 0) {
            // —— 避让判定：只写目标，实际值由上方平滑段逐帧趋近 ——
            // 闪烁病根（用户实报）：旧逻辑每 5 帧先把全部标签的
            // labelFade/labelDy 复位、再按瞬时投影重算并硬写实际值；
            // 行星持续公转，投影距离在碰撞阈值附近来回穿越，判定
            // 逐轮翻转，透明度 1↔0.15、位置 0↔让位偏移当场硬跳，
            // 以约 12Hz 的判定节拍跳变就是肉眼闪烁。现行双阈值滞
            // 回：进入让位要贴得更近（|dx|<0.13 且 |dy|<0.05，太
            // 阳盘面 dd<盘半径+0.03），退出让位要离得更远（|dx|>
            // 0.20 或 |dy|>0.10，太阳盘面 dd>盘半径+0.10），两带
            // 之间保持上一判定——距离在阈值附近漂移不再翻转判定；
            // 判定真翻转时实际值也只平滑淡变/滑动，不硬跳。
            const fadeTOf = (e: { id: string; pv?: PlanetVis }): number =>
              e.pv ? e.pv.labelFadeT : moonLabelFadeT;
            const dyTOf = (e: { id: string; pv?: PlanetVis }): number =>
              e.pv ? e.pv.labelDyT : moonLabelDyT;
            const setTarget = (
              e: { id: string; pv?: PlanetVis },
              fade: number,
              dy: number,
            ) => {
              if (e.pv) {
                e.pv.labelFadeT = fade;
                e.pv.labelDyT = dy;
              } else if (e.id === "moon") {
                moonLabelFadeT = fade;
                moonLabelDyT = dy;
              }
            };
            if (trans <= 0.95 || st.focusedBody) {
              // 非总览静止态（过渡中/已聚焦）：全部目标复位全显，
              // 实际值平滑跟随，不再像旧逻辑那样一轮 pass 内硬复位；
              // 遮挡状态一并清零，回总览时从干净状态重新判定
              for (const e of labelEntries) {
                setTarget(e, 1, 0);
                if (e.pv) {
                  e.pv.labelOcc = false;
                  e.pv.labelOccStreak = 0;
                }
              }
              moonLabelOcc = false;
              moonLabelOccStreak = 0;
            } else {
              const PRIO: Record<string, number> = {
                sun: 100, earth: 92, jupiter: 84, saturn: 80, mars: 76,
                venus: 72, mercury: 68, moon: 60, uranus: 50, neptune: 50,
              };
              const proj = new Map<
                string,
                { x: number; y: number; dist: number }
              >();
              const tmpP = new THREE.Vector3();
              for (const e of labelEntries) {
                e.sprite.getWorldPosition(tmpP);
                const dist = tmpP.distanceTo(camera.position);
                tmpP.project(camera);
                proj.set(e.id, { x: tmpP.x, y: tmpP.y, dist });
              }
              sunMesh.getWorldPosition(tmpP);
              const sunDist = tmpP.distanceTo(camera.position);
              tmpP.project(camera);
              const sunNdc = { x: tmpP.x, y: tmpP.y };
              const halfTanL = Math.min(
                Math.tan(THREE.MathUtils.degToRad(21)),
                Math.tan(THREE.MathUtils.degToRad(21)) * camera.aspect,
              );
              const sunRdc =
                SUN_R / Math.max(sunDist, 1e-4) / Math.max(halfTanL, 1e-4);
              // —— 天体盘面遮挡体（2026-11-13 稳定性，用户实报星
              // 球移动时名字被其他星球遮挡而来回跳动）：标签精灵
              // 已关 GPU 深度测试（见 makeSolarLabel），遮挡改在
              // 本段解析判定——各天体本帧世界坐标投影成盘面（中
              // 心 + NDC 半径，土星按环外缘），标签中心落入更近
              // 天体的盘面即被遮挡。稳定性三件：① 进/出盘双阈
              // 值（进 <半径+0.01、出 >半径+0.07），临界带内保
              // 持上一状态；② 翻转须连续 2 次判定（≈10 帧）一
              // 致，单次擦过不翻；③ 命中只写 fade 目标 0（稳定
              // 全隐），实际透明度逐帧平滑趋近——全程无二值跳
              // 变。太阳盘面沿用下方既有让位规则，不在此重复。
              const bodies: Array<{
                id: string;
                x: number;
                y: number;
                r: number;
                dist: number;
              }> = [];
              {
                const gS = solarGroup.scale.x;
                const addBody = (id: string, rWorld: number) => {
                  const dist = tmpLv.distanceTo(camera.position);
                  tmpP.copy(tmpLv);
                  tmpP.project(camera);
                  bodies.push({
                    id,
                    x: tmpP.x,
                    y: tmpP.y,
                    r:
                      rWorld /
                      Math.max(dist, 1e-4) /
                      Math.max(halfTanL, 1e-4),
                    dist,
                  });
                };
                for (const pv of planetVis) {
                  if (!pv.mesh) continue;
                  pv.mesh.getWorldPosition(tmpLv);
                  addBody(
                    pv.def.id,
                    pv.def.size *
                      planetScale *
                      pv.mesh.scale.x *
                      gS *
                      (pv.def.id === "saturn" ? 2.62 : 1),
                  );
                }
                earth.getWorldPosition(tmpLv);
                addBody("earth", 0.985 * earth.scale.x);
                if (moonMesh) {
                  moonMesh.getWorldPosition(tmpLv);
                  addBody("moon", MOON_R * gS);
                }
              }
              const occOf = (e: { id: string; pv?: PlanetVis }): boolean =>
                e.pv ? e.pv.labelOcc : moonLabelOcc;
              const occStreakOf = (e: {
                id: string;
                pv?: PlanetVis;
              }): number =>
                e.pv ? e.pv.labelOccStreak : moonLabelOccStreak;
              const occApply = (
                e: { id: string; pv?: PlanetVis },
                occ: boolean,
                streak: number,
              ) => {
                if (e.pv) {
                  e.pv.labelOcc = occ;
                  e.pv.labelOccStreak = streak;
                } else if (e.id === "moon") {
                  moonLabelOcc = occ;
                  moonLabelOccStreak = streak;
                }
              };
              const IN_X = 0.13;
              const IN_Y = 0.05;
              const OUT_X = 0.2;
              const OUT_Y = 0.1;
              for (const e of labelEntries) {
                if (e.id === "sun") continue;
                const p = proj.get(e.id);
                if (!p) continue;
                // 盘面遮挡判定（迟滞 + 持续性，口径见 bodies 处
                // 注）：命中且确认翻转后本轮以遮挡为准——fade 目
                // 标 0 稳定全隐、不叠让位偏移，跳过下方让位判定
                {
                  const occPrev = occOf(e);
                  let occNear = false;
                  let occClear = true;
                  for (const b of bodies) {
                    if (b.id === e.id) continue;
                    if (b.dist >= p.dist) continue;
                    const dd = Math.hypot(p.x - b.x, p.y - b.y);
                    if (dd < b.r + 0.01) occNear = true;
                    if (dd < b.r + 0.07) occClear = false;
                  }
                  const occRaw = occPrev ? !occClear : occNear;
                  let occNow = occPrev;
                  let streak = occStreakOf(e);
                  if (occRaw !== occPrev) {
                    streak += 1;
                    if (streak >= 2) {
                      occNow = occRaw;
                      streak = 0;
                    }
                  } else {
                    streak = 0;
                  }
                  occApply(e, occNow, streak);
                  if (occNow) {
                    setTarget(e, 0, 0);
                    continue;
                  }
                }
                const wasYield = fadeTOf(e) < 1;
                let near = false;
                let clear = true;
                let causeDy = 0;
                // 只向优先级更高者让位（与旧规则同：低者让高者）
                for (const o of labelEntries) {
                  if (o.id === e.id) continue;
                  if ((PRIO[o.id] ?? 0) <= (PRIO[e.id] ?? 0)) continue;
                  const q = proj.get(o.id);
                  if (!q) continue;
                  const adx = Math.abs(p.x - q.x);
                  const ady = Math.abs(p.y - q.y);
                  if (adx < IN_X && ady < IN_Y) {
                    near = true;
                    causeDy = Math.max(causeDy, 0.14 * solarLabelScale);
                  }
                  if (adx < OUT_X && ady < OUT_Y) clear = false;
                }
                // 压上太阳盘面（水星凌日类）同样让位
                const ddSun = Math.hypot(p.x - sunNdc.x, p.y - sunNdc.y);
                if (ddSun < sunRdc + 0.03) {
                  near = true;
                  causeDy = Math.max(causeDy, 0.2 * solarLabelScale);
                }
                if (ddSun < sunRdc + 0.1) clear = false;
                const yielded = wasYield ? !clear : near;
                if (yielded) {
                  setTarget(
                    e,
                    0.15,
                    Math.max(causeDy, wasYield ? dyTOf(e) : 0),
                  );
                } else {
                  setTarget(e, 1, 0);
                }
              }
            }
          }
        }
        earth.scale.setScalar(1 + (EARTH_PLANET_SCALE - 1) * eTrans);
      } else {
        earth.position.set(0, 0, 0);
        earth.scale.setScalar(1);
        sunLight.intensity = 0;
        // 退出太阳系后取景复位，下次进入仍是默认近览构图
        if (!st.solarSystem) {
          solarZoom = 1;
          solarPan.x = 0;
          solarPan.y = 0;
          solarGroup.position.set(0, 0, 0);
          // 镜头平滑值同步复位到当前取景拟合距离，下次进入不带残影
          smoothSolarZ =
            solarNarrow && st.solarView === "near" ? solarNearZ : solarFullZ;
        }
      }
      const globeDetail = globeFade > 0.02 && !hpActive;
      flowPoints.visible = globeDetail;
      sparkPoints.visible = globeDetail;
      for (const a of flowArcs) {
        a.haloMesh.visible = globeDetail;
        a.coreMesh.visible = globeDetail;
        if (a.glowMesh) a.glowMesh.visible = globeDetail;
      }
      // 监控球点阵层随 globeFade 分层淡出（过渡前半段先退场）
      (landIn.material as THREE.PointsMaterial).opacity = 0.34 * globeFade;
      (landCo.material as THREE.PointsMaterial).opacity = 0.5 * globeFade;
      (oceanPoints.material as THREE.PointsMaterial).opacity =
        0.32 * globeFade;
      if (lightsPoints) lightsPoints.visible = globeDetail;
      atmosphere.visible = globeFade > 0.05 && !hpActive;
      atmosphereOuter.visible = globeFade > 0.05 && !hpActive;
      halo.visible = globeFade > 0.05 && !hpActive;

      // —— 展示自转推进 ——
      // 运行态以展示转速推进偏航（与真实时间脱钩，肉眼可见）；
      // 暂停态冻结偏航。明暗由本地系太阳向独立决定，不受影响。
      if (st.autoRotate) {
        displayYaw += dt * DISPLAY_SPIN;
      }
      // —— 太阳向（本地系，按真实时间，每秒重算）——
      // 世界太阳向在下方姿态合成之后由「本地向 × 球体四元数」得到：
      // 光源随球一起转，明暗钉在地理上。
      if (t - lastSunCalc > 1) {
        lastSunCalc = t;
        sunDateCache = new Date();
        sunLocal.copy(sunLocalFor(sunDateCache));
      }
      // 太阳系模式里方向光淡出，由太阳位置的点光源接管行星照明
      keyLight.intensity = 1.55 * (1 - eTrans);
      rimLight.intensity = 0.32 * (1 - eTrans);
      if (lightsMat) lightsMat.uniforms.uTime!.value = t;
      // 城市当地时间纹理：约每秒检查一次，分钟变了才重绘
      if (frame % 60 === 0) for (const u of timeUpdaters) u();

      const sel = st.selected;
      // 「暂停/恢复自转」是用户的显式指令：开关一变就释放拖拽锁、清掉
      // 残留惯性，让新状态在下一帧立即生效，不被任何手势状态压住
      if (st.autoRotate !== prevAutoRotate) {
        prevAutoRotate = st.autoRotate;
        userHold = false;
        velY = 0;
      }
      // 选中变化：弧线整体闪亮一遍 + 该国节点涟漪扩散；
      // 同时释放拖拽锁，保证点按钮聚焦/关卡后自转都能按开关恢复
      if (sel !== prevSel) {
        userHold = false;
        if (sel) {
          flashStart = t;
          CITIES.forEach((c, i) => {
            if (c.country === sel) burstStart.set(i, t);
          });
        }
        prevSel = sel;
      }
      // 镜头推近/拉远缓动（选中时推近，未选回原距）；太阳系过渡期间
      // 镜头距离在监控球距离与太阳系拟合距离之间按过渡进度插值。
      // 太阳系拟合距离：移动端（窄屏）按近览/全览取景选，桌面恒全览，
      // 再除以双指捏合/滚轮的缩放倍率
      const zTarget = sel ? baseZ * 0.86 : baseZ;
      globeCamZ += (zTarget - globeCamZ) * 0.045;
      // 近览/全览切换：先复位捏合缩放与平移再换拟合距离——否则用户捏过
      // 的 zoom/pan 会把新取景的效果吃掉，按钮看着还是「没用」
      if (st.solarView !== prevSolarView) {
        prevSolarView = st.solarView;
        solarZoom = 1;
        solarPan.x = 0;
        solarPan.y = 0;
      }
      // 取景判定读 resize 维护的 solarNarrow（粗指针或宽度 <1024），
      // 不再用宽高比 <0.9——地球区是横长矩形，该判定在真机上常年不成立，
      // 正是近览按钮失效的根因。距离经 smoothSolarZ 缓动，切换有过程、
      // 肉眼可确认；currentSolarZ 同步给捏合平移换算用
      const solarFitZ =
        solarNarrow && st.solarView === "near" ? solarNearZ : solarFullZ;
      const solarTargetZ = solarFitZ / solarZoom;
      smoothSolarZ +=
        (solarTargetZ - smoothSolarZ) * Math.min(1, dt * 5);
      if (Math.abs(solarTargetZ - smoothSolarZ) < 0.01) {
        smoothSolarZ = solarTargetZ;
      }
      currentSolarZ = smoothSolarZ;

      // —— 相机：总览位（带过渡弧线）/ 天体聚焦 fly-to ——
      // 切换天体时复位观赏方位角；退出聚焦时捏合缩放一并复位，
      // 回到总览原构图（近览/全览由 solarFitZ 决定，smoothSolarZ 缓动）
      if (st.focusedBody !== prevFocusId) {
        if (st.focusedBody) {
          focusYaw = 0.55;
          focusPitch = 0.38;
          // 聚焦落位选亮面（录屏实证：火星聚焦近景几乎全暗面、偏
          // 上被裁）：默认机位与太阳方向无关，镜头常落在行星的夜
          // 半边。改为按「目标→太阳」方向解算入场方位——镜头从太
          // 阳那一侧看过去，亮面迎客；再向侧方偏一点、抬一点，保
          // 留晨昏线的立体感而不是满月式平光。
          solarGroup.updateMatrixWorld(true);
          const fid = st.focusedBody;
          const tp = new THREE.Vector3();
          let haveTp = false;
          if (fid === "sun") {
            sunMesh.getWorldPosition(tp);
            haveTp = true;
          } else if (fid === "moon" && moonMesh) {
            moonMesh.getWorldPosition(tp);
            haveTp = true;
          } else if (fid === "earth") {
            earth.getWorldPosition(tp);
            haveTp = true;
          } else {
            const pv = planetVis.find((p) => p.def.id === fid);
            if (pv?.mesh) {
              pv.mesh.getWorldPosition(tp);
              haveTp = true;
            }
          }
          if (haveTp && fid !== "sun") {
            const sp = new THREE.Vector3();
            sunMesh.getWorldPosition(sp);
            const dir = sp.sub(tp);
            if (dir.lengthSq() > 1e-6) {
              dir.normalize();
              const side = new THREE.Vector3().crossVectors(
                dir,
                new THREE.Vector3(0, 1, 0),
              );
              if (side.lengthSq() > 1e-4) {
                dir.addScaledVector(side.normalize(), 0.38);
              }
              dir.y += 0.3;
              dir.normalize();
              focusYaw = Math.atan2(dir.x, dir.z);
              focusPitch = THREE.MathUtils.clamp(
                Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)),
                -0.3,
                1.0,
              );
            }
          }
        } else {
          solarZoom = 1;
        }
        // （居民已分散到整个月面：聚焦月球不再把某片区域转到正面，
        // 落位看到哪面取决于当下自转角，绕着看看即可。）
        prevFocusId = st.focusedBody;
      }
      const focusId = trans > 0.95 ? st.focusedBody : null;
      // 注意：camSmoothInit 不再在 trans 跌破 0.95 时就清掉——那是
      // 「送主页先闪回总览再硬切」的病根之一（见下方回程单飞行）。
      // 但回程的放行条件不许再带 trans > 0.01：旧写法把块内唯一的
      // 回程清旗（trans <= 0.01 才执行）挡在门外——trans 一跌到
      // 0.01 以下整块不再进入、清旗那行成死代码，camSmoothInit
      // 永久漏 true，camSmooth 冻在主页近机位；下次进太阳系、
      // trans 涨过 0.95 时第一子句靠这面漏旗把平滑相机重新激活，
      // 相机一帧瞬移到冻住的主页机位（全场盘面一帧涨约 1.5 倍、
      // 太阳辉光最显眼），再以 3.4/s 慢慢勒回总览——用户实报的
      // 「返回落位跳一下，整个太阳系」正是这一跳（真机录屏逐帧
      // 实证：落位前一帧盘面直径阶跃、其后约 0.5 秒平滑回收，与
      // 本机制的时刻/曲线严丝合缝）。现行：回程块不再带 trans
      // 下限，清旗在块内真实可达；再叠下方「重新接管必从当前机
      // 位起步」的复位，纵深防御同一类残留。
      let focusCamActive = false;
      if (
        (trans > 0.95 && (focusId || camSmoothInit)) ||
        (camSmoothInit && transGoal === 0)
      ) {
        // 目标天体的世界坐标与包围半径（土星连环、地球连月轨一起入框）
        let radius = 0.2;
        let haveTarget = false;
        if (focusId === "sun") {
          sunMesh.getWorldPosition(focusTargetPos);
          radius = SUN_R * 1.5;
          haveTarget = true;
        } else if (focusId === "moon" && moonMesh) {
          moonMesh.getWorldPosition(focusTargetPos);
          radius = MOON_R * 3.0;
          haveTarget = true;
        } else if (focusId === "earth") {
          earth.getWorldPosition(focusTargetPos);
          radius = MOON_ORBIT_R + MOON_R + 0.03;
          haveTarget = true;
        } else if (focusId) {
          const pv = planetVis.find((p) => p.def.id === focusId);
          if (pv?.mesh) {
            pv.mesh.getWorldPosition(focusTargetPos);
            radius =
              focusId === "saturn"
                ? pv.def.size * planetScale * 2.62
                : pv.def.size * planetScale * 1.2;
            haveTarget = true;
          }
        }
        if (!camSmoothInit || !focusCamWasActive) {
          // 平滑相机（重新）接管：必须从当前真实机位起步。旧逻辑
          // 只在 camSmoothInit=false 时拷贝现机位——旗一旦因任何
          // 原因漏置 true，冻住的旧 camSmooth（多半是别种模式下
          // 的近机位）会被直接顶上来渲染，整场一帧瞬移。现行：
          // 上一帧平滑相机不在位、本帧重新接管时，一律按现机位
          // 复位——连续在位时 focusCamWasActive 恒 true，不触发
          // 复位，聚焦跟随/单飞行回程的平滑性分毫不变。
          camSmooth.copy(camera.position);
          lookSmooth.set(0, 0, 0);
          camSmoothInit = true;
        }
        if (focusId && haveTarget) {
          const halfTanV = Math.tan(THREE.MathUtils.degToRad(21));
          const minTanF = Math.min(halfTanV, halfTanV * camera.aspect);
          // 距离留边：旧 1.08 倍边距在真机上让火星盘面撑满裁切，
          // 改 1.5 倍——目标连同标签完整入框，直径约占画面 2/3
          const dist = THREE.MathUtils.clamp(
            (radius / minTanF) * 1.5,
            0.32,
            30,
          ) / solarZoom;
          const cp = Math.cos(focusPitch);
          focusDesiredCam.set(
            focusTargetPos.x + Math.sin(focusYaw) * cp * dist,
            focusTargetPos.y + Math.sin(focusPitch) * dist,
            focusTargetPos.z + Math.cos(focusYaw) * cp * dist,
          );
          // 跟随刚度：月球公转最快（6.7 秒一圈），旧 2.4 的阻尼稳
          // 态滞后约 0.08 世界单位、相对其 0.34 的聚焦距离足以把
          // 球甩出框（录屏实证丢球约 3 秒）——月球提到 7，其余
          // 天体 3.4，目标始终锁在构图中心附近
          const rateF = focusId === "moon" ? 7 : 3.4;
          const k = 1 - Math.exp(-dt * rateF);
          camSmooth.lerp(focusDesiredCam, k);
          lookSmooth.lerp(focusTargetPos, k);
        } else {
          // 返回：回主页（transGoal=0）时直接飞向主页机位 (0,0,
          // globeCamZ)——与回程过渡同一条飞行，中途不许先在总览
          // 机位停顿再硬切（单飞行原则）；回太阳系总览时仍飞回
          // (0,0,拟合距离)，注视点收回原点
          focusDesiredCam.set(
            0,
            0,
            transGoal === 0 ? globeCamZ : currentSolarZ,
          );
          const k = 1 - Math.exp(-dt * 3.4);
          camSmooth.lerp(focusDesiredCam, k);
          lookSmooth.lerp(ZERO_V, k);
          if (transGoal === 0 && trans <= 0.01) {
            // 落位：常态相机接管的机位与此处一致，无缝交接
            camSmoothInit = false;
          } else if (
            transGoal === 1 &&
            camSmooth.distanceTo(focusDesiredCam) < 0.0015 &&
            lookSmooth.length() < 0.0015
          ) {
            // 渐近交接（「返回时跳一下」的实测根因）：旧逻辑在残差
            // <0.03 时把相机位置/注视点一帧硬切到总览默认机位
            // (0,0,currentSolarZ)/原点——飞行末帧还差着的残差被一
            // 帧吞掉，全场盘面直径在落位帧阶跃 −3.5px（相邻帧的衰
            // 减趋势是 −2.3→约 −1.5px，唯独落位帧反常放大），用户
            // 肉眼即见一跳。现行：阈值收紧到 0.0015 且不做任何硬
            // 赋值——交接帧仍由 camSmooth 渲染（与总览公式机位差
            // <0.0015 世界单位），下一帧总览相机接管时位置/注视点
            // 与之恒等到亚像素级，阶跃不可见。代价是尾段多约 0.9
            // 秒的渐近趋近；期间再点任何天体，camSmoothInit 保持
            // 在位、目标一切换即可无缝改道，不锁输入。
            camSmoothInit = false;
          }
        }
        if (camSmoothInit) {
          camera.position.copy(camSmooth);
          camera.lookAt(lookSmooth);
          focusCamActive = true;
        }
      }
      if (!focusCamActive) {
        // 总览相机：z 按过渡插值；x/y 走一条中点隆起的弧线
        // （4·e·(1−e) 在过渡中点达峰、两端归零），拉远不是直来直去
        const arc = 4 * eTrans * (1 - eTrans);
        camera.position.set(
          arc * 0.3,
          arc * 0.45,
          trans > 0
            ? globeCamZ + (currentSolarZ - globeCamZ) * eTrans
            : globeCamZ,
        );
        camera.lookAt(0, 0, 0);
      }
      focusCamWasActive = focusCamActive;

      // —— 地球姿态合成：展示自转 + 拖拽/聚焦偏移 ——
      // 基础偏航 = 展示自转角（展示转速推进，见上方自转段）。
      // 偏移的归宿：拖动中跟随手指；选中时缓动到聚焦偏移并保持；
      // 无选中且运行态时先惯性滑行、再缓动回 0（松手回到自转基线）；
      // 暂停态保持当前偏移（与冻结的自转配套，供停住细看）。
      const spinYaw = displayYaw;
      if (!dragging && !pinching && trans === 0) {
        if (sel && !userHold) {
          const rep =
            sel === "US" ? cityVecs[0]! : sel === "CN" ? cityVecs[2]! : cityVecs[4]!;
          const targetRotY = Math.atan2(-rep.x, rep.z);
          let diff = targetRotY - spinYaw - dragYaw;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const k = 1 - Math.exp(-dt * 3.2);
          dragYaw += diff * k;
          dragPitch += (0 - dragPitch) * k;
        } else if (st.autoRotate && !userHold) {
          if (Math.abs(velY) > 0.0001) {
            dragYaw += velY;
            velY *= Math.exp(-dt * 3);
          }
          const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 1.6);
          dragYaw += (0 - dragYaw) * k;
          dragPitch += (0 - dragPitch) * k;
          if (Math.abs(dragYaw) < 0.0004) dragYaw = 0;
          if (Math.abs(dragPitch) < 0.0004) dragPitch = 0;
        }
      }
      earth.rotation.set(HOME_TILT_X + dragPitch, spinYaw + dragYaw, 0.12);

      // —— 世界太阳向 = 本地太阳向 × 球体当前姿态 ——
      // 光源随地球的展示旋转一起动：明暗钉在地理上，无论球转到
      // 什么角度，亮面永远盖住此刻真实白天的那片区域。太阳系模式
      // 下按过渡进度混向轨道太阳向（地球位置 → 太阳本体原点），与
      // 太阳点光源的位置光照指向一致，那边逻辑不受本地系改造影响。
      sunTarget.copy(sunLocal).applyQuaternion(earth.quaternion);
      if (eTrans > 0) {
        tmpOrbitalSun.copy(earth.position).multiplyScalar(-1);
        if (tmpOrbitalSun.lengthSq() > 1e-6) {
          tmpOrbitalSun.normalize();
          sunTarget.lerp(tmpOrbitalSun, eTrans).normalize();
        }
      }
      sunUniform.value.copy(sunTarget);
      keyLight.position.copy(sunUniform.value).multiplyScalar(6);

      // —— 轨道卫星层逐帧：随监控图层同拍（太阳系过渡按 globeFade
      // 淡出；客串主页时 satGroup 已被 earthContent 整组隐藏，这里
      // 只管 satInner）。reducedMotion 时轨道钟冻结；反光判定用本
      // 地系太阳向（sunLocal），与昼夜同一套几何
      satFadeNow = globeFade;
      satInner.visible = globeFade > 0.02;
      // 金箔/光伏板着色器的淡出走各自 uFade（与基础材质同拍）
      satGoldUniforms.uFade.value = globeFade;
      satPanelFade.value = globeFade;
      if (satInner.visible) {
        if (!reducedMotion) satClock += dt;
        for (const f of satFadeMats) f.mat.opacity = f.base * globeFade;
        for (const tick of satTickers) tick(satClock);
      }

      // —— 流星雨速率曲线（与彗星同一条 3 分钟会话时钟）：1:30
      // 前速率为零（窗口外零痕迹）；1:30–2:30 由约 0.1 颗/秒渐
      // 强到约 2.7 颗/秒；2:30–3:00 峰值约 4.2 颗/秒（设计口径
      // 3–5）、火流星占比升到 8%。reduced-motion 不生成（快速闪
      // 光对该偏好不友好）。生成累加吃 rawDt（真实帧间隔）：dt
      // 钳在 0.1 秒而窗口时钟走真实秒，低帧率下按 dt 计账会把
      // 生成率暗中稀释。夜半球薄壳雨已按 JI 22:55 口径整套移除，
      // 流星雨自此只有下方主页星幕一种呈现。
      let mRate = 0;
      {
        const mct = reducedMotion ? -1 : nightCycleT;
        if (mct >= 90 && mct < 150) {
          mRate = 0.12 + ((mct - 90) / 60) * 2.6;
        } else if (mct >= 150) {
          mRate = 4.2;
        }
      }

      // —— 主页流星星幕（2D 前景层，「星辰坠落」式，JI 2026-11-12
      // 22:51 定；23:23 忠实化升级）：主页落位（trans=0）、地球当
      // 主页、非减动效时，按同一条会话时钟/速率曲线在覆盖画布上
      // 成幕降下——自画面上缘全宽生成、统一约 8° 斜角向下划过、
      // 划完即逝；寿命 <1 秒、火流星少数更亮更长。窗口外/过渡中/
      // 客串主页时不生成，残星燃尽后画布清空归零痕迹。
      // 忠实化三味（机制/时钟/强度曲线全不变，只升质感）：① 燃
      // 烧感——亮头带火焰式 flicker（逐颗相位、三频小幅高频抖
      // 动）+ 头部光晕呼吸，不是匀亮光条；② 很亮——头部 alpha、
      // 光晕尺寸/alpha 与一条宽晕描边同升（账见交付报告），单颗
      // 仍是细条、不糊成光墙；③ 星辰坠落气质——拖尾白→紫渐变
      // （火流星同色系更亮更满）、燃尽时尾端散落白紫星尘、幕布
      // 区域另铺一层极细的星尘闪烁氛围。色板于 23:50 改判为整
      // 体白紫系、00:08 再定版为逐颗四档变体（见 CURTAIN_VARIANTS
      // 与拖尾渐变处注）。
      // 闪烁四层（JI 23:34 强调「就是有那种一闪一闪的效果」——
      // 闪烁是签名不是点缀）：① 波次——生成率在会话强度曲线之
      // 上再叠约 2.6 秒周期的涌起/间歇（峰值段最明显）；② 空中
      // 星尘闪烁场——170 粒微尘各自独立一闪一灭（绘制段锐化曲
      // 线），与轨迹无关、铺满幕布；③ 坠星本体脉动 flicker +
      // 沿途脱落星尘（原地再闪 0.2–0.4 秒）；④ 落点星闪——终点
      // 炸开四角星芒小闪光（约 0.3 秒）+ 火花，闪完即灭。
      {
        const curtainOn = !hpActive && trans === 0 && !reducedMotion;
        if (curtainCtx && curtainW > 0 && curtainH > 0) {
          curtainTime += rawDt;
          // 波次因子：0.5+0.5·sin 整形 ^1.5 → 涌起陡、间歇明确；
          // 振幅随强度曲线缩放（峰值段满幅、渐强段收敛）
          const waveAmp = Math.min(1, mRate / 2.72);
          const waveShape = Math.pow(
            0.5 + 0.5 * Math.sin((curtainTime * Math.PI * 2) / 2.6),
            1.5,
          );
          const waveFactor =
            1 - waveAmp * 0.62 + waveAmp * 1.05 * waveShape;
          // 星尘氛围包络：向窗口速率归一值平滑趋近（开窗渐起、
          // 关窗渐熄，约 1 秒量级）并随波次轻晃，窗口外严格归零
          const dustTarget =
            curtainOn && mRate > 0
              ? Math.min(1, mRate / 2.72) * (0.72 + 0.28 * waveFactor)
              : 0;
          curtainDustEnv +=
            (dustTarget - curtainDustEnv) *
            Math.min(1, rawDt * 1.6);
          if (curtainOn && mRate > 0) {
            curtainAcc += mRate * waveFactor * rawDt;
            while (curtainAcc >= 1) {
              curtainAcc -= 1;
              if (curtainMeteors.length < 44) {
                // 配色抽档（00:08 定版权重）：月白紫 55% / 蓝白
                // 27% / 钙紫粉 13% / 镁绿白 5%；火流星放大改任意
                // 档约 3% 叠加（同色系、尺寸/亮度 1.6–2×、不换
                // 色），取代旧的分段概率 4%/8%
                const vr = Math.random();
                const v = vr < 0.55 ? 0 : vr < 0.82 ? 1 : vr < 0.95 ? 2 : 3;
                const fire = Math.random() < 0.03;
                // 陨石顶替判定（口径见 curtainRocks 处注）：最大
                // 尺寸档（火流星）直接顶替为陨石——无概率掷骰、
                // 不限峰值段、无每循环硬顶（JI 2026-11-13 令：
                // 「直接把最大尺寸的火流星用陨石代替，不然概率
                // 太低了」，推翻先前 0.35 概率 + 峰值段 + 每循
                // 环一颗的稀有口径）。火流星档自此不再以流星形
                // 态出现：凡抽中火流星，即生成一颗陨石
                const toRock = fire;
                // 档位偏置（变体即参数：蓝白生来最快最细、钙紫粉
                // 生来较慢较粗——边际权重精确，相关性由参数偏置
                // 保证，不事后筛选）
                // 速度定版（2026-11-13 09:30，用户：「星辰坠落
                // 的速度不能太快」）：单颗寿命由旧 0.5–0.95 秒拉
                // 到 1.4–2.2 秒（火流星 1.9–2.2），行程不变 → 坠
                // 速降到旧约 1/2–1/3，匀速直坠、头尾全程可读；
                // 同屏存活随寿命自然增至峰值约 8–12 条，存活上
                // 限 44（2026-11-13 晚自 36 小升：本轮轨身加宽
                // 加长后单颗更占眼、峰值段密度略补；出账：峰值
                // 生成 4.2 颗/秒 × 最长寿命 2.2 秒 ≈ 9.2 的稳态
                // 需求，44 是近 5 倍余量封顶、防波次叠加失控）
                let life = fire
                  ? 1.9 + Math.random() * 0.3
                  : 1.4 + Math.random() * 0.8;
                // 一生划行程 = 画面高 50%–85%：幕布的坠势靠长行程
                let dist =
                  curtainH *
                  (fire
                    ? 0.7 + Math.random() * 0.2
                    : 0.5 + Math.random() * 0.35);
                // 拖尾长度（2026-11-13 晚加长：治「太细太单
                // 调」——轨长占幕高比例整体上调约三成）
                let len =
                  curtainH *
                  (fire
                    ? 0.37 + Math.random() * 0.09
                    : 0.21 + Math.random() * 0.11);
                let wMul = 1;
                if (v === 1) {
                  life *= 0.9;
                  dist *= 1.08;
                  len *= 0.92;
                  wMul = 0.8;
                } else if (v === 2) {
                  life *= 1.1;
                  len *= 1.08;
                  wMul = 1.3;
                }
                const ang =
                  ((8 + (Math.random() * 3 - 1.5)) * Math.PI) / 180;
                const spd = dist / life;
                // 同档微抖（2026-11-13 修正）：每停点只掷一个 ±5%
                // 系数、三通道共用——旧版逐通道各掷一次，等于每颗
                // 都在随机改色相（红涨绿跌），把档与档之间的色差
                // 本身搅浑；共用系数只动明度、色相恒定，整段生命
                // 不变、不跨档
                const vdef = CURTAIN_VARIANTS[v]!;
                const cols = vdef.stops.map((s) => {
                  const jk = 0.95 + Math.random() * 0.1;
                  return s.rgb
                    .map((c) => Math.min(255, Math.round(c * jk)))
                    .join(",");
                });
                if (toRock) {
                  // 陨石顶替本颗火流星：更沉更慢（行程 78%–95%
                  // 幕高 / 寿命 2.6–3.2 秒），斜角与全幕同律（共
                  // 用生成段已掷定的 ang）
                  const rLife = 2.6 + Math.random() * 0.6;
                  const rSpd =
                    (curtainH * (0.78 + Math.random() * 0.17)) / rLife;
                  rockSpawnedTotal++;
                  curtainRocks.push({
                    x: Math.random() * curtainW * 1.04 - curtainW * 0.02,
                    y: -curtainH * 0.05 + Math.random() * curtainH * 0.05,
                    vx: Math.sin(ang) * rSpd,
                    vy: Math.cos(ang) * rSpd,
                    age: 0,
                    life: rLife,
                    r: 10 + Math.random() * 3,
                    sp: Math.floor(Math.random() * 3),
                    ph: Math.random() * Math.PI * 2,
                    smokeAcc: 0,
                    emberAcc: 0,
                    fragT: 0.5 + Math.random() * 0.5,
                  });
                } else curtainMeteors.push({
                  x: Math.random() * curtainW * 1.04 - curtainW * 0.02,
                  y: -curtainH * 0.04 + Math.random() * curtainH * 0.09,
                  vx: Math.sin(ang) * spd,
                  vy: Math.cos(ang) * spd,
                  age: 0,
                  life,
                  len,
                  // 粗指针宽度补偿 1.5 → 1.1（2026-11-13 修复
                  // 「感觉变大了」）：上一轮加强把基数 1.5→1.9、
                  // 四层半宽 ×1.35，与本补偿乘法叠加——移动端
                  // 芯宽 2.25→2.85、最外晕半宽 6.1→10.3 CSS px
                  // （+69%），桌面无此乘数、涨幅小得多，用户读
                  // 作「莫名其妙被放大」。补偿降到 1.1 后移动端
                  // 芯宽 ≈2.09（回到加强前 2.25 的量级）、晕半
                  // 宽 ≈7.5（加强轮的层叠辉光保留、总量回位）
                  w: (fire ? 3.0 : 1.9) * wMul * (isCoarse ? 1.1 : 1),
                  fire,
                  v,
                  cols,
                  sparkRgb: cols[2] ?? cols[0]!,
                  ph: Math.random() * Math.PI * 2,
                  shed: 0,
                  glint: 0.15 + Math.random() * 0.4,
                });
              }
            }
          } else {
            curtainAcc = 0;
          }
          // 推进 + 绘制（非主页时残星继续燃尽，随后清空）
          for (let i = curtainMeteors.length - 1; i >= 0; i--) {
            const dm = curtainMeteors[i]!;
            dm.age += rawDt;
            const dhx = dm.x + dm.vx * dm.age;
            const dhy = dm.y + dm.vy * dm.age;
            // —— 轨缀星点（2026-11-13 09:29 定调「拖尾要绚烂」
            // 的缀饰层）：沿轨每约 0.028 秒在头部当前位置缀一粒
            // 星点，嵌在轨身辉光带内（垂直轨向 ±(轨宽+3px) 随
            // 机落点）、原地闪烁 0.35–0.6 秒即灭——无弹道、无重
            // 力、无迸溅（那些连同烟迹已整层退役）：轨在动、星
            // 点在闪，读作拖尾里嵌着的星尘。池封顶 300（峰值稳
            // 态 ≈ 撒点率 10 颗在场星 × 36/秒 × 0.47 秒均寿
            // ≈ 170 粒）
            dm.shed += rawDt;
            while (dm.shed >= 0.024) {
              dm.shed -= 0.024;
              if (curtainSparks.length < 360 && dm.age < dm.life) {
                const spd0 = Math.hypot(dm.vx, dm.vy) || 1;
                const pxu = -dm.vy / spd0;
                const pyu = dm.vx / spd0;
                const off = (Math.random() - 0.5) * 2 * (dm.w * 1.7 + 3);
                curtainSparks.push({
                  x: dhx + pxu * off,
                  y: dhy + pyu * off,
                  vx: 0,
                  vy: 0,
                  age: 0,
                  life: 0.42 + Math.random() * 0.28,
                  rgb: dm.sparkRgb,
                  sz: Math.random(),
                  ph: Math.random() * Math.PI * 2,
                });
              }
            }
            // —— 头部 glint：逐颗计时（0.35–0.8 秒一遇）在头部处
            // 闪一枚小星芒，一闪即过、颜色随本颗档走
            dm.glint -= rawDt;
            if (dm.glint <= 0 && dm.age < dm.life) {
              dm.glint = 0.35 + Math.random() * 0.45;
              if (curtainSparkles.length < 90) {
                const hv = CURTAIN_VARIANTS[dm.v]!;
                curtainSparkles.push({
                  x: dhx,
                  y: dhy,
                  age: 0,
                  life: 0.22 + Math.random() * 0.14,
                  size: (dm.fire ? 15 : 11) + Math.random() * 4,
                  rgb: hv.halo.join(","),
                });
              }
            }
            if (dm.age >= dm.life) {
              const ex = dm.x + dm.vx * dm.life;
              const ey = dm.y + dm.vy * dm.life;
              // 落点星闪：终点炸开一枚四角星芒小闪光（机制不变）
              if (curtainFlashes.length < 24) {
                curtainFlashes.push({
                  x: ex,
                  y: ey,
                  age: 0,
                  life: 0.24 + Math.random() * 0.1,
                  size: dm.fire ? 30 : 19,
                });
              }
              curtainMeteors.splice(i, 1);
            }
          }
          // —— 陨石推进：本体沿弹道匀速坠落，沿途三件套——尘烟
          // （身后持续吐出、膨胀消散）、余烬（尾后脱落的火星、
          // 带轻重力下坠）、碎裂火花（每 0.5–1.0 秒崩落一块燃烧
          // 碎片）；寿命终点在落点闪爆（curtainBooms + 余烬迸溅
          // + 碎块四散）
          for (let i = curtainRocks.length - 1; i >= 0; i--) {
            const rk = curtainRocks[i]!;
            rk.age += rawDt;
            const rhx = rk.x + rk.vx * rk.age;
            const rhy = rk.y + rk.vy * rk.age;
            const rspd = Math.hypot(rk.vx, rk.vy) || 1;
            const rux = rk.vx / rspd;
            const ruy = rk.vy / rspd;
            rk.smokeAcc += rawDt;
            while (rk.smokeAcc >= 0.03) {
              rk.smokeAcc -= 0.03;
              if (curtainPuffs.length < 150 && rk.age < rk.life) {
                curtainPuffs.push({
                  x: rhx - rux * rk.r * 1.2 + (Math.random() - 0.5) * rk.r,
                  y: rhy - ruy * rk.r * 1.2 + (Math.random() - 0.5) * rk.r,
                  vx: -rk.vx * 0.06 + (Math.random() - 0.5) * 8,
                  vy: -rk.vy * 0.06 - 6 - Math.random() * 8,
                  age: 0,
                  life: 0.8 + Math.random() * 0.45,
                  s0: rk.r * (1.1 + Math.random() * 0.5),
                });
              }
            }
            rk.emberAcc += rawDt;
            while (rk.emberAcc >= 0.02) {
              rk.emberAcc -= 0.02;
              if (curtainEmbers.length < 240 && rk.age < rk.life) {
                curtainEmbers.push({
                  x: rhx - rux * rk.r * (0.6 + Math.random() * 1.6),
                  y: rhy - ruy * rk.r * (0.6 + Math.random() * 1.6),
                  vx: -rk.vx * 0.12 + (Math.random() - 0.5) * 26,
                  vy: -rk.vy * 0.12 + (Math.random() - 0.5) * 26,
                  age: 0,
                  life: 0.3 + Math.random() * 0.4,
                  sz: 0.8 + Math.random() * 1.5,
                });
              }
            }
            rk.fragT -= rawDt;
            if (rk.fragT <= 0 && rk.age < rk.life) {
              rk.fragT = 0.5 + Math.random() * 0.5;
              if (curtainFrags.length < 26) {
                const lat = (Math.random() - 0.5) * 90;
                curtainFrags.push({
                  x: rhx,
                  y: rhy,
                  vx: rk.vx * 0.85 - ruy * lat,
                  vy: rk.vy * 0.85 + rux * lat,
                  age: 0,
                  life: 0.45 + Math.random() * 0.35,
                  sz: 1.8 + Math.random() * 1.8,
                  ph: Math.random() * Math.PI * 2,
                });
              }
            }
            if (rk.age >= rk.life) {
              const ex = rk.x + rk.vx * rk.life;
              const ey = rk.y + rk.vy * rk.life;
              if (curtainBooms.length < 4) {
                curtainBooms.push({ x: ex, y: ey, age: 0, life: 0.5 });
              }
              for (let bi = 0; bi < 16 && curtainEmbers.length < 240; bi++) {
                const ba = Math.random() * Math.PI * 2;
                const bs = 40 + Math.random() * 130;
                curtainEmbers.push({
                  x: ex,
                  y: ey,
                  vx: Math.cos(ba) * bs,
                  vy: Math.sin(ba) * bs - 30,
                  age: 0,
                  life: 0.4 + Math.random() * 0.5,
                  sz: 0.9 + Math.random() * 1.6,
                });
              }
              for (let bi = 0; bi < 4 && curtainFrags.length < 26; bi++) {
                const ba = Math.random() * Math.PI * 2;
                const bs = 50 + Math.random() * 90;
                curtainFrags.push({
                  x: ex,
                  y: ey,
                  vx: Math.cos(ba) * bs,
                  vy: Math.sin(ba) * bs - 60,
                  age: 0,
                  life: 0.5 + Math.random() * 0.4,
                  sz: 2 + Math.random() * 2,
                  ph: Math.random() * Math.PI * 2,
                });
              }
              curtainRocks.splice(i, 1);
            }
          }
          // 陨石质感池推进：余烬/碎片吃轻重力（碎片更重、落得更
          // 直），烟团只漂移长老，闪爆只长老
          for (let i = curtainPuffs.length - 1; i >= 0; i--) {
            const pf = curtainPuffs[i]!;
            pf.age += rawDt;
            pf.x += pf.vx * rawDt;
            pf.y += pf.vy * rawDt;
            if (pf.age >= pf.life) curtainPuffs.splice(i, 1);
          }
          for (let i = curtainEmbers.length - 1; i >= 0; i--) {
            const em = curtainEmbers[i]!;
            em.age += rawDt;
            em.vy += 150 * rawDt;
            em.vx *= 1 - 0.6 * rawDt;
            em.x += em.vx * rawDt;
            em.y += em.vy * rawDt;
            if (em.age >= em.life) curtainEmbers.splice(i, 1);
          }
          for (let i = curtainFrags.length - 1; i >= 0; i--) {
            const fg = curtainFrags[i]!;
            fg.age += rawDt;
            fg.vy += 190 * rawDt;
            fg.x += fg.vx * rawDt;
            fg.y += fg.vy * rawDt;
            if (fg.age >= fg.life) curtainFrags.splice(i, 1);
          }
          for (let i = curtainBooms.length - 1; i >= 0; i--) {
            curtainBooms[i]!.age += rawDt;
            if (curtainBooms[i]!.age >= curtainBooms[i]!.life) {
              curtainBooms.splice(i, 1);
            }
          }
          // 轨缀星点推进：原地不动（vx/vy 恒 0），只长老消亡
          for (let i = curtainSparks.length - 1; i >= 0; i--) {
            const sk = curtainSparks[i]!;
            sk.age += rawDt;
            if (sk.age >= sk.life) curtainSparks.splice(i, 1);
          }
          // —— 闪耀层场域源的生成：只在星幕开启且强度包络在场
          // 时生成（curtainOn 含 reduced-motion 关闭口径，窗口
          // 外归零）
          if (curtainOn && curtainDustEnv > 0.03) {
            // 场域小闪：密度 ∝ 包络^1.5（峰值约 44 粒/秒成场、
            // 稀疏段趋零）；位置偏重上 2/3（坠星与烟的活动带）；
            // 档色随当下随机一颗在场坠星，无坠星以月白紫兜底
            sparkleAcc += Math.pow(curtainDustEnv, 1.5) * 44 * rawDt;
            while (sparkleAcc >= 1) {
              sparkleAcc -= 1;
              if (curtainSparkles.length < 90) {
                const src =
                  curtainMeteors.length > 0
                    ? curtainMeteors[
                        Math.floor(Math.random() * curtainMeteors.length)
                      ]!
                    : null;
                const sv = CURTAIN_VARIANTS[src ? src.v : 0]!;
                curtainSparkles.push({
                  x: Math.random() * curtainW,
                  y: Math.pow(Math.random(), 1.25) * curtainH * 0.85,
                  age: 0,
                  life: 0.2 + Math.random() * 0.25,
                  size: 7 + Math.random() * 6,
                  rgb: sv.halo.join(","),
                });
              }
            }
          } else {
            sparkleAcc = 0;
          }
          for (let i = curtainSparkles.length - 1; i >= 0; i--) {
            curtainSparkles[i]!.age += rawDt;
            if (curtainSparkles[i]!.age >= curtainSparkles[i]!.life) {
              curtainSparkles.splice(i, 1);
            }
          }
          for (let i = curtainFlashes.length - 1; i >= 0; i--) {
            curtainFlashes[i]!.age += rawDt;
            if (curtainFlashes[i]!.age >= curtainFlashes[i]!.life) {
              curtainFlashes.splice(i, 1);
            }
          }
          if (
            curtainMeteors.length > 0 ||
            curtainRocks.length > 0 ||
            curtainPuffs.length > 0 ||
            curtainEmbers.length > 0 ||
            curtainFrags.length > 0 ||
            curtainBooms.length > 0 ||
            curtainSparks.length > 0 ||
            curtainFlashes.length > 0 ||
            curtainSparkles.length > 0 ||
            curtainDustEnv > 0.02 ||
            curtainDrawn
          ) {
            curtainCtx.setTransform(curtainPr, 0, 0, curtainPr, 0, 0);
            curtainCtx.clearRect(0, 0, curtainW, curtainH);
            // 陨石尘烟先行（source-over、压在一切光之下）：烟团
            // 随龄膨胀、alpha 钟形起落——全幕唯一的「暗」质感层，
            // 与满幕加色光轨拉开材质差，陨石的重量感一半靠它
            for (const pf of curtainPuffs) {
              const pn = pf.age / pf.life;
              const pa = 0.5 * Math.sin(Math.PI * Math.min(1, pn));
              if (pa < 0.01) continue;
              const ps = pf.s0 * 2 * (1 + pn * 2.6);
              curtainCtx.globalAlpha = pa;
              curtainCtx.drawImage(
                smokeSprite,
                pf.x - ps / 2,
                pf.y - ps / 2,
                ps,
                ps,
              );
            }
            curtainCtx.globalAlpha = 1;
            curtainCtx.globalCompositeOperation = "lighter";
            curtainCtx.lineCap = "round";
            // 空中星尘闪烁场打底（主签名）：170 粒微尘各自随机相位
            // 独立一闪一灭——正弦经 ^6 锐化成「倏地亮起、随即熄灭」
            // 的眨眼曲线（非呼吸微光），峰值 alpha 0.55、平时大半
            // 处于熄灭态，整片空气像在眨眼；白/淡紫/淡蓝三色微
            // 粒（00:08 定版：按同场坠星的档色取系，绿档星尘省）
            if (curtainDustEnv > 0.02) {
              for (const d of curtainDust) {
                const tw =
                  0.5 +
                  0.5 *
                    Math.sin(curtainTime * (1.4 + d.sz * 1.2) + d.ph);
                const a = curtainDustEnv * 0.55 * Math.pow(tw, 6);
                if (a < 0.02) continue;
                curtainCtx.fillStyle =
                  d.hue < 0.4
                    ? `rgba(178,160,255,${a})`
                    : d.hue < 0.75
                      ? `rgba(169,194,255,${a})`
                      : `rgba(240,244,255,${a})`;
                curtainCtx.beginPath();
                curtainCtx.arc(
                  d.fx * curtainW,
                  d.fy * curtainH,
                  d.sz,
                  0,
                  Math.PI * 2,
                );
                curtainCtx.fill();
              }
            }
            for (const m of curtainMeteors) {
              const n = m.age / m.life;
              // 龄期包络：快速淡入、后 45% 平滑收尾（与薄壳同口径）
              const fs = Math.min(1, Math.max(0, (n - 0.55) / 0.45));
              const env = Math.min(1, n / 0.15) * (1 - fs * fs * (3 - 2 * fs));
              if (env <= 0) continue;
              // 头部闪烁 flicker：逐颗相位、三频叠加，亮度 ±约
              // 25% 高频抖动——星芒头不是匀亮的贴纸（口径不变）
              const flick =
                1 +
                0.2 * Math.sin(curtainTime * 34 + m.ph) +
                0.12 * Math.sin(curtainTime * 57 + m.ph * 1.7) +
                0.07 * Math.sin(curtainTime * 83 + m.ph * 0.6);
              const hx = m.x + m.vx * m.age;
              const hy = m.y + m.vy * m.age;
              const spd = Math.hypot(m.vx, m.vy) || 1;
              const ux = m.vx / spd;
              const uy = m.vy / spd;
              const tl = m.len * Math.min(1, n / 0.3);
              const tx = hx - ux * tl;
              const ty = hy - uy * tl;
              const headA = Math.min(
                1,
                env * (m.fire ? 1 : 0.92) * flick,
              );
              // 拖尾渐变（00:08 变体定版）：按这颗星的档位取生成
              // 时预抖的停点——芯白 → 头微染 → 尾段色 → 透明渐
              // 隐；火流星放大不换色，仍属本档（加码只在 headA
              // 与光晕/线宽的尺寸倍率上）
              const mkGrad = (k: number): CanvasGradient => {
                const g = curtainCtx.createLinearGradient(hx, hy, tx, ty);
                const vdef = CURTAIN_VARIANTS[m.v]!;
                for (let si = 0; si < vdef.stops.length; si++) {
                  const s = vdef.stops[si]!;
                  g.addColorStop(
                    s.o,
                    `rgba(${m.cols[si] ?? m.cols[0]},${headA * s.a * k})`,
                  );
                }
                return g;
              };
              // —— 本体形态（2026-11-13 09:28 改判，炉石金卡
              // 「星辰坠落」卡图为准，推翻 08:29 的弯尾球头）：笔
              // 直光轨 + 星芒爆点头 + 绚烂拖尾。中心线全程笔直
              // （无弓、无摆），轨身向后渐细成尖、向前收束到头
              // 部；绚烂靠四层辉光叠出（09:29 定调：拖尾是主
              // 角）——① 大气晕（最宽最淡）② 本档辉光鞘 ③ 色
              // 身 ④ 白炽芯线（只走前 4/5）；每层填充渐变都走
              // 本档多停点（mkGrad：白炽芯 → 头微染 → 尾段色
              // → 渐隐），沿轨自然流转色泽、近头最盛、尾尖收
              // 尽，素面平涂不合格。轨身缀闪星点在轨缀池段另绘。
              const px = -uy;
              const py = ux;
              const drawTail = (
                halfW0: number,
                profP: number,
                lenK: number,
                alphaK: number,
              ): void => {
                const SEG = 9;
                const segLen = tl * lenK;
                curtainCtx.fillStyle = mkGrad(alphaK);
                curtainCtx.beginPath();
                for (let i = 0; i <= SEG; i++) {
                  const t = i / SEG;
                  const cxp = hx - ux * segLen * t;
                  const cyp = hy - uy * segLen * t;
                  const hw = halfW0 * Math.pow(1 - t, profP);
                  if (i === 0) curtainCtx.moveTo(cxp + px * hw, cyp + py * hw);
                  else curtainCtx.lineTo(cxp + px * hw, cyp + py * hw);
                }
                for (let i = SEG; i >= 0; i--) {
                  const t = i / SEG;
                  const cxp = hx - ux * segLen * t;
                  const cyp = hy - uy * segLen * t;
                  const hw = halfW0 * Math.pow(1 - t, profP);
                  curtainCtx.lineTo(cxp - px * hw, cyp - py * hw);
                }
                curtainCtx.closePath();
                curtainCtx.fill();
              };
              // 四层半宽整体 ×~1.35（2026-11-13 晚加宽，外晕
              // 层 alpha 同步小升——拖尾要读成一片流光，不是线）
              drawTail(m.w * 3.6, 0.62, 1, 0.2);
              drawTail(m.w * 2.1, 0.72, 1, 0.5);
              drawTail(m.w * 1.15, 0.85, 1, 0.78);
              drawTail(m.w * 0.5, 1.05, 0.8, 1);
              // 头：星芒爆点（卡图签名）——全幕最亮。先盖按档预
              // 渲染柔光晕，其上画多角星芒：外层本档 halo 色四
              // 角长芒 + 四条 45° 斜细芒，内层近白四角星收一
              // 档，最后压一枚纯白小核。芒形与落点星闪同制（圆
              // 角四角星 path），尺度随闪烁小幅胀缩。
              const gs =
                (m.fire ? 68 : 42) *
                (1 + 0.12 * Math.sin(curtainTime * 9 + m.ph)) *
                (0.9 + 0.2 * (flick - 1));
              curtainCtx.globalAlpha = Math.min(1, env * 0.95 * flick);
              curtainCtx.drawImage(
                curtainGlows[m.v]!,
                hx - gs / 2,
                hy - gs / 2,
                gs,
                gs,
              );
              curtainCtx.globalAlpha = 1;
              const haloRgb = CURTAIN_VARIANTS[m.v]!.halo.join(",");
              const bR =
                (m.fire ? 34 : 22) * (0.92 + 0.16 * (flick - 1));
              const star4 = (s: number, inset: number): void => {
                curtainCtx.beginPath();
                curtainCtx.moveTo(hx, hy - s);
                curtainCtx.quadraticCurveTo(
                  hx + inset,
                  hy - inset,
                  hx + s,
                  hy,
                );
                curtainCtx.quadraticCurveTo(
                  hx + inset,
                  hy + inset,
                  hx,
                  hy + s,
                );
                curtainCtx.quadraticCurveTo(
                  hx - inset,
                  hy + inset,
                  hx - s,
                  hy,
                );
                curtainCtx.quadraticCurveTo(
                  hx - inset,
                  hy - inset,
                  hx,
                  hy - s,
                );
                curtainCtx.closePath();
                curtainCtx.fill();
              };
              curtainCtx.fillStyle = `rgba(${haloRgb},${headA * 0.55})`;
              star4(bR, bR * 0.1);
              // 斜芒：四条细三角（45° 向、半长 0.48R）
              curtainCtx.fillStyle = `rgba(${haloRgb},${headA * 0.45})`;
              for (const [dx, dy] of [
                [1, 1],
                [1, -1],
                [-1, 1],
                [-1, -1],
              ] as const) {
                const dl = Math.SQRT1_2;
                const tipX = hx + dx * dl * bR * 0.48;
                const tipY = hy + dy * dl * bR * 0.48;
                const wx = -dy * dl * bR * 0.055;
                const wy = dx * dl * bR * 0.055;
                curtainCtx.beginPath();
                curtainCtx.moveTo(hx + wx, hy + wy);
                curtainCtx.lineTo(tipX, tipY);
                curtainCtx.lineTo(hx - wx, hy - wy);
                curtainCtx.closePath();
                curtainCtx.fill();
              }
              curtainCtx.fillStyle = `rgba(255,255,255,${headA * 0.95})`;
              star4(bR * 0.55, bR * 0.055);
              curtainCtx.fillStyle = `rgba(255,255,255,${headA})`;
              curtainCtx.beginPath();
              curtainCtx.arc(hx, hy, Math.max(1.4, m.w * 0.85), 0, Math.PI * 2);
              curtainCtx.fill();
            }
            // —— 陨石绘制：先加色层（身后余烬辉 + 双层火焰锥），
            // 再切 source-over 压实心岩体（'lighter' 下暗像素加不
            // 出体积，本体必须走普通合成），最后回加色补前缘熔
            // 边弧光。本体直径 20–26px：读作一块烧红前缘的岩石，
            // 不读作放大的流星
            for (const rk of curtainRocks) {
              const rn = rk.age / rk.life;
              const rEnv =
                Math.min(1, rn / 0.08) *
                (rn > 0.92 ? Math.max(0, (1 - rn) / 0.08) : 1);
              if (rEnv <= 0) continue;
              const flick =
                1 +
                0.22 * Math.sin(curtainTime * 31 + rk.ph) +
                0.13 * Math.sin(curtainTime * 53 + rk.ph * 1.7) +
                0.07 * Math.sin(curtainTime * 79 + rk.ph * 0.6);
              const hx = rk.x + rk.vx * rk.age;
              const hy = rk.y + rk.vy * rk.age;
              const rspd = Math.hypot(rk.vx, rk.vy) || 1;
              const ux = rk.vx / rspd;
              const uy = rk.vy / rspd;
              // 身后余烬辉（预渲染橙辉盖印，尺度随燃闪胀缩）
              const gs = rk.r * 5.2 * (0.92 + 0.16 * (flick - 1));
              curtainCtx.globalAlpha = Math.min(1, rEnv * 0.85);
              curtainCtx.drawImage(
                rockGlowSprite,
                hx - gs / 2,
                hy - gs / 2,
                gs,
                gs,
              );
              curtainCtx.globalAlpha = 1;
              // 火焰锥：自本体向后收分的双层锥（外焰橙红、内焰
              // 明黄），长随燃闪伸缩——是「拖着火」，不是光轨
              const flameLen = rk.r * (4.4 + 1.3 * (flick - 1));
              const bx = hx - ux * rk.r * 0.5;
              const by = hy - uy * rk.r * 0.5;
              const tipX = hx - ux * flameLen;
              const tipY = hy - uy * flameLen;
              const pxu = -uy;
              const pyu = ux;
              const cone = (
                hw: number,
                stops: Array<[number, string]>,
              ): void => {
                const gr = curtainCtx.createLinearGradient(bx, by, tipX, tipY);
                for (const [o, c] of stops) gr.addColorStop(o, c);
                curtainCtx.fillStyle = gr;
                curtainCtx.beginPath();
                curtainCtx.moveTo(bx + pxu * hw, by + pyu * hw);
                curtainCtx.lineTo(tipX, tipY);
                curtainCtx.lineTo(bx - pxu * hw, by - pyu * hw);
                curtainCtx.closePath();
                curtainCtx.fill();
              };
              cone(rk.r * 0.95, [
                [0, `rgba(255,110,40,${0.34 * rEnv * flick})`],
                [0.55, `rgba(215,58,18,${0.16 * rEnv * flick})`],
                [1, "rgba(180,40,10,0)"],
              ]);
              cone(rk.r * 0.5, [
                [0, `rgba(255,196,105,${0.5 * rEnv * flick})`],
                [0.6, `rgba(255,120,45,${0.22 * rEnv * flick})`],
                [1, "rgba(255,90,30,0)"],
              ]);
              // 本体（source-over 实心岩）：精灵按坠向倾角 + 小
              // 幅摇摆转入，熔边烤在精灵底缘、恒朝前缘
              curtainCtx.globalCompositeOperation = "source-over";
              curtainCtx.save();
              curtainCtx.translate(hx, hy);
              curtainCtx.rotate(
                Math.atan2(rk.vx, rk.vy) +
                  Math.sin(curtainTime * 1.4 + rk.ph) * 0.13,
              );
              const ds = (rk.r * 2) / 0.727;
              curtainCtx.globalAlpha = rEnv;
              curtainCtx.drawImage(
                rockSprites[rk.sp]!,
                -ds / 2,
                -ds / 2,
                ds,
                ds,
              );
              curtainCtx.restore();
              curtainCtx.globalAlpha = 1;
              curtainCtx.globalCompositeOperation = "lighter";
              // 前缘熔边弧光：沿速度向 ±约 49° 的双层炽弧，燃闪
              // 调制——与精灵烤入的熔带叠出「正在烧穿大气」的边
              const va = Math.atan2(rk.vy, rk.vx);
              curtainCtx.strokeStyle = `rgba(255,84,30,${0.28 * rEnv * flick})`;
              curtainCtx.lineWidth = 5.5;
              curtainCtx.beginPath();
              curtainCtx.arc(hx, hy, rk.r * 0.98, va - 0.85, va + 0.85);
              curtainCtx.stroke();
              curtainCtx.strokeStyle = `rgba(255,150,70,${0.65 * rEnv * flick})`;
              curtainCtx.lineWidth = 2.2;
              curtainCtx.beginPath();
              curtainCtx.arc(hx, hy, rk.r * 0.98, va - 0.8, va + 0.8);
              curtainCtx.stroke();
            }
            // 余烬：带重力坠落的火星点，前段白炽金、后段橙红收尾
            for (const em of curtainEmbers) {
              const en = em.age / em.life;
              const ea = (1 - en) * 0.95;
              if (ea < 0.02) continue;
              curtainCtx.fillStyle =
                en < 0.35
                  ? `rgba(255,224,175,${ea})`
                  : `rgba(255,${Math.round(130 - 60 * en)},40,${ea})`;
              curtainCtx.beginPath();
              curtainCtx.arc(em.x, em.y, em.sz * (1 - en * 0.45), 0, Math.PI * 2);
              curtainCtx.fill();
            }
            // 碎裂火花：崩落的燃烧碎块——小辉盖印 + 白炽核，燃闪
            // 着坠落（块面太小不逐块画岩，靠辉与闪读作碎片）
            for (const fg of curtainFrags) {
              const fn2 = fg.age / fg.life;
              const fa2 =
                (1 - fn2) *
                (0.75 + 0.25 * Math.sin(curtainTime * 40 + fg.ph * 5));
              if (fa2 < 0.03) continue;
              const fs3 = fg.sz * 5.2;
              curtainCtx.globalAlpha = Math.min(1, fa2 * 0.8);
              curtainCtx.drawImage(
                rockGlowSprite,
                fg.x - fs3 / 2,
                fg.y - fs3 / 2,
                fs3,
                fs3,
              );
              curtainCtx.globalAlpha = 1;
              curtainCtx.fillStyle = `rgba(255,236,200,${fa2})`;
              curtainCtx.beginPath();
              curtainCtx.arc(fg.x, fg.y, fg.sz * 0.5, 0, Math.PI * 2);
              curtainCtx.fill();
            }
            // 终末闪爆：炽核辉光胀开 + 一圈冲击环扩散，约半秒亮
            // 起即灭（迸溅的余烬/碎块已在推进段撒出）
            for (const bm of curtainBooms) {
              const bn = bm.age / bm.life;
              const ba2 = Math.pow(1 - bn, 1.4);
              if (ba2 < 0.02) continue;
              const bs2 = 34 + 150 * bn;
              curtainCtx.globalAlpha = ba2 * 0.95;
              curtainCtx.drawImage(
                rockGlowSprite,
                bm.x - bs2 / 2,
                bm.y - bs2 / 2,
                bs2,
                bs2,
              );
              curtainCtx.globalAlpha = 1;
              curtainCtx.strokeStyle = `rgba(255,178,110,${ba2 * 0.55})`;
              curtainCtx.lineWidth = 2.2 * (1 - bn) + 0.4;
              curtainCtx.beginPath();
              curtainCtx.arc(bm.x, bm.y, 8 + 96 * bn, 0, Math.PI * 2);
              curtainCtx.stroke();
              curtainCtx.fillStyle = `rgba(255,244,220,${ba2})`;
              curtainCtx.beginPath();
              curtainCtx.arc(bm.x, bm.y, 9 * (1 - bn) + 1.5, 0, Math.PI * 2);
              curtainCtx.fill();
            }
            // 落点星闪：四角星芒——外层统一淡紫 #DDD6FE 大芒 +
            // 内层近白小芒（00:08 定版：全场统一，不随档变），
            // 尺度随龄轻张、alpha 陡降，约 0.3 秒闪完即灭
            for (const fl of curtainFlashes) {
              const fn = fl.age / fl.life;
              const fa = Math.pow(1 - fn, 1.6);
              if (fa < 0.02) continue;
              const fs2 = fl.size * (0.55 + 0.6 * fn);
              const star = (s: number, inset: number): void => {
                curtainCtx.beginPath();
                curtainCtx.moveTo(fl.x, fl.y - s);
                curtainCtx.quadraticCurveTo(
                  fl.x + inset,
                  fl.y - inset,
                  fl.x + s,
                  fl.y,
                );
                curtainCtx.quadraticCurveTo(
                  fl.x + inset,
                  fl.y + inset,
                  fl.x,
                  fl.y + s,
                );
                curtainCtx.quadraticCurveTo(
                  fl.x - inset,
                  fl.y + inset,
                  fl.x - s,
                  fl.y,
                );
                curtainCtx.quadraticCurveTo(
                  fl.x - inset,
                  fl.y - inset,
                  fl.x,
                  fl.y - s,
                );
                curtainCtx.closePath();
                curtainCtx.fill();
              };
              curtainCtx.fillStyle = `rgba(221,214,254,${fa * 0.5})`;
              star(fs2, fs2 * 0.1);
              curtainCtx.fillStyle = `rgba(255,255,250,${fa * 0.95})`;
              star(fs2 * 0.55, fs2 * 0.06);
            }
            // 轨缀星点：嵌在轨身辉光里的细密星尘——原地星式闪
            // 烁（sin 脉冲锐化：倏亮倏暗），随龄整体渐隐；颜色取
            // 母星档尾段色、约三成走近白（绘制时按 sz 分档）
            for (const sk of curtainSparks) {
              const sn = sk.age / sk.life;
              const tw = Math.pow(
                0.5 + 0.5 * Math.sin(curtainTime * 26 + sk.ph * 3.1),
                3,
              );
              const a = Math.pow(1 - sn, 1.2) * 0.92 * (0.25 + 0.75 * tw);
              if (a < 0.01) continue;
              curtainCtx.fillStyle =
                sk.sz > 0.72
                  ? `rgba(255,255,255,${a})`
                  : `rgba(${sk.rgb},${a})`;
              curtainCtx.beginPath();
              curtainCtx.arc(sk.x, sk.y, 1.0 + sk.sz * 1.55, 0, Math.PI * 2);
              curtainCtx.fill();
            }
            // —— 闪耀层绘制：小号四角星芒（与落点星闪同形制），
            // 包络锐起（前 22% 满亮）缓落；外层场域档色淡芒 + 内
            // 层近白小芒；两源（场域/头部 glint）同形制
            // 绘制，只差生成位置与档色来源
            for (const sp of curtainSparkles) {
              const n = sp.age / sp.life;
              const fa =
                n < 0.22 ? n / 0.22 : Math.pow(1 - (n - 0.22) / 0.78, 1.5);
              if (fa < 0.02) continue;
              const ss = sp.size * (0.6 + 0.55 * n);
              const star2 = (s: number, inset: number): void => {
                curtainCtx.beginPath();
                curtainCtx.moveTo(sp.x, sp.y - s);
                curtainCtx.quadraticCurveTo(
                  sp.x + inset,
                  sp.y - inset,
                  sp.x + s,
                  sp.y,
                );
                curtainCtx.quadraticCurveTo(
                  sp.x + inset,
                  sp.y + inset,
                  sp.x,
                  sp.y + s,
                );
                curtainCtx.quadraticCurveTo(
                  sp.x - inset,
                  sp.y + inset,
                  sp.x - s,
                  sp.y,
                );
                curtainCtx.quadraticCurveTo(
                  sp.x - inset,
                  sp.y - inset,
                  sp.x,
                  sp.y - s,
                );
                curtainCtx.closePath();
                curtainCtx.fill();
              };
              curtainCtx.fillStyle = `rgba(${sp.rgb},${fa * 0.55})`;
              star2(ss, ss * 0.1);
              curtainCtx.fillStyle = `rgba(255,255,252,${fa * 0.95})`;
              star2(ss * 0.55, ss * 0.06);
            }
            curtainCtx.globalCompositeOperation = "source-over";
            curtainDrawn =
              curtainMeteors.length > 0 ||
              curtainRocks.length > 0 ||
              curtainPuffs.length > 0 ||
              curtainEmbers.length > 0 ||
              curtainFrags.length > 0 ||
              curtainBooms.length > 0 ||
              curtainSparks.length > 0 ||
              curtainFlashes.length > 0 ||
              curtainSparkles.length > 0 ||
              curtainDustEnv > 0.02;
          }
        }
      }

      // —— 背景八星逐帧（太阳系深空背景）：季节权重（日粒度重
      // 算）驱动星光/连线/名签；星体世界坐标与连线曲线在首次进
      // 太阳系时由 layoutStarWorld 一次算定、之后恒定（3D 视差
      // 的前提，逐帧零重写）；整体随 sunFade 进太阳系淡入、回
      // 主页淡出，主页时 starBoard 整体不可见、零绘制。名卡每
      // 6 帧做一次互避判定——恒最高优先级、不让位任何数据标
      // 签，透明度只随季节权重；卡与卡相撞时扇开（低优先卡沿
      // 最小穿透轴推出留缝、偏移逐帧平滑跟随），推不开才淡
      // 出，禁硬跳。
      {
        const nowD = new Date();
        if (nowD.getDate() !== starWeightDay) {
          starWeightDay = nowD.getDate();
          starWeights.winter = seasonWeight(25, nowD);
          starWeights.summer = seasonWeight(208, nowD);
          starWeights.spica = seasonWeight(119, nowD);
        }
        const boardFade = sunFade;
        starBoard.visible = boardFade > 0.02;
        if (starBoard.visible && !starWorldReady) {
          layoutStarWorld();
          starWorldReady = true;
        }
        if (frame % 6 === 0) {
          const wpx = mount.clientWidth || 1;
          const hpx = mount.clientHeight || 1;
          const proj = new THREE.Vector3();
          // 名卡候选集：逐卡定 target 并登记实测矩形，循环后做卡
          // 间扇开（2026-11-13「不要扎堆」改判）。两条旧规则本轮
          // 撤销：① 让位数据标签——旧版名卡与太阳/行星/月球名签
          // 相撞即淡出，用户定版「图层优先级要最高」后名卡恒居
          // 顶层、透明度只由季节权重决定，与数据标签相遇不再退
          // 让（数据标签的收集/判定整段删除）；② 卡间相撞即藏卡
          // ——改为扇开：低优先卡沿最小穿透轴推出至留 3px 呼吸
          // 缝，锚点（星点投影）不动、只挪卡面，偏移封顶 48px
          // 且逐帧平滑跟随；多卡夹死、推出后仍相交才退回淡出。
          interface StarCardCand {
            ns: NamedStar;
            cx: number;
            cy: number;
            target: number;
            prio: number;
          }
          const starCands: StarCardCand[] = [];
          for (const ns of namedStars) {
            if (!ns.labelEl) continue;
            // 实测回读（位置精度定版）：名签真实渲染宽高覆写登
            // 记估算——visibility:hidden 仍有布局盒、offset 读数
            // 有效；字体后加载造成的字宽变化在下一次判定自动跟
            // 上。中心偏移随实测重推（新格式统一锚定：横向居中
            // 恒 0、纵向间隙恒 6px，见 labelCx/labelCy 处注）。
            const mw = ns.labelEl.offsetWidth;
            const mh = ns.labelEl.offsetHeight;
            if (mw > 0 && mh > 0 && (mw !== ns.labelW || mh !== ns.labelH)) {
              ns.labelW = mw;
              ns.labelH = mh;
              ns.labelCx = 0;
              ns.labelCy = -(6 + mh / 2);
            }
            const wgt = starWeights[ns.group];
            // 角宿一名卡破例常驻（2026-11-13 晚用户改判「spica
            // 至少把中文名卡片标出来吧」，推翻同日早间「保持季
            // 节规则、不破例」的定版——仅限名卡）：不受 0.25 藏
            // 卡门槛约束、全年可见；淡季以 0.42 地板压暗、不与
            // 当季星卡争亮度，旺季仍走 wgt×0.85。其星光亮度不
            // 在此列——下方 vis 仍走季节曲线，淡季仍是微光星
            // 点、春季连光带名一起回来。其余七星规则一律不动。
            const target =
              ns.group === "spica"
                ? Math.max(0.42, wgt * 0.85)
                : wgt >= 0.25
                  ? wgt * 0.85
                  : 0;
            // 扇开目标每轮判定先归零，落位段只给成功扇开的卡写
            // 回——离场/被藏的卡偏移自动收回，不留残位
            ns.labelShiftTX = 0;
            ns.labelShiftTY = 0;
            let cand: StarCardCand | null = null;
            if (target > 0 && boardFade > 0.05) {
              // 判定点 = 卡片中心：星点投影 + 登记的中心偏移（与
              // 逐帧定位同一套锚定，见下方名签定位段）。星在相机
              // 背后/离屏时投影无意义（镜像垃圾坐标会误判相撞），
              // 与定位段同口径跳过互避判定——剔除逻辑会把它藏掉
              proj.copy(ns.glow.position);
              proj.project(camera);
              if (
                proj.z > -1 &&
                proj.z < 1 &&
                Math.abs(proj.x) <= 1.03 &&
                Math.abs(proj.y) <= 1.03
              ) {
                cand = {
                  ns,
                  cx: (proj.x * 0.5 + 0.5) * wpx + ns.labelCx,
                  cy: (-proj.y * 0.5 + 0.5) * hpx + ns.labelCy,
                  target,
                  prio: wgt * 2 + ns.base,
                };
              }
            }
            ns.labelFadeT = target;
            if (cand) starCands.push(cand);
          }
          // 卡间扇开：按优先级从高到低逐张落位（高优先卡恒占原
          // 位）；本卡与已落位卡的矩形（实测宽高 + 3px 呼吸缝）
          // 相交时，沿穿透较浅的轴推出恰好留缝的距离，两轮迭代
          // 处理连环相撞；偏移超 48px 或终检仍相交 → 本轮淡出
          // （星点保留）。偏移走 labelShiftT* 目标、定位段逐帧平
          // 滑跟随，不产生跳变。
          if (starCands.length > 1) {
            starCands.sort((a, b) => b.prio - a.prio);
            const placed: StarCardCand[] = [];
            for (const c of starCands) {
              let sx = 0;
              let sy = 0;
              let stuck = false;
              for (let pass = 0; pass < 2 && !stuck; pass++) {
                let moved = false;
                for (const p of placed) {
                  const hw = (c.ns.labelW + p.ns.labelW) / 2 + 3;
                  const hh = (c.ns.labelH + p.ns.labelH) / 2 + 3;
                  const dx = c.cx + sx - p.cx;
                  const dy = c.cy + sy - p.cy;
                  if (Math.abs(dx) < hw && Math.abs(dy) < hh) {
                    const pushX = hw - Math.abs(dx);
                    const pushY = hh - Math.abs(dy);
                    if (pushX <= pushY) sx += (dx >= 0 ? 1 : -1) * pushX;
                    else sy += (dy >= 0 ? 1 : -1) * pushY;
                    moved = true;
                  }
                }
                if (!moved) break;
                if (Math.hypot(sx, sy) > 48) stuck = true;
              }
              if (!stuck) {
                for (const p of placed) {
                  const hw = (c.ns.labelW + p.ns.labelW) / 2 + 3;
                  const hh = (c.ns.labelH + p.ns.labelH) / 2 + 3;
                  if (
                    Math.abs(c.cx + sx - p.cx) < hw &&
                    Math.abs(c.cy + sy - p.cy) < hh
                  ) {
                    stuck = true;
                    break;
                  }
                }
              }
              if (stuck) {
                c.ns.labelFadeT = 0;
              } else {
                c.ns.labelShiftTX = sx;
                c.ns.labelShiftTY = sy;
                c.cx += sx;
                c.cy += sy;
                placed.push(c);
              }
            }
          }
        }
        const starEase = 1 - Math.exp(-dt * 6);
        const starProj = new THREE.Vector3();
        // 名卡背面剔除用：本帧相机朝向（单位向量），循环外取一次
        const starCamDir = new THREE.Vector3();
        camera.getWorldDirection(starCamDir);
        const starPxW = mount.clientWidth || 1;
        const starPxH = mount.clientHeight || 1;
        const siriusBlue = new THREE.Color("#a9c8ff");
        for (const ns of namedStars) {
          const wgt = starWeights[ns.group];
          // —— 当令慢闪（2026-11-13 三度定标，用户三报「没有呼
          // 吸变化 / 频率要错开」）：单正弦呼吸，周期/相位逐星定
          // 表（STAR_TW_TABLE，两两不同、避整数比谐波）——不许
          // 阶梯开关、不许整组同频。
          // 幅度曲线上抬（本轮主修）：旧式 0.35×(wgt−0.25)/0.75
          // 在冬组当前权重 0.65 下只剩 ±18.7%，且旧版核心精灵尺
          // 度根本不参与呼吸（只有光晕 opacity/半径在动、摆幅再
          // ×0.6），小星点上低于可辨阈——诊断属实。新式 =
          // 0.45×clamp((wgt−0.25)/0.55)：满权重 ±45%，冬组
          // 0.65 → ±33%，仍随权重缩放、<0.25 不闪。作用面三件
          // 同相：核心与光晕 opacity（全额）、光晕半径（×0.38
          // 折算 → 冬组 ±12.5%、满权重 ±17%）、星核半径（×0.22
          // 折算），小尺寸下也读得出胀缩。只动星点与光晕（名
          // 签/连线不闪）；天狼星额外带极轻微色温微闪，其余星
          // 不动色。opacity 以 1 封顶防加色过曝削平峰值。
          const twAmp =
            0.45 * THREE.MathUtils.clamp((wgt - 0.25) / 0.55, 0, 1);
          let tw = 1;
          let twS = 0;
          if (twAmp > 0.001) {
            twS = Math.sin(
              (2 * Math.PI * t) / ns.twPeriod + ns.twPhase,
            );
            tw = 1 + twAmp * twS;
          }
          // 非当令退微光：星点尚在（0.15 地板），不当令不消失
          const vis = boardFade * (0.15 + 0.85 * wgt) * tw;
          ns.glowMat.opacity = Math.min(1, 0.88 * ns.base * vis);
          ns.coreMat.opacity = Math.min(1, 0.92 * ns.base * vis);
          ns.glow.scale.setScalar(ns.glowBase * (1 + (tw - 1) * 0.38));
          const coreBreath = ns.coreScaleBase * (1 + (tw - 1) * 0.22);
          ns.core.scale.set(coreBreath, coreBreath, 1);
          if (ns.sirius) {
            ns.coreMat.color
              .copy(ns.coreBase)
              .lerp(
                siriusBlue,
                (0.5 + 0.5 * twS) * 0.4 * (twAmp / 0.45),
              );
          }
          if (ns.labelEl) {
            ns.labelFade += (ns.labelFadeT - ns.labelFade) * starEase;
            // 扇开偏移同走平滑趋近：判定每 6 帧跳一次目标，卡面
            // 逐帧滑过去，不许瞬移
            ns.labelShiftX +=
              (ns.labelShiftTX - ns.labelShiftX) * starEase;
            ns.labelShiftY +=
              (ns.labelShiftTY - ns.labelShiftY) * starEase;
            const lo = boardFade * ns.labelFade;
            // 背面/离屏剔除（2026-11-13 横向溢出定版）：旧口径只看
            // 投影 z<1——星点转到相机背后时 project() 除以负 w，
            // x/y 镜像翻飞到视口外数千 px，卡片 visibility 仍可能
            // 为 visible 并以极端 transform 撑宽页面（用户实报移
            // 动端横向不锁定）。现行口径 = 相机朝向点积（星必须在
            // 相机前方）+ NDC 三轴都在框内（留 3% 边距，贴边星的
            // 卡向内锚定仍可显）；任一不过即剔除：visibility 切
            // 断且 transform 归零停泊——hidden 元素带着极端
            // transform 仍计入可滚动溢出，光藏不归零照样出界。
            starProj.copy(ns.glow.position);
            const toStarX = starProj.x - camera.position.x;
            const toStarY = starProj.y - camera.position.y;
            const toStarZ = starProj.z - camera.position.z;
            const facing =
              toStarX * starCamDir.x +
                toStarY * starCamDir.y +
                toStarZ * starCamDir.z >
              0;
            starProj.project(camera);
            const onScreen =
              facing &&
              starProj.z > -1 &&
              starProj.z < 1 &&
              Math.abs(starProj.x) <= 1.03 &&
              Math.abs(starProj.y) <= 1.03;
            if (lo > 0.02 && onScreen) {
              // 矢量名签逐帧同源投影定位：直接投影星点本身的世界
              // 坐标（starBoard 在场景原点、无变换，glow.position
              // 即世界坐标），名签横向居中对星点、底边距星点 6px
              // ——不用缓存坐标、不用独立锚点，镜头拖动、星点漂
              // 移、3D 视差下都同帧跟随、不脱位（行星名签悬在行
              // 星上方同语义，锚点就是本体本身）
              const lx = (starProj.x * 0.5 + 0.5) * starPxW;
              const ly = (-starProj.y * 0.5 + 0.5) * starPxH;
              // 贴边收进（全员通用一条，取代玻璃卡时代的逐颗偏
              // 好侧/偏好下方 + 角点翻转）：横向把名签中心钳进层
              // 内（留 2px），不许左右出界被裁；纵向常态在星点
              // 上方，只有上方放不下才整签翻到星点下方同间隙。
              // 「放不下」的线 = 顶部安全带（见 labelTopSafePx 处
              // 注）：按本签横向跨度逐签取线（topSafeForSpan）——
              // 只有签面压到左侧时钟跨度时才抬到悬浮带下沿：近距
              // 取景下最上方的星点贴近层顶时，签翻到星点下方、且
              // 锚点再钳到带下沿之下，签面让出时钟药丸；中部与右
              // 侧的签翻转线已随右上角换圆形徽章退回层顶 2px
              // （右侧一段安全带退役，见常量处注），贴顶时照旧
              // 紧贴星点上方、不再整行下让。尺寸用实测
              // labelW/labelH，与互避判定同一套数值。扇开偏移先
              // 叠在锚点上再收进——锚的基准仍是星点投影，偏移只
              // 是签面的避让位移。
              const cardW = ns.labelW;
              const cardH = ns.labelH;
              let ax = lx + ns.labelShiftX;
              const ay = ly + ns.labelShiftY;
              ax = THREE.MathUtils.clamp(
                ax,
                cardW / 2 + 2,
                Math.max(cardW / 2 + 2, starPxW - cardW / 2 - 2),
              );
              const topSafe = topSafeForSpan(
                ax - cardW / 2,
                ax + cardW / 2,
              );
              const below = ay - 6 - cardH < topSafe;
              const ayUsed = below
                ? Math.max(ay, topSafe - 6)
                : ay;
              ns.labelEl.style.opacity = lo.toFixed(3);
              ns.labelEl.style.transform =
                `translate3d(${ax.toFixed(1)}px, ${ayUsed.toFixed(1)}px, 0)` +
                ` translate(-50%, ${below ? "6px" : "calc(-100% - 6px)"})`;
              ns.labelEl.style.visibility = "visible";
            } else if (ns.labelEl.style.visibility !== "hidden") {
              ns.labelEl.style.opacity = "0";
              ns.labelEl.style.visibility = "hidden";
              ns.labelEl.style.transform = "translate3d(0px, 0px, 0)";
              // 藏卡时偏移当前值直接对齐目标（恒为归零态），复
              // 显时不从旧扇开位滑回来
              ns.labelShiftX = ns.labelShiftTX;
              ns.labelShiftY = ns.labelShiftTY;
            }
          }
        }
        winterTri.mat.opacity = 0.32 * starWeights.winter * boardFade;
        summerTri.mat.opacity = 0.32 * starWeights.summer * boardFade;
      }

      // —— 具名彗星名卡（哈雷/恩克/潘斯达斯/艾森）：与八星名卡
      // 同层同纪律——starLabelLayer 最高层级、不让位任何数据标
      // 签；逐帧直锚彗头世界投影（彗星在 solarGroup 内、组带旋
      // 转/缩放/平移，必须经 matrixWorld 转世界坐标，不许拿本地
      // 坐标冒充）；背面/离屏剔除时 transform 归零停泊（横向出
      // 界纪律同八星段）；贴边翻转整卡留屏内。互避每 6 帧判定：
      // 八星已落位卡面作固定障碍、四张彗星卡之间按优先级扇开
      // （锚钉彗头、偏移封顶 48px 平滑跟随），推不开才淡出。
      // 透明度 = 本帧总淡化 × (0.45 + 0.55×活跃度)：远方暗核期
      // 卡片半透可凭卡认星、活跃期全显。
      {
        if (frame % 6 === 0) {
          const wpx = mount.clientWidth || 1;
          const hpx = mount.clientHeight || 1;
          // 八星卡障碍矩形：按八星段同口径重算其本帧落位中心
          // （星点投影 + 登记中心偏移 + 当前扇开偏移），实测宽高
          interface CardRect { cx: number; cy: number; w: number; h: number }
          const obstacles: CardRect[] = [];
          const oProj = new THREE.Vector3();
          for (const ns of namedStars) {
            if (!ns.labelEl || ns.labelFadeT <= 0) continue;
            oProj.copy(ns.glow.position);
            oProj.project(camera);
            if (
              oProj.z <= -1 || oProj.z >= 1 ||
              Math.abs(oProj.x) > 1.03 || Math.abs(oProj.y) > 1.03
            ) continue;
            obstacles.push({
              cx: (oProj.x * 0.5 + 0.5) * wpx + ns.labelCx + ns.labelShiftX,
              cy: (-oProj.y * 0.5 + 0.5) * hpx + ns.labelCy + ns.labelShiftY,
              w: ns.labelW,
              h: ns.labelH,
            });
          }
          interface CometCardCand {
            nc: NamedCometRt;
            cx: number;
            cy: number;
            prio: number;
          }
          const cometCands: CometCardCand[] = [];
          const cProj = new THREE.Vector3();
          for (const nc of namedCometRts) {
            // 实测回读（与八星同口径）：真实宽高覆写估算占位
            const mw = nc.cardEl.offsetWidth;
            const mh = nc.cardEl.offsetHeight;
            if (mw > 0 && mh > 0) {
              nc.cardW = mw;
              nc.cardH = mh;
            }
            nc.cardShiftTX = 0;
            nc.cardShiftTY = 0;
            nc.cardBlocked = false;
            if (nc.fadeNow <= 0.05) continue;
            cProj.copy(nc.localPos).applyMatrix4(solarGroup.matrixWorld);
            cProj.project(camera);
            if (
              cProj.z <= -1 || cProj.z >= 1 ||
              Math.abs(cProj.x) > 1.03 || Math.abs(cProj.y) > 1.03
            ) continue;
            cometCands.push({
              nc,
              // 卡心 = 彗头投影 + (间隙 9 + 半宽, −(间隙 7 + 半高))
              cx: (cProj.x * 0.5 + 0.5) * wpx + 9 + nc.cardW / 2,
              cy: (-cProj.y * 0.5 + 0.5) * hpx - 7 - nc.cardH / 2,
              prio: nc.def.cardPrio * 10 + nc.act,
            });
          }
          // 扇开：高优先先落位；障碍含八星卡与已落位彗星卡；沿
          // 最小穿透轴推出留 3px 缝，两轮迭代；超 48px 或终检
          // 仍相交 → 本轮淡出（彗星本体保留）
          cometCands.sort((a, b) => b.prio - a.prio);
          const placedC: CardRect[] = [...obstacles];
          for (const c of cometCands) {
            let sx = 0;
            let sy = 0;
            let stuck = false;
            for (let pass = 0; pass < 2 && !stuck; pass++) {
              let moved = false;
              for (const p of placedC) {
                const hw = (c.nc.cardW + p.w) / 2 + 3;
                const hh = (c.nc.cardH + p.h) / 2 + 3;
                const dx = c.cx + sx - p.cx;
                const dy = c.cy + sy - p.cy;
                if (Math.abs(dx) < hw && Math.abs(dy) < hh) {
                  const pushX = hw - Math.abs(dx);
                  const pushY = hh - Math.abs(dy);
                  if (pushX <= pushY) sx += (dx >= 0 ? 1 : -1) * pushX;
                  else sy += (dy >= 0 ? 1 : -1) * pushY;
                  moved = true;
                }
              }
              if (!moved) break;
              if (Math.hypot(sx, sy) > 48) stuck = true;
            }
            if (!stuck) {
              for (const p of placedC) {
                const hw = (c.nc.cardW + p.w) / 2 + 3;
                const hh = (c.nc.cardH + p.h) / 2 + 3;
                if (
                  Math.abs(c.cx + sx - p.cx) < hw &&
                  Math.abs(c.cy + sy - p.cy) < hh
                ) {
                  stuck = true;
                  break;
                }
              }
            }
            if (stuck) {
              c.nc.cardBlocked = true;
            } else {
              c.nc.cardShiftTX = sx;
              c.nc.cardShiftTY = sy;
              placedC.push({
                cx: c.cx + sx,
                cy: c.cy + sy,
                w: c.nc.cardW,
                h: c.nc.cardH,
              });
            }
          }
        }
        const cometCardEase = 1 - Math.exp(-dt * 6);
        const ccProj = new THREE.Vector3();
        const ccCamDir = new THREE.Vector3();
        camera.getWorldDirection(ccCamDir);
        const ccPxW = mount.clientWidth || 1;
        const ccPxH = mount.clientHeight || 1;
        for (const nc of namedCometRts) {
          nc.cardFadeT =
            !nc.cardBlocked && nc.fadeNow > 0.03
              ? nc.fadeNow * (0.45 + 0.55 * nc.act)
              : 0;
          nc.cardFade += (nc.cardFadeT - nc.cardFade) * cometCardEase;
          nc.cardShiftX +=
            (nc.cardShiftTX - nc.cardShiftX) * cometCardEase;
          nc.cardShiftY +=
            (nc.cardShiftTY - nc.cardShiftY) * cometCardEase;
          ccProj.copy(nc.localPos).applyMatrix4(solarGroup.matrixWorld);
          const toCX = ccProj.x - camera.position.x;
          const toCY = ccProj.y - camera.position.y;
          const toCZ = ccProj.z - camera.position.z;
          const ccFacing =
            toCX * ccCamDir.x + toCY * ccCamDir.y + toCZ * ccCamDir.z > 0;
          ccProj.project(camera);
          const ccOnScreen =
            ccFacing &&
            ccProj.z > -1 &&
            ccProj.z < 1 &&
            Math.abs(ccProj.x) <= 1.03 &&
            Math.abs(ccProj.y) <= 1.03;
          if (nc.cardFade > 0.02 && ccOnScreen) {
            const lx = (ccProj.x * 0.5 + 0.5) * ccPxW;
            const ly = (-ccProj.y * 0.5 + 0.5) * ccPxH;
            const ax = lx + nc.cardShiftX;
            const ay = ly + nc.cardShiftY;
            const flipX = ax + 9 + nc.cardW > ccPxW - 2;
            // 纵向翻转线与八星名签共用顶部安全带（同层同纪律、
            // 同走 topSafeForSpan 逐卡取线）：只有卡面横向压到
            // 左侧时钟跨度时才让出悬浮带、翻下后锚点再钳到带下
            // 沿之下；右侧一段已随右上角换圆形徽章退役，中部与
            // 右侧的卡翻转线回到层顶 2px，整卡不被时钟盖住即
            // 可、不再整行下让
            const cardSpanL = flipX ? ax - 9 - nc.cardW : ax + 9;
            const cardSpanR = flipX ? ax - 9 : ax + 9 + nc.cardW;
            const topSafe = topSafeForSpan(cardSpanL, cardSpanR);
            const flipY = ay - 7 - nc.cardH < topSafe;
            const ayUsed = flipY
              ? Math.max(ay, topSafe - 7)
              : ay;
            nc.cardEl.style.opacity = nc.cardFade.toFixed(3);
            nc.cardEl.style.transform =
              `translate3d(${ax.toFixed(1)}px, ${ayUsed.toFixed(1)}px, 0)` +
              ` translate(${flipX ? "calc(-100% - 9px)" : "9px"}, ${flipY ? "7px" : "calc(-100% - 7px)"})`;
            nc.cardEl.style.visibility = "visible";
          } else if (nc.cardEl.style.visibility !== "hidden") {
            nc.cardEl.style.opacity = "0";
            nc.cardEl.style.visibility = "hidden";
            nc.cardEl.style.transform = "translate3d(0px, 0px, 0)";
            nc.cardShiftX = nc.cardShiftTX;
            nc.cardShiftY = nc.cardShiftTY;
          }
        }
      }

      // 节点按朝向淡入淡出：转到背面的节点（含标签）整体隐去
      const camDir = camera.position.clone().normalize();
      for (const nv of nodeVis) {
        const wp = nv.base.clone().applyMatrix4(earth.matrixWorld);
        const facing = wp.normalize().dot(camDir);
        const vis = THREE.MathUtils.clamp((facing - 0.02) / 0.22, 0, 1);
        for (const m of nv.mats) {
          const base = (m.userData.baseOpacity as number | undefined) ?? 1;
          (m as THREE.Material & { opacity: number }).opacity =
            vis * base * globeFade;
        }
      }

      // 金融中心标记同样按朝向淡出，并记录 facing 供标签避让使用
      for (const cv of centerVis) {
        const wp = cv.base.clone().applyMatrix4(earth.matrixWorld);
        const facing = wp.normalize().dot(camDir);
        cv.facing = facing;
        const vis = THREE.MathUtils.clamp((facing - 0.02) / 0.22, 0, 1);
        for (const m of cv.mats) {
          // 客串主页回太阳系时随 earthReveal 一同淡入，不抢先弹入
          (m as THREE.Material & { opacity: number }).opacity =
            vis * earthRevealNow;
        }
      }

      // 统一标签避让（每 5 帧重算一次，帧间只做透明度缓动，避免转动时
      // 每帧全量重排造成抖动/掉帧）：核心城市与第一梯队中心是「常驻标签」，
      // 与邻居重叠或贴边出界时按优先级错位偏移找空位，绝不因避让被隐藏；
      // 第二梯队维持原规则（重叠即隐藏），仅贴边出界时允许小幅内收找空位。
      // 淡出阈值后移到接近球缘才开始（facing 0.04 起、0.24 全显），
      // 正面半球内的贴边标签（如悉尼）保持完整可读、不被裁切。
      if (frame % 5 === 0) {
        syncBoards();
        const w = mount.clientWidth || 1;
        const h = mount.clientHeight || 1;
        const pr = renderer.getPixelRatio();
        interface Cand {
          sprite: THREE.Sprite;
          base: THREE.Vector3;
          priority: number;
          tier1: boolean;
          /** 候选框高宽比（标签 72/256；指数板 144/384） */
          aspect: number;
          /** 错位后强制保持的离心距（仅指数板）：反投影只保投影
           * 深度、会把板心拖向球心，钳回锚半径防边角沉进球面 */
          clampLen?: number;
          /** 当地时间显隐：always=随名称常显 / uncrowded=仅原位无重叠时显 / never=不显 */
          timeMode: "always" | "uncrowded" | "never";
          getOff: () => { x: number; y: number };
          apply: (t: number, dx: number, dy: number) => void;
          applyTime: (v: number) => void;
        }
        const cands: Cand[] = [];
        for (const cl of coreLabels)
          cands.push({
            sprite: cl.sprite,
            base: cl.base,
            priority: cl.priority,
            tier1: true,
            aspect: 72 / 256,
            timeMode: "always",
            getOff: () => ({ x: cl.offX, y: cl.offY }),
            apply: (t, dx, dy) => {
              cl.target = t;
              cl.offX = dx;
              cl.offY = dy;
            },
            applyTime: (v) => {
              cl.timeTarget = v;
            },
          });
        for (const cv of centerVis) {
          const lbl = cv.label;
          if (!lbl) continue; // 无文字标签（香港）：不进避让池
          cands.push({
            sprite: lbl,
            base: cv.labelBase,
            priority: cv.def.tier === 1 ? 80 : cv.def.tier === 2 ? 40 : 26,
            tier1: cv.def.tier === 1,
            aspect: 72 / 256,
            timeMode:
              cv.def.tier === 1
                ? "always"
                : cv.def.tier === 2
                  ? "uncrowded"
                  : "never",
            getOff: () => ({ x: cv.labelOffX, y: cv.labelOffY }),
            apply: (t, dx, dy) => {
              cv.labelTarget = t;
              cv.labelOffX = dx;
              cv.labelOffY = dy;
            },
            applyTime: (v) => {
              cv.timeTarget = v;
            },
          });
        }
        // 指数板进同一个避让池：优先级 65（纽约第二板 63）——低于
        // 核心城市（72+）与第一梯队中心标签（80），永远不遮挡金融
        // 中心主标签；高于第二/三梯队标签（40/26），低级别标签给
        // 板让位。板按 tier1 的「常驻」语义找空位（只被朝向淡出
        // 隐藏），无数据的板不进池（整板不出现）。框高宽比直接取
        // 精灵缩放比（全场统一两行板 144/384，2026-11-13 起无地
        // 区变体）。
        for (const bv of boardVis)
          if (bv.hasData)
            cands.push({
              sprite: bv.sprite,
              base: bv.base,
              priority: bv.priority,
              tier1: true,
              aspect: bv.sprite.scale.y / bv.sprite.scale.x,
              clampLen: bv.base.length(),
              timeMode: "never",
              getOff: () => ({ x: bv.offX, y: bv.offY }),
              apply: (t, dx, dy) => {
                bv.target = t;
                bv.offX = dx;
                bv.offY = dy;
              },
              applyTime: () => {},
            });
        cands.sort((a, b) => b.priority - a.priority);
        const accepted: Array<{ x: number; y: number; w: number; h: number }> =
          [];
        const tmpNdc = new THREE.Vector3();
        for (const cand of cands) {
          const wp = cand.base.clone().applyMatrix4(earth.matrixWorld);
          const facing = wp.clone().normalize().dot(camDir);
          const faceFade = THREE.MathUtils.clamp(
            (facing - 0.04) / 0.2,
            0,
            1,
          );
          const sp = faceFade > 0.02 ? wp.project(camera) : null;
          if (!sp || sp.z >= 1) {
            cand.sprite.position.copy(cand.base);
            cand.apply(0, 0, 0);
            cand.applyTime(0);
            continue;
          }
          const bw =
            (cand.sprite.scale.x * scaleUniform.value) /
            camera.position.z /
            pr;
          const bh = bw * cand.aspect + 6;
          const sx = (sp.x * 0.5 + 0.5) * w;
          const sy = (-sp.y * 0.5 + 0.5) * h;
          const inBounds = (x: number, y: number) =>
            x - bw / 2 > 5 &&
            x + bw / 2 < w - 5 &&
            y - bh / 2 > 5 &&
            y + bh / 2 < h - 5;
          const overlaps = (x: number, y: number) =>
            accepted.some(
              (r) =>
                Math.abs(r.x - x) < (r.w + bw) / 2 &&
                Math.abs(r.y - y) < (r.h + bh) / 2,
            );
          // 候选偏移：先试上次的位置（防抖动），再原位，然后向四周错位
          const stepX = bw + 12;
          const stepY = bh + 8;
          const last = cand.getOff();
          const offsets: Array<{ x: number; y: number }> = [
            { x: last.x, y: last.y },
            { x: 0, y: 0 },
            { x: 0, y: -stepY },
            { x: 0, y: stepY },
            { x: -stepX, y: 0 },
            { x: stepX, y: 0 },
            { x: -stepX, y: -stepY },
            { x: stepX, y: -stepY },
            { x: -stepX, y: stepY },
            { x: stepX, y: stepY },
            { x: 0, y: -2 * stepY },
            { x: 0, y: 2 * stepY },
          ];
          let chosen: { x: number; y: number } | null = null;
          if (cand.tier1) {
            // 常驻标签：优先取无重叠且在界内的错位；实在没有空位时退而
            // 取在界内的位置（底衬保证压在低优先级标签上仍可读），最后
            // 才钳回界内——任何情况下不因避让消失
            for (const o of offsets) {
              if (
                inBounds(sx + o.x, sy + o.y) &&
                !overlaps(sx + o.x, sy + o.y)
              ) {
                chosen = o;
                break;
              }
            }
            if (!chosen) {
              for (const o of offsets) {
                if (inBounds(sx + o.x, sy + o.y)) {
                  chosen = o;
                  break;
                }
              }
            }
            if (!chosen) {
              chosen = {
                x: THREE.MathUtils.clamp(sx, bw / 2 + 5, w - bw / 2 - 5) - sx,
                y: THREE.MathUtils.clamp(sy, bh / 2 + 5, h - bh / 2 - 5) - sy,
              };
            }
          } else if (inBounds(sx, sy) && !overlaps(sx, sy)) {
            chosen = { x: 0, y: 0 };
          } else if (!inBounds(sx, sy)) {
            // 第二梯队贴边出界：允许小幅内收找空位，但仍不得与已接受
            // 标签重叠，找不到就按原规则隐藏
            for (const o of offsets) {
              if (
                inBounds(sx + o.x, sy + o.y) &&
                !overlaps(sx + o.x, sy + o.y)
              ) {
                chosen = o;
                break;
              }
            }
          }
          if (!chosen) {
            cand.sprite.position.copy(cand.base);
            cand.apply(0, 0, 0);
            cand.applyTime(0);
            continue;
          }
          accepted.push({ x: sx + chosen.x, y: sy + chosen.y, w: bw, h: bh });
          cand.apply(faceFade, chosen.x, chosen.y);
          // 当地时间：第一梯队随名称常显；第二梯队只有原位无重叠
          // （不拥挤）时才显示，错位挤出来的标签只留名称防糊
          cand.applyTime(
            cand.timeMode === "always"
              ? faceFade
              : cand.timeMode === "uncrowded" &&
                  chosen.x === 0 &&
                  chosen.y === 0
                ? faceFade
                : 0,
          );
          if (chosen.x === 0 && chosen.y === 0) {
            cand.sprite.position.copy(cand.base);
          } else {
            // 屏幕错位 → 世界坐标：保持原投影深度反投影，再转回地球本地系
            tmpNdc.set(
              ((sx + chosen.x) / w) * 2 - 1,
              -(((sy + chosen.y) / h) * 2 - 1),
              sp.z,
            );
            const world = tmpNdc.unproject(camera);
            const local = earth.worldToLocal(world);
            if (cand.clampLen) local.setLength(cand.clampLen);
            cand.sprite.position.copy(local);
          }
        }
      }
      for (const cl of coreLabels) {
        const m = cl.sprite.material as THREE.SpriteMaterial;
        m.opacity += (cl.target * globeFade - m.opacity) * 0.15;
      }
      for (const cv of centerVis) {
        if (!cv.label) continue;
        const m = cv.label.material as THREE.SpriteMaterial;
        m.opacity += (cv.labelTarget * globeFade - m.opacity) * 0.15;
      }
      // 指数板透明度跟随避让目标（同标签的缓动口径）；板专用锚点
      // 的小节点点跟随板的透明度；引线终点逐帧跟板心（避让错位把
      // 板挪到哪，引线就连到哪），起点钉死在交易所球面锚点
      for (const bv of boardVis) {
        const m = bv.sprite.material as THREE.SpriteMaterial;
        m.opacity += (bv.target * globeFade - m.opacity) * 0.15;
        bv.sprite.visible = globeDetail && m.opacity > 0.01;
        const lp = bv.line.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        lp.setXYZ(
          1,
          bv.sprite.position.x,
          bv.sprite.position.y,
          bv.sprite.position.z,
        );
        lp.needsUpdate = true;
        bv.lineMat.opacity = m.opacity * 0.5;
        bv.line.visible = bv.sprite.visible;
        if (bv.dot) {
          (bv.dot.material as THREE.SpriteMaterial).opacity = m.opacity * 0.85;
          bv.dot.visible = bv.sprite.visible;
        }
      }
      // 当地时间小标签跟随：贴在名称标签正下方（沿相机上方向反向偏移），
      // 透明度 = 名称透明度 × 时间显隐系数 × 太阳系过渡淡出。
      // 偏移量按字形几何收紧（2026-11-11，用户：时间位置偏移有些多）：
      // 旧值 0.064/0.056/0.05 与名称字形底之间留了约 0.02 的空档，
      // 时间看着像浮在别处；现按「名称底衬盒/字形底 + 时间字形顶
      // + 约 0.004 的呼吸缝」逐级算：核心 0.052、第一梯队 0.044、
      // 第二梯队 0.034，时间贴着名称走，不再独立漂移。
      {
        earth.updateMatrixWorld();
        camUpV.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const solarFade = 1 - eTrans;
        for (const cl of coreLabels) {
          cl.timeVis += (cl.timeTarget - cl.timeVis) * 0.15;
          const tm = cl.timeSprite.material as THREE.SpriteMaterial;
          tm.opacity =
            (cl.sprite.material as THREE.SpriteMaterial).opacity *
            cl.timeVis *
            solarFade;
          cl.sprite.visible = globeDetail;
          cl.timeSprite.visible = globeDetail;
          if (globeDetail) {
            cl.sprite.getWorldPosition(tmpWorldV);
            tmpWorldV.addScaledVector(camUpV, -0.052);
            cl.timeSprite.position.copy(earth.worldToLocal(tmpWorldV));
          }
        }
        for (const cv of centerVis) {
          cv.timeVis += (cv.timeTarget - cv.timeVis) * 0.15;
          const lbl = cv.label;
          if (!lbl) continue; // 无文字标签（香港）：名称/时间都不跟随
          lbl.visible = globeDetail;
          if (cv.timeSprite) {
            const tm = cv.timeSprite.material as THREE.SpriteMaterial;
            tm.opacity =
              (lbl.material as THREE.SpriteMaterial).opacity *
              cv.timeVis *
              solarFade;
            cv.timeSprite.visible = globeDetail;
            if (globeDetail) {
              lbl.getWorldPosition(tmpWorldV);
              tmpWorldV.addScaledVector(
                camUpV,
                cv.def.tier === 1 ? -0.044 : -0.034,
              );
              cv.timeSprite.position.copy(earth.worldToLocal(tmpWorldV));
            }
          }
        }
      }

      // 节点光环呼吸扩散
      for (const ring of nodeRings) {
        const s = 0.16 + ((t * 0.45 + ring.phase) % 1) * 0.2;
        ring.sprite.scale.set(s, s, 1);
      }

      // 命中涟漪：选中后 1.1 秒内从节点向外扩散并淡出
      burstRings.forEach((b, i) => {
        const start = burstStart.get(i);
        const age = start == null ? 99 : t - start;
        if (age >= 0 && age < 1.1) {
          const p = age / 1.1;
          const s = 0.12 + p * 0.55;
          b.sprite.scale.set(s, s, 1);
          b.mat.opacity = 0.85 * (1 - p);
        } else {
          b.mat.opacity = 0;
        }
      });

      const inten = st.intensity;
      const flash = Math.max(0, 1 - (t - flashStart) / 1.4);
      // 弧线背面变淡：按弧线中点朝向调管身亮度，不抢夜面灯光。
      // 双层分别调：光晕层恒淡，芯线层更亮并带极慢的呼吸（虚实感）；
      // 整体亮度系数按通道强度缩放（a.bright：顶级 1.00 → 尾部 0.30），
      // 顶级通道的柔光鞘再叠一层极淡的辉光。2026-11-11 收锐口径：
      // 芯线提亮（0.6→0.74）、呼吸减半（±0.16→±0.08）、鞘压淡
      // （0.055→0.04，配合建网时鞘宽 2.3→1.6 倍与晕管 ×0.79）——
      // 亮度从摊开的软带收回芯线，观感更利落、地域色更分明。
      // 激光轮（同日续）：芯线已换激光着色器——此处只写它的基础
      // 不透明度 uniform（账面与旧 opacity 完全一致），扫光带与随机
      // 闪烁由着色器内的共享时钟 laserTime 驱动；鞘微微回提
      // （0.04→0.05）给扫光带让出一点辉光氛围，不动鞘宽、不回糊。
      laserTime.value = t;
      sparkMat.uniforms.uOpacity!.value = globeFade;
      for (const a of flowArcs) {
        const wm = a.mid
          .clone()
          .applyMatrix4(earth.matrixWorld)
          .normalize();
        const f = wm.dot(camDir);
        a.fade = THREE.MathUtils.clamp((f + 0.25) / 0.75, 0.08, 1);
        const common =
          a.fade *
          (0.75 + inten * 0.45 + flash * flash * 0.3) *
          a.bright *
          globeFade;
        a.matHalo.opacity = 0.15 * common;
        a.matCore.uniforms.uOpacity!.value =
          0.74 * common * (0.92 + 0.08 * Math.sin(t * 1.35 + a.phase * 9.0));
        if (a.matGlow) a.matGlow.opacity = 0.05 * common;
      }

      // —— 海底光缆层逐帧：常驻显示（无开关），仅在非主页星球、
      // 监控图层未淡出时可见；状态每 30 帧与 App 的状态表对齐
      // 一次（板块与球上同源同色）；朝向淡出与金融弧同口径；
      // fault 警示脉动、watch 缓脉动；光流相位逐帧推进（见
      // CableVis 注释里的速度账），无 CPU 曲线更新
      {
        cableGroup.visible = !hpActive && globeFade > 0.02;
        if (cableGroup.visible) {
          if (frame % 30 === 0) {
            for (const vis of cableVisList) {
              const tier = st.cableStatusById?.[vis.id]?.tier ?? "ok";
              if (tier !== vis.tier) applyCableTier(vis, tier);
            }
          }
          for (const vis of cableVisList) {
            const wm = vis.mid
              .clone()
              .applyMatrix4(earth.matrixWorld)
              .normalize();
            const f = wm.dot(camDir);
            const fade =
              THREE.MathUtils.clamp((f + 0.25) / 0.75, 0.05, 1) * globeFade;
            const pulse =
              vis.tier === "fault"
                ? 0.7 + 0.3 * Math.sin(t * 2.3 + vis.phase)
                : vis.tier === "watch"
                  ? 0.88 + 0.12 * Math.sin(t * 1.2 + vis.phase)
                  : 1;
            vis.coreMat.opacity = 0.5 * fade * pulse;
            vis.haloMat.opacity = 0.1 * fade * pulse;
            vis.dotMat.opacity = 0.9 * fade;
            vis.flowMat.uniforms.uPhase!.value = (t * vis.flowSpeed) % 1;
            vis.flowMat.uniforms.uOpacity!.value =
              fade * (vis.tier === "fault" ? pulse : 1);
          }
        }
      }

      // 到达涟漪：0.95 秒内从目标节点向外扩散并淡出
      for (const r of ripplePool) {
        const age = t - r.start;
        if (age >= 0 && age < 0.95) {
          const p = age / 0.95;
          const s = 0.07 + p * 0.3;
          r.sprite.scale.set(s, s, 1);
          r.mat.opacity = 0.65 * (1 - p);
        } else {
          r.mat.opacity = 0;
        }
      }
      // 流动粒子（彗星式）：亮头 + 8 点拖尾，拖尾沿来路在相位空间回退、
      // 经同一条缓动曲线取点——离城段尾巴拉长、近城段收拢。
      // 运动节奏全线一致：缓动 u = 1-(1-p)^1.7，出发快、接近目标减速汇入。
      // 相位回绕即抵达 → 在目标城市触发一次涟漪。头部亮度带轻微脉动；
      // 大小/亮度/速度按通道强度差异化，速度与亮度另随当日波动强度放大。
      // 双向交换（2026-11-11，用户：「信息在交换的粒子效果」）：同一
      // 条弧的脉冲按序号交替方向——偶数 A→B、奇数 B→A，两端城市轮流
      // 收发，到达涟漪也随之在两端交替触发，一眼读出「对流交换」而
      // 非单向灌输。粒子总数不变（只是方向账改了），性能零增量。
      // 头部另带激光频闪：pow 6 次方的尖峰正弦让亮头周期性爆亮并
      // 向白热混合、尺寸微胀——与芯线扫光带、沿弧火花同属一个「闪」
      // 的家族，三层叠起来是完整的信号感。
      {
        let p = 0;
        let pi = 0;
        const speedMul = 0.55 + inten * 1.15;
        const ease = (x: number) => 1 - Math.pow(1 - x, 1.7);
        for (const a of flowArcs) {
          const lvlSpeed = a.speedF;
          const headBase = a.headBase;
          const headSize = a.headSize;
          for (let k = 0; k < a.pulses; k++) {
            const rev = k % 2 === 1;
            const raw =
              (t * a.speed * speedMul * lvlSpeed + a.phase + k / a.pulses) %
              1;
            const prev = pulsePrev[pi]!;
            if (prev > 0.7 && raw < 0.3 && a.fade > 0.25) {
              if (rev) fireRipple(a.src, a.colA, t);
              else fireRipple(a.dest, a.colB, t);
            }
            pulsePrev[pi] = raw;
            pi++;
            const pulse =
              0.85 + 0.15 * Math.sin(t * 5 + a.phase * 20 + k * 1.7);
            const strobe = Math.pow(
              0.5 + 0.5 * Math.sin(t * 9 + a.phase * 40 + k * 2.39),
              6,
            );
            for (let j = 0; j <= TRAILS; j++) {
              const idx = p++;
              // 移动端护栏：弱通道拖尾先砍短，保帧率
              if (isCoarse && a.strength < 0.2 && j > 4) {
                flowAlpha[idx] = 0;
                continue;
              }
              const pj = raw - j * 0.016;
              if (pj < 0) {
                flowAlpha[idx] = 0;
                continue;
              }
              const uu = rev ? 1 - ease(pj) : ease(pj);
              const pt = a.curve.getPointAt(uu);
              flowPos[idx * 3] = pt.x;
              flowPos[idx * 3 + 1] = pt.y;
              flowPos[idx * 3 + 2] = pt.z;
              flowTmpColor.lerpColors(a.colA, a.colB, uu);
              flowCol[idx * 3] = flowTmpColor.r;
              flowCol[idx * 3 + 1] = flowTmpColor.g;
              flowCol[idx * 3 + 2] = flowTmpColor.b;
              if (j === 0 && strobe > 0.02) {
                const w = strobe * 0.5;
                const cr = flowCol[idx * 3]!;
                const cg = flowCol[idx * 3 + 1]!;
                const cb = flowCol[idx * 3 + 2]!;
                flowCol[idx * 3] = cr + (1 - cr) * w;
                flowCol[idx * 3 + 1] = cg + (1 - cg) * w;
                flowCol[idx * 3 + 2] = cb + (1 - cb) * w;
              }
              const env = Math.sin(uu * Math.PI);
              const headA =
                headBase *
                a.fade *
                (0.3 + 0.7 * env) *
                (0.7 + inten * 0.6 + flash * 0.4) *
                pulse *
                globeFade;
              flowAlpha[idx] =
                j === 0
                  ? headA * (1 + 1.5 * strobe)
                  : headA * Math.pow(0.6, j);
              const hs = headSize * (0.8 + 0.4 * env);
              flowSize[idx] =
                j === 0 ? hs * (1 + 0.4 * strobe) : hs * (1 - j * 0.085);
            }
          }
        }
        (flowGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        (flowGeo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
        (flowGeo.getAttribute("aAlpha") as THREE.BufferAttribute).needsUpdate = true;
        (flowGeo.getAttribute("aSize") as THREE.BufferAttribute).needsUpdate = true;
      }

      // 星空缓慢自转 + 闪烁（两层不同相位，避免整片同步呼吸）
      stars.rotation.y = t * 0.004;
      brightStars.rotation.y = t * 0.0025;
      (stars.material as THREE.PointsMaterial).opacity =
        0.66 + 0.16 * Math.sin(t * 1.35);
      (brightStars.material as THREE.PointsMaterial).opacity =
        0.62 + 0.36 * (0.5 + 0.5 * Math.sin(t * 2.3 + 1.7));

      // 星云极缓慢漂移
      nebulaA.position.x = -1.15 + Math.sin(t * 0.05) * 0.35;
      nebulaA.position.y = 0.55 + Math.cos(t * 0.037) * 0.2;
      nebulaB.position.x = 1.35 + Math.cos(t * 0.043) * 0.3;
      nebulaB.position.y = -0.75 + Math.sin(t * 0.031) * 0.18;
      // —— 主页星球的位置/缩放同步（渲染前最后一刻）：走它自己
      // 在太阳系里的位置进出（用户口径：「每个星球应该从太阳系
      // 自己的位置进入和返回」）——
      // 旧逻辑逐帧把主页星球组钉在地球组的位置/缩放上：地球组转
      // 场只沿原点↔地球轨道位飞行，哪颗星当主页，进出都从地球
      // 那里过（用户实报）。现行：逐帧取目标天体在太阳系里的本
      // 体（行星/月球/太阳网格）的世界位置与世界半径，主页星球
      // 组在「主页构图（原点、fit）」与「该天体的太阳系位置/尺寸
      // （几何半径×世界缩放 ÷ HOME_R）」之间按同一条 eTrans 插
      // 值：出程飞向它自己的轨道位、回程从它自己的轨道位飞回；
      // 交接点（trans=1、eTrans 严格 =1）与本体同位同尺寸，配合
      // 下方本体显隐同步（飞行期间本体隐藏、由主页组顶替其位）
      // 交接无跳变。主页静止时 eTrans=0，插值即主页构图本身、无
      // 副作用；太阳的轨道位即系心，轨迹退化为原地缩放，同样成立。
      if (hpActive) {
        // 主页构图校准：客串星球与地球同等视直径、完整入框——普通
        // 星球留 3% 安全边；带环的土星（环外缘 2.25R）与天王星
        // （1.68R）按环外缘反算整组缩放，环不许被画面裁掉（录屏
        // 里火星/月球撑满裁切的构图问题同源于此处的无差别同步）
        const HOME_FIT: Record<string, number> = {
          saturn: 0.45,
          uranus: 0.6,
        };
        const fit = HOME_FIT[builtHomeId] ?? 0.97;
        const gRef = guestSolarRef(builtHomeId);
        if (gRef && eTrans > 0.001) {
          gRef.obj.getWorldPosition(tmpGuestPos);
          gRef.obj.getWorldScale(tmpGuestScale);
          const solarScale = (gRef.geoR * tmpGuestScale.x) / HOME_R;
          homePlanetGroup.position.lerpVectors(
            ZERO_V,
            tmpGuestPos,
            eTrans,
          );
          homePlanetGroup.scale.setScalar(
            fit + (solarScale - fit) * eTrans,
          );
        } else {
          homePlanetGroup.position.set(0, 0, 0);
          homePlanetGroup.scale.setScalar(fit);
        }
        // 环口径渐变对齐（落位抽动根因①的修法）：代理环与本体环
        // 几何口径不同（土星 2.25R vs 2.58R、天王星 1.68R vs
        // 1.78R），只对齐球体时交接帧环外径会一帧跳 +14.6%/+5.9%。
        // 飞行中把代理环按 homeRingMatch 渐变放大：eTrans=0 时是
        // 主页设计的环（系数 1），eTrans=1 时环外径与本体恒等
        // （HOME_R×代理外缘×groupScale×match = geoR×本体外缘），
        // 交接帧环与球同时严丝合缝
        if (homeRingMesh) {
          homeRingMesh.scale.setScalar(
            1 + (homeRingMatch - 1) * eTrans,
          );
        }
      }
      // 太阳系本体显隐逐帧同步：当前主页星球的本体在飞行/主页期
      // 间隐藏（由主页星球组顶替其位，交接点同位同尺寸不跳变），
      // 其余本体恒显；主页星球中途变更（底栏菜单换星）时旧星球的
      // 本体随之恢复，不留被藏死的网格
      for (const pv of planetVis) {
        if (pv.mesh) {
          pv.mesh.visible = !(hpActive && builtHomeId === pv.def.id);
        }
      }
      if (moonMesh) {
        moonMesh.visible = !(hpActive && builtHomeId === "moon");
      }
      sunMesh.visible = !(hpActive && builtHomeId === "sun");
      renderer.render(scene, camera);
      if (disposed) cancelAnimationFrame(raf);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (el.parentElement === mount) mount.removeChild(el);
      if (curtainCanvas.parentElement === mount) {
        mount.removeChild(curtainCanvas);
      }
      scene.traverse((obj) => {
        const anyObj = obj as unknown as {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        anyObj.geometry?.dispose();
        const m = anyObj.material;
        if (Array.isArray(m)) {
          m.forEach((x) => {
            (x as THREE.SpriteMaterial).map?.dispose();
            x.dispose();
          });
        } else if (m) {
          (m as THREE.SpriteMaterial).map?.dispose();
          m.dispose();
        }
      });
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="relative h-full w-full cursor-grab overflow-hidden active:cursor-grabbing"
      style={{ touchAction: "pan-y" }}
      role="img"
      aria-label="3D 地球：真实地图纹理、夜间城市灯光与按真实太阳位置移动的晨昏线，明暗钉在地理上、亮面永远是此刻真实世界里白天的区域，地球以可见速度自转，拖动后松手会回到自转基线，全球主要金融中心以分级标记落于球上并标注当地时间，城市之间有流动的光弧相连，横向拖动可旋转，点按标记查看小结，点按地球本体或下方太阳系按钮进入太阳系视图，太阳系中双指捏合可缩放、双指拖动可平移，点按任意星球可飞近观赏、点返回太阳系回到总览"
    />
  );
}
