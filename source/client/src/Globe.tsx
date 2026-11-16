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
import { ZODIAC_CUTOUTS } from "./zodiacCutouts";
import {
LAND_COORDS_B64,
LAND_FLAGS_B64,
LAND_POINT_COUNT,
} from "./landData";
import { LIGHTS_B64, LIGHT_POINT_COUNT } from "./lightsData";
import {
ASTRO_PLANETS,
eclipticPrecessionDeg,
moonEcliptic,
moonLongitude,
planetGeocentricEcliptic,
sunGeocentricEcliptic,
zodiacSignFor,
ZODIAC_SIGNS,
} from "./moonPhase";
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
import {
GAL_BAR_ANGLE_DEG,
GAL_BAR_HALF_KPC,
GAL_R0_KPC,
GAL_SUN_Z_PC,
GALAXY_ARMS,
GALAXY_STARS,
armPlanPoint,
} from "./galaxyData";

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
  /**
   * 银河系模式开关（App 持有状态）：自太阳系再往外一级——银盘按
   * Xu et al. 2023 多旋臂模型重建，太阳系标在其真实银河坐标处。
   * 只从太阳系进入（App 底栏「银河系」钮），退出回太阳系。
   */
  galaxy?: boolean;
  /** 银河系取景：full 全盘（默认）/ near 太阳邻域（八星展开）。
   * 第三级「近邻特写」已按用户口径整体下线（2026-11-14），只剩两档 */
  galaxyView?: "full" | "near";
  /** 银河画布点按回调（2026-11-15 改判）：全览点太阳标记 →
   * "near"；邻域点银心罗盘标记 → "full"；邻域点太阳系标记只
   * 回正镜头、不走本回调（不退出邻域） */
  onGalaxyViewChange?: (v: "full" | "near") => void;
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
 * 日晚客串彗星整体下线后改四幕；2026-11-15 第五颗坦普尔–塔特
 * 尔入列后扩五幕）——
 * 太阳系里的五颗具名彗星（哈雷/恩克/潘斯达斯/艾森/坦普尔–塔
 * 特尔）共用一条 400 秒舞台时钟、五幕各 80 秒轮流登场、哈雷
 * 起场、坦普尔–塔特尔压轴第五幕。任一时刻至
 * 多一颗在场——核/彗发/双尾/名卡/轨道线成套算一个「出现」单
 * 位、随幕同进同出；幕内首尾各 8 秒淡入淡出、幕与幕首尾相接
 * 不重叠（包络只活在自己幕内，交界处前一颗已归零后一颗才
 * 起，无交叉淡化）。轨道线随其包络淡变（在场峰值 0.34）。幕
 * 内时间映射到各颗自己的轨道时间：以近日点时刻为幕中点、按
 * 各自活跃跨度缩放（slotScale），使幕边缘活跃度 ≈0——没有谁
 * 亮着脸上下场。舞台相位 30：打开时哈雷位于其幕内 30 秒处；
 * reduced-motion 时舞台冻结在同一相位（只哈雷在场、余四颗隐
 * 去）。
 */
const COMET_STAGE_S = 400;
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
 * —— 第五颗入列（2026-11-15，用户令只做彗星这一件）：55P/坦
 * 普尔–塔特尔，狮子座流星雨母体。根数同取 JPL 发表值：a=10.338
 * AU、e=0.9056、i=162.49°（逆行）、Ω=235.27°、ω=172.50°，由
 * a(1−e) 得 q=0.976 AU、a^1.5 得周期 33.2 年，与发表值自洽。
 * 逆行是它的身份证：倾角与哈雷同档（162° 级），但升交点与哈雷
 * 差约 177°、近日点幅角差约 61°，轨道面朝向完全不同，远日点
 * 19.7 AU 也明显小于哈雷的 35 AU——轨道线一出场就分得开。
 * 轨道形状/倾角/升交点/近日点幅角全按真实根数经 perifocal 基底
 * 换算，位置由真近点角直接定（ν 定义椭圆上的点，与开普勒解等
 * 价，且对 e→1 的近抛物线轨道数值稳定）。
 * 摆位口径（诚实标注，与客串彗星同例）：不按真实日期摆位——按
 * 真位放，哈雷现在在约 35 AU 外无尾、艾森 2013 年过近日点时已
 * 解体，多数看不见、「拖尾要有区别」无从谈起。故取活跃展
 * 示：各沿自己轨道慢跑，时间轴同样走正切弯折把过境展开；登场
 * 时机走舞台轮值（见 COMET_STAGE_S 处注：五颗彗星轮流独占舞
 * 台、从不同时出现，各颗只在自己那一幕里在场）；真实周期与下
 * 次回归/解体事实如实写入各自名卡副行，页面提示片同步标注
 * 「彗星为活跃期示意」。
 * —— 全维逐颗分家（2026-11-13 晚用户总纲「这几颗彗星的设计
 * 风格和色彩风格粒子风格要做区分、大小也要有区别」）：不止拖
 * 尾长短宽窄——设计/色彩/粒子/体量各成一套；新海诚式的高明
 * 度辉光质感是共同底味，色相与形态逐颗分家（逐颗色板/描边/
 * 彗发染色/粒子风格全在 def 表）：
 * 哈雷 = 经典主力——体量最大、彗发最亮，蓝（离子）金（尘埃）
 * 正色双尾，粒子晶亮规整、成簇绽放，是「标准答案」；
 * 恩克 = 最小最黯——彗发紧凑、整体小一号，灰蓝离子尾 + 暗金
 * 尘埃的灰旧色，粒子稀疏微弱、慢速小粒，磨老了的彗星；
 * 潘斯达斯 = 宽阔暖金——尘埃大扇面五颗最宽、暖金主导，粒子
 * 是弥漫的金色尘雾、大粒慢飘；
 * 艾森 = 翠绿纤细——借 2013 年实拍的双原子碳绿彗发作签名
 * 色，离子尾极细极长走青绿，粒子翠绿细喷、快而 sharp，靠长
 * 度取胜。原逐颗拖尾形态差异（长/宽/扇面/射线）保留并入各自
 * 风格。近日点粒子喷流逐颗一份（风格档见构建段 sparks
 * 注），过近日点时喷发。
 * 坦普尔–塔特尔 = 冰刃小核（2026-11-15 入列）——核仅约 3.6 km，
 * 体量第二小（comaK 0.68，仅大于恩克）、但亮度不压黯（brightK
 * 0.98，与恩克的灰旧黯淡正相反）：彗发紧凑烧白、离子尾是一条
 * 窄而直的冰蓝刃（宽 0.15、长 2.1，宽比尘埃/离子 ≈3.5 在报告
 * 带内），色板走全场最白的冰白→冰青→靛紫、尘埃走银白薰衣草，
 * 粒子是小而快而亮的冰晶针点（sparkMode 5）——小、锐、白，是
 * 它与哈雷的饱和蓝金、恩克的灰旧之间的辨识位。
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
   * 达斯金尘 / 4 艾森翠绿 / 5 坦普尔冰刃）/ 粒数 / 速度系数 /
   * 尺寸系数 / 亮度系数（见 makeCometSparks） */
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
  {
    id: "tempel",
    name: "55P/坦普尔–塔特尔",
    info: "周期 33.2 年 · 狮子座流星雨母体 · 下次回归 2031 年",
    // JPL 发表根数：a=10.338、e=0.9056、i=162.49°（逆行）、
    // Ω=235.27°、ω=172.50°；q = a(1−e) = 0.976 AU、远日点
    // 19.70 AU（闭合整圈、示意半径 ≈6.60，在全览拟合内）
    a: 10.338,
    e: 0.90555,
    inclDeg: 162.49,
    nodeDeg: 235.27,
    periArgDeg: 172.5,
    onsetAU: 3.0,
    // cycleS/periAtS 沿全表口径（periAtS = 0.3×cycleS）；
    // slotScale 按与四颗同一条反解式核定：幕边缘（幕半宽 40 秒
    // ×slotScale）处 r 恰达 onsetAU——p=1.861、onset 3.0 →
    // ν=2.004 rad → s=0.784τ=37.6 秒 → 37.6/40 = 0.94（同式复算
    // 四颗得 1.22/0.95/1.87/4.58，与现行 1.23/0.95/1.86/4.6 吻合）
    cycleS: 240,
    periAtS: 72,
    slotScale: 0.94,
    // 小而锐利：体量第二小（仅大于恩克）、亮度不压黯——紧凑
    // 烧白的小彗发，与恩克「小而黯」正相反
    comaK: 0.68,
    brightK: 0.98,
    // 离子尾 = 冰刃：窄（0.15，仅次于艾森 0.12）、直、中长
    // （2.1）；尘埃窄扇（0.52），尘埃/离子宽比 ≈3.5（报告带内）
    ionLen: 2.1,
    ionOp: 0.62,
    ionWidth: 0.15,
    ionLayers: [0.8, 0.54, 0.34],
    dustOp: 0.36,
    dustWidth: 0.52,
    dustLayers: [0.6, 0.38, 0.22],
    dustHistK: 0.004,
    orbitColor: "#d9c8ff",
    cardPrio: 2,
    // 坦普尔–塔特尔：冰刃色板——全场最白：离子纯白起程、冰青
    // 中段、靛紫收梢（比哈雷的饱和蓝→品紫更白更冷）；尘埃走
    // 银白→薰衣草（比哈雷的粉尘更银、比恩克的灰粉更亮）
    ionPalette: [
      { o: 0, hex: "#FFFFFF" },
      { o: 0.18, hex: "#CFF4FF" },
      { o: 0.45, hex: "#5EC8F2" },
      { o: 0.72, hex: "#6E7CF0" },
      { o: 1, hex: "#9D6FE8" },
    ],
    dustPalette: [
      { o: 0, hex: "#FFFFFF" },
      { o: 0.3, hex: "#EFEAF6" },
      { o: 0.62, hex: "#C4B2E0" },
      { o: 0.85, hex: "#9484C4" },
      { o: 1, hex: "#9484C4" },
    ],
    ionRim: "#AEE9FF",
    dustRim: "#C4B2E0",
    comaCore: "#FFFFFF",
    comaInner: "#F2FBFF",
    comaHaloMid: "#7FD4F0",
    comaHaloOut: "#B9A8F0",
    // 冰刃粒子：小粒、快、亮——针点状冰晶（狮子座流星 71 km/s
    // 的快也呼应在此：速度系数仅次于艾森、尺寸全场最小档）
    sparkMode: 5,
    sparkCount: 140,
    sparkSpeed: 1.35,
    sparkSize: 0.65,
    sparkBright: 1.1,
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

/**
 * 银河系专用标签（2026-11-14 精致轮）：与太阳系标签同一设计语言
 * （细字重纯文字 + 极轻描边 + 同色微光晕），画布加宽到 336×76
 * 给「星名 · 距离」小字后缀留位——后缀字号更小、颜色更沉，与星
 * 名同排居中成组；整组量宽后超限等比缩字，绝不许溢出画布被裁。
 * 后缀数据 = galaxyData 的 distLabel（与已下线的说明卡同一份八
 * 星距离，卡删数据不删、随签上图）。宽高比 76/336，锚点登记时
 * 按此值传 aspect。
 */
function makeGalaxyLabel(
  text: string,
  color: string,
  scale = 0.44,
  suffix?: string,
): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 336;
  c.height = 76;
  const g = c.getContext("2d")!;
  const nameFont = "500 30px 'Noto Sans SC', system-ui, sans-serif";
  const sufFont = "500 20px 'Noto Sans SC', system-ui, sans-serif";
  g.font = nameFont;
  const nw = g.measureText(text).width;
  let sw = 0;
  if (suffix) {
    g.font = sufFont;
    sw = g.measureText(` · ${suffix}`).width;
  }
  const total = nw + sw;
  const k = total > 316 ? 316 / total : 1;
  g.translate(168 - (total * k) / 2, 40);
  g.scale(k, k);
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.strokeStyle = "rgba(3,8,18,0.85)";
  g.font = nameFont;
  g.lineWidth = 6;
  g.strokeText(text, 0, 0);
  g.shadowColor = color;
  g.shadowBlur = 5;
  g.fillStyle = "#eef4fc";
  g.fillText(text, 0, 0);
  if (suffix) {
    const s = ` · ${suffix}`;
    g.font = sufFont;
    g.shadowColor = "transparent";
    g.lineWidth = 5;
    g.strokeText(s, nw, 3);
    g.shadowColor = color;
    g.shadowBlur = 3;
    g.fillStyle = "rgba(178,203,235,0.92)";
    g.fillText(s, nw, 3);
  }
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
  sprite.scale.set(scale, scale * (76 / 336), 1);
  return sprite;
}

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

// —— 调度安全网 · 让行原语（2026-11-14 MWG 深查轮，指南
// break-up-long-tasks 口径）——
// 特性检测分层：scheduler.yield 可用则用（Chromium 系）；Safari
// 没有 Scheduler API，检测自然落空、走 setTimeout(0) 回退——回
// 退路径是真实默认路径而非摆设（Safari 上每个让行点都走它）。
// 不用 rAF 做回退：标签页隐藏/元素离屏时 rAF 可能被节流到不触
// 发，建场让行会假死；setTimeout(0) 在任何可见性下都必达。
type SchedulerYieldLike = { yield?: () => Promise<void> };
const schedulerYieldFn: (() => Promise<void>) | null = (() => {
  const s = (globalThis as { scheduler?: SchedulerYieldLike }).scheduler;
  return s && typeof s.yield === "function"
    ? () => s.yield!()
    : null;
})();
const yieldToMain = (): Promise<void> =>
  schedulerYieldFn
    ? schedulerYieldFn()
    : new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
/** 建场中途卸载的中止信号：分片器在让行点检查 disposed 后抛
 * 出，由建场 IIFE 的 catch 静默吞掉（清理已由 effect 作用域的
 * teardown 槽完成，不留半成品在页面上） */
class BuildAbort extends Error {}
/** 单片时间预算（ms）：指南口径 ≤50ms 一片，此处取 25——检查点
 * 间隔（点阵 1024 点/块、fillDisc 2048 点/块）与预算双保险，把可
 * 切分的片长压在规格的一半以内；不可再分的原子调用（单张程序
 * 纹理绘制）以 yieldNow 前后隔离成独立一片，其片长即该调用本身 */
const SLICE_BUDGET_MS = 25;
type BuildSlicer = {
  /** 预算检查点：本片未超预算立即返回；超了才真正让行一次 */
  tick: () => Promise<void>;
  /** 阶段边界：无条件让行一次（保证阶段之间必有交互窗口） */
  yieldNow: () => Promise<void>;
};
const makeBuildSlicer = (
  isDisposed: () => boolean,
  stats: { longestSliceMs: number; slices: number },
): BuildSlicer => {
  let sliceStart = performance.now();
  const doYield = async (): Promise<void> => {
    const sliceMs = performance.now() - sliceStart;
    if (sliceMs > stats.longestSliceMs) stats.longestSliceMs = sliceMs;
    stats.slices++;
    await yieldToMain();
    sliceStart = performance.now();
    if (isDisposed()) throw new BuildAbort();
  };
  return {
    tick: async (): Promise<void> => {
      if (performance.now() - sliceStart >= SLICE_BUDGET_MS) {
        await doYield();
      } else if (isDisposed()) {
        throw new BuildAbort();
      }
    },
    yieldNow: doYield,
  };
};

export function Globe({
  intensity,
  selected,
  autoRotate,
  solarSystem,
  galaxy = false,
  galaxyView = "full",
  onGalaxyViewChange,
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
    galaxy,
    galaxyView,
    onGalaxyViewChange,
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
    galaxy,
    galaxyView,
    onGalaxyViewChange,
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
    // —— 调度安全网（2026-11-14 MWG 深查轮）：建场分片 + 离屏暂
    // 停的跨作用域状态。teardown 资源槽：建场在异步 IIFE 内分片
    // 进行，卸载清理必须在 effect 作用域先行登记、由建场过程逐
    // 项填充——卸载发生在建场中途时，已建资源照样能拆干净。
    const schedStats = {
      buildMs: 0,
      longestSliceMs: 0,
      slices: 0,
      frames: 0,
      paused: false,
      framesWhilePaused: 0,
      framesAtPauseStart: 0,
      lastGapS: 0,
      stageMt: 0,
      t: 0,
    };
    let raf = 0;
    const td: {
      renderer: THREE.WebGLRenderer | null;
      el: HTMLCanvasElement | null;
      curtain: HTMLCanvasElement | null;
      scene: THREE.Scene | null;
      ro: ResizeObserver | null;
      io: IntersectionObserver | null;
      pauseTimer: number | null;
      handlers: {
        down: (e: PointerEvent) => void;
        move: (e: PointerEvent) => void;
        up: (e: PointerEvent) => void;
        cancel: (e: PointerEvent) => void;
        wheel: (e: WheelEvent) => void;
        touchStart: (e: TouchEvent) => void;
        touchMove: (e: TouchEvent) => void;
        touchEnd: (e: TouchEvent) => void;
        touchCancel: (e: TouchEvent) => void;
      } | null;
    } = {
      renderer: null,
      el: null,
      curtain: null,
      scene: null,
      ro: null,
      io: null,
      pauseTimer: null,
      handlers: null,
    };
    void (async () => {
      try {

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
    td.renderer = renderer;
    td.el = el;
    // 建场分片器（调度安全网）：本 effect 的全部建场重活自此按
    // 40ms 时间片推进，阶段边界与大数据循环内插入让行点（见各
    // sl.tick / sl.yieldNow 调用处），首屏 DOM 交互不再被一整块
    // 同步长任务堵住；建场最终状态与分片前逐项一致（同一份数
    // 据、同样的构建顺序，只在片间把主线程让出去）
    const buildT0 = performance.now();
    const sl = makeBuildSlicer(() => disposed, schedStats);
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
    td.curtain = curtainCanvas;
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
    // 按权重抽一档、整段生命用该档渐变——① 月白紫（主力）：
    // 芯 #FFFFFF、头微染 #EDE9FF、尾 →#C4B5FD、光晕 #B8A9FF；
    // ② 蓝白（分给最快最细的那批）：头微染 #E0EAFF、尾
    // →#A9C2FF、光晕 #93B4FF；③ 钙紫粉（较慢较粗、四档中最艳、
    // 靠稀少控场）：头微染 #FBE9FF、尾 →#E9B8FF→#C99BF5、光晕
    // #D8A7F5；④ 镁绿白：头微染 #E6FFF2、尾 →#B9E8D2（高度降
    // 饱和的薄荷白）。纪律：同档内只许 ±6° 色相 / ±5% 明度微抖
    // （生成时逐通道 ±5% 预抖、不许跨档乱变）；禁金/黄主导、禁
    // 实心满饱和 #A78BFA/#5F83FF（撞金融弧——流星紫更淡、带渐
    // 变、瞬时、低 α 光晕）。stops = [偏移, rgb, alpha 系数]，
    // 尾端 alpha 归零渐隐；haloA = 光晕中段 alpha（低 α 口径）。
    // —— 2026-11-16 狮子座注入（用户令「流星雨可以加入火流星和
    // 蓝绿色流星、特效拉满」，素材 = 用户亲发狮子座科普文）：
    // 新增两档阶级专属色——⑤ 蓝绿（狮子座标志：流星体金属元
    // 素高速燃烧的蓝绿光）：芯白、头微染 #D6FFF0、尾 →#40E0B2
    // →#12B8C4、光晕 #34E2BA，高饱和实色；⑥ 火流星（橙红燃烧
    // 色阶）：芯白、头 #FFEECD、尾 →#FFA642→#F0541A→#C8300C、
    // 光晕 #FF8A36。旧纪律中「禁青/蓝绿实色（撞光缆）」「禁橙
    // 红（撞彗星）」两条自此只约束①–④ 常规四档：蓝绿与橙红是
    // 用户点名的狮子座两大招牌、只发给⑤⑥ 两个新阶级，不许漏
    // 进常规档。阶级与占比见 animate 生成段（普通/明亮/火流星
    // /蓝绿/最高阶陨石五路分流）；常规四档内部权重改 50/27/15
    // /8（月白紫仍是全场第一大色：全口径约 34%）。
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
      {
        // 蓝绿（2026-11-16 狮子座阶级：金属燃烧蓝绿光，高饱和、
        // 高辨识——与④ 镁绿白的降饱和薄荷白刻意拉开：本档是
        // 「实色蓝绿」，④ 是「近白微绿」，同屏不混）
        stops: [
          { o: 0, rgb: [255, 255, 255], a: 1 },
          { o: 0.2, rgb: [214, 255, 240], a: 0.95 },
          { o: 0.55, rgb: [64, 224, 178], a: 0.92 },
          { o: 0.85, rgb: [18, 184, 196], a: 0.8 },
          { o: 1, rgb: [18, 184, 196], a: 0 },
        ],
        halo: [52, 226, 186],
        haloA: 0.5,
      },
      {
        // 火流星（2026-11-16 狮子座阶级：橙红燃烧色阶，只发给
        // 火流星阶级；与陨石的熔边橙红同语系——一个是光、一个
        // 是实心岩体，材质不同不混读）
        stops: [
          { o: 0, rgb: [255, 255, 255], a: 1 },
          { o: 0.18, rgb: [255, 238, 205], a: 0.98 },
          { o: 0.45, rgb: [255, 166, 66], a: 0.95 },
          { o: 0.75, rgb: [240, 84, 26], a: 0.85 },
          { o: 1, rgb: [200, 48, 12], a: 0 },
        ],
        halo: [255, 138, 54],
        haloA: 0.52,
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
    // 火流星余迹辉团（2026-11-16 新增）：火流星划过后滞留数秒
    // 的发光余迹盖印——暖白芯 → 橙 → 深红外缘的软径向，与陨石
    // 余烬辉（rockGlowSprite）同语系但更散更淡：余迹是「光迹」
    // 不是「火」，绘制走加色、低 α、随龄膨胀飘散（见
    // curtainWakes 池与绘制段）
    const wakeSprite = (() => {
      const cv = document.createElement("canvas");
      cv.width = 160;
      cv.height = 160;
      const g = cv.getContext("2d");
      if (g) {
        const grad = g.createRadialGradient(80, 80, 0, 80, 80, 80);
        grad.addColorStop(0, "rgba(255,214,150,0.85)");
        grad.addColorStop(0.35, "rgba(255,140,60,0.42)");
        grad.addColorStop(0.7, "rgba(220,70,22,0.16)");
        grad.addColorStop(1, "rgba(190,50,14,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 160, 160);
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
    td.scene = scene;
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

    await sl.yieldNow();
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
        // 分片让行（调度安全网）：61,305 点逐点解码是建场最重的
        // 单循环之一，每 2048 点查一次时间预算，超 40ms 即让行
        if ((i & 1023) === 0) await sl.tick();
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
        // 分片让行（调度安全网）：夜光点逐点填 Float32Array，
        // 每 2048 点查一次时间预算（口径同大陆点阵循环）
        if ((i & 1023) === 0) await sl.tick();
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

    await sl.yieldNow();
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

    await sl.yieldNow();
    // —— 背景八星（夜空四单 · 太阳系背景，2026-11-12 移师、深夜
    // 3D 化；设计稿 = goal-5 GOAL.md「背景星空冬夏大三角设计」位
    // 置条修订 + 色板节）——
    // 2026-11-15 模式口径（用户点名）：本组在太阳系**全览**整组
    // 隐藏（星体/连线/名签，见 animate 名星段 starModeFade），
    // 默认近距模式按下方季节权重逻辑正常体现。
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
    // 星街彗星的最外圈轨道争位。默认构图按构造守恒：落位以默认
    // 近览机位为参考视角、沿各星 (sx, sy) 视线方向放到各自深度
    // 上（设计单位 2026-11-15 改为像素等距口径，见落位处长注），
    // 参考视角下投影与设计坐标严丝合缝。两组三角的连线改空间曲
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
    // addNamedStar 处注。绘制账：星芒精灵 18（主芒 9 + 淡芒 9，
    // 2026-11-16 改版：主芒 = 照片式十字细芒、淡槽 = 独
    // 立柔光晕；同日 ✨ 四角星芒一版已退役）+ 连线 2
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
      /** 设计方位（像素等距单位：1 = 半个画布高，x/y 同标尺）：
       * 参考机位下投影像素偏移 = (sx, sy) × 半画布高——形状不随
       * 画布宽高比变形（2026-11-15 拉长修正，见落位处长注） */
      sx: number;
      sy: number;
      /** 世界深度：太阳系原点后方多少世界单位（z = −depth），逐星各异 */
      depth: number;
      /** 登记尺度（布局时按各星的距离因子换算成精灵世界尺度） */
      size: number;
      /** 慢闪周期（秒）与相位：逐星定表 STAR_TW_TABLE（两两不同、
       * 避整数比谐波、相位黄金角错开；当令组才闪） */
      twPeriod: number;
      twPhase: number;
      /** 外层柔光晕基础尺度（glow 槽：独立径向晕图；
       * 闪烁时随亮度极轻微同相呼吸，见 animate 背景八星段） */
      glowBase: number;
      /** 主星芒基础尺度（布局时按距离因子算定；闪烁时芒长
       * 只作等比细微呼吸、不拉伸变形，见 animate 背景八星段） */
      coreScaleBase: number;
      /** 主星芒基础色（天狼星色温微闪的基准，其余星不改色） */
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
    // 柔光晕相对逐星 size 的尺度系数（2026-11-16 光晕收小轮，
    // 元灿：「近览大三角的光晕小一些」）：提亮轮把晕径放到
    // ×1.35（直径约为星芒精灵 ×0.82 的 1.65 倍），帧里读作大
    // 团光雾——本轮只收尺寸：×1.35 → ×0.65（直径约为旧值的
    // 48%、略小于星芒精灵本体），晕面收紧到星芒根部一小圈；
    // 亮芯/细芒的亮度、芒长（×0.82）、星色、闪烁幅度、位置、
    // 标签、连线一概不动；帧段晕透明度系数随尺寸略降（见
    // animate 背景八星段）。登记（addNamedStar 占位）与布局
    // （layoutStarWorld）两处 glowBase 同引本常量，不许漂移
    const STAR_GLOW_K = 0.65;
    // —— 照片式细长星芒贴图（2026-11-16 元灿选定方向
    // 「改成照片式细长星芒，像哈勃拍的那种」；同日 ✨
    // 四角星芒被判「太难看了」退役）：天文照片的衍射芒
    // 语言——小而饱和的亮芯 + 十字细长芒（横竖四支、
    // 等长），芒身是楔形：根部半宽仅 2.6px（256 图）、
    // 向外渐细、亮度沿程渐淡至尖端消失，不许等粗、不
    // 许 ✨ 的凹腰胖芒比例。白色作图、由材质 color 染
    // 各星真色；alpha 即形状本身。【提亮轮改判混合】材质
    // 改加色混合（见 addNamedStar 处注：加色按 alpha 加
    // 权、只增不减，无黑尾通道；旧「正常混合」注针对的
    // 是预乘 alpha 在正常混合下压出暗边，与此不同）。两槽
    // 分图：core 槽用本图（芯 + 芒，图内自带一圈极淡
    // 的根部柔光），glow 槽改用下方独立的径向柔光晕
    // 图（只是一圈克制的晕、不再放大芒形）。精灵恒朝
    // 向镜头（Sprite 语义），芒形在任意视角下不透视
    // 变形
    const namedStarSpikeTex = ((): THREE.CanvasTexture => {
      const S = 256;
      const cv = document.createElement("canvas");
      cv.width = S;
      cv.height = S;
      const g = cv.getContext("2d")!;
      const c = S / 2;
      // 芒根柔光（只垫在芯周 44px 内；2026-11-16 提亮轮，
      // 元灿：「近览大三角的星太暗了，亮度要调很高」——
      // 根光与芒身 alpha 整体上调，见下方各 stop）
      const root = g.createRadialGradient(c, c, 0, c, c, 44);
      root.addColorStop(0, "rgba(255,255,255,0.55)");
      root.addColorStop(0.5, "rgba(255,255,255,0.26)");
      root.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = root;
      g.fillRect(c - 44, c - 44, 88, 88);
      // 十字细芒：四支楔形（根半宽 2.6 → 尖端 0、长
      // 122），亮度沿程 0.95 → 0 渐淡
      for (let k = 0; k < 4; k++) {
        g.save();
        g.translate(c, c);
        g.rotate((k * Math.PI) / 2);
        const grad = g.createLinearGradient(0, 0, 122, 0);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.25, "rgba(255,255,255,0.82)");
        grad.addColorStop(0.6, "rgba(255,255,255,0.38)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(0, -2.6);
        g.lineTo(122, 0);
        g.lineTo(0, 2.6);
        g.closePath();
        g.fill();
        g.restore();
      }
      // 小而饱和的亮芯（实芯渐变；提亮轮半径 9 → 11，
      // 仍是照片式小芯、不许胖成圆点贴纸）
      const coreG = g.createRadialGradient(c, c, 0, c, c, 11);
      coreG.addColorStop(0, "rgba(255,255,255,1)");
      coreG.addColorStop(0.55, "rgba(255,255,255,0.95)");
      coreG.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = coreG;
      g.fillRect(c - 11, c - 11, 22, 22);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();
    // glow 槽柔光晕图：一圈径向渐变（中心 0.5 → 边缘
    // 0），只作芯周光场衬底、无任何芒形
    const namedStarHaloTex = ((): THREE.CanvasTexture => {
      const S = 128;
      const cv = document.createElement("canvas");
      cv.width = S;
      cv.height = S;
      const g = cv.getContext("2d")!;
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
      grad.addColorStop(0, "rgba(255,255,255,0.85)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.42)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, S, S);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    })();
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
      sx: number,
      sy: number,
      depth: number,
      colorHex: string,
      size: number,
      base: number,
      withLabel = true,
    ): NamedStar => {
      const col = new THREE.Color(colorHex);
      // —— 提亮轮（2026-11-16，元灿：「近览大三角的星
      // 太暗了，亮度要调很高」）：上一轮照片式细芒把倍
      // 率/透明度/闪烁全线收敛（主芒 ×0.55、晕透明 0.30、
      // 闪烁 ±22%），八颗地标星在深空底上只剩微光——本
      // 轮只动亮度不动形态：① 两槽材质改加色混合——深
      // 空底上星光按 alpha 全额叠加（src×alpha + dst，
      // 只增不减、无压暗通道，黑尾无从产生），芯/芒/晕
      // 的有效亮度整体翻倍量级；② 芯色向白 lerp 0.22 →
      // 0.38（照片过曝规律：芯近白、星色留在芒与晕里，
      // 色相身份不变）；③ 尺度与帧段透明度/闪烁落数见
      // layoutStarWorld 与 animate 背景八星段各注。细长
      // 十字芒的楔形比例（贴图）一字未动，不许借提亮回
      // 到胖 ✨、不许变回圆点。
      // 外层柔光晕（glow 槽）：独立径向晕图、无芒形，
      // 星色全额承载
      const glowMat = new THREE.SpriteMaterial({
        map: namedStarHaloTex,
        color: col,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(
        size * STAR_GLOW_K * STAR_INIT_K,
        size * STAR_GLOW_K * STAR_INIT_K,
        1,
      );
      starBoard.add(glow);
      // 主星芒（core 槽）：照片式衍射芒本体——小亮芯 +
      // 十字细长芒；芯色向白 lerp 0.38（提亮轮，见上注）
      const coreMat = new THREE.SpriteMaterial({
        map: namedStarSpikeTex,
        color: col.clone().lerp(new THREE.Color("#ffffff"), 0.38),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const core = new THREE.Sprite(coreMat);
      core.scale.set(
        size * 0.82 * STAR_INIT_K,
        size * 0.82 * STAR_INIT_K,
        1,
      );
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
        sx,
        sy,
        depth,
        size,
        twPeriod: twSpec.period,
        twPhase: twSpec.phase,
        glowBase: size * STAR_GLOW_K * STAR_INIT_K,
        coreScaleBase: size * 0.82 * STAR_INIT_K,
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
    // —— 落位（2026-11-12 深夜 3D 化；2026-11-15 拉长修正）：
    // 设计坐标 (sx, sy) = 参考近览机位下的像素等距方位（单位 =
    // 半个画布高，x/y 同标尺）。旧口径 (nx, ny) 是 NDC 分数：
    // NDC→像素时 x 按半画布宽、y 按半画布高缩放，竖屏全屏舞台
    // （宽高比 ≈0.46、高/宽 ≈2.16）下纵向每单位像素是横向的
    // 2.16 倍——公式量测（390×844 近览默认帧）：冬三角边长比
    // 1.000/2.184/2.028（真实 1.000/1.046/1.004，两长边偏差
    // +109%/+102%）、夏三角 1.000/2.076/2.679（真实 1.000/
    // 1.431/1.590），即用户实报「被拉长」。有限深度视差不是主
    // 因：默认帧落位时相机距 = 布局参考距，逐星因子
    // (zRef+depth)/(C+depth) 恒 1，深度在该帧零贡献——拉长纯
    // 系设计空间各向异性。新口径下两组顶点按真实角距嵌入
    // （冬：25.9°/27.1°/26.0° 近等边，冬组另带 +5° 整体倾角；
    // 夏：23.9°/34.2°/38.0° 瘦长，朝向与旧构图一致：参宿四/
    // 天津四在上、天狼星/牛郎星在下），同乘 0.0092/° 落位，
    // 参考帧像素边长比与真实角距比偏差 ≤0.3%（公式复核）。
    // 整组纵向位置两度调整：拉长修正轮先自质心距顶 26.4% 下移
    // 到 31.1%（最高星 12.5% → 23.3%）脱离顶部 UI 挤压；同日晚
    // 用户真机裁决「大三角位置再往上，还是不够高」——整组刚性
    // 上移 Δsy = +0.22（全员同量、形状/边长比/深度一字不动）：
    // 六顶点质心距顶 31.1% → 20.1%、最高星（天津四）23.3% →
    // 12.3%，平移量 = 画布高的 11.0%（≈93px @844）。约束核算：
    // 最高星中心 @844 距顶 ≈104px，仍在顶栏药丸下沿（顶距
    // max(12px, 安全区) + 药丸 30px）之下；左侧星名签若贴近安
    // 全带由既有 topSafeForSpan 翻到星点下方，不被药丸盖住；
    // 同轮删除的黄道环注释（原占顶 3.9rem 一行）也让出了这条
    // 横带。冬/夏两组质心分别距顶 19.9% / 20.2%。
    // 第五参 depth = 世界深度（原点后方、世界单位）：按各星真
    // 实距离的座次排（光年数只取序、压进 15–38 的可感知视差
    // 带）——天狼星 8.6 ly 最近、次南河三 11.5、牛郎星 17、织
    // 女星 25，再跳到角宿一 ~250、天鹅座β ~430、参宿四 ~550，
    // 天津四 ~2600 ly 独占最远。深度全 ≥15，恒在行星系（半径
    // ≲5.2）与星街彗星轨道之后，不与之争位；锚定方式仍是沿参
    // 考机位视线方向放深度（非拍平）：相机离开参考位（聚焦/
    // 缩放/平移）时近星移多远星移少，视差照旧——如近览内捏合
    // 2× 时天狼星与天津四的投影缩放因子差约 14%。
    // 星色提色对照（2026-11-13，色相身份不变、饱和上调到明显
    // 档；旧 → 新）：参宿四 #ff9e45 → #ff7d2a（橙红读得出橙红）、
    // 天狼星 #dcebff → #a9c9ff（蓝白读得出蓝）、南河三 #fff2d4 →
    // #ffe396（淡黄白加重黄意）、天津四 #f5f8ff → #eef4ff（干净
    // 白不发灰）、织女星 #d9e7ff → #a3c2ff、牛郎星 #ffffff 不变
    // （本就纯白）、天鹅座β金 #ffc44d → #ffab1a（更金）、天鹅座
    // β蓝 #6fa8ff → #4a86ff（更蓝，金蓝对比拉开）、角宿一
    // #dce9ff → #9db4ff。饱和守上限：无霓虹荧光、不过曝成色块
    // 冬日大三角（近等边）：参宿四橙红是红超巨星的签名，不漂白
    const wBetelgeuse = addNamedStar("参宿四", "winter", -0.225, 0.744, 33, "#ff7d2a", 0.78, 0.9);
    const wSirius = addNamedStar("天狼星", "winter", -0.335, 0.52, 15, "#a9c9ff", 0.88, 1.0);
    const wProcyon = addNamedStar("南河三", "winter", -0.098, 0.541, 17.5, "#ffe396", 0.68, 0.8);
    // 夏日大三角（瘦长）。名签落位已全员统一为紧贴锚定（星点
    // 正上方居中）：玻璃卡时代给织女星定的偏左、给天津四/天鹅
    // 座β/参宿四定的偏下都是卡面体积的补丁，新格式下一并作
    // 废，此处不再有任何逐颗落位参数
    const sDeneb = addNamedStar("天津四", "summer", 0.148, 0.754, 38, "#eef4ff", 0.7, 0.78);
    const sVega = addNamedStar("织女星", "summer", 0.055, 0.555, 22.5, "#a3c2ff", 0.8, 0.88);
    const sAltair = addNamedStar("牛郎星", "summer", 0.36, 0.476, 20, "#ffffff", 0.72, 0.8);
    // 天鹅座β星（Albireo）：天津四近旁，一金一蓝双点紧挨永不重合
    // （组间距拉宽不拆这对「一尾一嘴」）；名签按定名写「天鹅座β
    // 星」，只挂在金点上；蓝点无名签不受影响
    const albireo = addNamedStar("天鹅座β星", "summer", 0.1, 0.702, 31, "#ffab1a", 0.52, 0.66);
    {
      // 蓝点：沿天津四→金点方向再错开一线间隙（等距设计单位
      // 0.030 ≈ 参考帧 13px）；深度与金点同为 31——这对双星在
      // 3D 里也是紧挨的一对，任意视角下间隙不胀不缩、永不重
      // 合；蓝点无名签，核心色走与金点同一套「光谱色向白提
      // 亮」构造
      const dirx = albireo.sx - sDeneb.sx;
      const diry = albireo.sy - sDeneb.sy;
      const dl = Math.hypot(dirx, diry) || 1;
      addNamedStar(
        "",
        "summer",
        albireo.sx + (dirx / dl) * 0.03,
        albireo.sy + (diry / dl) * 0.03,
        31,
        "#4a86ff",
        0.38,
        0.5,
        false,
      );
    }
    // 角宿一：独立成星、不连线，季节自成一档（春季峰值）；落在
    // 冬三角左翼外侧——与冬三角拉开组间距、仍在上方带内，不许
    // 贴近画面中线，免得聚焦近景时侵入星体主体区域。
    // 身份注（2026-11-13 用户问「冬季大三角左侧的星星怎么没标
    // 签，是 spica 吗」——答：是，就是角宿一）：它贴在天狼星左
    // 上方（等距设计距 ≈0.101）。名签口径已经用户同日晚间改判
    // （见 animate 背景八星段）：角宿一名签破例全年常驻（淡季
    // 压暗地板 0.42），只有星光仍走季节曲线——淡季是微光星点
    // 带着一张压暗的名签，春季连光带名一起回来。本轮格式统
    // 一后常驻口径平移不变，只是换成行星标签同款小标签
    addNamedStar("角宿一", "spica", -0.41, 0.58, 28, "#9db4ff", 0.72, 0.82);
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
    // —— 3D 布局（首次进太阳系时一次算定，之后恒定）：以默认近
    // 览机位为参考视角（取景拟合距离 zRef，与 resize 的
    // solarFitZ 同式），把每颗星沿其 (sx, sy) 视线方向放到各自
    // 深度 depth 上：x = sx·(zRef+depth)·tanV、
    // y = sy·(zRef+depth)·tanV、z = −depth。参考视角下 NDC =
    // (sx/aspect, sy)，投影像素偏移恰为 (sx, sy)×半画布高——
    // x 式中 aspect 与投影的水平 tan 互消，世界落位本身不带宽
    // 高比，形状在任何宽高比的参考帧都不变形（2026-11-15 拉
    // 长修正：旧式 x 带 aspect、设计空间是 NDC，竖屏下纵向被
    // 像素标尺放大 2.16 倍，见落位处长注）。世界坐标从此固
    // 定——相机移动时视差自然产生。表观尺寸按角直径守恒换
    // 算：精灵尺度 ∝ (zRef+depth)/15（15 = 旧主页口径的星距参
    // 考），参考视角下与旧板同大；聚焦视角下近星自然略大、远
    // 星略小，是深度的一部分，不做屏幕锚定补偿。名签不设世界
    // 锚点：卡片逐帧直锚星点本身的投影 + 固定屏幕间隙（见
    // addNamedStar 与 animate 名签段）。
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
        const x = ns.sx * distCam * tanV;
        const y = ns.sy * distCam * tanV;
        ns.glow.position.set(x, y, -ns.depth);
        ns.core.position.copy(ns.glow.position);
        // 星芒尺度（提亮轮 2026-11-16）：主星芒 =
        // size×0.82——细芒轮的 0.55 收敛倍率撤销（元灿判
        // 太暗）：芒长涨约 1.5 倍、楔形粗细比随贴图等比
        // 不变（仍是细长芒、不是胖芒）；逐星 size 座次即
        // 大小层级（天狼星最长、天津四次之……）、一字不
        // 动。柔光晕尺度已于同日光晕收小轮改判：size×
        // STAR_GLOW_K（0.65，见该常量处注），不再随提亮
        // 轮的 ×1.35
        ns.glowBase = ns.size * STAR_GLOW_K * distK * STAR_SIZE_K;
        ns.glow.scale.set(ns.glowBase, ns.glowBase, 1);
        const coreS = ns.size * 0.82 * distK * STAR_SIZE_K;
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

    await sl.yieldNow();
    // —— 银河系模式（2026-11-14 新增，用户：「在太阳系之外再做一
    // 个银河系 / 设计得漂亮一些 / 银河系里就可以直接标出太阳系里
    // 面星星的绝对位置」）——
    // 几何与参数全在 galaxyData.ts：旋臂 = Xu et al. 2023 式 (2)
    // 对数螺旋 + Table 2 拟合（半人马臂按论文切点推断复现），太
    // 阳置 (0, 8.15 kpc)、银心原点；八星由赤道坐标经标准旋转矩阵
    // 换算银河坐标后按真实距离落位。本地坐标映射：x = 银面 X、
    // y = 盘面高度、z = −银面 Y（太阳方向银面 +Y → 本地 −z，组带
    // 全览落定倾角后落在画面上方，与论文图 3 俯视同向）。
    // 构建延迟到首次进入银河模式的那一帧（主页/太阳系零成本）；
    // 星点全走 GPU Points + 辉光纹理，桌面约 7.5 万点、移动约
    // 4.5 万点。银河自转 = 绕银轴 2π/26 分钟——近乎静止的庄重
    // 慢转（用户刚投诉过太阳系旧转速太快），近览时冻结防邻域漂移。
    const GAL_S = 0.5; // 世界单位 / 千秒差距
    /**
     * 纵向表现性拉伸（2026-11-15 23:45 元灿亲口改口径：
     * 「可以拉高 z，而且应该大幅拉高以改变粒子的分布增强
     * 表现力」——此前「禁 z 拉伸」作废，其本是「从未批准」
     * 而非明令；23:50 再令「能拉多大就拉多大」）：落点 =
     * 薄盘系（盘面薄成分/旋臂/辉光/尘带/星团/HII/细尘）
     * ×8（薄盘标高 0.30→2.40 kpc、旋臂 0.06→0.48），厚
     * 盘成分单独 ×3.5（0.95→3.33——全额 ×8 时其 Laplace
     * 长尾把 16% 的星撒到 ±20 kpc、盘读成球云，是先到
     * 的可读性界）；等效盘厚（质量加权平均标高）0.404→
     * 2.55 kpc ≈ ×6.3。取景界复核：薄盘 90% 质量纵向半
     * 幅 ±2.3×1.2 wu ≈ ±2.8 wu，与盘面投影半高 4.3 wu
     * 同点叠加只在 r≈15 kpc 极稀疏尾部发生、亮盘（r≤
     * 5.5 kpc）纵向总半幅 ≈5.9 wu < 放大后可用半高
     * 6.1 wu（移动）/7.1 wu（桌面），不裁。棒/核球 z 高
     * 斯另用 ×2（近球形体全额拉成纺锤、反噬银心收束）。
     * 属艺术表现层：Xu 旋臂 x–y 形状、星数、R₀、5 kpc
     * 标尺、邻域真实测距星一律不经此系数（口径全文见
     * DATA-PLAN 本轮条目）
     */
    const GAL_Z_STRETCH = 8;
    /** 厚盘成分的拉伸系数（可读性界，见上） */
    const GAL_Z_THICK = 3.5;
    /**
     * 全览放大（2026-11-15 晚，元灿：「整体稍微放大」）：
     * 全览组缩放统乘 (1 + 本值) = ×1.12（工单域 +10–15%
     * 的落点），只经 (1−eNear) 混入——邻域取景/倍率口径
     * 零影响；35° 视角与 galaxyFitZ 不动。5 kpc 标尺与盘
     * 面同在 galaxyGroup 内、同比缩放，标尺真值由构造守
     * 恒（标尺世界长与盘面 kpc 世界长同乘 1.12，比值不
     * 变）；亮盘外缘余量：移动端盘径 0.80→0.90 画布高、
     * 桌面亮盘（5.5 wu）6.16 对半幅 8.0，仍在框内
     */
    const GAL_FULL_BOOST = 0.12;
    /**
     * 银河全览落定倾角（口径：组 rotation.x = 相机视线与银盘
     * 平面的夹角，即离面倾角）。沿革：初版 0.62 rad = 离面
     * 35.5°；2026-11-15 立体感修正轮抬到 0.96 rad = 55°（治
     * 「看上去还是一个平面」）；同日晚质感纠正轮（元灿裁决
     * 「视角要调的平行一些，不然俯瞰更薄」）**改回更平行**：
     * 0.61 rad = 离面 35°——55° 的斜俯把盘面表观压扁、粒子
     * 稀疏感被放大成「CD」；35° 下盘面表观纵横比 sin(0.61)
     * ≈ 0.57，视线更贴盘面，核球隆起、银道面亮带与厚盘/晕
     * 的纵向轮廓在近平行视角里成剪影，厚度感靠视角＋光感
     * 做（当轮口径：不动逐星 z；该 z 禁令已于 2026-11-15
     * 23:45 被元灿亲口撤销并反转为大幅拉高，见 GAL_Z_
     * STRETCH 注——本段只记倾角沿革）。全览纵
     * 拖夹取 [0.18, 1.25] 不变；邻域入场极角恒 +0.62
     * （galEntryPol；旧 ±0.62 按相位选符号已于 2026-11-16
     * 旋转轴对齐轮废止——负极角即镜像，见 galEntryPol 注）
     * 是另一口径，不动；退出邻域与退出银
     * 河模式的倾角复位都回到本值（各复位点引用本常量，无
     * 旧值残留）。5 kpc 标尺随新倾角同式复算内移（见构建
     * 段标尺头注）。
     */
    const GAL_FULL_TILT = 0.61;
    const galaxyGroup = new THREE.Group();
    galaxyGroup.rotation.x = GAL_FULL_TILT;
    // XYZ（2026-11-16 转盘轮改判，旧 YXZ 作废）：合成
    // R = Rx(俯仰)·Ry(偏航)——俯仰在偏航之外（世界系）
    // 施加，盘面法线与镜头高度对方位角恒定（见
    // galOrbitEuler 处转盘注）。本欧拉只作初值/复位写
    // 入，帧段朝向由 galOrbitEuler 四元数直写；读回分
    // 解在 |偏航|>90° 时走等价别名分支，故任何需要倾
    // 角数值的下游一律读状态量 galTilt、不读
    // rotation.x（转盘轮已逐处替换）
    galaxyGroup.rotation.order = "XYZ";
    galaxyGroup.visible = false;
    scene.add(galaxyGroup);
    const galaxySpin = new THREE.Group();
    galaxyGroup.add(galaxySpin);
    let galaxyBuilt = false;
    /** 银河分片构建进行中（防 animate 逐帧重复触发，见帧段调用处） */
    let galaxyBuilding = false;
    /** 银河模式镜头拟合距离（resize 维护，口径同 solarFullZ） */
    let galaxyFitZ = 22;
    /**
     * 锚点登记：标签/标记精灵不挂自转组——逐帧按自转角把锚点旋到
     * 当前位置，并按组缩放反算精灵尺寸（世界尺寸恒定：组放大
     * 14 倍看邻域时标签不许跟着胀 14 倍）。rise = 标签在锚点上方
     * 的世界高度（全盘/近览两档，逐帧按近览混合插值后除组缩放）。
     */
    interface GalAnchor {
      obj: THREE.Sprite;
      base: THREE.Vector3;
      kind: "arm" | "hub" | "sun" | "star";
      wFull: number;
      wNear: number;
      aspect: number;
      mat: THREE.SpriteMaterial;
      baseOpacity: number;
      riseFull: number;
      riseNear: number;
      pulse?: boolean;
      /** 近览签面偏移（世界单位，仅近览混合时生效）：星名签
       * 是屏幕系恒定小偏移（fanScreen=true，见下）；太阳系签
       * 沿用本地系小偏移。两者都只挪签面，星点恒在真实位置 */
      fanX: number;
      fanY: number;
      /** 呼出偏移（签验收补完轮，星名签专用）：宽取景时签沿
       * 本星方向径向外放的屏幕系偏移（galCalloutOffsets 求
       * 解），帧段按倍率与 fanX/fanY 平滑混合；默认 = fanX/
       * fanY（未求解前混合恒等） */
      fanCX: number;
      fanCY: number;
      /** fan 的坐标系：true = 屏幕系恒定偏移（邻域优化轮，星名
       * 签专用）——fan 存画面右/上方向的世界偏移，帧段经组旋
       * 转的逆变换落回本地，用户怎么转签恒在本星同一侧；
       * false = 旧本地系扇开（太阳系签沿用） */
      fanScreen: boolean;
      /** 星名签引线：true 时帧段把「本星真点 → 签面位置」写入
       * 引线几何（galLeaderPos 的 leaderIdx 段） */
      leader: boolean;
      leaderIdx: number;
      /** 横向夹取只对星名签开（真机修正轮收窄）：距离环数签
       * 同为 kind=star 的宽签，深变焦时其环在画外、数签本应
       * 随环离场——旧条件按 kind+aspect 一网打尽会把数签硬
       * 拽到画缘冒充在位，故夹取改认此旗 */
      clampLabel: boolean;
      /** 屏幕尺寸补偿目标（CSS px，0 = 不补偿）：只给八星光
       * 晕锚点赋值（= 对应实体 pxT × 1.9）；同为 kind=star
       * 的落点小点不许误入补偿（其 wNear 语义完全不同） */
      pxT: number;
      /** 邻域径向 warp（本轮，用户：「领域相对位置拉大一些 /
       * 离太阳系近的几个星球都扎堆了」）：0 = 不 warp（全览
       * 与银河层恒走真坐标）；1 = 绕太阳径向三维 warp（星体/
       * 光晕/星签/距离环数签，warpK 为构建时按本锚点真实日心
       * 距离算出的满额倍率，帧段按 eNC 混合）；2 = 落点式
       * warp（足点专用：x/z 按母星 warpK 径向放大、y 恒钉
       * 盘面 0，保证垂线恒竖直、足点恒在盘面上） */
      warpMode: number;
      warpK: number;
    }
    const galAnchors: GalAnchor[] = [];
    /**
     * 八星实体登记（2026-11-14，用户：「最好做出星球实体」）：邻域
     * 档里八星以带临边昏暗的发光球呈现（自发光着色器，无外部光源
     * 依赖），原 Points 式辉光精灵退为球外光晕。逐帧与锚点同步：
     * 位置按自转角旋转锚点；尺寸自真机修正轮二起走屏幕补偿——
     * dNear 只定相对序、pxT 为目标表观直径（CSS px），帧段按相
     * 机距反解世界直径（示意量、非物理比例，真实半径在此尺度下
     * 不可见，DATA-PLAN 有注）。太阳系标记不在此列：用户明示不
     * 做实体，恒为呼吸光环 + 签。
     */
    interface GalStarBody {
      mesh: THREE.Mesh;
      base: THREE.Vector3;
      mat: THREE.ShaderMaterial;
      dNear: number;
      /** 屏幕尺寸补偿的目标表观直径（CSS px）：构建时按
       * dNear 相对量定（见构建处 STAR_PX），帧段逐帧按相机
       * 距离反解世界直径——整个邻域变焦域内表观恒在本字段
       * 值（带宽 16–30 CSS px，真机修正轮二 C） */
      pxT: number;
      /** 邻域径向 warp 满额倍率（按本星真实日心距离构建时算
       * 定，帧段按 eNC 混合；= 1 表示 warp 在本星处已收敛） */
      warpK: number;
    }
    const galStarBodies: GalStarBody[] = [];
    /** 补偿反解共用临时向量（锚点/实体两处逐帧复用） */
    const galCompV = new THREE.Vector3();
    /** 屏幕系签偏移换算用：组旋转的逆四元数 + 临时向量（帧段
     * 在锚点循环前各算一次，八签共用） */
    const galInvQ = new THREE.Quaternion();
    const galFanV = new THREE.Vector3();
    /** 星名签引线几何（邻域优化轮）：8 段 × 2 点的本地坐标缓
     * 冲，构建时分配、帧段逐帧回填（星点端恒在本星真坐标、
     * 签面端恒在签的落位） */
    let galLeaderPos: Float32Array | null = null;
    let galLeaderAttr: THREE.BufferAttribute | null = null;
    /** 邻域 warp 的几何通道（本轮）：距离环（整环同一倍率）与
     * 垂线（逐顶点倍率 + 足点旗）在 galaxySpin 本地系里是静态
     * 几何，warp 须逐帧按 eNC 从真值数组重写——构建时登记真
     * 值副本，帧段在 eNC 变化时才重写（applyGalWarpGeos） */
    const galRingWarps: Array<{
      attr: THREE.BufferAttribute;
      base: Float32Array;
      k: number;
    }> = [];
    let galDropWarp: {
      attr: THREE.BufferAttribute;
      base: Float32Array;
      ks: Float32Array;
      foot: Uint8Array;
    } | null = null;
    /** warp 几何上次写到的 eNC（静止帧不重写，省 CPU） */
    let galWarpGeoApplied = -1;
    /** 银心罗盘（本轮，用户：「银心在领域里不缩到最小看不
     * 见」）：场景级（不挂银河组）虚线 + 标记 + 签，帧段按屏
     * 幕系几何逐帧落位——见构建处与帧段罗盘段 */
    let galCompass: {
      line: THREE.Line;
      linePos: Float32Array;
      lineAttr: THREE.BufferAttribute;
      lineMat: THREE.LineDashedMaterial;
      marker: THREE.Sprite;
      markerMat: THREE.SpriteMaterial;
      pulse: THREE.Sprite;
      pulseMat: THREE.SpriteMaterial;
      label: THREE.Sprite;
      labelMat: THREE.SpriteMaterial;
    } | null = null;
    /** 罗盘最近一帧读数（验收钩子用）：臂长 px 与屏幕系方
     * 向（初值正上 = 退化相位兜底方向）；mk/lb = 标记/名签
     * 最近一帧的画布相对 px 中心（点按热区判定与探针共用同
     * 一份落位，未落位时恒 −1） */
    const galCompassState = {
      lenPx: 0,
      sdx: 0,
      sdy: -1,
      mkPxX: -1,
      mkPxY: -1,
      lbPxX: -1,
      lbPxY: -1,
    };
    /** 「太阳系」签精灵（构建时登记）：邻域点按热区按它的实
     * 际世界位投影判定，不靠估位 */
    let galSunLabel: THREE.Sprite | null = null;
    /** 邻域轨道朝向的欧拉合成（转盘模型，2026-11-16 改
     * 判）：恒 XYZ、z 分量构造上恒 0——合成 R = Rx(极
     * 角)·Ry(方位角)：方位角是绕过太阳的世界竖轴的纯
     * 转盘旋转、极角在世界系外层施加，盘面法线
     * R·(0,1,0) = (0, cos 极角, sin 极角) 与方位角无
     * 关——任意方位下镜头恒在银道面上方 +极角 等高线
     * 上、永不越面、地面倾斜度恒定、无 roll 通道。旧
     * YXZ（R = Ry·Rx）下法线 z 分量 = sin(极角)·
     * cos(方位角)：方位 0/90/180/270° 时镜头高度
     * +0.62/0/−0.62/0 rad 上下翻——即元灿真机判「旋
     * 转时视角一会儿在上面一会儿在下面」的病根（离线
     * 同式数值复核，见 DATA-PLAN 本轮条目）。帧段每帧
     * 由此写组四元数（见帧段轨道段） */
    const galOrbitEuler = new THREE.Euler(0, 0, 0, "XYZ");
    /** warp/罗盘帧段共用临时向量 */
    const galWarpV = new THREE.Vector3();
    /** 逐帧统一淡变的材质登记（base = 满显透明度） */
    const galFadeMats: Array<{
      mat: THREE.Material & { opacity: number };
      base: number;
    }> = [];
    /** 连续光场层（银河视觉重构轮）：盘面/旋臂辉光底片与尘带
     * 暗幕只属于全览读法——帧段在 galFade 基础上再乘 (1−eNC)，
     * 邻域落定时恒隐，免大号柔边点在太阳近旁糊成雾/暗斑 */
    const galHazeMats: Array<{
      mat: THREE.Material & { opacity: number };
      base: number;
    }> = [];
    /** 银心向图层（公转弧/箭头/比例尺）：近览时再乘 (1−近览混合) */
    const galHubMats: Array<{
      mat: THREE.Material & { opacity: number };
      base: number;
    }> = [];
    /** 太阳在组内本地坐标（银面 (0, R0)、盘面上方约 20 pc） */
    const galSunBase = new THREE.Vector3(
      0,
      (GAL_SUN_Z_PC / 1000) * GAL_S,
      -GAL_R0_KPC * GAL_S,
    );
    // —— 邻域径向 warp（本轮，用户：「你稍微把领域相对位置拉
    // 大一些 / 离太阳系近的几个星球都扎堆了」）——
    // 只活在邻域视图层：方向（方位角/仰角）一律不变，只把日
    // 心径向距离 r（pc）映到 r′ = r·k(r)，
    //   k(r) = 1 + 1.05·exp(−(r/30)^1.6)
    // 近处放大、远处收敛（离线核验，DATA-PLAN 有全表）：内圈
    // 四星 k = 1.94–2.03（天狼星 2.03 / 南河三 2.02 / 牛郎星
    // 1.99 / 织女星 1.94，在用户「稍微」口径的 1.8–2.2 带内）、
    // 10 pc 处 1.88、50 pc 处 1.11、角宿一 76.6 pc 处 1.01、
    // ≥100 pc 恒 ≈1.00；r′ 全域单调递增（步进 0.5 pc 验到
    // 900 pc），星序不乱。作用面：八星（实体/光晕/星签）、距
    // 离环（环按同式放大，环签仍标真实 pc——经 warp 的星恰
    // 落回同名环的球面上）、垂线与足点（足点按母星倍率放
    // x/z、y 钉盘面）；银道面网格是参考格、引力井在中心，
    // 均不 warp；银心指引是方向量，走屏幕系罗盘（见罗盘段）。
    // 真值守恒：galaxyData 真坐标与全览落位一字不动，星签距
    // 离文案仍是真实光年；warp 的混合量 = eNC（邻域混合），
    // 全览 eNC=0 时逐分量恒等真值
    const galWarpK = (rPc: number): number =>
      1 + 1.05 * Math.exp(-Math.pow(Math.max(0, rPc) / 30, 1.6));
    /** 满额 warp 倍率（按 spin 系 base 到太阳的真实距离算） */
    const galWarpKOf = (v: THREE.Vector3): number =>
      galWarpK((v.distanceTo(galSunBase) * 1000) / GAL_S);
    // 银河系过渡进度（0=太阳系/主页 / 1=银河系）与取景状态：与
    // trans 同曲线家族（2.6 秒 easeInOutCubic），进出各走一条连
    // 续飞行；galaxyZoom 捏合/滚轮倍率、galaxyNearMix 近览混合、
    // 其余为逐帧平滑量（组缩放/组平移/镜头距），手势只写目标。
    // 声明在此处而非 trans 旁：resize 首调在 trans 声明之前执行，
    // 它要读 gTrans/smoothGalaxyZ，放后面会撞 TDZ。
    let gTrans = 0;
    let galaxyZoom = 1;
    let galaxyNearMix = 0;
    // —— 邻域环视与档内缩放（2026-11-14 拖动修正轮）——
    // 拖动模型（本轮定版，用户：「拖动时不需要加 Z 轴的变化 /
    // 就和太阳系一样就行」）：与太阳系聚焦环视同一套球面轨
    // 道模型——状态只有两个角：galYaw = 方位角（横拖专属）、
    // galTilt = 极角（盘面倾角，落定值 GAL_FULL_TILT；
    // 邻域入场时由 galEntryPol 改写为恒 +0.62）；朝向每帧由 galOrbitEuler（XYZ
    // 转盘序、z 恒 0）合成四元数，roll 通道在构造上不存在（全仓无第三个
    // 角的写入者，验收钩子 orbit() 逐帧可读 roll ≡ 0、elev 恒 = 极角）；惯性
    // galVelY 只推方位角、沿同一模型衰减。横拖绝不碰极角、
    // 纵拖绝不碰方位角，两路在 onMove 里分开写入（见手势段）。
    // —— 邻域纯方位角拖动（2026-11-15 晚，用户：「领域可以
    // 和太阳系和银河系一样只左右旋转嘛，不要加上下」）：邻
    // 域内纵拖不再进视角——pitch 通道（增益 0.003、夹取
    // [0.15, 1.35]）在邻域层级整体停用，极角自入场边沿落定
    // 后恒等于入场极角，邻域内任何手势路径都不再写
    // galTiltT（拖动两路只写 galYawT 与 galVelY；点太阳系标
    // 记回正写的仍是入场极角本身，与此口径同值）。纵拖改极
    // 角只剩银河全览一路（指针路、全览夹取 [0.18, 1.25]）。
    // galYaw：邻域里绕太阳的环视偏航（目标/当前一对，帧段阻尼趋
    // 近；只在邻域混合在位时施加到组旋转，全览恒 0）；galTilt：
    // 盘面倾角（全览鼠标纵拖与邻域环视纵拖共用同一目标，帧段统
    // 一阻尼——旧实现是拖拽直写组旋转、无阻尼、触摸端纵拖被整段
    // 丢弃）；galaxyNearZoom：邻域档内捏合/滚轮缩放（旧实现捏合
    // 写的是全览的 galaxyZoom，而邻域取景窗由 nearFitKpc 锁死、
    // 相机距与组缩放同比抵消，捏合在邻域里视觉上是空操作）
    let galYawT = 0;
    let galYaw = 0;
    let galTiltT = GAL_FULL_TILT;
    let galTilt = GAL_FULL_TILT;
    // 邻域默认倍率 11（2026-11-14 邻域优化轮，用户：「星球不要
    // 挨着太近」）：基准拟合 ±1.1 kpc 经倍率 11 收紧为 ±100 pc
    // ——默认取景约 200 pc 见方，内圈四星与角宿一在真实位置上
    // 自然分开；推近端（24）窗半径约 46 pc 不变
    // 变焦域下限 0.6 → 0.25（2026-11-16 银心本体进帧轮，元灿
    // 真机澄清「领域里视角缩小到一定程度可以看见银心本体，
    // 我是说那个本体」）：银心本体（EHT 环，组原点）距太阳
    // 真距 8.15 kpc，邻域相机钉太阳、入口方位下本体方向恒
    // 在太阳上方约 35.6° 离轴——其中心 NDC 高度只随倍率降
    // 低而降：旧下限 0.6 时中心约 +1.08 NDC、环只露约四成
    // （半裁）；下限放宽到 0.25 后，约 0.30 起环顶进帧、
    // 0.25 档中心约 +0.68 NDC、环（含精灵晕尾）上沿约
    // +0.90 NDC——完整在框、留约一成半高边距（移动/桌面
    // 同式复算，见 DATA-PLAN 本轮条目）。本体方向恒为真
    // 银心方向、距离标注恒真值（罗盘签「约 26,600 光
    // 年」），无任何渲染距离压缩；既有档位（≥0.6）的取
    // 景与尺度感一字未动，只是变焦行程向外多放一段
    const GAL_NEAR_ZOOM_MIN = 0.25;
    let galaxyNearZoomT = 11;
    let galaxyNearZoom = 11;
    /** 邻域入场边沿检测（全览→邻域切换的那一帧触发入场朝向） */
    let galPrevNearGoal = 0;
    /** 入场相位拨正目标（旋转轴对齐轮）：入场边沿按
     * galEntryPhase 置位，帧段自转驱动把它阻尼拨到该相位
     * 后清零；null = 无拨正进行中（自转走常速慢转） */
    let galSpinEntryTarget: number | null = null;
    /**
     * 入场朝向解算（邻域优化轮，用户：「切换到领域时视角朝向
     * 最好对着黑洞」）：太阳→银心方向（自转系里 = −galSunBase）
     * 经当前自转角旋转后取水平方位角，入场偏航 = π − 方位
     * 角——相机落在背离银心的一侧、越过太阳望向银心，银心
     * 方向在画面正前方且恒在太阳上方（转盘合成下的推导见
     * 函数内注）。构建期（星签偏移优选）与帧段（入场边沿）
     * 共用同一份解算，口径恒一致
     */
    const galEntryYaw = (spinA: number, _tilt: number): number => {
      // 转盘轮（2026-11-16）改解：帧段合成已改 R =
      // Rx(极角)·Ry(方位角)——方位角先于极角作用于自转
      // 系向量，故入场解算只对自转后的银心方向 d0 取水
      // 平方位：偏航把 d0 的方位角转到 π（正前方、背离
      // 相机一侧），其后极角 Rx(+0.62) 不动 x 分量、把
      // 水平分量抬向 +Y——银心恒落在太阳正上方、与自
      // 转相位无关（纵分量 = d0.y·cos + h·sin(0.62)，
      // h 为 d0 水平模长 ≈ 1、恒正）。旧解把极角先揉进
      // d 再取方位，是 YXZ 合成下的配套式、随合成改判
      // 一并作废（tilt 参保留签名、式内不用）
      const d = new THREE.Vector3(
        -galSunBase.x,
        -galSunBase.y,
        -galSunBase.z,
      ).normalize();
      d.applyAxisAngle(new THREE.Vector3(0, 1, 0), spinA);
      // Ry(θ) 使水平方位角 α → α+θ（three 的右手系口径），
      // 要把银心方向转到正前方（方位角 π）须 θ = π − α
      return Math.PI - Math.atan2(d.x, d.z);
    };
    /**
     * 入场极角恒正（2026-11-16 旋转轴对齐轮，用户真机判
     * 「领域里面旋转的轴和太阳系、银河系不一样，总是上下
     * 颠倒」）。【三层旋转约定对比·诊断结论】方位角增益三
     * 处同号（太阳系 +0.005 / 银河全览 +0.0045 / 邻域
     * +0.005 rad/px）、旋转轴同为 +Y 右手系、相机 up 同为
     * +Y——唯一分岔在极角符号：太阳系总览 rotation.x =
     * +0.55、聚焦 pitch 常态为正，银河全览 galTilt 夹取
     * [0.18, 1.25] 落定 +0.61，极角恒正（相机恒在盘面上
     * 方）；旧入场极角按自转相位选 ±0.62，cos(spinA)>0 的
     * 一半入场取 −0.62——相机钻到盘面下方，世界上下镜像、
     * 方位视觉反向，正是「上下颠倒」的来源。【修法】极角
     * 恒 +0.62（与全览 +0.61 同族同号）；「银心在太阳上
     * 方」的构图改由方位角选取实现（galEntryPhase 选自转
     * 相位分支），不许再靠翻极角符号凑。【转盘轮续注
     * （2026-11-16）】旧合成（YXZ）下银心纵分量 ∝
     * −cos(spinA)·sin(极角)，故须相位分支保 cos ≤ −0.2；
     * 转盘合成（XYZ）下纵分量 = d0.y·cos(极角) +
     * h·sin(极角)（h ≈ 1）、对一切相位恒为上——相位选
     * 取自此不再是「在上方」的承重件，仅保留作入场构图
     * 余量与签偏移求解的连续性口径（行为不变）。求解器
     * （galLabelCtx）与帧段入场边沿共用本式；退出邻域
     * 时极角目标复位 GAL_FULL_TILT
     */
    const GAL_NEAR_POL = 0.62;
    const galEntryPol = (_spinA: number): number => GAL_NEAR_POL;
    /**
     * 入场方位角选取（同轮）：入场自转相位——当前相位已在
     * cos ≤ −0.2 分支（银心在上方且余量足）则原样用；否则
     * 取「相位 ≡ π（cos = −1、银心纵分量最大）」的最短角
     * 距修正值。帧段入场边沿把自转角阻尼拨到此相位（转场
     * 飞行里盘面顺转一段，落定即所需构图），求解器与回正
     * 解算按同一相位口径。方位角（绕 +Y）本身改不了纵分
     * 量——能选的是自转相位这个方位角，故名
     */
    const galEntryPhase = (spinA: number): number => {
      if (Math.cos(spinA) <= -0.2) return spinA;
      let d = (Math.PI - spinA) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return spinA + d;
    };
    // 邻域纵拖极角夹取 galNearPolClamp 已随 pitch 通道停用
    // 一并退役（2026-11-15 晚纯方位角轮）：邻域内再无极角写
    // 入者需要它；其「入场负极角不许被夹回正侧」的教训由入
    // 场极角恒定口径直接消解（见上方拖动模型条）。
    /** 星名签登记表（构建时回填）：入场边沿按当次自转相位
     * 重算偏移后逐签写回 fanX/fanY（锚定）与 fanCX/fanCY（呼出） */
    const galStarLabelRefs: Array<{ name: string; a: GalAnchor }> = [];
    // —— 星名签落位求解（邻域签验收补完轮，用户：「领域名字
    // 定位要准确」；独立复核判上一轮未达标后重做）——
    // 旧优选在「模型空间」（正交投影、无 rise/夹取/透视）里算
    // 裕量，与帧段真实落位不是同一套几何：最远帧下 8 签中 6
    // 签实测裕量为负（签离邻星比离本星还近）。本轮两改：
    // ① 锚定优选改在**帧段真实几何**里搜（组欧拉转盘序入场
    // 朝向 + rise + 横向夹取 + 透视投影，CSS px 口径），默认
    // 帧（倍率 11）逐星取点对点裕量最大者——模式不变（屏幕
    // 系小偏移 + 引线），只换搜索口径；
    // ② 宽取景（倍率 ≤ 约 1.1）时小偏移在几何上无解（内圈
    // 星团缩到约 2 px、天津四在 170 px 外，任何近旁小偏移都
    // 必然离某颗邻星更近）——改走**引线呼出**（galCallout-
    // Offsets）：签沿本星相对太阳（星团中心）的方向径向外放
    // 到可读距离、发丝引线连回本星，环绕次序与星的角向次序
    // 一致、引线不交叉；帧段按倍率在两套偏移间平滑混合（倍
    // 率 ≥2.6 纯锚定、≤1.1 纯呼出）。验收口径与全表见
    // DATA-PLAN「邻域优化轮」签验收补完条。
    // 以下纯数值小工具（元组矩阵，避免求解热环里 alloc）：
    type GalV3 = [number, number, number];
    type GalM3 = [
      number, number, number,
      number, number, number,
      number, number, number,
    ];
    const galMRotY = (t: number): GalM3 => {
      const c = Math.cos(t);
      const s = Math.sin(t);
      return [c, 0, s, 0, 1, 0, -s, 0, c];
    };
    const galMRotX = (t: number): GalM3 => {
      const c = Math.cos(t);
      const s = Math.sin(t);
      return [1, 0, 0, 0, c, -s, 0, s, c];
    };
    const galMMul = (A: GalM3, B: GalM3): GalM3 => [
      A[0] * B[0] + A[1] * B[3] + A[2] * B[6],
      A[0] * B[1] + A[1] * B[4] + A[2] * B[7],
      A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
      A[3] * B[0] + A[4] * B[3] + A[5] * B[6],
      A[3] * B[1] + A[4] * B[4] + A[5] * B[7],
      A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
      A[6] * B[0] + A[7] * B[3] + A[8] * B[6],
      A[6] * B[1] + A[7] * B[4] + A[8] * B[7],
      A[6] * B[2] + A[7] * B[5] + A[8] * B[8],
    ];
    const galMApply = (M: GalM3, v: GalV3): GalV3 => [
      M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
      M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
      M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
    ];
    /** 星名签近览宽（世界单位）= wNear = 1.55 × LW（LW 见构建
     * 处标签宽度纪律，粗指针 1.43 / 细指针 1.3）——夹取复刻用 */
    const GAL_LABEL_W = 1.55 * (isCoarse ? 1.43 : 1.3);
    interface GalLabelCtx {
      cw: number;
      ch: number;
      aspect: number;
      halfTanV: number;
      fitZ: number;
      scale: number;
      R: GalM3;
      Ri: GalM3;
      sunSpin: GalV3;
      sunPx: [number, number];
      /** 入场极角（galEntryPol，恒 +0.62）：夹取复刻的
       * sin/cos 须与帧段落定极角同值同符号 */
      pol: number;
    }
    /** 落位求解上下文：与帧段落位同式（入场朝向已解算、极
     * 角 = galEntryPol(相位)、枢轴钉太阳、相机距 galaxyFitZ），
     * zoom 为邻域档内倍率。画布尺寸取当前 mount CSS 尺寸
     * （验收口径同源） */
    const galLabelCtx = (spinA: number, zoom: number): GalLabelCtx => {
      const cw = mount.clientWidth || 390;
      const ch = mount.clientHeight || 785;
      const halfTanV = Math.tan(THREE.MathUtils.degToRad(21));
      const nearK = THREE.MathUtils.clamp(
        (galaxyFitZ * halfTanV) / ((isCoarse ? 1.1 : 1.08) * GAL_S),
        6,
        24,
      );
      const pol = galEntryPol(spinA);
      const yaw = galEntryYaw(spinA, pol);
      return {
        cw,
        ch,
        aspect: cw / ch,
        halfTanV,
        fitZ: galaxyFitZ,
        scale: nearK * zoom,
        pol,
        // 转盘合成（2026-11-16，与帧段 galOrbitEuler 同
        // 式）：R = Rx(极角)·Ry(偏航)，逆 Ri = Ry(−偏
        // 航)·Rx(−极角)——旧 YXZ 序（Ry·Rx）随帧段改判
        // 一并换序，求解器与真实落位恒同几何
        R: galMMul(galMRotX(pol), galMRotY(yaw)),
        Ri: galMMul(galMRotY(-yaw), galMRotX(-pol)),
        sunSpin: galMApply(galMRotY(spinA), [
          galSunBase.x,
          galSunBase.y,
          galSunBase.z,
        ]),
        sunPx: [cw / 2, ch / 2],
      };
    };
    const galProjPx = (ctx: GalLabelCtx, W: GalV3): [number, number] => {
      const d = ctx.fitZ - W[2];
      return [
        ((W[0] / (d * ctx.halfTanV * ctx.aspect)) + 1) / 2 * ctx.cw,
        (1 - W[1] / (d * ctx.halfTanV)) / 2 * ctx.ch,
      ];
    };
    type GalStarT = (typeof GALAXY_STARS)[number];
    /** 求解器口径的星 base = 邻域显示坐标（真坐标经满额径向
     * warp）：两套求解（锚定 @倍率 11 / 呼出 @倍率 0.6）都只
     * 服务邻域帧，与帧段 eNC=1 的落位同几何；全览不经此路，
     * 真坐标审计表不受影响 */
    const galStarBaseV = (s: GalStarT): GalV3 => {
      const vx = s.planX * GAL_S;
      const vy = s.planZ * GAL_S;
      const vz = -s.planY * GAL_S;
      const dx = vx - galSunBase.x;
      const dy = vy - galSunBase.y;
      const dz = vz - galSunBase.z;
      const k = galWarpK(
        (Math.hypot(dx, dy, dz) * 1000) / GAL_S,
      );
      return [
        galSunBase.x + dx * k,
        galSunBase.y + dy * k,
        galSunBase.z + dz * k,
      ];
    };
    /** 本星真点：屏幕 px + 世界坐标（呼出反解 fan 用） */
    const galStarFramePx = (
      ctx: GalLabelCtx,
      spinA: number,
      s: GalStarT,
    ): { starPx: [number, number]; starW: GalV3 } => {
      const p = galMApply(galMRotY(spinA), galStarBaseV(s));
      const d: GalV3 = [
        p[0] - ctx.sunSpin[0],
        p[1] - ctx.sunSpin[1],
        p[2] - ctx.sunSpin[2],
      ];
      const w = galMApply(ctx.R, d);
      const starW: GalV3 = [
        w[0] * ctx.scale,
        w[1] * ctx.scale,
        w[2] * ctx.scale,
      ];
      return { starPx: galProjPx(ctx, starW), starW };
    };
    /** 签面落位（帧段同式复刻：自转烘焙 + rise 0.5 + fanScreen
     * 逆旋转落回本地 + 横向夹取 + 透视），返回签锚点屏幕 px */
    const galLabelFramePx = (
      ctx: GalLabelCtx,
      spinA: number,
      s: GalStarT,
      fan: [number, number],
    ): [number, number] => {
      const rot = galMRotY(spinA);
      let p = galMApply(rot, galStarBaseV(s));
      p = [p[0], p[1] + 0.5 / ctx.scale, p[2]];
      const fl = galMApply(ctx.Ri, [fan[0], fan[1], 0]);
      p = [
        p[0] + fl[0] / ctx.scale,
        p[1] + fl[1] / ctx.scale,
        p[2] + fl[2] / ctx.scale,
      ];
      const offWY = (p[1] - galSunBase.y) * ctx.scale;
      const offWZ = (p[2] - ctx.sunSpin[2]) * ctx.scale;
      const wz =
        offWY * Math.sin(ctx.pol) + offWZ * Math.cos(ctx.pol);
      const depth = ctx.fitZ - wz;
      if (depth > 1) {
        const limWorld =
          0.98 * depth * ctx.halfTanV * ctx.aspect - GAL_LABEL_W / 2;
        if (limWorld > 0) {
          const lim = limWorld / ctx.scale;
          if (
            Math.abs(p[0] - ctx.sunSpin[0]) <=
            lim + GAL_LABEL_W / ctx.scale
          ) {
            p = [
              ctx.sunSpin[0] +
                THREE.MathUtils.clamp(
                  p[0] - ctx.sunSpin[0],
                  -lim,
                  lim,
                ),
              p[1],
              p[2],
            ];
          }
        }
      }
      const d: GalV3 = [
        p[0] - ctx.sunSpin[0],
        p[1] - ctx.sunSpin[1],
        p[2] - ctx.sunSpin[2],
      ];
      const w = galMApply(ctx.R, d);
      return galProjPx(ctx, [
        w[0] * ctx.scale,
        w[1] * ctx.scale,
        w[2] * ctx.scale,
      ]);
    };
    /**
     * 星名签锚定偏移优选（默认帧，倍率 11）：在帧段真实几何
     * 里逐星独立搜（各星签面互不影响本星裕量——裕量只对星点
     * 与太阳量）7 档幅值（0.55…0.06 世界单位）× 64 方向 +
     * 局部细化，取「签到本星 − 签到最近其他星（含太阳）」点
     * 对点裕量（CSS px）最大者，同分偏右上。构建时以相位 0
     * 预置，入场边沿按当次真实相位重算覆盖
     */
    const galLabelOffsets = (
      spinA: number,
    ): Record<string, [number, number]> => {
      const ctx = galLabelCtx(spinA, 11);
      const stars = GALAXY_STARS.filter((s) => s.name);
      const starPx = new Map<string, [number, number]>();
      for (const s of stars)
        starPx.set(s.name, galStarFramePx(ctx, spinA, s).starPx);
      const out: Record<string, [number, number]> = {};
      for (const s of stars) {
        const own = starPx.get(s.name)!;
        const evalMargin = (fan: [number, number]): number => {
          const L = galLabelFramePx(ctx, spinA, s, fan);
          let nearest = Math.hypot(
            L[0] - ctx.sunPx[0],
            L[1] - ctx.sunPx[1],
          );
          for (const o of stars) {
            if (o.name === s.name) continue;
            const P = starPx.get(o.name)!;
            nearest = Math.min(
              nearest,
              Math.hypot(L[0] - P[0], L[1] - P[1]),
            );
          }
          return nearest - Math.hypot(L[0] - own[0], L[1] - own[1]);
        };
        let best: [number, number] = [0.14, 0.14];
        let bestMargin = -Infinity;
        let bestScore = -Infinity;
        for (const m of [0.55, 0.42, 0.32, 0.24, 0.17, 0.11, 0.06]) {
          for (let k = 0; k < 64; k++) {
            const a = (k / 64) * Math.PI * 2;
            const fan: [number, number] = [
              m * Math.cos(a),
              m * Math.sin(a),
            ];
            const mg = evalMargin(fan);
            const score = mg - Math.abs(a - Math.PI / 4) * 0.00001;
            if (score > bestScore) {
              bestScore = score;
              bestMargin = mg;
              best = fan;
            }
          }
        }
        for (const dm of [-0.05, -0.025, 0.025, 0.05]) {
          for (const da of [-0.12, -0.06, 0.06, 0.12]) {
            const m0 = Math.hypot(best[0], best[1]);
            const a0 = Math.atan2(best[1], best[0]);
            const fan: [number, number] = [
              (m0 + dm) * Math.cos(a0 + da),
              (m0 + dm) * Math.sin(a0 + da),
            ];
            const mg = evalMargin(fan);
            if (mg > bestMargin + 0.02) {
              bestMargin = mg;
              best = fan;
            }
          }
        }
        out[s.name] = best;
      }
      return out;
    };
    /** 点到线段距离（px，引线净空口径用） */
    const galDistPtSeg = (
      P: [number, number],
      A: [number, number],
      B: [number, number],
    ): number => {
      const abx = B[0] - A[0];
      const aby = B[1] - A[1];
      const den = abx * abx + aby * aby || 1;
      const t = THREE.MathUtils.clamp(
        ((P[0] - A[0]) * abx + (P[1] - A[1]) * aby) / den,
        0,
        1,
      );
      return Math.hypot(P[0] - (A[0] + t * abx), P[1] - (A[1] + t * aby));
    };
    /** 线段相交（引线交叉判定，端点接触不算） */
    const galSegCross = (
      a: [number, number],
      b: [number, number],
      c: [number, number],
      d: [number, number],
    ): boolean => {
      const rx = b[0] - a[0];
      const ry = b[1] - a[1];
      const qx = d[0] - c[0];
      const qy = d[1] - c[1];
      const den = rx * qy - ry * qx;
      if (Math.abs(den) < 1e-12) return false;
      const t = ((c[0] - a[0]) * qy - (c[1] - a[1]) * qx) / den;
      const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
      return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
    };
    /**
     * 星名签呼出偏移（宽取景，最远帧倍率 0.6 求解）：签沿本
     * 星相对太阳（星团中心）的方向径向外放到可读距离（半径
     * = max(本星距, 52 px) + 34 px、上限 215 px），环绕次序
     * 与星角向次序一致（接缝感知松弛，最小角距 0.55 rad，
     * 近邻半径错层 +40 px）；其后修复循环以词典序（引线交
     * 叉数 → 本签引线净空）逐签挪角/挪半径至全达标。归属口
     * 径 = 引线端点：引线星端恒落本星真点、签端为签锚点，
     * 裕量 = 本签到**他星引线**的最短距离（净空）。目标点经
     * 本星深度反解回 fan（屏幕系世界偏移，与锚定同通道）
     */
    const galCalloutOffsets = (
      spinA: number,
    ): Record<string, [number, number]> => {
      const ctx = galLabelCtx(spinA, 0.6);
      const stars = GALAXY_STARS.filter((s) => s.name);
      const riseW = galMApply(ctx.R, [0, 0.5, 0]);
      interface CallItem {
        s: GalStarT;
        name: string;
        r: number;
        ang: number;
        rho: number;
        starW: GalV3;
      }
      const items: CallItem[] = [];
      for (const s of stars) {
        const f = galStarFramePx(ctx, spinA, s);
        const mx = f.starPx[0] - ctx.sunPx[0];
        const my = ctx.sunPx[1] - f.starPx[1];
        items.push({
          s,
          name: s.name,
          r: Math.hypot(mx, my),
          ang: Math.atan2(my, mx),
          rho: 0,
          starW: f.starW,
        });
      }
      for (const it of items)
        it.rho = Math.min(Math.max(it.r, 52) + 34, 215);
      // 接缝感知排序：从最大角隙后起排、展开成线（织女星与
      // 天津四在 ±π 两侧相邻，朴素排序会把环绕次序拆散）
      const sorted = [...items].sort((a, b) => a.ang - b.ang);
      let seam = 0;
      let seamGap = -1;
      for (let i = 0; i < sorted.length; i++) {
        const cur = sorted[i]!.ang;
        const nxt =
          sorted[(i + 1) % sorted.length]!.ang +
          (i === sorted.length - 1 ? Math.PI * 2 : 0);
        if (nxt - cur > seamGap) {
          seamGap = nxt - cur;
          seam = (i + 1) % sorted.length;
        }
      }
      const line: CallItem[] = [];
      for (let k = 0; k < sorted.length; k++) {
        const it = sorted[(seam + k) % sorted.length]!;
        if (k > 0 && it.ang <= line[k - 1]!.ang) it.ang += Math.PI * 2;
        line.push(it);
      }
      const MIN_GAP = 0.55;
      const span0 = line[line.length - 1]!.ang - line[0]!.ang;
      for (let pass = 0; pass < 80; pass++) {
        let moved = false;
        for (let i = 1; i < line.length; i++) {
          if (line[i]!.ang - line[i - 1]!.ang < MIN_GAP) {
            line[i]!.ang = line[i - 1]!.ang + MIN_GAP;
            moved = true;
          }
        }
        if (!moved) break;
      }
      const span1 = line[line.length - 1]!.ang - line[0]!.ang;
      const shift = (span0 - span1) / 2;
      for (const it of line) it.ang += shift;
      for (let i = 1; i < line.length; i++) {
        if (
          line[i]!.ang - line[i - 1]!.ang < 0.85 &&
          Math.abs(line[i]!.rho - line[i - 1]!.rho) < 30
        )
          line[i]!.rho += 40;
      }
      const targetOf = (it: CallItem): [number, number] => [
        ctx.sunPx[0] + it.rho * Math.cos(it.ang),
        ctx.sunPx[1] - it.rho * Math.sin(it.ang),
      ];
      const fanFromTarget = (
        it: CallItem,
        T: [number, number],
      ): [number, number] => {
        const wz = it.starW[2] + riseW[2];
        const d = ctx.fitZ - wz;
        const Wx = ((T[0] / ctx.cw) * 2 - 1) * d * ctx.halfTanV * ctx.aspect;
        const Wy = (1 - (T[1] / ctx.ch) * 2) * d * ctx.halfTanV;
        return [Wx - it.starW[0], Wy - it.starW[1] - riseW[1]];
      };
      const buildFan = (): Record<string, [number, number]> => {
        const f: Record<string, [number, number]> = {};
        for (const it of items) f[it.name] = fanFromTarget(it, targetOf(it));
        return f;
      };
      const evalAll = (
        fanOf: Record<string, [number, number]>,
      ): Map<string, { starPx: [number, number]; labelPx: [number, number] }> => {
        const m = new Map();
        for (const it of items) {
          m.set(it.name, {
            starPx: galStarFramePx(ctx, spinA, it.s).starPx,
            labelPx: galLabelFramePx(ctx, spinA, it.s, fanOf[it.name]!),
          });
        }
        return m;
      };
      const leaderMarginOf = (
        fr: Map<string, { starPx: [number, number]; labelPx: [number, number] }>,
        name: string,
      ): number => {
        const L = fr.get(name)!.labelPx;
        let m = Infinity;
        for (const o of items) {
          if (o.name === name) continue;
          const e = fr.get(o.name)!;
          m = Math.min(m, galDistPtSeg(L, e.starPx, e.labelPx));
        }
        return m;
      };
      const crossCountFor = (
        fr: Map<string, { starPx: [number, number]; labelPx: [number, number] }>,
        name: string,
      ): number => {
        let n = 0;
        const A = fr.get(name)!;
        for (const o of items) {
          if (o.name === name) continue;
          const B = fr.get(o.name)!;
          if (galSegCross(A.starPx, A.labelPx, B.starPx, B.labelPx)) n++;
        }
        return n;
      };
      const totalCross = (
        fr: Map<string, { starPx: [number, number]; labelPx: [number, number] }>,
      ): number => {
        let n = 0;
        for (let i = 0; i < items.length; i++)
          for (let j = i + 1; j < items.length; j++) {
            const A = fr.get(items[i]!.name)!;
            const B = fr.get(items[j]!.name)!;
            if (galSegCross(A.starPx, A.labelPx, B.starPx, B.labelPx)) n++;
          }
        return n;
      };
      const orderIdx = new Map(line.map((it, i) => [it.name, i]));
      for (let iter = 0; iter < 240; iter++) {
        const fr = evalAll(buildFan());
        const cr = totalCross(fr);
        let worstName = "";
        let worst = 6;
        for (const it of items) {
          const lm = leaderMarginOf(fr, it.name);
          if (lm < worst) {
            worst = lm;
            worstName = it.name;
          }
        }
        if (cr === 0 && !worstName) break;
        let target: CallItem | undefined;
        if (cr > 0) {
          let bestC = -1;
          let bestM = Infinity;
          for (const it of items) {
            const c = crossCountFor(fr, it.name);
            const lm = leaderMarginOf(fr, it.name);
            if (c > bestC || (c === bestC && lm < bestM)) {
              bestC = c;
              bestM = lm;
              target = it;
            }
          }
        } else {
          target = items.find((x) => x.name === worstName);
        }
        if (!target) break;
        const idx = orderIdx.get(target.name)!;
        const prevA =
          idx > 0
            ? line[idx - 1]!.ang
            : line[line.length - 1]!.ang - Math.PI * 2;
        const nextA =
          idx < line.length - 1
            ? line[idx + 1]!.ang
            : line[0]!.ang + Math.PI * 2;
        const curMargin = leaderMarginOf(fr, target.name);
        let bestMove: [number, number] | null = null;
        let bestKey: [number, number] | null = null;
        for (const da of [-0.45, -0.3, -0.18, -0.08, 0.08, 0.18, 0.3, 0.45]) {
          const na = target.ang + da;
          if (na - prevA < 0.26 || nextA - na < 0.26) continue;
          for (const nr of [
            target.rho,
            target.rho + 35,
            target.rho - 25,
            target.rho + 70,
          ]) {
            if (nr < 55 || nr > 240) continue;
            const sA = target.ang;
            const sR = target.rho;
            target.ang = na;
            target.rho = nr;
            const fr2 = evalAll(buildFan());
            const key: [number, number] = [
              totalCross(fr2),
              -leaderMarginOf(fr2, target.name),
            ];
            target.ang = sA;
            target.rho = sR;
            const improves =
              key[0] < cr || (key[0] === cr && -key[1] > curMargin + 0.3);
            const better =
              !bestKey ||
              key[0] < bestKey[0] ||
              (key[0] === bestKey[0] && key[1] < bestKey[1]);
            if (better && improves) {
              bestKey = key;
              bestMove = [na, nr];
            }
          }
        }
        if (!bestMove) break;
        target.ang = bestMove[0];
        target.rho = bestMove[1];
      }
      return buildFan();
    };
    /** 签偏移求解并写回（锚定 + 呼出两套）：只许在离散时点调
     * 用——构建预置、入场边沿、拖动/捏合落定后（见帧段
     * galLabelResolvePending 消费处）。求解是多方向搜索（锚
     * 定 7 档×64 向 + 呼出修复循环），拖动态逐帧绝不重跑：
     * 拖动期间签走帧段的廉价路径（已存偏移 + 逐帧投影跟
     * 随），几何假设（入场朝向模型）不随手势变，落定再求解
     * 与入场同口径同结果，画布尺寸变过时在此自动跟上 */
    const applyGalLabelSolve = (spinA: number) => {
      const lo = galLabelOffsets(spinA);
      for (const ref of galStarLabelRefs) {
        const o = lo[ref.name];
        if (o) {
          ref.a.fanX = o[0];
          ref.a.fanY = o[1];
        }
      }
      const co = galCalloutOffsets(spinA);
      for (const ref of galStarLabelRefs) {
        const c = co[ref.name];
        if (c) {
          ref.a.fanCX = c[0];
          ref.a.fanCY = c[1];
        }
      }
    };
    /** warp 几何重写（本轮）：距离环/垂线在 spin 本地系里按
     * eNC 从真值副本重算——环逐顶点绕太阳径向缩放（整环同
     * 一倍率）、垂线星端三维缩放/足端只放 x/z 且 y 恒 0。
     * 只在 eNC 变化时调用（帧段以 galWarpGeoApplied 把关），
     * eNC=0 时写回真值、全览恒等 */
    const applyGalWarpGeos = (e: number): void => {
      const sx = galSunBase.x;
      const sy = galSunBase.y;
      const sz = galSunBase.z;
      for (const rw of galRingWarps) {
        const fb = 1 + (rw.k - 1) * e;
        const arr = rw.attr.array as Float32Array;
        const base = rw.base;
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] = sx + (base[i]! - sx) * fb;
          arr[i + 1] = sy + (base[i + 1]! - sy) * fb;
          arr[i + 2] = sz + (base[i + 2]! - sz) * fb;
        }
        rw.attr.needsUpdate = true;
      }
      if (galDropWarp) {
        const dw = galDropWarp;
        const arr = dw.attr.array as Float32Array;
        const base = dw.base;
        for (let j = 0, i = 0; i < arr.length; j++, i += 3) {
          const fb = 1 + (dw.ks[j]! - 1) * e;
          if (dw.foot[j]) {
            arr[i] = sx + (base[i]! - sx) * fb;
            arr[i + 1] = 0;
            arr[i + 2] = sz + (base[i + 2]! - sz) * fb;
          } else {
            arr[i] = sx + (base[i]! - sx) * fb;
            arr[i + 1] = sy + (base[i + 1]! - sy) * fb;
            arr[i + 2] = sz + (base[i + 2]! - sz) * fb;
          }
        }
        dw.attr.needsUpdate = true;
      }
    };
    /** 落定再求解待办（拖动补完轮）：邻域拖动/捏合收尾置位，
     * 帧段在手势与惯性都停稳后消费一次 */
    let galLabelResolvePending = false;
    /** 画布 touch-action 是否已切到 none（邻域在位时手势不漏给页面滚动） */
    let galTouchNone = false;
    let galaxyScaleCur = 0.15;
    const galaxyPosCur = new THREE.Vector3();
    const galaxyTmpV = new THREE.Vector3();
    /** 组平移目标（锚点钉住解算用，与 galaxyPosCur 分开免自引用） */
    const galaxyPosTarget = new THREE.Vector3();
    /** 太阳标记的当前世界坐标（转场锚定：镜头注视点逐帧追它） */
    const galaxySunWorld = new THREE.Vector3();
    /** 镜头注视点（转场期 = 太阳锚点×(1−eG)，落位 = 原点） */
    const galaxyLook = new THREE.Vector3();
    // —— 立体重构轮（2026-11-14）：呼吸闪烁的着色器基建 ——
    // galTimeUniform：全银河星点共享的一枚时间 uniform——CPU
    // 每帧只写它一个值，逐星呼吸（相位/频率/振幅）在顶点着色
    // 器里并行算，静态缓冲构建时一次上传、绘制调用结构不变、
    // CPU 逐帧开销为零；reduced-motion 时帧段不推进它，呼吸
    // 冻结。galPointScale：点径换算标尺 = 绘图缓冲高 × 0.5，
    // 与 three 0.187 PointsMaterial 的 scale 口径逐像素同式
    // （resize 维护），自定义着色器的点径与旧 PointsMaterial
    // 完全一致。galNearMats：邻域定位家具（网格/垂线/距离环/
    // 引力井）材质登记，帧段按 galFade × eNC 淡入——只在邻
    // 域档出现，全览恒隐
    const galTimeUniform = { value: 0 };
    // 粒子游移时钟（2026-11-16「活银河」轮，用户改口径：
    // 不走轨道，只在本位附近随机游移；当晚返工轮调强——
    // 幅度/频率/呼吸振幅全面上调到真机肉眼可辨，见 mkPoints
    // 头注）：全银河点层共享——帧段按 (1−eNC) 推进（邻域
    // 渐冻、校准层恒静），逐粒子在顶点着色器里以自家相位
    // 做三轴 Lissajous 漂移（mkPoints 头注），CPU 每帧只
    // 写这一个值
    const galOrbitUniform = { value: 0 };
    let galOrbitClock = 0;
    const galPointScale = { value: 800 };
    const galNearMats: Array<{
      mat: THREE.Material & { opacity: number };
      base: number;
    }> = [];
    let smoothGalaxyZ = 22;
    const buildGalaxy = async (): Promise<void> => {
      // 分片构建（调度安全网）：约 4.3 万（移动）–8 万（桌面）
      // 星点的生成按时间
      // 预算切片让行（fillDisc 循环内检查点 + 逐臂检查点），构
      // 建在银河过渡的 2.6 秒里分片完成、不再是一整块长任务；
      // galaxyBuilt 只在全部构建完成时才置真——帧段对银河结构
      // 的引用全部以 galaxyBuilt 为闸，半成品永不被逐帧逻辑读到
      const rand = seededRand(20231114);
      const gauss = (): number => (rand() + rand() + rand()) / 1.5 - 1;
      // Laplace 采样（密度 ∝ exp(−|z|/b)，b = 指数标高）：银盘
      // 竖直分布的发表形式即指数律（Jurić et al. 2008 薄盘标高
      // 约 0.3 kpc、厚盘约 0.9 kpc）——旧 gauss 近似的尾巴太短，
      // 盘面上下读不出纵深，本轮各成分逐星独立抽 z 皆走它
      const laplace = (b: number): number => {
        const u = rand() - 0.5;
        return -b * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
      };
      /** 逐通道小抖动：每颗星在自家色系内偏几个百分点（色相/
       * 明暗的近亲变化，用户口径「同色系或者邻色系的变化」） */
      const jit = (v: number): number => v * (0.9 + rand() * 0.2);
      const glowTex = makeGlowTexture(
        "rgba(255,255,255,0.95)",
        "rgba(255,255,255,0.30)",
      );
      // 银河星点专用辉光（2026-11-14 精致轮）：多段缓降——亮核
      // 更小、外围拖得更长更淡，点与点叠起来是云气感而不是硬
      // 圆斑；仍是同一条 CanvasTexture + Points 渲染路径
      const galGlowTex = (() => {
        const c = document.createElement("canvas");
        c.width = 128;
        c.height = 128;
        const g = c.getContext("2d")!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgba(255,255,255,0.95)");
        grad.addColorStop(0.16, "rgba(255,255,255,0.60)");
        grad.addColorStop(0.38, "rgba(255,255,255,0.28)");
        grad.addColorStop(0.62, "rgba(255,255,255,0.11)");
        grad.addColorStop(0.85, "rgba(255,255,255,0.03)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();
      // 连续光场专用纹理（银河视觉重构轮）：比星点辉光更宽更
      // 平的缓降——峰值压低、肩部抬高，大号点彼此叠绘时融成
      // 连续光带而不是一颗颗圆斑（多尺度辉光叠绘近似 bloom：
      // 本页无后期辉光通道，连续感全靠这层 + 臂/盘两级大点
      // 层的加色累积）。尘带暗幕共用同一张（宽肩 = 软边吸收）
      const galHazeTex = (() => {
        const c = document.createElement("canvas");
        c.width = 128;
        c.height = 128;
        const g = c.getContext("2d")!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgba(255,255,255,0.50)");
        grad.addColorStop(0.3, "rgba(255,255,255,0.34)");
        grad.addColorStop(0.55, "rgba(255,255,255,0.18)");
        grad.addColorStop(0.8, "rgba(255,255,255,0.06)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();
      const L = (xKpc: number, yKpc: number, zKpc = 0): THREE.Vector3 =>
        new THREE.Vector3(xKpc * GAL_S, zKpc * GAL_S, -yKpc * GAL_S);
      const tmpC = new THREE.Color();
      // 星点渲染（立体重构轮改着色器，用户：「每一颗都加一闪
      // 一闪的呼吸效果、注意性能优化」）：逐星静态属性 aPhase/
      // aFreq/aAmp 在构建时一次写进缓冲——周期 2.5–6 秒随机、
      // 亮度因子（真机修正轮重做，用户真机判「没看到呼吸」；
      // 诊断：属性/uTime 通路经 three 0.187 源码查实无故障——
      // WebGLProgram 对非 Raw 材质按 vertexColors 注入 USE_COLOR
      // 并声明 color 属性、uTime 逐帧以秒推进；真因是旧公式
      // 1 − aAmp·(0.5+0.5·sin) 把 88% 的星压在 [0.82, 1.0]
      // （±9% 调制），在手机小屏 + 加色叠亮下低于感知阈值）：
      // 新式 vB = uCenter + aAmp·sin(t·freq+phase)，uCenter=
      // 0.87、aAmp 为半幅——约 20% 的星半幅 0.34–0.40（亮度
      // 约 0.47–1.27、一眼可感），其余 0.18–0.26（2026-11-16
      // 活银河返工轮再上调：上一档 0.24–0.28 / 0.12–0.20 在
      // 真机上仍被判「看不到」，本档半幅约 ±30–46% 调制；时
      // 间均值恒为 uCenter 0.87、与振幅无关，亮度预算不
      // 变）；时间均值由
      // 旧式约 0.92 降到 0.87，图层不透明度统一 ×1.06 补偿回
      // 旧均值（亮度预算守恒，只写进 galFadeMats 的 base）；
      // breatheAmp 是层级总闸（尘带 0 且其 uCenter=1.0 恒定、
      // HII 区压低）。顶点着色器读共享 uTime 并行算，CPU 每帧
      // 只递一个 uniform 值。点径公式与 three 0.187 的
      // PointsMaterial 逐像素同式（size × pixelRatio × 缓冲高
      // ×0.5 / 深度，pixelRatio 已折进 uPointScale），辉光纹理
      // 与混合方式（加色走 SrcAlpha/One、尘带走正常混合）沿用
      // 现行已验路径——禁用预乘加色（彗星尾出过事）
      const mkPoints = (
        n: number,
        size: number,
        opacity: number,
        blending: THREE.Blending,
        vertexColors: boolean,
        breatheAmp = 1,
        tex: THREE.Texture | null = null,
        hazeFade = false,
        order = 0,
      ): {
        pos: Float32Array;
        col: Float32Array | null;
        mat: THREE.ShaderMaterial;
        done: () => void;
      } => {
        const pos = new Float32Array(n * 3);
        const col = vertexColors ? new Float32Array(n * 3) : null;
        const phase = new Float32Array(n);
        const freq = new Float32Array(n);
        const amp = new Float32Array(n);
        // 游移向量（2026-11-16「活银河」轮立、当晚返工轮调
        // 强——元灿真机判「全是静止的」）：逐粒子随机方向 ×
        // 层级幅度——星点层 0.14 wu（≈0.28 kpc，仍在臂宽 1σ
        // ≈0.36 kpc 内、不脱臂）、大号软云层（点径 ≥1.4 的
        // 雾团/辉光/剪影）0.30 wu（云体本就弥散，游移读作云
        // 气翻动）；顶点着色器以自家相位派生三轴频率与相
        // 位、周期 6–20 秒多档错开地漂移（Lissajous 小域游
        // 走，恒在本位附近、不成轨道——元灿改口径：不要轨
        // 道运动，要整体活气）。返工诊断：旧口径（星点层
        // 0.045 wu、周期 48–68 秒）通路无冻结（uOrbit 时钟
        // 逐帧推进、邻域外不门控），纯量级问题——手机全览
        // 约 50 px/wu 下旧游移幅约 2 px、5 秒位移不足 1 px，
        // 低于肉眼阈值；新口径星点层幅约 7 px、典型 5 秒位
        // 移 5–9 px，软云层幅约 15 px
        const driftAmp = size >= 1.4 ? 0.3 : 0.14;
        const drift = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          phase[i] = rand() * Math.PI * 2;
          freq[i] = (Math.PI * 2) / (2.5 + rand() * 3.5);
          amp[i] =
            breatheAmp * (rand() < 0.2 ? 0.34 + rand() * 0.06 : 0.18 + rand() * 0.08);
          const dMag = driftAmp * (0.35 + rand() * 0.65);
          drift[i * 3] = gauss() * dMag;
          drift[i * 3 + 1] = gauss() * dMag * 0.7;
          drift[i * 3 + 2] = gauss() * dMag;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        if (col)
          geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
        geo.setAttribute("aFreq", new THREE.BufferAttribute(freq, 1));
        geo.setAttribute("aAmp", new THREE.BufferAttribute(amp, 1));
        geo.setAttribute("aDrift", new THREE.BufferAttribute(drift, 3));
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTime: galTimeUniform,
            uOrbit: galOrbitUniform,
            uPointScale: galPointScale,
            uSize: { value: size },
            uOpacity: { value: opacity },
            uMap: { value: tex ?? galGlowTex },
            uColor: { value: new THREE.Color(0xffffff) },
            // 呼吸中心：参与呼吸的层 0.87（均值补偿见头注），
            // 不参与的层（尘带 breatheAmp=0、aAmp 恒 0）取 1.0
            uCenter: { value: breatheAmp > 0 ? 0.87 : 1.0 },
          },
          vertexShader: [
            "attribute float aPhase;",
            "attribute float aFreq;",
            "attribute float aAmp;",
            "attribute vec3 aDrift;",
            "uniform float uTime;",
            "uniform float uOrbit;",
            "uniform float uPointScale;",
            "uniform float uSize;",
            "uniform float uCenter;",
            "uniform vec3 uColor;",
            "varying vec3 vColor;",
            "varying float vB;",
            "void main() {",
            "  #ifdef USE_COLOR",
            "    vColor = color;",
            "  #else",
            "    vColor = uColor;",
            "  #endif",
            "  vB = uCenter + aAmp * sin(uTime * aFreq + aPhase);",
            // 游移（活银河轮立、返工轮调强）：三轴角频率逐
            // 粒子由自家相位派生（fract 散列到 0.34–1.02
            // rad/s、周期约 6–20 秒、多档错开）× 非整数倍派
            // 生相位——逐粒子路径与节拍互不相同、不同步、
            // 不成整齐机械感；位移恒被 aDrift 幅度封顶在本
            // 位附近（旧式全员同频 0.131/0.093/0.107、周期
            // 48–68 秒，真机不可见，已作废）
            "  float dw1 = mix(0.34, 1.02, fract(aPhase * 0.61803));",
            "  float dw2 = mix(0.34, 1.02, fract(aPhase * 1.31370));",
            "  float dw3 = mix(0.34, 1.02, fract(aPhase * 2.11703));",
            "  vec3 dp = position + aDrift * vec3(",
            "    sin(uOrbit * dw1 + aPhase * 3.17),",
            "    sin(uOrbit * dw2 + aPhase * 5.29),",
            "    sin(uOrbit * dw3 + aPhase * 7.73));",
            "  vec4 mv = modelViewMatrix * vec4(dp, 1.0);",
            "  gl_PointSize = clamp(uSize * uPointScale / max(0.05, -mv.z), 0.0, 300.0);",
            "  gl_Position = projectionMatrix * mv;",
            "}",
          ].join("\n"),
          fragmentShader: [
            "uniform sampler2D uMap;",
            "uniform float uOpacity;",
            "varying vec3 vColor;",
            "varying float vB;",
            "void main() {",
            "  vec4 tex = texture2D(uMap, gl_PointCoord);",
            "  gl_FragColor = vec4(vColor * tex.rgb, tex.a * uOpacity * vB);",
            "}",
          ].join("\n"),
          transparent: true,
          depthWrite: false,
          blending,
          vertexColors,
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;
        // 绘制序（银河视觉重构轮）：尘带两层 order=1 恒在一切
        // 加色层（默认 0，含登记在后的核球/星晕/辉光精灵）之
        // 后落笔——吸收必须压在已累积的光之上才成立，旧版靠
        // 插入顺序、核球与辉光在其后又把内臂尘缝冲淡
        points.renderOrder = order;
        galaxySpin.add(points);
        // 呼吸均值补偿：新式时间均值 0.87 vs 旧式约 0.92，参与
        // 呼吸的层 base ×1.06 补回（0.87×1.06≈0.92）；尘带
        // （breatheAmp=0、因子恒 1.0）不补。hazeFade 层改登记
        // galHazeMats（帧段再乘 (1−eNC)，邻域恒隐）
        (hazeFade ? galHazeMats : galFadeMats).push({
          mat,
          base: opacity * (breatheAmp > 0 ? 1.06 : 1),
        });
        return {
          pos,
          col,
          mat,
          done: () => {
            geo.computeBoundingSphere();
          },
        };
      };
      const put = (
        arr: Float32Array,
        i: number,
        xKpc: number,
        yKpc: number,
        zKpc: number,
      ): void => {
        arr[i * 3] = xKpc * GAL_S;
        arr[i * 3 + 1] = zKpc * GAL_S;
        arr[i * 3 + 2] = -yKpc * GAL_S;
      };
      const putC = (
        arr: Float32Array,
        i: number,
        r: number,
        g: number,
        b: number,
      ): void => {
        arr[i * 3] = r;
        arr[i * 3 + 1] = g;
        arr[i * 3 + 2] = b;
      };
      // —— 平滑盘面：指数盘（标长 3 kpc——论文 §3.2 的盘权重同值）
      // 截断 15 kpc；颜色由内暖金渐变到外蓝白，亮度随机压暗出颗粒
      {
        // 点数沿革：23,000/13,000 → 立体重构轮 24,500/12,800
        // → 本轮（2026-11-15 质感纠正轮·市面参考简报：「粒子
        // 效果一定要足，粒子是本体不是装饰；不许再以性能为
        // 由悄悄削粒子量」）34,000/16,000。主体/亮点两层拆分
        // （5%）沿用。主体点径 0.085→0.10、不透明度 0.68→
        // 0.78，亮点 0.145→0.17 / 0.8→0.88——旧帧里盘面外区
        // 近乎空黑、臂间无填充，正是「CD」感的主因之一；本
        // 轮靠点数＋点径＋亮度分布（见 fillDisc 内 b 式）把
        // 盘面铺实，径向指数密度律不变（中心压倒性亮、边缘
        // 渐隐的梯度由采样律本身给出，不动几何）
        const n = isCoarse ? 16000 : 34000;
        const brightN = Math.round(n * 0.05);
        const bodySet = mkPoints(
          n - brightN, 0.1, 0.78, THREE.AdditiveBlending, true,
        );
        const brightSet = mkPoints(
          brightN, 0.17, 0.88, THREE.AdditiveBlending, true,
        );
        // 盘面配色：内圈饱和金 → 外圈麦秆色（盘面大众脸是暖
        // 白到鹅黄，蓝白留给旋臂的年轻星）；本轮内圈金再加
        // 深（#f2cf8e→#f5c877），与核球金、旋臂蓝三方一眼可
        // 分；逐星再叠色系内抖动与少量邻色人口（约 6% 偏蓝
        // 白、约 5% 偏橙）
        const cIn = new THREE.Color("#f5c877");
        const cOut = new THREE.Color("#d8c491");
        const fillDisc = async (
          set: { pos: Float32Array; col: Float32Array | null; done: () => void },
          count: number,
          bright: boolean,
        ): Promise<void> => {
          for (let i = 0; i < count; i++) {
            // 分片让行：盘面主体约 2.3 万点是银河构建最重的单
            // 循环，每 4096 点查一次时间预算
            if ((i & 2047) === 0) await sl.tick();
            const u = rand();
            const rKpc =
              -3 * Math.log(1 - u * (1 - Math.exp(-15 / 3)));
            const beta = rand() * Math.PI * 2;
            // 竖直分布双成分（立体重构轮定版，取代加厚轮的
            // gauss 近似）：逐星独立抽 Laplace z（指数标高律，
            // Jurić et al. 2008 的发表量级）——约 84% 薄盘（标
            // 高 0.30 kpc）+ 约 16% 厚盘（标高 0.95 kpc、色偏
            // 暖、年老星族）；指数律的长尾让盘面上下自然散开
            // 少数高 z 星，斜视时纵深立刻可读。每颗星的 z 只
            // 由它所属成分决定，不许整层共用一个高度
            // 【z 拉伸轮（2026-11-15 晚，23:50 幅度再放
            // 开）】抽样标高：薄成分 ×8（0.30→2.40 kpc）、
            // 厚成分 ×3.5（0.95→3.33，等效盘厚合计 ×6.3）：
            // 发表量级只作两成分的配比与形状来源，纵向比例
            // 自本轮起是表现层口径、非真实标高（元灿亲令，
            // 见 GAL_Z_STRETCH 注）
            const thick = rand() < 0.16;
            put(
              set.pos, i,
              rKpc * Math.sin(beta),
              rKpc * Math.cos(beta),
              laplace(thick ? 0.95 * GAL_Z_THICK : 0.3 * GAL_Z_STRETCH),
            );
            tmpC.copy(cIn).lerp(cOut, Math.min(1, rKpc / 13));
            if (thick) tmpC.lerp(cIn, 0.4);
            const acc = rand();
            if (acc < 0.06) tmpC.lerp(new THREE.Color(0.62, 0.76, 1.0), 0.55);
            else if (acc < 0.11)
              tmpC.lerp(new THREE.Color(1.0, 0.5, 0.24), 0.45);
            // 亮度分布（质感纠正轮）：旧式 0.3+0.7·u^2.2 中位
            // 仅约 0.44，半数盘星压在暗端、外盘读成空黑；新式
            // 0.42+0.58·u^1.6 中位约 0.61，盘面整体抬亮但峰值
            // 不变（仍 ≤1.0），中心靠密度梯度保持压倒性。
            // 视觉重构轮再乘径向收束 radK（0.45+0.55·e^(−r/6))：
            // 旧版逐星亮度与半径无关、只有密度在衰减，渲染出
            // 的面亮度梯度被点径/钳制吃平——本轮让单星亮度也
            // 随半径指数衰减，面亮度向核心强收束（Gaia 全天
            // 图的中心压倒性亮度即密度×亮度双梯度）
            const radK = 0.45 + 0.55 * Math.exp(-rKpc / 6);
            const b =
              (bright
                ? 0.85 + 0.3 * rand()
                : 0.42 + 0.58 * Math.pow(rand(), 1.6)) * radK;
            if (set.col)
              putC(set.col, i, jit(tmpC.r * b), jit(tmpC.g * b), jit(tmpC.b * b));
          }
          set.done();
        };
        await fillDisc(bodySet, n - brightN, false);
        await fillDisc(brightSet, brightN, true);
        // —— 盘面连续底光（银河视觉重构轮·画法一）：与星点同
        // 分布（指数盘、双成分 z）的宽肩大点低透明叠绘——星
        // 点是颗粒，这层是把颗粒融成连续光场的几何「底片」
        // （100,000 Stars 后期以照片盘面垫底、Gaia 以密度场
        // 成像的同一原理；本页无贴图/后期通道，用多尺度辉光
        // 点层近似 bloom）。逐点亮度带强径向收束
        // (0.25+0.75·e^(−r/4.2))：内盘成面、外盘渐隐。登记
        // galHazeMats——邻域落定时淡出，不糊太阳近旁
        {
          const hn = isCoarse ? 1500 : 2600;
          const haze = mkPoints(
            hn, 1.6, 0.03, THREE.AdditiveBlending, true, 1,
            galHazeTex, true,
          );
          for (let i = 0; i < hn; i++) {
            if ((i & 2047) === 0) await sl.tick();
            const u = rand();
            const rKpc =
              -3 * Math.log(1 - u * (1 - Math.exp(-15 / 3)));
            const beta = rand() * Math.PI * 2;
            const thick = rand() < 0.16;
            put(
              haze.pos, i,
              rKpc * Math.sin(beta),
              rKpc * Math.cos(beta),
              laplace(thick ? 0.95 * GAL_Z_THICK : 0.3 * GAL_Z_STRETCH),
            );
            tmpC.copy(cIn).lerp(cOut, Math.min(1, rKpc / 13));
            if (thick) tmpC.lerp(cIn, 0.4);
            const b =
              (0.25 + 0.75 * Math.exp(-rKpc / 4.2)) *
              (0.7 + 0.3 * rand());
            if (haze.col)
              putC(haze.col, i, jit(tmpC.r * b), jit(tmpC.g * b), jit(tmpC.b * b));
          }
          haze.done();
        }
        // —— 盘面细尘粒（2026-11-15 晚·粒子加厚轮）：与盘
        // 面主体同分布（指数盘 + 双成分 z ×拉伸）的细粒层
        // （点径 0.05）——盘面颗粒自此三档：主体 0.10 / 亮
        // 点 0.17 / 细尘 0.05，臂间与外盘的空黑被细尘填
        // 实；亮度压在主体之下（(0.30+0.40·u) × radK），
        // 只补质感密度、不动盘面亮度梯度
        {
          const fn = isCoarse ? 3000 : 6000;
          const fine = mkPoints(
            fn, 0.05, 0.5, THREE.AdditiveBlending, true,
          );
          for (let i = 0; i < fn; i++) {
            if ((i & 2047) === 0) await sl.tick();
            const u = rand();
            const rKpc =
              -3 * Math.log(1 - u * (1 - Math.exp(-15 / 3)));
            const beta = rand() * Math.PI * 2;
            const thick = rand() < 0.16;
            put(
              fine.pos, i,
              rKpc * Math.sin(beta),
              rKpc * Math.cos(beta),
              laplace(thick ? 0.95 * GAL_Z_THICK : 0.3 * GAL_Z_STRETCH),
            );
            tmpC.copy(cIn).lerp(cOut, Math.min(1, rKpc / 13));
            if (thick) tmpC.lerp(cIn, 0.4);
            const radK = 0.45 + 0.55 * Math.exp(-rKpc / 6);
            const b = (0.3 + 0.4 * rand()) * radK;
            if (fine.col)
              putC(fine.col, i, jit(tmpC.r * b), jit(tmpC.g * b), jit(tmpC.b * b));
          }
          fine.done();
        }
      }
      // —— 逐臂色板（2026-11-16 色系重做轮，用户判现行色
      // 系「太难看了」）——【废止】旧口径按半径一刀切洗色
      // （气体盘面 gasCol：内暖金→中青蓝→外深蓝；雾团按半
      // 径在青蓝/蓝/暖间走）：青蓝大面积洗与深蓝外圈读着
      // 廉价、且各臂无色彩身份。【新口径】色按臂设计，向
      // M31/M51/M33 天体摄影看齐：七臂同属一个家族——蓝白
      // 年轻星为臂的主光、粉色电离氢只作点缀（hii = 本臂
      // 粉点缀密度倍率）、暖白人口占比 warm 微调臂的年龄
      // 感；臂间与内盘的暖香槟底色由盘面层承担（cIn/cOut
      // 不动）、尘带暖棕剪影不动。臂间差异刻意微妙（同系
      // 内的色温/纯度偏移，不是彩虹臂）：矩尺最深蓝（内
      // 盘大质量年轻星）、船底青蓝偏绿（船底座大星云的
      // 气质）、人马最暖且粉点缀最密（银心方向的丰富星
      // 场）、本地中性蓝白（太阳所在臂）、英仙清亮蓝白、
      // 外臂最淡（稀疏外围）、半人马钢蓝（推断臂另有整臂
      // 压暗）。body = 主体星色、bright = 亮结色（RGB 倍
      // 率，与逐星亮度 b 相乘）；气体盘面/雾团/光带/细尘
      // 各层一律从本表取色，不许新旧两套色混杂
      const ARM_PALETTE: Record<
        string,
        {
          body: [number, number, number];
          bright: [number, number, number];
          warm: number;
          hii: number;
        }
      > = {
        Norma: { body: [0.47, 0.64, 1.0], bright: [0.55, 0.73, 1.0], warm: 0.08, hii: 1.0 },
        Centaurus: { body: [0.52, 0.66, 0.96], bright: [0.6, 0.74, 0.99], warm: 0.1, hii: 0.7 },
        Sagittarius: { body: [0.55, 0.7, 1.0], bright: [0.64, 0.78, 1.0], warm: 0.18, hii: 1.35 },
        Carina: { body: [0.49, 0.72, 1.0], bright: [0.57, 0.8, 1.0], warm: 0.1, hii: 1.2 },
        Local: { body: [0.56, 0.71, 1.0], bright: [0.63, 0.77, 1.0], warm: 0.14, hii: 1.0 },
        Perseus: { body: [0.48, 0.68, 1.0], bright: [0.56, 0.75, 1.0], warm: 0.09, hii: 1.1 },
        Outer: { body: [0.54, 0.69, 0.97], bright: [0.61, 0.75, 0.99], warm: 0.08, hii: 0.8 },
      };
      const armPal = (arm: (typeof GALAXY_ARMS)[number]) =>
        ARM_PALETTE[arm.en] ?? {
          body: [0.52, 0.7, 1.0] as [number, number, number],
          bright: [0.58, 0.75, 1.0] as [number, number, number],
          warm: 0.1,
          hii: 1,
        };
      // —— 旋臂点云：沿式 (2) 中心线采样，径向按论文臂宽高斯散布；
      // 推断段（矩尺外延/船底四象限/半人马全臂）同臂同对象、逐点
      // 压暗 + 降密——与论文图 5 的虚线推断同一诚实口径
      // —— 年轻星团（蓝白大点）与电离氢区（粉红点）单独成层嵌臂上
      const clusterSpec: Array<{ x: number; y: number; z: number }> = [];
      const hiiSpec: Array<{ x: number; y: number; z: number }> = [];
      for (const arm of GALAXY_ARMS) {
        // 分片让行：逐臂查一次时间预算（单臂填充约 4.5 千点，
        // 臂间必有让行机会）
        await sl.tick();
        const pal = armPal(arm);
        // 点数（质感纠正轮·粒子量硬指令）：主段 3,400→4,600
        // （移动 2,000→2,600）、外延 1,100→1,400（移动 650→
        // 800）；推断段 ×0.55 降密口径不变
        const mainN = Math.round(
          (isCoarse ? 2600 : 4600) * (arm.inferred ? 0.55 : 1),
        );
        const extN = arm.extMinDeg != null ? (isCoarse ? 800 : 1400) : 0;
        // 质感分层：拆「主体（多而暗、亮度走陡分布）+ 亮结
        // （主段约 6%、点径近两倍、更亮）」两张点云，打破单
        // 层同径的均匀撒盐感；推断段只进主体层——推断处不
        // 许有亮结（诚实口径）。本轮主体点径 0.09→0.105、不
        // 透明度 0.78→0.85，亮结 0.165→0.19 / 0.9→0.95——
        // 旧帧里臂是「一串稀点」而非光带，点径与密度同补
        const brightN = Math.round(mainN * 0.06);
        const bodySet = mkPoints(
          mainN + extN - brightN, 0.105, 0.85, THREE.AdditiveBlending, true,
        );
        const brightSet = mkPoints(
          brightN, 0.19, 0.95, THREE.AdditiveBlending, true,
        );
        const dim = arm.inferred ? 0.5 : 1;
        const fillInto = (
          set: { pos: Float32Array; col: Float32Array | null },
          from: number,
          count: number,
          bMin: number,
          bMax: number,
          shade: number,
          bright: boolean,
        ): void => {
          for (let k = 0; k < count; k++) {
            const i = from + k;
            const betaDeg = bMin + rand() * (bMax - bMin);
            const c = armPlanPoint(arm, betaDeg);
            const sr = gauss() * arm.widthKpc;
            const rx = c.x / c.r;
            const ry = c.y / c.r;
            // 旋臂竖直散布贴盘面（年轻天体本就贴平面）：逐星
            // 独立 Laplace z、标高 0.06 kpc（年轻盘量级）——有
            // 厚度但不离面，与盘面/厚盘的标高分层拉开
            put(set.pos, i, c.x + rx * sr, c.y + ry * sr, laplace(0.06 * GAL_Z_STRETCH));
            // 臂色（色系重做轮）：逐臂色板 pal——主体/亮结
            // 取本臂蓝白（见 ARM_PALETTE 注，同系内的微妙差
            // 异）；暖白人口占比按臂（pal.warm，人马最暖）；
            // 亮结层另掺约 3.5% 橙红（红超巨星点缀）；逐通
            // 道抖动出近亲色差。主体亮度分布同步
            // 抬中位：0.34+0.66·u^1.8（中位约 0.55）→
            // 0.45+0.55·u^1.5（中位约 0.64）
            const warm = rand() < pal.warm;
            const giant = bright && rand() < 0.035;
            // 径向收束（视觉重构轮，同盘面 radK 口径）：臂的
            // 内段亮、外段渐暗——旧版臂亮度与半径无关，整条
            // 臂一个亮度、读作等亮的珠串；收束后亮度结构与
            // 盘面同向（向核心汇聚），外臂自然退后
            const radK = 0.32 + 0.68 * Math.exp(-c.r / 5.2);
            const b =
              (bright
                ? 0.82 + 0.33 * rand()
                : 0.45 + 0.55 * Math.pow(rand(), 1.5)) *
              shade *
              dim *
              radK;
            if (set.col) {
              if (giant) putC(set.col, i, jit(1.0 * b), jit(0.42 * b), jit(0.22 * b));
              else if (warm) putC(set.col, i, jit(0.92 * b), jit(0.85 * b), jit(0.7 * b));
              else if (bright) putC(set.col, i, jit(pal.bright[0] * b), jit(pal.bright[1] * b), jit(pal.bright[2] * b));
              else putC(set.col, i, jit(pal.body[0] * b), jit(pal.body[1] * b), jit(pal.body[2] * b));
            }
          }
        };
        fillInto(brightSet, 0, brightN, arm.betaMinDeg, arm.betaMaxDeg, 1, true);
        fillInto(bodySet, 0, mainN - brightN, arm.betaMinDeg, arm.betaMaxDeg, 1, false);
        if (arm.extMinDeg != null) {
          fillInto(bodySet, mainN - brightN, extN, arm.extMinDeg, arm.betaMinDeg, 0.42, false);
        }
        bodySet.done();
        brightSet.done();
        // —— 旋臂光带（银河视觉重构轮·画法一，本轮核心）：同
        // 中心线、同臂宽散布的两级宽肩辉光点——带芯级（点径
        // 0.55、低透明）把主体星点的颗粒融成连续带，宽晕级
        // （1.5、更低透明、深一号蓝）给带一条向外缓降的肩；
        // 两级叠绘 + 星点在上 = 多尺度辉光近似 bloom（无后期
        // 通道下的几何做法）。推断段只进带芯级且同主体口径
        // 压暗（shade 0.42、整臂 dim），宽晕不进推断段——推
        // 断处不许有宽光晕（诚实口径同亮结）。逐点亮度带同
        // 式径向收束 radK；登记 galHazeMats，邻域恒隐
        {
          const fillHaze = (
            set: { pos: Float32Array; col: Float32Array | null; done: () => void },
            count: number,
            bMin: number,
            bMax: number,
            shade: number,
            cr: number,
            cg: number,
            cb: number,
            scatterK = 1,
          ): void => {
            for (let k = 0; k < count; k++) {
              const betaDeg = bMin + rand() * (bMax - bMin);
              const c = armPlanPoint(arm, betaDeg);
              const sr = gauss() * arm.widthKpc * scatterK;
              put(
                set.pos, k,
                c.x + (c.x / c.r) * sr,
                c.y + (c.y / c.r) * sr,
                laplace(0.06 * GAL_Z_STRETCH),
              );
              const radK = 0.32 + 0.68 * Math.exp(-c.r / 5.2);
              const b = (0.45 + 0.55 * rand()) * shade * dim * radK;
              if (set.col)
                putC(set.col, k, jit(cr * b), jit(cg * b), jit(cb * b));
            }
          };
          const core1 = mkPoints(
            Math.round((isCoarse ? 300 : 520) * (arm.inferred ? 0.55 : 1)) +
              (arm.extMinDeg != null ? (isCoarse ? 170 : 300) : 0),
            0.55, 0.16, THREE.AdditiveBlending, true, 1,
            galGlowTex, true,
          );
          const mainHazeN = Math.round(
            (isCoarse ? 300 : 520) * (arm.inferred ? 0.55 : 1),
          );
          fillHaze(core1, mainHazeN, arm.betaMinDeg, arm.betaMaxDeg, 1, pal.body[0], pal.body[1], pal.body[2]);
          if (arm.extMinDeg != null) {
            // 推断段续填同一层（索引接主体之后）：fillHaze 自
            // 0 写起不适用，手动同式填尾段
            const extHN = isCoarse ? 170 : 300;
            for (let k = 0; k < extHN; k++) {
              const i = mainHazeN + k;
              const betaDeg =
                arm.extMinDeg + rand() * (arm.betaMinDeg - arm.extMinDeg);
              const c = armPlanPoint(arm, betaDeg);
              const sr = gauss() * arm.widthKpc;
              put(
                core1.pos, i,
                c.x + (c.x / c.r) * sr,
                c.y + (c.y / c.r) * sr,
                laplace(0.06 * GAL_Z_STRETCH),
              );
              const radK = 0.32 + 0.68 * Math.exp(-c.r / 5.2);
              const b = (0.45 + 0.55 * rand()) * 0.42 * dim * radK;
              if (core1.col)
                putC(core1.col, i, jit(pal.body[0] * b), jit(pal.body[1] * b), jit(pal.body[2] * b));
            }
          }
          core1.done();
          if (!arm.inferred) {
            const halo2 = mkPoints(
              isCoarse ? 80 : 140, 1.5, 0.05, THREE.AdditiveBlending,
              true, 1, galHazeTex, true,
            );
            fillHaze(
              halo2, isCoarse ? 80 : 140,
              arm.betaMinDeg, arm.betaMaxDeg, 1,
              pal.body[0] * 0.82, pal.body[1] * 0.85, pal.body[2] * 0.98,
            );
            halo2.done();
          }
          // —— 臂脊亮芯 + 辉光裙（2026-11-15 晚·臂立体轮，
          // 与 z 拉伸同轮）：体积感的光层分工再加两级——脊
          // 芯级贴中心线窄散布（臂宽 ×0.38）、点径 0.30、
          // 亮蓝白，把臂读出一条有脊的亮带芯；裙级散布
          // ×1.9 溢出臂宽两侧、点径 2.6、极低透明深蓝，是
          // 臂向两侧漫开的辉光裙。明暗层次自此为：脊芯
          // （最亮）→ 带芯 → 星点颗粒 → 宽晕 → 裙（最
          // 暗），尘带暗幕仍以 order=1 压在全部光层之后
          // （遮挡关系不变）。脊芯随带芯同规：推断段 ×0.55
          // 降密压暗、外延段不进（亮芯不许出现在推断/外延
          // 处，同亮结诚实口径）；裙只进非推断段（同宽晕）
          const ridge = mkPoints(
            Math.round((isCoarse ? 240 : 420) * (arm.inferred ? 0.55 : 1)),
            0.3, 0.2, THREE.AdditiveBlending, true, 1,
            galGlowTex, true,
          );
          fillHaze(
            ridge,
            Math.round((isCoarse ? 240 : 420) * (arm.inferred ? 0.55 : 1)),
            arm.betaMinDeg, arm.betaMaxDeg, 1,
            Math.min(1, pal.bright[0] + 0.06), Math.min(1, pal.bright[1] + 0.04), pal.bright[2],
            0.38,
          );
          ridge.done();
          if (!arm.inferred) {
            const skirt = mkPoints(
              isCoarse ? 60 : 110, 2.6, 0.028, THREE.AdditiveBlending,
              true, 1, galHazeTex, true,
            );
            fillHaze(
              skirt, isCoarse ? 60 : 110,
              arm.betaMinDeg, arm.betaMaxDeg, 1,
              pal.body[0] * 0.72, pal.body[1] * 0.74, pal.body[2] * 0.93, 1.9,
            );
            skirt.done();
          }
        }
        // —— 臂上细尘粒（2026-11-15 晚·粒子加厚轮）：臂宽
        // ×1.15 散布的细小颗粒层（点径 0.05、半透明）——在
        // 亮星点与辉光点之间补一档「尘粒」粒度，臂面读出
        // 沙粒质感而非只有大点小点两档；色以淡蓝白为主、
        // 约 15% 暖尘色；亮度压暗（0.30–0.62 × radK），只
        // 作质感填充不抢亮结。呼吸/闪烁差异由 mkPoints 的
        // 逐星相位属性自带，与其余层不同步
        {
          const fn = isCoarse ? 800 : 1500;
          const fine = mkPoints(
            fn, 0.05, 0.5, THREE.AdditiveBlending, true,
          );
          for (let k = 0; k < fn; k++) {
            const betaDeg =
              arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
            const c = armPlanPoint(arm, betaDeg);
            const sr = gauss() * arm.widthKpc * 1.15;
            put(
              fine.pos, k,
              c.x + (c.x / c.r) * sr,
              c.y + (c.y / c.r) * sr,
              laplace(0.06 * GAL_Z_STRETCH),
            );
            const radK = 0.32 + 0.68 * Math.exp(-c.r / 5.2);
            const b = (0.3 + 0.32 * rand()) * dim * radK;
            if (fine.col) {
              if (rand() < 0.15)
                putC(fine.col, k, jit(0.9 * b), jit(0.8 * b), jit(0.62 * b));
              else
                putC(fine.col, k, jit(Math.min(1, pal.body[0] * 1.06) * b), jit(Math.min(1, pal.body[1] * 1.04) * b), jit(pal.body[2] * b));
            }
          }
          fine.done();
        }
        const nCl = isCoarse ? 80 : 140;
        for (let k = 0; k < nCl; k++) {
          const betaDeg =
            arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
          const c = armPlanPoint(arm, betaDeg);
          const sr = gauss() * arm.widthKpc * 0.55;
          clusterSpec.push({
            x: c.x + (c.x / c.r) * sr,
            y: c.y + (c.y / c.r) * sr,
            z: laplace(0.05 * GAL_Z_STRETCH),
          });
        }
        // HII 粉点缀密度按臂（色系重做轮）：人马最密、半
        // 人马最疏——粉只作点缀、量级由 pal.hii 限定
        const nHii = Math.round((isCoarse ? 36 : 64) * pal.hii);
        for (let k = 0; k < nHii; k++) {
          const betaDeg =
            arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
          const c = armPlanPoint(arm, betaDeg);
          const sr = gauss() * arm.widthKpc * 0.35;
          hiiSpec.push({
            x: c.x + (c.x / c.r) * sr,
            y: c.y + (c.y / c.r) * sr,
            z: laplace(0.045 * GAL_Z_STRETCH),
          });
        }
      }
      {
        const { pos, col, done } = mkPoints(
          clusterSpec.length, 0.24, 0.95, THREE.AdditiveBlending, true,
        );
        clusterSpec.forEach((s, i) => {
          put(pos, i, s.x, s.y, s.z);
          const b = 0.5 + 0.5 * Math.pow(rand(), 1.5);
          if (col) {
            if (rand() < 0.22) putC(col, i, jit(b), jit(b), jit(b));
            else putC(col, i, jit(0.78 * b), jit(0.87 * b), jit(1.0 * b));
          }
        });
        done();
      }
      {
        // HII 区是电离气体不是恒星：呼吸总闸压到 0.4，只留
        // 极轻微的明暗起伏，不与星点同闪。质感纠正轮：点径
        // 0.16→0.19、不透明度 0.85→0.92，品红加深（市面参
        // 考里 H II 区是旋臂上明确的品红点缀，旧值偏粉白、
        // 帧里几乎读不出）
        const { pos, col, done } = mkPoints(
          hiiSpec.length, 0.19, 0.92, THREE.AdditiveBlending, true, 0.4,
        );
        hiiSpec.forEach((s, i) => {
          put(pos, i, s.x, s.y, s.z);
          const b = 0.6 + 0.4 * Math.pow(rand(), 1.4);
          // 色相轻微游走：多数玫红、约四分之一偏紫红，免整层一色
          if (col) {
            if (rand() < 0.25) putC(col, i, 1.0 * b, 0.36 * b, 0.68 * b);
            else putC(col, i, 1.0 * b, 0.46 * b, 0.6 * b);
          }
        });
        done();
      }
      // ════════════════════════════════════════════════════
      // —— 银河美术语言重构（2026-11-15 晚·招牌轮，元灿：
      // 「银河系特效全开吧，最好完全重做……这几版都是同样
      // 的美术风格」）——
      // 【旧语言诊断】自初版到上轮重构，银河的成像单元始终
      // 是「点」：星点、辉光点、尘点——密度与辉光叠层只是把
      // 点阵加密加软，缩略图下仍读作黑底撒彩色点（星表/粒
      // 子图语言）。真实星系摄影（M31/M33）与 SpaceEngine/
      // 电影级星云渲染的成像单元是「介质」：连续的气尘光
      // 场——亮度长在雾里、尘埃以剪影压在光上、亮星只是介
      // 质表面稀疏的针尖。
      // 【新语言】「气体介质 + 尘埃剪影 + 针尖亮星」三层成
      // 像：① 程序绘制的气体盘面（沿 Xu 臂形逐段上色/多遍
      // 描绘 + fbm 噪蚀团块感，三张同纹理盘面以 ±1.7 kpc
      // 纵深错层出视差）作连续光场本体；② 不规则雾团辉光
      // （fbm alpha 贴图的巨型软点两级）沿臂铺设，让光带
      // 呈云团状起伏而非均匀描边；③ 尘埃剪影（同雾团贴
      // 图、正常混合近黑大点）沿臂内缘压暗——吸收第一次
      // 有「面」而不只是点列；④ 衍射耀斑亮星（十字耀斑贴
      // 图）在亮星位稀疏点缀。既有点云层全数保留、退作介
      // 质之上的星光颗粒与呼吸层；银心在新语言里由盘面中
      // 心的暖金雾团 + 压低后的核芯辉光共同承担（环融进
      // 光场，见弱化银心各注）。新层全登记 galHazeMats：
      // 只属全览读法，邻域（校准层）恒隐、不沾真实星位。
      // ════════════════════════════════════════════════════
      // 雾团 alpha 贴图：多团高斯叠出的不规则云形（fbm 的
      // 廉价近似——径向渐变团块错位叠加，边缘参差）
      const galPuffTex = (() => {
        const S = 256;
        const c = document.createElement("canvas");
        c.width = S;
        c.height = S;
        const g = c.getContext("2d")!;
        g.globalCompositeOperation = "lighter";
        const blob = (x: number, y: number, r: number, a: number) => {
          const gr = g.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, `rgba(255,255,255,${a})`);
          gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.45})`);
          gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr;
          g.fillRect(x - r, y - r, r * 2, r * 2);
        };
        blob(128, 128, 120, 0.5);
        blob(88, 104, 74, 0.42);
        blob(172, 96, 66, 0.4);
        blob(104, 164, 70, 0.38);
        blob(160, 158, 78, 0.36);
        blob(128, 84, 52, 0.3);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();
      // ① 气体盘面：2048 画布（移动 1024）逐像素外的矢量
      // 描绘——臂形来自 armPlanPoint 采样折线（与点云同
      // 源），多遍描绘（宽晕/带体/亮芯）+ 径向色温（内暖
      // 金→中青蓝→外深蓝）+ 团块噪蚀（destination-out 随
      // 机软团反复擦出气孔）+ HII 粉点缀。映射口径：画布
      // ±16.5 kpc 对平面 ±8.25 wu，px = (0.5 + kx/33)·W、
      // py = (0.5 − ky/33)·H（平面几何 rotateX(−90°) 后
      // 的 UV 对位，见三层错层处注）
      const galGasTex = (() => {
        const S = isCoarse ? 1024 : 2048;
        const c = document.createElement("canvas");
        c.width = S;
        c.height = S;
        const g = c.getContext("2d")!;
        const px = (kx: number) => (0.5 + kx / 33) * S;
        const py = (ky: number) => (0.5 - ky / 33) * S;
        const k2p = S / 33; // px / kpc
        // 底洗：整盘极淡暖香槟径向雾（外盘不死黑；色系重
        // 做轮：旧蓝灰→深蓝的径向洗一并废止，底色归暖中性、
        // 蓝只许出现在臂上）
        {
          const gr = g.createRadialGradient(
            S / 2, S / 2, 0, S / 2, S / 2, S * 0.5,
          );
          gr.addColorStop(0, "rgba(170,150,112,0.20)");
          gr.addColorStop(0.35, "rgba(146,132,108,0.10)");
          gr.addColorStop(0.75, "rgba(112,106,98,0.045)");
          gr.addColorStop(1, "rgba(90,88,86,0)");
          g.fillStyle = gr;
          g.fillRect(0, 0, S, S);
        }
        // 臂体三遍描绘：同一折线、宽→窄/淡→浓（色系重做
        // 轮：颜色逐臂取自 ARM_PALETTE——宽晕 = 本臂主体色
        // 压深、带体 = 主体色、亮芯 = 亮结色向白靠 25%；
        // 旧 gasCol 按半径内金→中青蓝→外深蓝的一刀切洗色
        // 整条废止，半径不再决定臂色）
        const armStroke = (
          widthKpc: number,
          alpha: number,
          colFn: (arm: (typeof GALAXY_ARMS)[number]) => string,
        ) => {
          for (const arm of GALAXY_ARMS) {
            const dimA = arm.inferred ? 0.5 : 1;
            g.lineCap = "round";
            g.lineJoin = "round";
            let prev: { x: number; y: number; r: number } | null = null;
            const seg = (
              b0: number, b1: number, shade: number,
            ) => {
              prev = null;
              for (let bd = b0; bd <= b1; bd += 2.5) {
                const pt = armPlanPoint(arm, bd);
                if (prev) {
                  g.strokeStyle = colFn(arm);
                  g.globalAlpha = alpha * dimA * shade;
                  g.lineWidth = Math.max(1.5, widthKpc * k2p);
                  g.beginPath();
                  g.moveTo(px(prev.x), py(prev.y));
                  g.lineTo(px(pt.x), py(pt.y));
                  g.stroke();
                }
                prev = pt;
              }
            };
            seg(arm.betaMinDeg, arm.betaMaxDeg, 1);
            if (arm.extMinDeg != null) {
              seg(arm.extMinDeg, arm.betaMinDeg, 0.42);
            }
          }
          g.globalAlpha = 1;
        };
        const gasCss = (
          c: [number, number, number],
          kr: number,
          kg: number,
          kb: number,
        ): string =>
          `rgba(${Math.round(Math.min(1, c[0] * kr) * 255)},${Math.round(Math.min(1, c[1] * kg) * 255)},${Math.round(Math.min(1, c[2] * kb) * 255)},1)`;
        armStroke(2.6, 0.05, (arm) =>
          gasCss(armPal(arm).body, 0.52, 0.55, 0.62),
        );
        armStroke(1.15, 0.1, (arm) =>
          gasCss(armPal(arm).body, 0.85, 0.87, 0.92),
        );
        armStroke(0.42, 0.16, (arm) => {
          const br = armPal(arm).bright;
          return gasCss(
            [
              br[0] + (1 - br[0]) * 0.25,
              br[1] + (1 - br[1]) * 0.25,
              br[2] + (1 - br[2]) * 0.25,
            ],
            1,
            1,
            1,
          );
        });
        // 中心暖金雾团：核球在介质层的本体（与核芯辉光同
        // 源同色，环坐其上——弱化银心在新语言里的落点）
        {
          const gr = g.createRadialGradient(
            S / 2, S / 2, 0, S / 2, S / 2, 4.6 * k2p,
          );
          gr.addColorStop(0, "rgba(255,205,130,0.55)");
          gr.addColorStop(0.4, "rgba(240,180,105,0.28)");
          gr.addColorStop(1, "rgba(230,160,90,0)");
          g.fillStyle = gr;
          g.fillRect(0, 0, S, S);
        }
        // 团块噪蚀：随机软团以 destination-out 擦出气孔与
        // 参差边缘（介质的「团块感」来源，两档尺度）
        {
          g.globalCompositeOperation = "destination-out";
          for (let i = 0; i < 260; i++) {
            const a = rand() * Math.PI * 2;
            const rr = Math.pow(rand(), 0.6) * 15.5;
            const x = S / 2 + Math.cos(a) * rr * k2p;
            const y = S / 2 + Math.sin(a) * rr * k2p;
            const rad = (0.5 + rand() * 1.7) * k2p;
            const gr = g.createRadialGradient(x, y, 0, x, y, rad);
            const al = 0.05 + rand() * 0.13;
            gr.addColorStop(0, `rgba(0,0,0,${al})`);
            gr.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = gr;
            g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
          }
          for (let i = 0; i < 700; i++) {
            const a = rand() * Math.PI * 2;
            const rr = Math.pow(rand(), 0.7) * 15.5;
            const x = S / 2 + Math.cos(a) * rr * k2p;
            const y = S / 2 + Math.sin(a) * rr * k2p;
            const rad = (0.12 + rand() * 0.5) * k2p;
            const gr = g.createRadialGradient(x, y, 0, x, y, rad);
            const al = 0.06 + rand() * 0.16;
            gr.addColorStop(0, `rgba(0,0,0,${al})`);
            gr.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = gr;
            g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
          }
          g.globalCompositeOperation = "source-over";
        }
        // HII 粉点缀：沿臂随机小软点（玫红，与点云 HII 层
        // 同色系），只在介质层作色斑
        for (const arm of GALAXY_ARMS) {
          if (arm.inferred) continue;
          const nP = isCoarse ? 26 : 44;
          for (let i = 0; i < nP; i++) {
            const bd =
              arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
            const pt = armPlanPoint(arm, bd);
            const sr = gauss() * arm.widthKpc * 0.4;
            const kx = pt.x + (pt.x / pt.r) * sr;
            const ky = pt.y + (pt.y / pt.r) * sr;
            const rad = (0.14 + rand() * 0.3) * k2p;
            const gr = g.createRadialGradient(
              px(kx), py(ky), 0, px(kx), py(ky), rad,
            );
            gr.addColorStop(0, "rgba(255,120,165,0.20)");
            gr.addColorStop(1, "rgba(255,120,165,0)");
            g.fillStyle = gr;
            g.fillRect(px(kx) - rad, py(ky) - rad, rad * 2, rad * 2);
          }
        }
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();
      // 三层错层盘面：同纹理、纵深 y = 0 / ±0.85 wu（=
      // ±1.7 kpc）——旋转/改倾角时三层视差错动，平面读作
      // 有厚度的气体层而非一张贴图；中层最浓、上下层淡
      // （纵深里的介质渐隐）。几何 rotateX(−π/2)：顶点
      // (x, y) → 场景 (x, 0, −y)，纹理 UV 随之与画布映射
      // 对位（见 galGasTex 头注）
      {
        const gasGeo = new THREE.PlaneGeometry(16.5, 16.5);
        gasGeo.rotateX(-Math.PI / 2);
        const gasLayers: Array<[number, number]> = [
          [0, 0.5],
          [0.85, 0.26],
          [-0.85, 0.26],
        ];
        for (const [gy, gop] of gasLayers) {
          const m = new THREE.MeshBasicMaterial({
            map: galGasTex,
            transparent: true,
            opacity: gop,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(gasGeo, m);
          mesh.position.y = gy;
          mesh.renderOrder = 0;
          mesh.frustumCulled = false;
          galaxySpin.add(mesh);
          galHazeMats.push({ mat: m, base: gop });
        }
      }
      // ② 雾团辉光两级（巨型软点、雾团贴图）：沿臂采样、
      // 散布比星点宽（臂宽 ×1.3），色随半径在青蓝/蓝/暖
      // 间走、约 8% 玫红（气体辉光的色温纵深）；大级
      // （3.2 wu）极淡成云底、小级（1.6 wu）成云团亮斑。
      // z 抽拉得更厚（Laplace 0.5 kpc 等效，未拉伸口径
      // 0.1）——雾在纵深里成层，改倾角时云层视差可读
      for (const arm of GALAXY_ARMS) {
        const puffDim = arm.inferred ? 0.5 : 1;
        const fillPuffs = (
          set: { pos: Float32Array; col: Float32Array | null; done: () => void },
          count: number,
        ): void => {
          for (let k = 0; k < count; k++) {
            const betaDeg =
              arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
            const c = armPlanPoint(arm, betaDeg);
            const sr = gauss() * arm.widthKpc * 1.3;
            put(
              set.pos, k,
              c.x + (c.x / c.r) * sr,
              c.y + (c.y / c.r) * sr,
              laplace(0.5),
            );
            const radK = 0.32 + 0.68 * Math.exp(-c.r / 5.2);
            const b = (0.5 + 0.5 * rand()) * puffDim * radK;
            if (set.col) {
              // 色系重做轮：雾团随本臂色板——主体 = pal.body；
              // 内盘段（r<4）向暖香槟掺一半（内盘老星底色从
              // 臂根透出来）；粉点缀占比按臂 pal.hii（旧口径
              // 按半径在青蓝/蓝间洗色废止）
              const pal = armPal(arm);
              const pick = rand();
              if (pick < 0.08 * pal.hii)
                putC(set.col, k, jit(0.85 * b), jit(0.45 * b), jit(0.6 * b));
              else if (c.r < 4)
                putC(
                  set.col, k,
                  jit((pal.body[0] * 0.5 + 0.48) * b),
                  jit((pal.body[1] * 0.5 + 0.39) * b),
                  jit((pal.body[2] * 0.5 + 0.26) * b),
                );
              else
                putC(set.col, k, jit(pal.body[0] * b), jit(pal.body[1] * b), jit(pal.body[2] * b));
            }
          }
        };
        const puffA = mkPoints(
          isCoarse ? 170 : 300, 1.6, 0.055, THREE.AdditiveBlending,
          true, 1, galPuffTex, true,
        );
        fillPuffs(puffA, isCoarse ? 170 : 300);
        puffA.done();
        if (!arm.inferred) {
          const puffB = mkPoints(
            isCoarse ? 70 : 120, 3.2, 0.032, THREE.AdditiveBlending,
            true, 1, galPuffTex, true,
          );
          fillPuffs(puffB, isCoarse ? 70 : 120);
          puffB.done();
        }
      }
      // ③ 尘埃剪影（雾团贴图、正常混合、近黑暖褐）：沿臂
      // 内缘（与尘点同采样线）的大幅软吸收——尘带第一次
      // 以「面」压光：宽 1.4 wu 的云团剪影错落叠在内缘，
      // 与点尘层（缝芯）+ 暗幕（缝肩）构成三级吸收。绘制
      // 序 1（压在一切加色层之后，同尘带纪律）；不呼吸
      {
        const silN = isCoarse ? 110 : 200;
        const sil = mkPoints(
          silN, 1.4, 0.1, THREE.NormalBlending, false, 0,
          galPuffTex, true, 1,
        );
        (sil.mat.uniforms.uColor!.value as THREE.Color).set("#0d0603");
        for (let si = 0; si < silN; si++) {
          const arm = GALAXY_ARMS[si % GALAXY_ARMS.length]!;
          const betaDeg =
            arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
          const c = armPlanPoint(arm, betaDeg);
          const inward =
            arm.widthKpc * 0.8 + 0.1 + gauss() * arm.widthKpc * 0.5;
          put(
            sil.pos, si,
            c.x - (c.x / c.r) * inward,
            c.y - (c.y / c.r) * inward,
            laplace(0.04 * GAL_Z_STRETCH),
          );
        }
        sil.done();
      }
      // ④ 衍射耀斑亮星：十字耀斑贴图（细长十字 + 核心辉
      // 光，画布逐像素 alpha）——天体摄影里亮星的签名；
      // 沿臂亮星位稀疏点缀（采样同星团口径、散布更紧），
      // 白/蓝白两色，呼吸压低（0.7）免与星点同闪
      const galSpikeTex = (() => {
        const S = 128;
        const c = document.createElement("canvas");
        c.width = S;
        c.height = S;
        const g = c.getContext("2d")!;
        const img = g.createImageData(S, S);
        const d = img.data;
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const dx = (x - S / 2 + 0.5) / (S / 2);
            const dy = (y - S / 2 + 0.5) / (S / 2);
            const r = Math.hypot(dx, dy);
            const core = Math.exp(-r * r * 18);
            const spike =
              Math.exp(-Math.abs(dy) * 26) * Math.exp(-Math.abs(dx) * 3.2) +
              Math.exp(-Math.abs(dx) * 26) * Math.exp(-Math.abs(dy) * 3.2);
            const a = Math.min(1, core + spike * 0.55);
            const idx = (y * S + x) * 4;
            d[idx] = 255;
            d[idx + 1] = 255;
            d[idx + 2] = 255;
            d[idx + 3] = a * 255;
          }
        }
        g.putImageData(img, 0, 0);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return tex;
      })();
      {
        const spN = isCoarse ? 70 : 130;
        const spikes = mkPoints(
          spN, 0.55, 0.5, THREE.AdditiveBlending, true, 0.7,
          galSpikeTex,
        );
        for (let k = 0; k < spN; k++) {
          const arm = GALAXY_ARMS[k % GALAXY_ARMS.length]!;
          const betaDeg =
            arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
          const c = armPlanPoint(arm, betaDeg);
          const sr = gauss() * arm.widthKpc * 0.4;
          put(
            spikes.pos, k,
            c.x + (c.x / c.r) * sr,
            c.y + (c.y / c.r) * sr,
            laplace(0.05 * GAL_Z_STRETCH),
          );
          const b = 0.55 + 0.45 * rand();
          if (spikes.col) {
            if (rand() < 0.3)
              putC(spikes.col, k, jit(b), jit(b), jit(b));
            else
              putC(spikes.col, k, jit(0.78 * b), jit(0.87 * b), jit(1.0 * b));
          }
        }
        spikes.done();
      }
      // —— 尘埃带：沿每条臂内侧（朝银心一侧偏 臂宽×0.8+0.1 kpc）
      // 的暗红棕点，正常混合压暗盘面——旋臂内侧勾边出自此层。
      // 几何沿既有 Xu 旋臂的臂内缘塑形（示意层，不另编数据）。
      // 质感纠正轮（市面参考简报：「尘带是质感的命根子，没
      // 有尘带就是 CD」；Gaia 全天图的暗尘裂缝）：点数 620→
      // 950/臂（移动 380→560），点径 0.14→0.17、不透明度
      // 0.36→0.42，色由近黑 #1c0f0a 改暖棕 #2a1409——旧值
      // 太淡太稀，近平行视角下带中劈缝读不出来；本轮让暗
      // 带在亮臂内侧成连续的吸收带。【此段参数已被下方视觉
      // 重构轮取代：点径/透明度/色/绘制序与暗幕层见循环内注】
      for (const arm of GALAXY_ARMS) {
        const n = isCoarse ? 560 : 950;
        // 视觉重构轮（画法三·尘带真暗缝）：采样口径（沿臂内
        // 缘偏移 臂宽×0.8+0.1、散布 臂宽×0.42、点数）一字不
        // 动，只改落笔——点径 0.17→0.36、透明度 0.42→0.50、
        // 色 #2a1409→近黑暖棕 #160a05、绘制序 order=1 恒在
        // 一切加色层之后。旧版三重弱：点太小（全览帧里约
        // 5–11 px 的软点列）、色不够黑、且核球/星晕/辉光精
        // 灵登记在它之后又把内臂的缝冲亮；Gaia 全天图的暗
        // 尘缝靠「亮带够亮 + 吸收够黑够宽」对比成立，本轮
        // 亮带由光带层补足、吸收由本层 + 下方暗幕补足
        // 尘带不呼吸（breatheAmp=0）、颜色走着色器 uColor
        const { pos, done, mat: dustMat } = mkPoints(
          n, 0.36, 0.5, THREE.NormalBlending, false, 0,
          null, false, 1,
        );
        (dustMat.uniforms.uColor!.value as THREE.Color).set("#160a05");
        for (let i = 0; i < n; i++) {
          const betaDeg =
            arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
          const c = armPlanPoint(arm, betaDeg);
          const inward = arm.widthKpc * 0.8 + 0.1 + gauss() * arm.widthKpc * 0.42;
          put(
            pos, i,
            c.x - (c.x / c.r) * inward,
            c.y - (c.y / c.r) * inward,
            laplace(0.04 * GAL_Z_STRETCH),
          );
        }
        done();
        // —— 尘带暗幕（同轮新增）：与主层同一条内缘线的宽肩
        // 大点（0.85、极低透明、近黑）——主层是缝的芯，这层
        // 是缝向两侧缓降的肩，让暗缝在手机全览尺度下有足够
        // 宽度读成「带中劈开的吸收带」而非一串暗点；同为
        // order=1 落笔在加色层之后。登记 galHazeMats：只属
        // 全览读法，邻域淡出（主层沿旧制留在邻域，点小而
        // 疏、是既有行为）
        {
          const vn = isCoarse ? 220 : 380;
          const veil = mkPoints(
            vn, 0.85, 0.055, THREE.NormalBlending, false, 0,
            galHazeTex, true, 1,
          );
          (veil.mat.uniforms.uColor!.value as THREE.Color).set("#100704");
          for (let i = 0; i < vn; i++) {
            const betaDeg =
              arm.betaMinDeg + rand() * (arm.betaMaxDeg - arm.betaMinDeg);
            const c = armPlanPoint(arm, betaDeg);
            const inward =
              arm.widthKpc * 0.8 + 0.1 + gauss() * arm.widthKpc * 0.42;
            put(
              veil.pos, i,
              c.x - (c.x / c.r) * inward,
              c.y - (c.y / c.r) * inward,
              laplace(0.04 * GAL_Z_STRETCH),
            );
          }
          veil.done();
        }
      }
      // —— 中央棒 + 核球：棒半长 3.1 kpc（论文 §4.3 引 Hilmi+2020），
      // 暖金点云；核球近球状压扁。二者皆老恒星色，与盘面蓝白分层
      {
        // 点数 6,200→7,400（移动 3,800→4,600）、点径 0.095→
        // 0.105、不透明度 0.85→0.9（质感纠正轮：近平行视角
        // 下中央隆起是三读数之一，核球须成穹不成斑）
        const n = isCoarse ? 4600 : 7400;
        const { pos, col, done } = mkPoints(
          n, 0.105, 0.9, THREE.AdditiveBlending, true,
        );
        const aRad = (GAL_BAR_ANGLE_DEG * Math.PI) / 180;
        const ax = Math.sin(aRad);
        const ay = Math.cos(aRad);
        for (let i = 0; i < n; i++) {
          let x: number;
          let y: number;
          let z: number;
          if (i % 2 === 0) {
            const t = rand() * 2 - 1;
            const along = t * GAL_BAR_HALF_KPC;
            const across = gauss() * 0.5 * (1 - Math.abs(t) * 0.35);
            x = ax * along + ay * across;
            y = ay * along - ax * across;
            // z 拉伸（同轮）：棒/核球只乘 ×2（0.3→0.6 /
            // 0.5→1.0）——核球本近球形，全额 ×5 会拉成竖直
            // 纺锤、反噬弱化银心轮的收束；×2 后核球 z 标高
            // 1.0 与 x/y 0.95 近等，读作饱满球体
            z = gauss() * 0.3 * 2;
          } else {
            x = gauss() * 0.95;
            y = gauss() * 0.95;
            z = gauss() * 0.5 * 2;
          }
          put(pos, i, x, y, z);
          const b = 0.42 + 0.58 * Math.pow(rand(), 1.4);
          // 核球/棒是老星族：黄白金橙打底（0.76/0.40，市面参
          // 考的暖核口径，与旋臂蓝拉开成一眼可分的金核）、
          // 逐星抖动，约 4% 橙红巨星
          if (col) {
            if (rand() < 0.04)
              putC(col, i, jit(1.0 * b), jit(0.42 * b), jit(0.2 * b));
            else putC(col, i, jit(1.0 * b), jit(0.76 * b), jit(0.4 * b));
          }
        }
        done();
      }
      // —— 恒星晕（立体重构轮新分布）：球状幂律（体积密度约
      // ∝ r^−3.5、壳层采样 ∝ r^−1.5 的逆 CDF）、半径 3–50 kpc、
      // 轻微压扁 q≈0.8、老星族金橙色压得极淡——它的职责是让点
      // 飘在盘面上方下方几万光年处，眼睛立刻读出「球里装着
      // 盘」；参数为发表量级的总体示意（DATA-PLAN 有注）。旧
      // 版均匀球壳 2.5–15 kpc 蓝点层就此退役
      {
        // 点数 1,600→2,000（移动 900→1,100）、不透明度 0.26→
        // 0.3（质感纠正轮：近平行视角下厚盘晕是中央隆起剪影
        // 的一部分，旧值太淡、盘上下读不出晕）
        const n = isCoarse ? 1100 : 2000;
        const { pos, col, done } = mkPoints(
          n, 0.07, 0.3, THREE.AdditiveBlending, true, 0.7,
        );
        const rMin = 3;
        const rMax = 50;
        const sMin = Math.pow(rMin, -0.5);
        const sMax = Math.pow(rMax, -0.5);
        for (let i = 0; i < n; i++) {
          const th = rand() * Math.PI * 2;
          const ph = Math.acos(rand() * 2 - 1);
          const rr = Math.pow(sMin + rand() * (sMax - sMin), -2);
          put(
            pos, i,
            rr * Math.sin(ph) * Math.sin(th),
            rr * Math.sin(ph) * Math.cos(th),
            rr * Math.cos(ph) * 0.8,
          );
          const b = 0.25 + 0.55 * Math.pow(rand(), 2);
          if (col)
            putC(col, i, jit(0.85 * b), jit(0.66 * b), jit(0.42 * b));
        }
        done();
      }
      // —— 球状星团群（立体重构轮新增）：约 150 个略大的暖白
      // 点（与银河系真实球状星团总数同量级——Harris 星表约
      // 157 个）、球状分布向银心集中（r = 0.6 + 28·u^2.4
      // kpc、轻微压扁 0.85）。这是总体级示意——画的是「有这
      // 么一群、这么分布」，不是逐个真实星团的星表（DATA-
      // PLAN 明示）
      {
        const n = 150;
        const { pos, col, done } = mkPoints(
          n, 0.3, 0.85, THREE.AdditiveBlending, true, 0.5,
        );
        for (let i = 0; i < n; i++) {
          const th = rand() * Math.PI * 2;
          const ph = Math.acos(rand() * 2 - 1);
          const rr = 0.6 + 28 * Math.pow(rand(), 2.4);
          put(
            pos, i,
            rr * Math.sin(ph) * Math.sin(th),
            rr * Math.sin(ph) * Math.cos(th),
            rr * Math.cos(ph) * 0.85,
          );
          const b = 0.55 + 0.45 * rand();
          if (col)
            putC(col, i, jit(1.0 * b), jit(0.93 * b), jit(0.8 * b));
        }
        done();
      }
      // —— 盘面底光贴图层已下线（立体重构轮审计项，用户问
      // 「那个只是一张贴图而已」）：旧版有一张躺在盘面内的径
      // 向渐变圆盘网格冒充盘面体积——本轮整层删除，盘面轮廓
      // 改由盘面点云自身的体积（点数调剂 + 主体不透明度补
      // 偿，见盘面段）承担；中心辉光三件（核芯/中层/盘面大
      // 晕）是精灵辉光、与太阳日冕同族的氛围提亮，不是平面
      // 贴图，保留
      await sl.tick();
      // —— 中心辉光（暖金核球晕 + 盘面冷蓝大晕）：纯氛围提亮，
      // 加色混合、深度不写入；尺度是世界量级、不随近览锚点同步
      const coreGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeGlowTexture(
            "rgba(255,201,120,0.9)",
            "rgba(255,160,80,0.35)",
          ),
          color: 0xffc978,
          transparent: true,
          opacity: 0.58,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      // 质感纠正轮：核芯晕 0.5→0.58、尺度 3.3→3.6——SpaceEngine
      // 式「尘埃向中心渐变为核球的黄色雾」，中心黄雾是近平行
      // 视角下隆起读数的一半。视觉重构轮（画法四·核心融合）：
      // 再收紧到 3.4 并抬到 0.72——核心亮度收束的顶点由这层
      // 与核球点云共同承担，EHT 环背光垫（见下）同源于此。
      // 弱化银心轮（2026-11-15 晚）：顶点过抢——尺度 3.4→
      // 3.0（收束更紧）、峰值 0.72→0.58，中心回到「盘面自
      // 然变亮的顶点」而非一团独立亮斑
      coreGlow.scale.set(3.0, 3.0, 1);
      galaxySpin.add(coreGlow);
      galFadeMats.push({ mat: coreGlow.material, base: 0.58 });
      // 核球中层暖晕（精致轮新增一层）：核芯小晕与盘面大晕之间
      // 补一级过渡，银心的光不再是「一团亮斑 + 一大片雾」两段式
      const midGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: makeGlowTexture(
            "rgba(255,205,140,0.55)",
            "rgba(255,170,90,0.18)",
          ),
          color: 0xffc98c,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      midGlow.scale.set(8.2, 8.2, 1);
      galaxySpin.add(midGlow);
      galFadeMats.push({ mat: midGlow.material, base: 0.22 });
      const discGlow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: 0x5f7fb8,
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      discGlow.scale.set(13.5, 13.5, 1);
      galaxySpin.add(discGlow);
      galFadeMats.push({ mat: discGlow.material, base: 0.13 });
      // —— EHT 环背光垫（银河视觉重构轮·画法四·核心融合）：
      // 一枚宽 2.9 的暖金辉光精灵垫在黑洞精灵（renderOrder
      // 9）之后（本层 8）——环外径 1.25，此垫把环周约 2.3 倍
      // 环径的范围铺成与核芯同色的亮场：旧版环外只有程序纹
      // 理自带的 ≤0.07 极淡晕、环一出纹理边缘就落在暗背景
      // 上，缩略图里读成一枚独立的橙色甜甜圈；垫后环坐在核
      // 球辉光里，亮度自环向外连续缓降、无落差台阶。黑洞纹
      // 理本体（几何/配色带/亮结口径）一字未动，只改它与核
      // 球辉光的融合读法
      // 弱化银心轮（2026-11-15 晚）：垫的强度与范围同压——
      // 宽 2.9→2.6、峰值 0.42→0.30：融合关系不变（环仍坐
      // 在核球辉光里、无台阶），只是整片中央亮场的电平下
      // 调，缩略图第一眼不再被中心单独抢走
      {
        const bhBack = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: makeGlowTexture(
              "rgba(255,196,116,0.85)",
              "rgba(255,158,74,0.30)",
            ),
            color: 0xffbe78,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        bhBack.scale.set(2.6, 2.6, 1);
        bhBack.renderOrder = 8;
        galaxySpin.add(bhBack);
        galFadeMats.push({ mat: bhBack.material, base: 0.3 });
      }
      // —— 银心黑洞本体 · 人马座 A*（2022 EHT 光环轮，用户：
      // 「把它的中心做成 2022 年那个光环的样子」「就是最中心
      // 那个核换了就行 旁边的粒子都别动」）：旧三件（金橙泛光
      // + 暗核 + 细光子环）整组退役，换一枚逐像素程序纹理的
      // 单精灵，按 2022 年事件视界望远镜人马座 A* 发表影像的
      // 造型画：粗厚橙金环（外径 = 中央暗影直径的 2.5 倍）、
      // 中央近黑暗影、环上亮度不均带数处亮结且最亮一团在下
      // 方、内外缘由值噪声扰动出湍流毛边（无一处几何圆边）、
      // 配色黑→暗橙→橙→金黄、亮结峰处近黄白。尺寸仍是示意
      // 符号量：暗影直径 0.50 世界单位（同旧暗核）、环外径
      // 1.25——真实影像的环约 50 微角秒，在此尺度下真值不可
      // 见，此处是按发表影像造型的示意符号（口径同八星实体
      // 球的示意纪律，DATA-PLAN 有注）。混合走普通混合 + 非
      // 预乘真 alpha（彗星尾教训：避开 iOS WebKit 上预乘 +
      // 加色压黑块）；暗影段 alpha≈1 压住背景星光、环外只剩
      // 极淡暖晕收尾。与中心辉光三件同挂自转组同登记淡变；
      // 「银心 · 人马座 A*」名签沿用既有 hub 锚点、不动；周
      // 边粒子系统（核球/星晕/球状星团）与邻域银心罗盘标记
      // 本轮零改动；邻域档里它在 8.15 kpc 外、恒在画外，不
      // 抢太阳
      {
        const bhTex = (() => {
          const S = 384;
          const C = S / 2;
          const RS = 64; // 暗影半径 px（直径 128 px → 世界 0.50）
          const c = document.createElement("canvas");
          c.width = S;
          c.height = S;
          const g = c.getContext("2d")!;
          const img = g.createImageData(S, S);
          const data = img.data;
          // 值噪声（湍流毛边 + 亮度颗粒）：整数哈希网格 + 双
          // 线性平滑采样，fbm 三倍频叠加
          const hash = (ix: number, iy: number): number => {
            let n = (ix * 374761393 + iy * 668265263) | 0;
            n = Math.imul(n ^ (n >>> 13), 1274126177);
            return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
          };
          const vnoise = (x: number, y: number): number => {
            const ix = Math.floor(x);
            const iy = Math.floor(y);
            const fx = x - ix;
            const fy = y - iy;
            const sx = fx * fx * (3 - 2 * fx);
            const sy = fy * fy * (3 - 2 * fy);
            const a = hash(ix, iy);
            const b = hash(ix + 1, iy);
            const cc = hash(ix, iy + 1);
            const d = hash(ix + 1, iy + 1);
            return (
              a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy
            );
          };
          const fbm = (x: number, y: number): number =>
            vnoise(x, y) * 0.55 +
            vnoise(x * 2.13 + 31.7, y * 2.13 + 11.3) * 0.28 +
            vnoise(x * 4.31 + 7.9, y * 4.31 + 47.1) * 0.17;
          const sstep = (e0: number, e1: number, x: number): number => {
            const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
            return t * t * (3 - 2 * t);
          };
          const angDist = (a: number, b: number): number => {
            let d = Math.abs(a - b) % (Math.PI * 2);
            if (d > Math.PI) d = Math.PI * 2 - d;
            return d;
          };
          // 配色带：黑→暗橙→橙→金黄→黄白（发表影像色带；
          // 2026-11-15 质感纠正轮中段橙金加深：0.38 档
          // (198,76,8)→(214,84,6)、0.58 档 (255,124,16)→
          // (255,134,10)——旧带在小尺寸帧里橙段发虚发淡，
          // 与核球金雾糊成一片，环自身的橙金须独立可读）
          const STOPS: Array<[number, number, number, number]> = [
            [0, 24, 7, 1],
            [0.18, 104, 34, 3],
            [0.38, 214, 84, 6],
            [0.58, 255, 134, 10],
            [0.78, 255, 182, 54],
            [0.92, 255, 218, 124],
            [1.08, 255, 247, 216],
          ];
          const ramp = (t: number): [number, number, number] => {
            for (let i = 1; i < STOPS.length; i++) {
              const hi = STOPS[i]!;
              if (t <= hi[0]) {
                const lo = STOPS[i - 1]!;
                const k = (t - lo[0]) / (hi[0] - lo[0]);
                return [
                  lo[1] + (hi[1] - lo[1]) * k,
                  lo[2] + (hi[2] - lo[2]) * k,
                  lo[3] + (hi[3] - lo[3]) * k,
                ];
              }
            }
            return [255, 247, 216];
          };
          const TH_B = Math.PI / 2; // 画布下向（y 向下）= 最亮团所在
          for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
              const dx = x - C + 0.5;
              const dy = y - C + 0.5;
              const r = Math.hypot(dx, dy);
              const idx = (y * S + x) * 4;
              if (r > C - 1) continue;
              const theta = Math.atan2(dy, dx);
              const rho = r / RS;
              // 方位亮度：底部最亮、顶部约半亮；再叠四处亮结
              // （底部主结最强，余结环绕分布）
              // 弱化银心轮（2026-11-15 晚，用户：「银心现在仍
              // 太抢眼，压它的光、不改它的形」）：方位基底
              // 0.52+0.62 → 0.47+0.45、四结增益 0.55/0.30/
              // 0.24/0.16 → 0.38/0.21/0.17/0.11——峰值亮度与
              // 亮结对比同压约三成，环读作核球辉光里自然亮
              // 起的一圈而非独立物件；几何（RS/ρ 廓形/毛边
              // 噪声）与配色带一字未动
              const dAz = 0.5 + 0.5 * Math.cos(theta - TH_B);
              let bright = 0.47 + 0.45 * Math.pow(dAz, 1.7);
              bright +=
                0.38 *
                  Math.exp(
                    -(angDist(theta, TH_B) ** 2) / (2 * 0.42 * 0.42),
                  ) +
                0.21 *
                  Math.exp(
                    -(angDist(theta, TH_B + 2.3) ** 2) / (2 * 0.3 * 0.3),
                  ) +
                0.17 *
                  Math.exp(
                    -(angDist(theta, TH_B - 2.0) ** 2) / (2 * 0.26 * 0.26),
                  ) +
                0.11 *
                  Math.exp(
                    -(angDist(theta, TH_B + 3.4) ** 2) / (2 * 0.3 * 0.3),
                  );
              // 径向廓形在噪声扰动后的半径上求值 → 内外缘毛糙
              const wob = (fbm(x * 0.02, y * 0.02) - 0.5) * 15;
              const rhoJ = (r + wob) / RS;
              const rise = sstep(0.98, 1.45, rhoJ);
              const fall = 1 - sstep(1.85, 2.52, rhoJ);
              // 径向峰廓同轮压低（0.78+0.55 → 0.74+0.40）：环
              // 脊峰值再让一档，与方位亮度同向收（弱化银心轮）
              const peak = 0.74 + 0.4 * Math.exp(-(((rhoJ - 1.62) / 0.4) ** 2));
              const grain = 0.7 + 0.6 * fbm(x * 0.06, y * 0.06);
              let inten = rise * fall * peak * bright * grain;
              // 环外极淡暖晕收尾（远逊旧泛光，只防硬截断）
              if (rho > 2.5)
                inten +=
                  0.07 * Math.exp(-(rho - 2.5) * 1.7) * (0.6 + 0.4 * dAz);
              const aR = Math.min(1, Math.max(0, inten * 1.18));
              const [cr, cg, cb] = ramp(Math.min(1.1, inten));
              // 暗影：近黑，alpha 在 ρ 0.88→1.12 间让位给环
              const aS = 1 - sstep(0.88, 1.12, rhoJ);
              const aOut = aR + aS * (1 - aR);
              if (aOut <= 0) continue;
              const wS = (aS * (1 - aR)) / aOut;
              const wR = aR / aOut;
              data[idx] = cr * wR + 3 * wS;
              data[idx + 1] = cg * wR + 2 * wS;
              data[idx + 2] = cb * wR + 3 * wS;
              data[idx + 3] = aOut * 255;
            }
          }
          g.putImageData(img, 0, 0);
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.premultiplyAlpha = false;
          return tex;
        })();
        const bh = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: bhTex,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            blending: THREE.NormalBlending,
          }),
        );
        // 精灵宽 1.50 世界单位：暗影直径 = 1.50×(128/384) =
        // 0.50（同旧暗核）；环外径 = 1.50×(320/384) = 1.25 =
        // 暗影直径的 2.5 倍（发表影像比例）
        bh.scale.set(1.5, 1.5, 1);
        bh.renderOrder = 9;
        galaxySpin.add(bh);
        galFadeMats.push({ mat: bh.material, base: 1 });
      }
      // —— 比例尺：5 kpc 线段 + 两端短刻。钉 galaxyGroup 南缘
      // 固定位（不随盘自转）。位置沿革：fitZ≈22 时 x 0.2..2.7、
      // z 6.2；fitZ≈17.9 后内移 x −1.6..0.9、z 5.4；倾角
      // 0.96（离面 55°）轮内收 z 4.3 / 签 z 3.8。本轮倾角改
      // 0.61（离面 35°，见 GAL_FULL_TILT 注）后同式复算（fitZ
      // 17.9、tanV = tan21°、盘面点 NDC y = −z·sinθ /
      // ((fitZ − z·cosθ)·tanV)）：保线 NDC y ≈ −0.60 须
      // z 5.42 → 取 5.4，签保 y ≈ −0.51 须 z 4.78 → 取 4.8；
      // 线 x −1.6..0.9 不变（长仍恰 2.5 世界单位 = 5 kpc，
      // 只挪位置不改长度），NDC x −0.62..0.35；签 (−0.35, 0,
      // 4.8) 横跨约 −0.48..0.22、在线上方约 0.09 NDC；叠
      // frameK 最坏平移（±0.35 NDC）仍全在框内。线与签同入
      // galHubMats（邻域档随集线层淡出，且其组局部位置离太
      // 阳 ~7.5 单位、近览窗外，双保险）。
      {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(
            new Float32Array([
              -1.6, 0, 5.4, 0.9, 0, 5.4,
              -1.6, 0, 5.1, -1.6, 0, 5.7,
              0.9, 0, 5.1, 0.9, 0, 5.7,
            ]),
            3,
          ),
        );
        const mat = new THREE.LineBasicMaterial({
          color: 0x8fa8c8,
          transparent: true,
          opacity: 0.75,
        });
        const bar = new THREE.LineSegments(geo, mat);
        bar.renderOrder = 6;
        galaxyGroup.add(bar);
        galHubMats.push({ mat, base: 0.75 });
        const sLbl = makeGalaxyLabel("5 千秒差距", "#8fa8c8", 1);
        const sw = 1.3 * (isCoarse ? 1.43 : 1.3);
        sLbl.scale.set(sw, sw * (76 / 336), 1);
        // 签位：随倾角 0.61 复算至 z 4.8（线 z 5.4），相对纵
        // 位与离底栏距离按新倾角复算不变（见线段头注）
        sLbl.position.set(-0.35, 0, 4.8);
        sLbl.renderOrder = 12;
        galaxyGroup.add(sLbl);
        galHubMats.push({
          mat: sLbl.material as THREE.Material,
          base: 0.95,
        });
      }
      // —— 太阳公转弧 + 方向箭头：R0 圆上过太阳的一段弧（β −17°→
      // +17°），箭头在 +β 端沿切线——自转方向（北银极俯视顺时针）
      {
        const arcPts: THREE.Vector3[] = [];
        for (let bd = -17; bd <= 17; bd += 2) {
          const b = (bd * Math.PI) / 180;
          arcPts.push(
            L(
              GAL_R0_KPC * Math.sin(b),
              GAL_R0_KPC * Math.cos(b),
              0.02,
            ),
          );
        }
        const geo = new THREE.BufferGeometry().setFromPoints(arcPts);
        const mat = new THREE.LineBasicMaterial({
          color: 0xffd98f,
          transparent: true,
          opacity: 0.38,
        });
        galaxySpin.add(new THREE.Line(geo, mat));
        galHubMats.push({ mat, base: 0.38 });
        const coneMat = new THREE.MeshBasicMaterial({
          color: 0xffd98f,
          transparent: true,
          opacity: 0.55,
        });
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.05, 0.17, 10),
          coneMat,
        );
        const cb = (15.5 * Math.PI) / 180;
        cone.position.copy(
          L(GAL_R0_KPC * Math.sin(cb), GAL_R0_KPC * Math.cos(cb), 0.02),
        );
        cone.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(Math.cos(cb), 0, Math.sin(cb)).normalize(),
        );
        galaxySpin.add(cone);
        galHubMats.push({ mat: coneMat, base: 0.55 });
      }
      await sl.tick();
      // —— 锚点精灵（标签/标记）：纯文字轻标签与行星标签同式
      const addAnchor = (
        sprite: THREE.Sprite,
        base: THREE.Vector3,
        kind: GalAnchor["kind"],
        wFull: number,
        wNear: number,
        aspect: number,
        riseFull = 0,
        riseNear = 0,
        pulse = false,
        fanX = 0,
        fanY = 0,
        clampLabel = false,
        pxT = 0,
        fanScreen = false,
        leader = false,
        leaderIdx = -1,
        warpMode = 0,
        warpK = 1,
      ): void => {
        sprite.renderOrder = 12;
        galaxyGroup.add(sprite);
        galAnchors.push({
          obj: sprite,
          base,
          kind,
          wFull,
          wNear,
          aspect,
          mat: sprite.material as THREE.SpriteMaterial,
          baseOpacity: (sprite.material as THREE.SpriteMaterial).opacity,
          riseFull,
          riseNear,
          pulse,
          fanX,
          fanY,
          fanCX: fanX,
          fanCY: fanY,
          fanScreen,
          leader,
          leaderIdx,
          clampLabel,
          pxT,
          warpMode,
          warpK,
        });
      };
      // 标签宽度纪律（精致轮）：银河标签画布加宽到 336（旧
      // 256），同字号下精灵宽按 336/256≈1.31 补偿到 1.3 倍、
      // 移动端再 ×1.1（字面约大一成）——LW 一处定义、全场标签
      // 同步，不许各签各行其是；aspect 同步换 76/336
      const LW = isCoarse ? 1.43 : 1.3;
      const GAL_ASPECT = 76 / 336;
      // 旋臂名：锚在拟合段中段、沿径向外偏 0.85 kpc
      for (const arm of GALAXY_ARMS) {
        const c = armPlanPoint(arm, arm.labelBetaDeg);
        // 外臂签例外（立体重构轮）：其锚点半径约 12 kpc，按
        // 亮盘定标的新取景（移动拟合 5.9 世界单位）再向外偏
        // 0.85 kpc 会在自转到侧向时出框——改向内偏 0.5 kpc
        // 贴臂内侧（只挪签面，臂与星点坐标不动）
        const off = arm.en === "Outer" ? -0.5 : 0.85;
        const ox = (c.x / c.r) * off;
        const oy = (c.y / c.r) * off;
        addAnchor(
          makeGalaxyLabel(arm.name, "#bcd3f2", 1),
          L(c.x + ox, c.y + oy, 0.1),
          "arm",
          1.3 * LW,
          0.3 * LW,
          GAL_ASPECT,
        );
      }
      // （「5 千秒差距」签已随比例尺改钉组南缘固定位，见比例尺块——
      // 不再走会随盘自转的锚点系统）
      // 银心标记 + 名签
      {
        const core = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: galGlowTex,
            color: 0xffd9a0,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        addAnchor(core, L(0, 0, 0), "hub", 0.55, 0.55, 1);
        // 核心融合补完（视觉重构轮验收帧抓到）：银心标记点走
        // 锚点默认 renderOrder 12、压在黑洞精灵（9）之上——
        // 0.55 宽的加色辉光正落在 0.50 宽的暗影中央，把暗影
        // 顶成一只带高光的眼球，EHT 暗影读不成立。改 8（垫
        // 在环之后、与背光垫同级）：暗影 alpha≈1 处标记被环
        // 本体盖住，环外透明区只剩与背光垫同色的 faint 辉
        // 光，不成独立元素；名签锚点仍 12 在上
        core.renderOrder = 8;
        addAnchor(
          makeGalaxyLabel("银心 · 人马座 A*", "#ffd9a0", 1),
          L(0, -1.3, 0.1),
          "hub",
          1.25 * LW,
          0.4 * LW,
          GAL_ASPECT,
        );
      }
      // 太阳标记：暖金核 + 呼吸光环 + 「太阳系」签（签靠 rise 悬
      // 在点上方——近览时组放大，签距不许按 kpc 偏移胀开）
      {
        const core = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: galGlowTex,
            color: 0xffe9b8,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        addAnchor(core, galSunBase.clone(), "sun", 0.3, 0.15, 1);
        const ring = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: makeRingTexture(),
            color: 0xffd98f,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            depthTest: false,
          }),
        );
        addAnchor(ring, galSunBase.clone(), "sun", 0.62, 0.36, 1, 0, 0, true);
        const sunLabelSprite = makeGalaxyLabel("太阳系", "#ffd98f", 1);
        galSunLabel = sunLabelSprite;
        addAnchor(
          sunLabelSprite,
          galSunBase.clone(),
          "sun",
          1.0 * LW,
          1.55 * LW,
          GAL_ASPECT,
          0.55,
          0.5,
          false,
          -0.17,
          0.67,
        );
      }
      // 太阳邻域八星：真实银河坐标落位（galaxyData 换算，2026-11-14
      // 位置审计后逐分量与真实日心偏移恒等，见 galaxyData planZ 注），
      // 星色与太阳系模式登记逐颗一致；蓝伴星无签、贴金点旁（同太阳
      // 系纪律）
      // —— 星名签锚定（2026-11-14 邻域优化轮，用户：「领域名字
      // 定位要准确」）：旧扇开位移（内圈四星签被甩到离本星一整
      // 个世界单位开外、读起来像邻星的签）整套废除。每签改走
      // 屏幕系恒定小偏移（galLabelOffsets 在帧段真实几何里优
      // 选，取「签到本星 − 签到最近其他星」点对点裕量最大
      // 者），构建时以自转相位 0 预置、入场边沿按当次真实相
      // 位重算覆盖（见帧段入场段与 galLabelOffsets 注）；签
      // 与本星之间另挂一条发丝引线（见引线几何），归属一眼
      // 可辨。宽取景另有呼出偏移（STAR_LABEL_CALLOUT，帧段
      // 按倍率混合）。星体与签的锚点 base 恒为真实坐标，偏
      // 移只挪签面
      const STAR_LABEL_OFF: Record<string, [number, number]> =
        galLabelOffsets(0);
      /** 呼出偏移预置（相位 0，入场边沿按真实相位重算覆盖） */
      const STAR_LABEL_CALLOUT: Record<string, [number, number]> =
        galCalloutOffsets(0);
      let starLabelIdx = 0;
      // 实体球（本轮新增）：自发光球面着色——中心亮、临边昏暗
      // （恒星临边昏暗的真实观感）+ 一圈细的大气式 rim，不依赖场
      // 景光源；静态无脉动。直径档位按亮度/个头示意（见
      // STAR_BODY_D），光晕精灵在球后垫底（renderOrder 10 < 球 11
      // < 签 12）
      const starBodyGeo = new THREE.SphereGeometry(0.5, 24, 18);
      const makeStarBodyMat = (color: string): THREE.ShaderMaterial =>
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color(color) },
            uOpacity: { value: 0 },
          },
          vertexShader: [
            "varying vec3 vNv;",
            "void main() {",
            "  vNv = normalize(normalMatrix * normal);",
            "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
            "}",
          ].join("\n"),
          fragmentShader: [
            "uniform vec3 uColor;",
            "uniform float uOpacity;",
            "varying vec3 vNv;",
            "void main() {",
            "  float ndv = clamp(normalize(vNv).z, 0.0, 1.0);",
            "  float limb = 0.42 + 0.72 * pow(ndv, 1.35);",
            "  float rim = pow(1.0 - ndv, 2.4) * 0.30;",
            "  vec3 c = uColor * (limb + rim) + vec3(1.0) * pow(ndv, 6.0) * 0.18;",
            "  gl_FragColor = vec4(c, uOpacity);",
            "}",
          ].join("\n"),
          transparent: true,
          depthWrite: false,
        });
      /** 实体直径档（世界单位，邻域档 1.1 kpc 取景）：天津
       * 四（蓝白超巨星、最亮）与参宿四（红超巨星）最大，余
       * 者按视亮度/个头递减。真机修正轮整体加大一档（×1.35）。
       * 真机修正轮二起本档只定**相对序**：实际绘制走屏幕尺
       * 寸补偿（pxT 按本档换算、帧段按相机距反解世界直径，
       * 见 animate）——缩远不缩没、推近不膨胀。示意量、非
       * 物理比例（真实半径在此尺度不可见） */
      const STAR_BODY_D: Record<string, number> = {
        Deneb: 0.4,
        Betelgeuse: 0.39,
        Spica: 0.28,
        Sirius: 0.28,
        Albireo: 0.27,
        Vega: 0.26,
        Procyon: 0.23,
        Altair: 0.22,
        "Albireo B": 0.16,
      };
      for (const star of GALAXY_STARS) {
        const dot = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: galGlowTex,
            color: new THREE.Color(star.color),
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        const dNear = STAR_BODY_D[star.en] ?? 0.22;
        // 屏幕补偿目标（CSS px）：以天狼星档 0.28 → 23 px 为
        // 基准按 dNear 线性、夹进 [16, 30] 带宽——天津四/参
        // 宿四触顶 30、蓝伴星触底 16，相对序保留（真机修正
        // 轮二 C）；实体登记与光晕锚点共用同一份值（晕 =
        // 球 × 1.9，与旧 wNear = dNear×1.9 的晕/球比一致）
        const bodyPx = THREE.MathUtils.clamp(23 * (dNear / 0.28), 16, 30);
        // 邻域 warp 登记（本轮）：base 恒存真坐标，warpK 按真
        // 实日心距离一次算定——光晕/实体/星签三路共用同一份
        // 倍率，帧段按 eNC 混合落位（全览恒真值）
        const starBase = L(star.planX, star.planY, star.planZ);
        const starK = galWarpKOf(starBase);
        addAnchor(
          dot,
          starBase,
          "star",
          0.05,
          dNear * 1.9,
          1,
          0,
          0,
          false,
          0,
          0,
          false,
          bodyPx * 1.9,
          false,
          false,
          -1,
          1,
          starK,
        );
        dot.renderOrder = 10;
        const bodyMat = makeStarBodyMat(star.color);
        const body = new THREE.Mesh(starBodyGeo, bodyMat);
        body.renderOrder = 11;
        body.visible = false;
        body.frustumCulled = false;
        galaxyGroup.add(body);
        galStarBodies.push({
          mesh: body,
          base: starBase,
          mat: bodyMat,
          dNear,
          // 帧段按相机距反解世界直径（见 animate 八星实体段）
          pxT: bodyPx,
          warpK: starK,
        });
        if (star.name) {
          const off = STAR_LABEL_OFF[star.name] ?? [0.14, 0.14];
          // 距离后缀随签（精致轮）：说明卡下线后，八星距离改附
          // 在签后作小字——数据仍是 galaxyData 的 distLabel，
          // 只在邻域视角随星签淡入（星签全盘恒隐，后缀不外溢）。
          // 锚定走屏幕系恒定偏移 + 引线（见 STAR_LABEL_OFF 注）
          addAnchor(
            makeGalaxyLabel(star.name, star.color, 1, star.distLabel),
            starBase,
            "star",
            0.85 * LW,
            1.55 * LW,
            GAL_ASPECT,
            0,
            0.5,
            false,
            off[0],
            off[1],
            true,
            0,
            true,
            true,
            starLabelIdx++,
            1,
            starK,
          );
          const lblA = galAnchors[galAnchors.length - 1]!;
          const coff = STAR_LABEL_CALLOUT[star.name];
          if (coff) {
            lblA.fanCX = coff[0];
            lblA.fanCY = coff[1];
          }
          galStarLabelRefs.push({ name: star.name, a: lblA });
        }
      }
      // 星名签引线（邻域优化轮）：发丝线连接本星真点与签面，
      // 与签同走 galNearMats 淡变（只在邻域档出现）；几何在
      // 此处只分配缓冲，坐标由帧段锚点循环逐帧回填
      {
        const labeled = GALAXY_STARS.filter((s) => s.name).length;
        galLeaderPos = new Float32Array(labeled * 6);
        const geo = new THREE.BufferGeometry();
        galLeaderAttr = new THREE.BufferAttribute(galLeaderPos, 3);
        galLeaderAttr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute("position", galLeaderAttr);
        const mat = new THREE.LineBasicMaterial({
          color: 0x8fb0d8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        galNearMats.push({ mat, base: 0.45 });
        const lines = new THREE.LineSegments(geo, mat);
        lines.frustumCulled = false;
        lines.renderOrder = 9;
        galaxyGroup.add(lines);
      }
      await sl.tick();
      // —— 邻域定位家具（立体重构轮，用户：「切换到领域时要
      // 以太阳系为中心、不然看不清楚那 8 颗星的位置」+「领域
      // 里面也方便定位」）：全部 faint、明确辅助性质，只在邻
      // 域档淡入（galNearMats，帧段按 eNC 驱动），全览恒隐。
      // 家具与星点同挂自转组、同走 L() 真坐标——相机枢轴锁太
      // 阳的既有机制（组平移钉太阳于画面中心）之下，网格/垂
      // 线/环/井与八星恒同框同转
      const sunL = L(0, GAL_R0_KPC, GAL_SUN_Z_PC / 1000);
      const nearLineMat = (
        color: number,
        base: number,
      ): THREE.LineBasicMaterial => {
        const mat = new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0,
        });
        galNearMats.push({ mat, base });
        return mat;
      };
      // 银道面参考网格：z=0 面（本地 y=0）、以太阳为心 ±1.6
      // kpc、格距 0.2 kpc；太阳悬在面上方 20 pc——它的垂线
      // （下条）与网格的间距就是这 20 pc 的读数
      {
        const pts: number[] = [];
        const ext = 1.6;
        const step = 0.2;
        for (let g = -ext; g <= ext + 1e-6; g += step) {
          const a = L(g, GAL_R0_KPC - ext, 0);
          const b = L(g, GAL_R0_KPC + ext, 0);
          pts.push(a.x, 0, a.z, b.x, 0, b.z);
          const c = L(-ext, GAL_R0_KPC + g, 0);
          const d = L(ext, GAL_R0_KPC + g, 0);
          pts.push(c.x, 0, c.z, d.x, 0, d.z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(pts), 3),
        );
        galaxySpin.add(
          new THREE.LineSegments(geo, nearLineMat(0x41618c, 0.34)),
        );
      }
      // 垂线 + 落点：太阳与八星各自向银道面落一条垂线，落点
      // 一枚小点——高低差一落线，位置不用想就定位（内圈四星
      // 的垂线只有零点几 pc 长、几乎与星重合，是真值不是漏画）
      {
        const pts: number[] = [];
        // warp 登记（本轮）：逐顶点倍率 + 足点旗与 pts 同步推
        // 进，帧段 applyGalWarpGeos 据此重写——星端按母星倍率
        // 三维径向放大、足端只放 x/z 且 y 恒 0，垂线恒竖直、
        // 足点恒落在 warp 后星体的正下方
        const dropKs: number[] = [];
        const dropFoot: number[] = [];
        const drop = (v: THREE.Vector3, k: number): void => {
          pts.push(v.x, v.y, v.z, v.x, 0, v.z);
          dropKs.push(k, k);
          dropFoot.push(0, 1);
        };
        drop(galSunBase, 1);
        for (const star of GALAXY_STARS) {
          const v = L(star.planX, star.planY, star.planZ);
          drop(v, galWarpKOf(v));
        }
        const geo = new THREE.BufferGeometry();
        const dropAttr = new THREE.BufferAttribute(
          new Float32Array(pts),
          3,
        );
        dropAttr.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute("position", dropAttr);
        galaxySpin.add(
          new THREE.LineSegments(geo, nearLineMat(0x7d94b5, 0.42)),
        );
        galDropWarp = {
          attr: dropAttr,
          base: new Float32Array(pts),
          ks: new Float32Array(dropKs),
          foot: new Uint8Array(dropFoot),
        };
        const foot = (v: THREE.Vector3): void => {
          const dot = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: galGlowTex,
              color: 0x8fa8c8,
              transparent: true,
              opacity: 0.55,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
            }),
          );
          // kind=star：随邻域档淡入、全览恒隐（锚点类别淡变
          // 机制现成）；落点在盘面上，base 的 y 取 0；warp 走
          // 落点式（mode 2，倍率 = 母星倍率，与垂线足端同值，
          // 两处落点逐帧恒重合）
          addAnchor(
            dot,
            new THREE.Vector3(v.x, 0, v.z),
            "star",
            0.05,
            0.09,
            1,
            0,
            0,
            false,
            0,
            0,
            false,
            0,
            false,
            false,
            -1,
            2,
            galWarpKOf(v),
          );
        };
        foot(galSunBase);
        for (const star of GALAXY_STARS)
          foot(L(star.planX, star.planY, star.planZ));
      }
      // 距离环：绕太阳、躺在过太阳且平行于银道面的平面上
      // （环上每点到太阳的距离就是环半径——若躺 z=0 面，10 pc
      // 环的真实距离会被太阳 20 pc 悬高污染成约 22 pc，故环
      // 随太阳平面、网格留在 z=0，两者的错位正是悬高本身）；
      // 档位 10/50/100/500 pc 各配一枚数签
      for (const rpc of [10, 50, 100, 500]) {
        const rW = (rpc / 1000) * GAL_S;
        const ringPts: THREE.Vector3[] = [];
        for (let k = 0; k <= 96; k++) {
          const a = (k / 96) * Math.PI * 2;
          ringPts.push(
            new THREE.Vector3(
              sunL.x + rW * Math.cos(a),
              sunL.y,
              sunL.z + rW * Math.sin(a),
            ),
          );
        }
        const geo = new THREE.BufferGeometry().setFromPoints(ringPts);
        const ringAttr = geo.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        ringAttr.setUsage(THREE.DynamicDrawUsage);
        galaxySpin.add(
          new THREE.Line(geo, nearLineMat(0x54749e, 0.5)),
        );
        // warp 登记（本轮）：整环同一倍率 galWarpK(rpc)——环半
        // 径与星的日心距离走同一条 k(r)，warp 后星恰落回同名
        // 环的球面上；环签仍标真实 pc（文案不改）
        galRingWarps.push({
          attr: ringAttr,
          base: new Float32Array(ringAttr.array),
          k: galWarpK(rpc),
        });
        addAnchor(
          makeGalaxyLabel(`${rpc} pc`, "#7d94b5", 1),
          new THREE.Vector3(
            sunL.x + rW * 0.7071,
            sunL.y,
            sunL.z + rW * 0.7071,
          ),
          "star",
          0.001,
          1.05 * LW,
          GAL_ASPECT,
          0,
          0,
          false,
          0,
          0,
          false,
          0,
          false,
          false,
          -1,
          1,
          galWarpK(rpc),
        );
      }
      // 银心指引 → 屏幕系罗盘（本轮，用户：「还有银心在领域
      // 里不缩到最小看不见」）：旧制是 spin 系里一条 80 pc 长
      // 的虚线 + 锚点签——最远帧（约 2.2 kpc 见方）下 80 pc
      // 只剩约 17 px、标记签随组缩放缩没，正是用户所指。本
      // 轮改罗盘式：银心本体距太阳 8.15 kpc、永在邻域尺度之
      // 外，这里做的恒是**方向常驻标记**（非尺度内天体，
      // DATA-PLAN 有注）——线/标记/签改为场景级对象，帧段按
      // 屏幕系几何落位：自太阳屏幕位置沿太阳→银心真方位引
      // 出，臂长 = max(80 pc 的投影长，72 px 屏幕下限)（再沿
      // 同一射线按圆盘＋签的刚性整体包围盒夹进画布，方向不
      // 偏、只截长、整体完整在框——2026-11-16 可见性修复轮
      // 改判，见帧段罗盘段钳制注）；末端标记固定 36 px 屏幕尺寸（暗核＋金环，与
      // 全览人马座 A* 同一套视觉语言），签「银心方向」附真
      // 实距离后缀。任意缩放档位恒可见、拖动时随方位转动
      {
        const mc = document.createElement("canvas");
        mc.width = 128;
        mc.height = 128;
        const mg = mc.getContext("2d")!;
        mg.beginPath();
        mg.arc(64, 64, 43, 0, Math.PI * 2);
        mg.fillStyle = "rgba(3,6,14,0.94)";
        mg.fill();
        mg.beginPath();
        mg.arc(64, 64, 47, 0, Math.PI * 2);
        mg.strokeStyle = "rgba(255,217,143,0.95)";
        mg.lineWidth = 6;
        mg.shadowColor = "rgba(255,201,94,0.8)";
        mg.shadowBlur = 10;
        mg.stroke();
        mg.beginPath();
        mg.arc(64, 64, 5, 0, Math.PI * 2);
        mg.fillStyle = "#ffe9b8";
        mg.shadowBlur = 12;
        mg.fill();
        const markerTex = new THREE.CanvasTexture(mc);
        markerTex.colorSpace = THREE.SRGBColorSpace;
        const linePos = new Float32Array(6);
        const lineGeo = new THREE.BufferGeometry();
        const lineAttr = new THREE.BufferAttribute(linePos, 3);
        lineAttr.setUsage(THREE.DynamicDrawUsage);
        lineGeo.setAttribute("position", lineAttr);
        const lineMat = new THREE.LineDashedMaterial({
          color: 0x8fa8c8,
          dashSize: 0.01,
          gapSize: 0.008,
          transparent: true,
          opacity: 0,
          depthTest: false,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        line.frustumCulled = false;
        line.renderOrder = 13;
        line.visible = false;
        scene.add(line);
        const markerMat = new THREE.SpriteMaterial({
          map: markerTex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
        });
        const marker = new THREE.Sprite(markerMat);
        marker.renderOrder = 13;
        marker.visible = false;
        marker.frustumCulled = false;
        scene.add(marker);
        // 可点暗示（2026-11-15 邻域导航改判 B3）：罗盘标记本轮
        // 起可点（点它回银河全览）——给它与太阳标记同一套视觉
        // 语言的呼吸光环（太阳标记恒有呼吸环、旧罗盘没有，正
        // 是它看着像纯摆设的原因）：细金环绕标记缓慢呼吸，不
        // 做按钮形、不加文字，罗盘本来的样子不破
        const pulseMat = new THREE.SpriteMaterial({
          map: makeRingTexture(),
          color: 0xffd98f,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
        });
        const pulse = new THREE.Sprite(pulseMat);
        pulse.renderOrder = 13;
        pulse.visible = false;
        pulse.frustumCulled = false;
        scene.add(pulse);
        const label = makeGalaxyLabel(
          "银心方向",
          "#ffd9a0",
          1,
          "人马座 A* · 约 26,600 光年",
        );
        const labelMat = label.material as THREE.SpriteMaterial;
        labelMat.opacity = 0;
        label.renderOrder = 14;
        label.visible = false;
        label.frustumCulled = false;
        scene.add(label);
        galCompass = {
          line,
          linePos,
          lineAttr,
          lineMat,
          marker,
          markerMat,
          pulse,
          pulseMat,
          label,
          labelMat,
        };
      }
      // 引力井（用户认可的引力场形式）：太阳系本体在邻域里
      // 不做球——一小片极线网格在太阳处凹成漏斗，井底即太阳
      // 本体（既有金色核 + 呼吸光环签恒在井底）。金色调、安
      // 静——尺寸全是示意（真实引力井无界，此处只取「一口井」
      // 的符号形，DATA-PLAN 明示）；全览里太阳仍是既有呼吸
      // 光环标记，井只在邻域尺度出现
      // —— 井体量收紧（2026-11-14 引力井修复轮，用户真机判
      // 词：「怎么星球都挤在引力场最底下了」）：旧井井口半径
      // 45 pc、深度参数 22 pc、宽度参数 13 pc——井口足迹盖住
      // 内圈四星的落点（天狼星 2.64 / 南河三 3.51 / 牛郎星
      // 5.13 / 织女星 7.68 pc），且井面在天狼星平面距处已隆
      // 起约 +0.87 pc、高于其真实高度（太阳平面下 −0.41 pc），
      // 再叠星球 16–30 px 的屏幕尺寸补偿，视觉上四星全沉井
      // 底。星坐标是真值不动，动井：井口半径压到 1.2 pc（明
      // 确小于最近的天狼星 2.64 pc，最近的星也落在井外）、
      // 深度参数 0.55 pc（井口实际隆起约 0.47 pc）、宽度参
      // 数 0.5 pc——读感是网格上一个小凹陷，不是深坑；太阳
      // 光点仍在井底中心
      {
        // 井半径 1.2 pc 即下方 ringR 的外缘值，口径归 ringR 一处
        const R0_PC = 0.5;
        const D_PC = 0.55;
        const toLocal = (pc: number): number => (pc / 1000) * GAL_S;
        const yAt = (rPc: number): number =>
          sunL.y +
          toLocal(D_PC) * ((rPc * rPc) / (rPc * rPc + R0_PC * R0_PC));
        const ringR = [0, 0.18, 0.36, 0.55, 0.74, 0.92, 1.08, 1.2];
        const SEG = 48;
        const pts: number[] = [];
        const ptAt = (rPc: number, a: number): [number, number, number] => [
          sunL.x + toLocal(rPc) * Math.cos(a),
          yAt(rPc),
          sunL.z + toLocal(rPc) * Math.sin(a),
        ];
        for (const rPc of ringR) {
          if (rPc === 0) continue;
          for (let k = 0; k < SEG; k++) {
            const a1 = (k / SEG) * Math.PI * 2;
            const a2 = ((k + 1) / SEG) * Math.PI * 2;
            pts.push(...ptAt(rPc, a1), ...ptAt(rPc, a2));
          }
        }
        for (let s = 0; s < 16; s++) {
          const a = (s / 16) * Math.PI * 2;
          for (let k = 0; k + 1 < ringR.length; k++) {
            pts.push(
              ...ptAt(ringR[k]!, a),
              ...ptAt(ringR[k + 1]!, a),
            );
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(pts), 3),
        );
        // 层序（同轮审计）：井线关 depthWrite、renderOrder 压
        // 到星光晕（10）/星体（11）/签（12）之下——旧井线走
        // LineBasicMaterial 默认 depthWrite:true 且几何隆起段
        // 位于相机与内圈星之间时，线写入的深度会挡掉星体碎
        // 片、线条直接压在球面上，是「沉底」读感的一半成因。
        // 关写深度后井线只作背景网格存在，星球恒绘在井面之
        // 前；井收紧到 1.2 pc 后已无任何星与井足迹重叠，近中
        // 心星球的暗色衬底因此不需要加（示意层从简）
        const wellMat = nearLineMat(0xd9a94e, 0.55);
        wellMat.depthWrite = false;
        const wellLines = new THREE.LineSegments(geo, wellMat);
        wellLines.renderOrder = 2;
        wellLines.frustumCulled = false;
        galaxySpin.add(wellLines);
      }
      galaxyBuilt = true;
      galaxyBuilding = false;
    };

    await sl.yieldNow();
    // —— 太阳系模式：太阳 + 八大行星 + 轨道圈 ——
    // 位置口径（2026-11-14 同步+减速，用户：「太阳系月球地球太阳
    // 的位置最好和月相同步 / 现在运行的速度太快了」）：不再用
    // 「构建时黄经 + 展示角速度×会话秒」的快放时钟——animate 每帧
    // 以当前真实时刻直接调同一套星历定角（行星 planetLongitude
    // JPL Table 1、月球 moonLongitude Meeus，与主页月相卡同一模块
    // 同一函数），场景里日-地-月的几何与月相卡的日月距角因此恒等
    // （离线验算：经度差口径下两处相位角之差 0.000°；含月轨 5°
    // 倾角的 3D 照亮比与卡片一致到 0.1%）。流速 = 真实时间 1×：
    // 改前地球公转一周 90 秒、月球绕地约 6.7 秒；改后地球 365.25
    // 天、月球 27.32 天（屏幕上几乎静止是同步的必然结果，行星自转
    // 等展示动画不在此列）。轨道半径与行星大小为压缩示意（页面
    // 有标注）。行星用低面数球体、轨道线静态 LineLoop，移动端帧
    // 率优先。地球不另造：监控球本体在过渡动画里缩小并移动到
    // earthAnchor 处，成为太阳系里的地球。
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
    // 分片让行：太阳程序纹理是单次原子重活，前后各设一个让行
    // 点把它隔离成独立一片（片长由分片器如实记录）
    await sl.yieldNow();
    const sunMat = makeSunMaterial(makeSunTexture(!isCoarse));
    await sl.yieldNow();
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
      /** 个性效应逐帧驱动（粒子时间/淡入 + 精灵透明度）；无效应为 null */
      fxTick: ((t: number, fade: number) => void) | null;
    }
    /** 监控球在太阳系模式里的目标缩放（成为行星地球的半径） */
    const EARTH_PLANET_SCALE = isCoarse ? 0.14 : 0.076;
    const planetVis: PlanetVis[] = [];
    /** 轨道圈材质登记（按 PLANET_ELEMENTS 顺序 = 由内到外）：过渡时逐个淡入 */
    const orbitMats: THREE.LineDashedMaterial[] = [];
    /** 黄道十二宫环材质/宫名签登记（animate 按 sunFade 驱动） */
    let zodiacRingMat: THREE.LineBasicMaterial | null = null;
    let zodiacTickMat: THREE.LineBasicMaterial | null = null;
    const zodiacLabels: THREE.Sprite[] = [];
    /** 黄道层登记口径（2026-11-16 星点删除轮后）：骨架星
     * 点三件 Points 与主星名签已随元灿令整体删除（见构
     * 建段墓碑注），本层只剩黄道环/刻度（上方材质）、
     * 宫名签（zodiacLabels）与抠图（下方登记）三类，不
     * 存在任何 Line/线带/Points 对象 */
    // —— 十二宫抠图（2026-11-16 元灿工单「把星座本体抠
    // 出来呀，不要整张图贴在那」）：整卡贴图退场，换亲
    // 发海报抠出的透明底单体图（本体＋自带辉光、无卡
    // 底无文字）竖立环上——摆法与卡图轮一致（挂
    // zodiacFrame、一宫一格、双面可读），尺寸改按最大
    // 边 2.0 世界单位逐宫适配（宽高比各宫不同、图心对
    // 格心，落数见构建段）。绘制版图形（金线轮廓四层）
    // 同轮整体删除、不再有回落路径：某宫纹理加载失败
    // 时该宫置 ok=false 恒隐（宁缺一宫、不许旧线复活）。
    // 宫名签、环/刻度是坐标层，不在替代范围、照旧在
    // 场（骨架星点与主星名签已于同日星点删除轮退场）
    let zodiacCutoutGroup: THREE.Group | null = null;
    const zodiacCutoutMats: Array<{
      mat: THREE.MeshBasicMaterial;
      base: number;
      ok: boolean;
    }> = [];
    /** 月球轨道圈材质（随地球一同在行星序列里淡入） */
    let moonOrbitMat: THREE.LineBasicMaterial | null = null;
    // —— 月球：绕地小天体，位置逐帧按当前真实时刻的月球黄经
    // （moonLongitude，与主页月相卡同一函数）定角——相位与卡片
    // 恒等、流速真实（27.32 天一圈；改前展示时钟约 6.7 秒一圈）。
    // 盈亏由太阳点光源真实照明，亮面天然朝向太阳，不贴任何假
    // 月相纹理。
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
            void t;
            // 本体当前位置由 animate 的星历段同帧先行写入
            // mesh.position（太阳系组本地系），尾向直接读它——与
            // 本体恒同位，不再另算一份轨道角（2026-11-14 同步改）
            const px = mesh.position.x;
            const pz = mesh.position.z;
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
    /**
     * 星街彗星黄经（任意时刻）：历元相位 4.40 rad（选定使 2026-11
     * 打开总览时它在前侧易见位）+ 自 J2000 天数 × 210 年周期平黄
     * 经率——真实流速公式，animate 逐帧以当前时刻求值（2026-11-14
     * 同步改：旧口径构建时定相位、之后按展示角速度快放，已废）
     */
    const suiseiLongitudeAt = (d: Date): number =>
      4.4 +
      (d.getTime() / 86400000 - 10957.5) * ((Math.PI * 2) / (210 * 365.25));
    const suiseiPosTmp = new THREE.Vector3();
    {
      const orbitSeg = 128;
      for (const p of PLANET_ELEMENTS) {
        // 分片让行：逐天体查一次时间预算——每颗行星的程序纹理
        // （planetMaps）是本循环的重量来源，天体之间必有让行点
        await sl.tick();
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
          fxTick: buildPlanetFx(p, mesh),
        });
      }
    }
    await sl.yieldNow();
    // —— 黄道十二宫环（2026-11-14 新增，用户两张黄道示意图落地
    // 之一）：沿黄道面在太阳系外围排一圈十二宫，每宫 30°、宫界
    // 与宫名按真实黄经定位，零点 = 春分点方向（黄经 0°）。落点
    // 公式与行星逐帧定角完全同式（黄经 λ → (cosλ·R, 0, −sinλ·R)），
    // 故天体视觉上站在哪个宫前面与它黄经算出的宫恒等——零点验
    // 算（2026-11-14 离线，同式复算）：太阳地心黄经 231.3° →
    // 天蝎宫、反日点 51.3° → 金牛宫。半径取全览拟合口径 7.95
    // （海王星圈 7.45 之外、全览恰好入框），刻度向内（宫界长、
    // 5° 短），宫名签在环内侧（纯文字、与行星标签同式）。十二
    // 宫在惯性系静止（岁差在本尺度忽略）。只随 sunFade 淡入淡
    // 出，不进命中表与标签避让系统——它是坐标框，不是天体。
    // 2026-11-15 全站统一口径（用户令：与现实对齐）：环/刻度/
    // 宫签/抠图整体挂进黄道框组 zodiacFrame，组按黄经岁差
    // ψ(构建时刻) 绕 Y 整体转——行星黄经（globeMath
    // .planetLongitude 与 moonPhase 地心链出口）同加 ψ(t)，故
    // 「行星站在哪个宫前 = 其黄经算出的宫」在新口径下继续恒等。
    // （原同挂框内的星座骨架星点/主星名签已于 2026-11-16 删
    // 除，见构建段墓碑注。）ψ 在会话内漂移 ~1e-7°，构建时
    // 取一次即可。
    {
      const zodiacFrame = new THREE.Group();
      zodiacFrame.rotation.y =
        (eclipticPrecessionDeg(new Date()) * Math.PI) / 180;
      solarGroup.add(zodiacFrame);
      const ZODIAC_R = 7.95 * SOLAR_S;
      const ringPts: THREE.Vector3[] = [];
      for (let i = 0; i < 256; i++) {
        const a = (i / 256) * Math.PI * 2;
        ringPts.push(
          new THREE.Vector3(
            Math.cos(a) * ZODIAC_R,
            0,
            -Math.sin(a) * ZODIAC_R,
          ),
        );
      }
      zodiacRingMat = new THREE.LineBasicMaterial({
        color: 0x51749c,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      zodiacFrame.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(ringPts),
          zodiacRingMat,
        ),
      );
      const tickPos: number[] = [];
      for (let k = 0; k < 72; k++) {
        const a = (k * 5 * Math.PI) / 180;
        const len = k % 6 === 0 ? 0.17 : 0.08;
        tickPos.push(
          Math.cos(a) * ZODIAC_R,
          0,
          -Math.sin(a) * ZODIAC_R,
          Math.cos(a) * (ZODIAC_R - len),
          0,
          -Math.sin(a) * (ZODIAC_R - len),
        );
      }
      const tickGeo = new THREE.BufferGeometry();
      tickGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(tickPos, 3),
      );
      zodiacTickMat = new THREE.LineBasicMaterial({
        color: 0x6d8ab0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      zodiacFrame.add(new THREE.LineSegments(tickGeo, zodiacTickMat));
      for (let k = 0; k < 12; k++) {
        const a = ((k * 30 + 15) * Math.PI) / 180;
        const label = makeSolarLabel(
          ZODIAC_SIGNS[k]!,
          "#93a9c9",
          0.42 * solarLabelScale,
        );
        (label.material as THREE.SpriteMaterial).opacity = 0;
        label.position.set(
          Math.cos(a) * (ZODIAC_R - 0.4),
          0,
          -Math.sin(a) * (ZODIAC_R - 0.4),
        );
        zodiacFrame.add(label);
        zodiacLabels.push(label);
      }
      // —— 十二宫抠图落位（2026-11-16 元灿工单「把星座
      // 本体抠出来呀，不要整张图贴在那」，声明段
      // zodiacCutoutMats 处有总注）：挂 zodiacFrame（随
      // 岁差框同转、与环/宫签相对构图恒定），门控走
      // zodiacFigVis（帧段）。
      // 竖摆口径（十二宫一律）：图面垂直于黄道平面、立
      // 在环上；落位 = 现 30° 单元格中心（λ = 30k+15°、
      // 与宫签同式）、环半径 ZODIAC_R。尺寸逐宫适配：
      // 最大边统一 2.0 世界单位、另一边按各宫源图宽高
      // 比（700×508–634）等比——落数（宽×高）：白羊
      // 2.00×1.64 / 金牛 2.00×1.59 / 双子 2.00×1.78 /
      // 巨蟹 2.00×1.81 / 狮子 2.00×1.74 / 处女 2.00×
      // 1.45 / 天秤 2.00×1.74 / 天蝎 2.00×1.76 / 射手
      // 2.00×1.51 / 摩羯 2.00×1.63 / 宝瓶 2.00×1.57 /
      // 双鱼 2.00×1.70；宽 2.0 仍小于宫格弧宽约 2.58、
      // 不侵邻宫。对齐 = 图心对格心：格心高度取整卡时
      // 代的卡心 1.04（旧卡 0.04..2.04 的中点），各宫图
      // 心恒落 (λ中心, 1.04, R) 一点、图形绕格心展开。
      // 双面可读（全览可拖转、绕到背面也要读正形）：每
      // 宫两片单面图背对背——正面片朝径向外侧、背面片
      // 朝径向内侧，两片沿径向错开 0.016 免共面闪烁；
      // 不用 DoubleSide 镜像糊弄。两片共用同一纹理与材
      // 质（同宫同淡变）。
      // 材质：MeshBasicMaterial 无光照（图自带明暗与辉
      // 光、不吃场景光）、sRGB 纹理、真 alpha 正常混合；
      // depthWrite 关——抠图大半面积是透明像素，开深度
      // 写入会把图后的星点/带光在透明区里 punched 掉；
      // 关后透明区如实透出后方，图体本身靠 alpha 成形。
      // 某宫纹理加载失败只置该宫 ok=false 恒隐，不再有
      // 任何回落图形（绘制版已整体删除）。
      {
        const cutGroup = new THREE.Group();
        zodiacFrame.add(cutGroup);
        zodiacCutoutGroup = cutGroup;
        const CUT_MAX = 2.0;
        const CUT_CY = 1.04;
        const texLoader = new THREE.TextureLoader();
        ZODIAC_CUTOUTS.forEach((cut, k) => {
          const rec: {
            mat: THREE.MeshBasicMaterial;
            base: number;
            ok: boolean;
          } = {
            mat: null as unknown as THREE.MeshBasicMaterial,
            base: 1,
            ok: true,
          };
          const tex = texLoader.load(
            cut.url,
            undefined,
            undefined,
            () => {
              rec.ok = false;
            },
          );
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          });
          rec.mat = mat;
          zodiacCutoutMats.push(rec);
          const s = CUT_MAX / Math.max(cut.w, cut.h);
          const pw = cut.w * s;
          const ph = cut.h * s;
          const geo = new THREE.PlaneGeometry(pw, ph);
          const lam = ((k * 30 + 15) * Math.PI) / 180;
          const cl = Math.cos(lam);
          const sl2 = Math.sin(lam);
          // 正面片：+Z 径向朝外、+Y 朝上（右手系由
          // x = y × z 唯一确定），自环外看正形
          const front = new THREE.Mesh(geo, mat);
          const frontBasis = new THREE.Matrix4().makeBasis(
            new THREE.Vector3(-sl2, 0, -cl),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(cl, 0, -sl2),
          );
          front.quaternion.setFromRotationMatrix(frontBasis);
          front.position.set(
            cl * (ZODIAC_R + 0.008),
            CUT_CY,
            -sl2 * (ZODIAC_R + 0.008),
          );
          cutGroup.add(front);
          // 背面片：绕竖轴翻 180°、+Z 径向朝内，自环内
          // （太阳侧）向外看同为正形
          const back = new THREE.Mesh(geo, mat);
          const backBasis = new THREE.Matrix4().makeBasis(
            new THREE.Vector3(sl2, 0, cl),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-cl, 0, sl2),
          );
          back.quaternion.setFromRotationMatrix(backBasis);
          back.position.set(
            cl * (ZODIAC_R - 0.008),
            CUT_CY,
            -sl2 * (ZODIAC_R - 0.008),
          );
          cutGroup.add(back);
        });
      }
// —— 黄道骨架星点与主星名签：已删除（2026-11-16 元灿
// 令「黄道星座之前的星星也要删了」）——原 88 颗骨架星
// 点（菱星节点/四角星芒/柔光晕三件 Points）、逐宫星表
// 数据 ZODIAC_FIGS、轮廓包围数据 ZODIAC_OUTLINES、一
// 宫一格适配 fitPt 与 14 枚主星名签（娄宿三/毕宿五/北
// 河二三/鬼宿四/轩辕十四/角宿一/氐宿四/心宿二/尾宿八/
// 箕宿三/牛宿一/虚宿一/外屏七）整体物理删除，无回落、
// 无开关。此前各轮的连线/绘制版图形删除账见
// DATA-PLAN。本层自此只剩：黄道环、刻度、十二宫名签、
// 十二宫抠图单体。删除范围只限黄道层——近览八颗地标
// 星、邻域真实星、背景星野不在此列、未动。
    }
    await sl.yieldNow();
    // —— 地心视线桥（2026-11-15 新增，用户原则「一个画面只许一个
    // 中心」落地）：太阳系全览是日心画面、管结构；一切读数归地
    // 心、管判断；黄道环在日心画面里只是方向参考环，不许默认
    // 「行星站在哪段就是落哪个宫」。点选一颗行星（或太阳/月亮）
    // 时，自地球当前场景位置向该天体画一条视线、延长打到黄道环
    // （R = 7.95×SOLAR_S，与环本体同半径），落点高亮，落点旁标
    // 地心落宫（宫名＋宫内度数）。读数走 moonPhase 地心链（行星
    // planetGeocentricEcliptic / 太阳 sunGeocentricEcliptic /
    // 月亮 moonEcliptic——与世事占星卡同源同函数，岁差已对齐当
    // 日回归黄道），不许另算一份。视线只在点选状态存在（sightK
    // 平滑淡入淡出、取消点选即收起），不进常驻构图；与彗星舞台
    // 轮值、背景八星全览隐藏各走各的门控、互不冲突。星街彗星
    // 是虚构客串（无地心链），不设视线。地球（2026-11-15 补
    // 洞，用户实报「点地球什么都没有」）：它本身是观察点、没
    // 有「从地球看地球」的方向，但点选它时画站在地球上最有
    // 意义的一条视线——地球→太阳（实线）再延到太阳的地心落
    // 点（虚线）：地球、太阳、落点三者恒共线（太阳地心黄经 =
    // 地球日心黄经 + 180°），这条线构造上无折角；信息牌口径
    // 见 App 的 BodySignReadings 地球分支。
    // 口径差与落点定法（审计 P1 修正后）：场景距离是压缩示意
    // （orbitR），若把视线自地球穿行星直延到环，落点方向与真
    // 实地心黄经存在视差差（实测火星 +9.6°、木星 +20.4°，跨
    // 宫——量测与成因见 DATA-PLAN 本轮条目），落点就会与标签
    // 读数互相矛盾、正是本原则要禁的镜像错误。故落点恒按地心
    // 链黄经落在环上：实线段 地球→行星（看的目标），虚线段
    // 行星→链落点（把读数投到环上的延长，虚线即「投影、非物
    // 理视线」的图面约定），落点/标签/环段三者恒一致；两方向
    // 的角度差（折角）由验收钩子逐帧量出、不藏。
    // 用色浅钢蓝白：不抢金（主操作/太阳）、红绿（行情）、青
    // （UI 强调）、奶金（黄道图形）等既有语义色。绘制账 +5
    // （实线/虚线/落点球/落点晕/标签精灵），纹理 +2（晕图/标
    // 签画布）。
    const SIGHT_RING_R = 7.95 * SOLAR_S;
    const sightGroup = new THREE.Group();
    solarGroup.add(sightGroup);
    const sightLineGeo = new THREE.BufferGeometry();
    sightLineGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const sightLineMat = new THREE.LineBasicMaterial({
      color: 0xb9cfe4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sightLine = new THREE.Line(sightLineGeo, sightLineMat);
    sightLine.frustumCulled = false;
    sightGroup.add(sightLine);
    // 延长段（行星→链落点）：虚线 = 把地心读数投到环上的投影
    // 约定，与实线段的物理视线分家（见上方口径注）
    const sightExtGeo = new THREE.BufferGeometry();
    sightExtGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const sightExtMat = new THREE.LineDashedMaterial({
      color: 0xb9cfe4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      dashSize: 0.09,
      gapSize: 0.06,
    });
    const sightExtLine = new THREE.Line(sightExtGeo, sightExtMat);
    sightExtLine.frustumCulled = false;
    sightGroup.add(sightExtLine);
    const sightDotMat = new THREE.MeshBasicMaterial({
      color: 0xe6f1fd,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sightDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 16, 12),
      sightDotMat,
    );
    sightGroup.add(sightDot);
    const sightHaloMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(
        "rgba(230,241,253,0.9)",
        "rgba(150,180,215,0.28)",
      ),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const sightHalo = new THREE.Sprite(sightHaloMat);
    sightHalo.scale.set(0.34, 0.34, 1);
    sightGroup.add(sightHalo);
    // 落点地心标签：可重绘画布精灵，文字随读数变、文本不变不重绘
    const sightLabelCanvas = document.createElement("canvas");
    sightLabelCanvas.width = 512;
    sightLabelCanvas.height = 128;
    const sightLabelTex = new THREE.CanvasTexture(sightLabelCanvas);
    sightLabelTex.colorSpace = THREE.SRGBColorSpace;
    const sightLabelMat = new THREE.SpriteMaterial({
      map: sightLabelTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const sightLabel = new THREE.Sprite(sightLabelMat);
    sightLabel.renderOrder = 12;
    sightGroup.add(sightLabel);
    let sightLabelText = "";
    const drawSightLabel = (text: string): void => {
      if (text === sightLabelText) return;
      sightLabelText = text;
      const g = sightLabelCanvas.getContext("2d")!;
      g.clearRect(0, 0, 512, 128);
      g.font = "500 46px 'Noto Sans SC', system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 8;
      g.lineJoin = "round";
      g.strokeStyle = "rgba(3,8,18,0.85)";
      g.strokeText(text, 256, 66);
      g.fillStyle = "#eef4fc";
      g.fillText(text, 256, 66);
      sightLabelTex.needsUpdate = true;
    };
    sightGroup.visible = false;
    /** 视线在位系数（0..1，animate 指数趋近，与 zodiacFigK 同语法） */
    let sightK = 0;
    const sightE = new THREE.Vector3();
    const sightT = new THREE.Vector3();
    const sightL = new THREE.Vector3();
    /** 视线验收钩子读数（animate 逐帧写）：sceneGeoDeg = 地球→
     * 目标的场景方向黄经、chainGeoDeg = 同帧地心链黄经（落点与
     * 标签按它落位）、bendDeg = 两者之差（虚线段的折角，示意
     * 视差的量测本体）——供审计探针直接读数，不靠肉眼估 */
    const sightState: {
      id: string | null;
      k: number;
      sceneGeoDeg: number | null;
      chainGeoDeg: number | null;
      bendDeg: number | null;
      label: string;
    } = {
      id: null,
      k: 0,
      sceneGeoDeg: null,
      chainGeoDeg: null,
      bendDeg: null,
      label: "",
    };
    (window as unknown as Record<string, unknown>).__financeGlobeSight =
      {
        state: () => ({ ...sightState }),
        // 天体屏幕坐标（画布相对 px，验收探针据此发真实点按走
        // handleTap 全链，而不是绕过点选直接写状态——A2 逐颗
        // 触发实测口径）；pos/半径与点按兜底判定同一 bodyWorldInfo
        bodyPx: (id: string) => {
          const info = bodyWorldInfo(id);
          if (!info) return null;
          const rect = el.getBoundingClientRect();
          const v = info.pos.clone().project(camera);
          return {
            x: ((v.x + 1) / 2) * rect.width,
            y: ((1 - v.y) / 2) * rect.height,
            behind: v.z >= 1,
          };
        },
      };
    await sl.yieldNow();
    // —— 莫比乌斯带客串（太阳系故事层，2026-11-15，用户令「先做
    // 莫比乌斯环客串」；克莱因瓶明确不在本轮，只在小卡文案里提
    // 一句、不做瓶体）——
    // 本体：一条参数曲面莫比乌斯带，斜挂在太阳系外圈、整体缓慢
    // 自转。
    // —— 质感纠正轮（2026-11-15 晚，用户真机裁决「不按照参
    // 考来做、出入太大了」＋纠正单）：此前各轮的克制条款
    // （「亮度压在数据层之下」「峰值不透明度 0.16」「低饱
    // 和」）与用户指定参考（3.7 开屏原片 BV1xq1nBmE4e 扭
    // 带段）冲突、**即时作废**；让位原则改为靠层次与透明
    // 度让位、不靠饿瘦自己。本轮以参考为唯一标准重做质
    // 感：带宽 0.22 → 0.40、带面峰值不透明度 0.16 → 0.50
    // （半透厚度）、双面渐变饱和上调 + 白色热芯线 + 流光
    // 提速、边缘加光鞘（三角带承载光边，不再只有 1px
    // 线）。形状（横置 ∞＋星扣＋双带尾）、双面色体系、翻
    // 面机制、摆位/倾角/门控一字不变——错的是质感营养，
    // 不是骨架。逐项对照自评见 DATA-PLAN 本轮条目。
    // —— 蝴蝶结形改版（2026-11-15 晚，用户指认「昔涟真正的标志
    // 物是她手里的莫比乌斯环，像蝴蝶结」；官方名「象征翁法罗斯
    // 的莫比乌斯手环」）——带不再是均匀圆环。当晚 20:22 用户
    // 亲口钉死轮廓硬线（工单六）：「你那个环也要做成 ♾️ 形，
    // 不能是圆形」——上一版「大环绕盘＋小环下垂」纵向构图作
    // 废（第一眼读出的是「环＋坠子」不是 ♾️）。中心线重做为
    // 横置 ∞（Gerono 双纽线，见 MOB_INF_A）：两瓣左右并列、
    // 共用正中心交叉点，星扣（粉白星芒五角星，工单七改色）
    // 压在正中心交叉点上，双带尾仍垂在扣下（一粉一蓝、轻
    // 摆）。∞ 半宽 4.72、带面最远 ≈4.83 < 黄道环 4.929，取
    // 景一字未动；工单八：摆位与倾角锁定现行出货值，路径只
    // 在现摆位内部重做。两支在交叉点以 y = ±0.06 错层相交
    // （sin u 沿程），不共面穿插。
    // 几何诚实：仍是真莫比乌斯带——带面 P(u, v) = C(u) +
    // v·W(u)，W = cosψ·E1 + sinψ·ŷ（E1 为中心线切向在带面内
    // 旋 90°），半扭转 ψ(u) 总量恒为 π，但集中在星扣窗口
    // （u = MOB_U1 ± 0.15 的 smoothstep 段）内累积：扣前 ψ≈0、
    // 扣后 ψ≈π。接缝纪律不变：u = 2π 列顶点取 v 反号落位
    // ——P(2π, v) ≡ P(0, −v)，网格按此闭合、无裂缝无重叠。
    // 带面半透明（峰值不透明度 0.50，纠正轮口径——旧
    // 「压在数据层之下、峰值 0.16」条款已作废，见上方纠
    // 正轮注）。色彩定版（工单七，2026-11-15：只
    // 认 3.7 开屏一个来源，覆盖此前从终结技/立绘拼出的配
    // 色）：带面改双面体系、以面定色（shader 按
    // gl_FrontFacing 分面）——一面暖色渐变 金橙→绿→青蓝
    // （带星光颗粒、沿带面缓行，即开屏扭带的流转，不再另
    // 叠虹彩层）、另一面 银白→粉紫；过星扣后哪一面朝外互
    // 换，由 ψ 在扣附近的 π 扭转从几何里长出来，不手动贴
    // 换。此前「粉/品红边 vs 青蓝边」的边缘分色就此作废：
    // 边界仍按双圈 τ∈[0,2) 描一整圈（莫比乌斯带只有一条
    // 边界曲线），两条边缘统一改亮白发光线（主线＋加色辉
    // 光线同几何叠加），带面内另有极细光丝（shader 调制）。
    // 行走光点（核心机制）：一颗光点沿带面中心线（v = 0）行
    // 走，周期 MOB_PERIOD_S = 90 秒/圈（会话时钟，与彗星舞台
    // 同口径：t 为打开空间起的会话秒；reduced-motion 冻结在起
    // 始相位）。光点带不对称标记（侧向箭鳍 + 偏置小球）：标记
    // 的朝向逐帧由带面局部标架导出——切向 T（中心线中央差
    // 分）、横向 W(u)、法向 N = T×W，标记组四元数由
    // makeBasis(T, W, N) 逐帧设定。u 推进 2π 时 ψ 累积 π、W
    // 与 N 同步反号：标记走完一圈回到同一点时呈镜像翻转（鳍
    // 尖反向、小球落到带面另一侧），第二圈复原——翻转从几何
    // 里长出来，无贴图切换、无手动翻转。翻面集中发生在过星
    // 扣瞬间（ψ 窗口即在扣处），迸散也收在扣处爆发。验收钩
    // 子 __financeGlobeMobius 可确定性跳相位（setPhase(圈
    // 数)）取翻面对比帧、frameAt(圈数) 读标架数值。
    // 模式显隐（与黄道图形同门控）：只在太阳系**全览**在位
    // （mobVis = sunFade × zodiacFigK × (1−eG)）——主页不显、
    // 近览/聚焦不显、银河不显；默认不挂名签（故事层规矩）。
    // 点选：点中带体/光点（行星命中优先、本元素最后裁决，见
    // handleTap 太阳系分支）→ 带体提亮 + 弹故事层小卡（玫瑰
    // 色调、明标「故事层 · 意象」，与数据层玻璃卡视觉分家）；
    // 再点带体或点别处收起。不进 solarHitList / planetVis /
    // 聚焦矩阵，不碰黄道环、星历、ψ(t)、视线桥与任何读数。
    // 性能账：参数网格 1 张（240×8）+ 边界线 1 + 光点 4 件，
    // 逐帧只算一组标架，零新增渲染通道。
    // —— 视觉定调改版（2026-11-15 晚，用户问「可以做成昔涟大
    // 招的样子吗」；同晚主座逐帧核 BWIKI 终结技演示 GIF＋实
    // 机视频后紧急修订，冲突处以修订为准）：只换外观与动效语
    // 言，几何/取景/周期/标架翻面/门控/点选裁决一律不变。昔
    // 涟（《崩坏：星穹铁道》）终结技名即「诗的『。』，誓约的
    // 『∞』」，施放后展开「往昔的涟漪」结界。实机主参考是缎
    // 带涡旋：宽、扁、半透明缎带，渐变 白 → 粉 → 淡蓝，带身
    // 光泽边缘，缓慢翻卷流动——照其配色/质感/动效语言原创实
    // 现（不搬运、不描摹游戏素材）：① 带面改白→粉→淡蓝缎带
    // 渐变半透，边缘光泽描边（shader 沿边界相位流动，粉金只
    // 作流光峰值的微光、不作主色）+ 光尘微粒 90 粒沿带面稀
    // 疏漂移，整体随既有自转慢翻卷；② 行走光点 = 涟漪源（与
    // 她启动时水面平台的涟漪纹同源），身后在带面上周期扩散
    // 细涟漪环（池 6 枚），扩散到带宽边缘衰减消失；③ 光点每
    // 走完一圈、翻面瞬间迸出一小簇粉紫水晶碎片（棱柱小片，
    // 品红芯/青边两色）向外飞散 + 一点白色星爆，随即收净——
    // 只是视觉标点，翻面判定仍靠标记镜像；全元素无花瓣/花朵
    // （实机没有花瓣雨，粒子语言是粉色星形光点、白色光尘、
    // 亮白星爆与粉紫水晶棱柱）；④ 点选时一圈涟漪光自点选处
    // 沿带面扩散至全带（结界展开动势，波前 shader 覆膜与带
    // 体共用几何），随后提亮停驻；收起反向收净；⑤ 小卡在原
    // 三行后加一行出处，标明致敬。另：实机全程无弓（「粉金
    // 长弓」是付费专武外观的文字资料、已撤销），本元素不加
    // 任何弓形元素。
    // 新增绘制账：光尘点云 1（90 粒）+ 涟漪线池 6 + 水晶碎
    // 片 14 小片 + 星爆精灵 1 + 波前覆膜 1（共用带体几何）+
    // 边界改 shader 材质（绘制数不变）——全是廉价实现，无
    // 持续高开销通道。
    // —— 蝴蝶结形改版的增删（2026-11-15 晚续）：⑥ 点选收尾
    // 的平面 ∞ 光痕**撤销并清除干净**——带本身已是 ∞/蝴蝶结
    // 形，不再另画（本段上方 ④ 的光痕条款与下方绘制账中的
    // 「∞ 光痕线 1」均已作废）；⑦ 星扣（金星 + 辉光）1 组 +
    // 双带尾 2 条为本轮新增绘制，边界改顶点色双色线（绘制
    // 数不变）。
    // —— 开屏定版轮（2026-11-15 20:20–20:24，工单四～八连
    // 续定版，冲突处以最晚为准）：⑧ 形状按工单六改横置 ∞
    // （见上方改版段）；⑨ 色彩按工单七只认开屏：带面双面
    // 体系（暖面金橙→绿→青蓝流转＋星光颗粒／背面银白→粉
    // 紫，shader 以面定色）、边缘亮白发光线、星扣改粉白星
    // 芒（⑦ 的金星作废）、④ 的「全元素无花瓣」结论被工单
    // 四推翻一半——元灿亲自指定开屏参考（00:56 转场有粉紫
    // 花瓣飘落）：结周加 6 片粉紫花瓣光斑稀疏漂移；但 ③ 的
    // 翻面迸散仍是粉紫水晶碎片、不许换花瓣，花瓣只此一
    // 处；⑩ 位置按工单八锁定：太阳系全览、现摆位与倾角不
    // 动。小卡出处行尾补「质感取自 3.7 开屏动画」。
    // —— 位置上调（2026-11-15 22:42 元灿本人开口，⑩ 锁
    // 的例外）：整体沿组本地 +Y 上抬（见 mobOuter 处
    // MOB_LIFT 注：天花板实测与读法口径都在那里）；同日
    // 23:39 元灿再令继续上抬，MOB_LIFT 1.50 → 1.75（抬满
    // 至天花板内最后一格，账目同在 MOB_LIFT 注）。
    // 2026-11-16 元灿再令「位置再调高一些，环的角度可以
    // 再稍微调整」：MOB_LIFT 1.75 → 2.00、mobTilt 微调
    // (0.42,0,0.16) → (0.34,0,0.12) 腾挪（账目同在
    // MOB_LIFT 注）；同轮高亮改回点击触发（见帧段注）。
    // 本轮新增绘制账：边缘辉光线 1（与主线同几何）+ 花瓣
    // 精灵 6；带面改 shader（绘制数不变）；既有效果零删改。
    // —— 双纽线缎带重生成轮（2026-11-16，元灿亲截四帧＋
    // 慢放帧定调：「这个视频里面也是有扭转的深度的呀，你
    // 没看见人站在中间吗」）——带按昔涟开屏/慢放视频里的
    // 双纽线缎带在代码里参数化重建（非图生 GLB），替换原
    // 平面 ∞ 带网格：
    // · 形：宽幅飘带——带宽沿程分布（瓣中段最宽、交叉与
    //   瓣尖收束），边缘沿法向波浪起伏（纱感），半透。
    // · 扭转与深度（本轮头条）：中心线离开单一平面——深
    //   度项 D·cos u·sin²u 使两瓣中段一前一后倾出/倾入
    //   （瓣尖与交叉点深度归零），带从中心轴空间的前方与
    //   后方分别穿过，像绕着站在中间的人；静帧可读前后
    //   层次。莫比乌斯半扭转 ψ（总量 π、集中星扣窗口）
    //   原样保留并融入：标架构造一字未改，离线复算任意
    //   morph 下走完一圈 W·W′ = N·N′ = −1.0000（机器精
    //   度）、接缝 P(2π,v) ≡ P(0,−v) 精确——行走点翻面
    //   演示成立（止损轨未触发）。
    // · 可变：收拢态（视频一 ∞ 环绕）⇄ 展开态（视频二
    //   两瓣大张）周期变形（周期/波形经展开返工轮重塑
    //   为 48 秒分段停留式，见 MOB_MORPH_HOLD_WRAP_S 处
    //   注）——morph m 驱动深度幅度 D（1.2→1.7，峰值深
    //   度 0.46→0.65）、瓣压扁 kz（0.50→0.27）、带宽分
    //   布（基宽 ×1.0→1.18、瓣中段隆起 0.10→0.45）；拓
    //   扑与扭转全程不破。位置 MOB_LIFT = 2.00、倾角
    //   (0.34, 0, 0.12)、太阳中轴、全览门控一字未动；取
    //   景账（离线同式全相位扫描）：新几何最坏相位顶部较
    //   出货态 +0.07 本地单位，在出货鞘尖名义余量
    //   (−0.075) 同档内，带体完整在框。
    // · 展开端点重定＋镜头联动（2026-11-16 涨满轮，元灿
    //   B 案）：上条端点作废——展开态改照参考图定：半
    //   宽 A 4.72→7.60（mobA）、kz 0.50→0.13（mobKz）、
    //   中心线加 S 形涌动波浪（mobCenterAt 内注）、星扣
    //   随 m 缩成正中小亮点（帧段）；展开相位里全览镜
    //   头同步拉远（MOB_DOLLY_MAX，涨满轮 1.22、展开返
    //   工轮加大至 1.38，帧段 solarTargetZ 处注）、收
    //   拢精确回位。展开态瓣尖
    //   有意越出黄道环（≈7.95 对环 4.929）——图片的涨
    //   满感正来自溢出，半透带面从立卡前飘过、不做避
    //   让；收拢态几何与取景逐字回到本轮前定版。
    // · 瓣孔张开（2026-11-16 瓣孔张开轮，元灿真机判
    //   「环变化也没有打开呀，只不过是拉长了」）：上条
    //   的 kz 0.50→0.13 作废——morph 主对象自横向缩放
    //   改判为瓣孔张开度：kz 0.50→0.28 + z 向主浪幅
    //   0.85→1.50（落数与不变量见 mobKz / mobCenterAt
    //   内注）；半宽 A 4.72→7.60、48 秒节律（20/7/14/
    //   7）、镜头拉远 1.38、结点收紧口径不变；展开态
    //   纵向半幅升至约 2.1 本地单位，拉远 1.38 后的取
    //   景半高约 7.1——带体纵向仍完整在框（验收帧复
    //   核）。【本条已被下条取代：kz/主浪口径退役】
    // · 展开第三次返工（2026-11-16，元灿：「环还是没
    //   打开，你参考我发你的4张图其中两张打开的样子
    //   制作呀」）：病根判定 = 双纽线骨架本身（股线离
    //   结即回弯成水滴瓣、楔形张不开），上条的 kz/主
    //   浪调参整套退役。展开端点单独定义新中心线
    //   （mobCenterOpen：结点居中收紧、股线按 mobOpenR
    //   分离剖面陡角张开——|x|≈2.5 分离 ≥4.5、峰值
    //   ≈5.5、末端回卷 ≈4、股身 S 波 ±0.5），morph 改
    //   为收拢双纽线（mobCenterClosed，逐字定版）与该
    //   端点之间的逐点插值；带宽/扭转框随新中心线切
    //   线逐点重算（mobFrameAt/mobHalfW 既有机制）；
    //   48 秒节律、拉远 1.38、收拢端形态逐字不变（落
    //   数与 m = 0/0.5/1 翻面复核见 mobOpenR 注与
    //   DATA-PLAN 本轮条目）。【本条的展开端点（双纽线
    //   骨架＋mobOpenR 剖面）已被 X 改判轮整套取代】
    // · 屏幕读数返工（2026-11-16，元灿「环还是连着
    //   的」；麻衣读探针展开帧 observe-003/004 定案）：
    //   上条的中心线数据没错、错在屏幕读数三条——① 带
    //   面斜躺（场景倾 0.55＋静息倾角）被透视压扁、楔
    //   形读不出；② 瓣尖 U 形折返点落在帧内、肉眼可见
    //   地连着；③ 带色被着色器白色叠加（等通道流光高
    //   光＋白光涌＋带缘掺白＋宽热芯）洗成白透。本轮：
    //   展开相位把带组转正对镜头（帧段逐帧按相机基向
    //   量解算、m 驱动、停留段完全正对）＋带组等比放
    //   大到瓣尖冲出左右帧边（帧内无合拢点、结点恒居
    //   中）＋带面体量（半宽 morph 系数 0.18→0.45、峰
    //   值不透明度 0.50→0.725）＋色彩管线去白（流光/
    //   光涌改蓝紫 tint、带缘直达采样色 #A4C6FD、热
    //   芯收窄成白炽细线、光场近白掺入收 3/4）＋星尘
    //   闪点加密增亮、结点光针提亮。验收只认屏幕读数
    //   （展开停留帧：结点星芒居中、四股大角度张开、
    //   1/4 宽处股距 ≥ 画高约 25%、帧内无合拢点、带
    //   色饱和蓝紫），与四张参考图（5EF04FF5 构图／
    //   C784DF3E 迸开与光针／A3B47D08 体量与星尘／
    //   7EE50D9C 纵深交叉）并置对照；收拢端逐字不变、
    //   48 秒节律与拉远 1.38 不变。落数见帧段转正+冲
    //   框注与 DATA-PLAN 本轮条目。【本条的展开形态已
    //   被下条取代：落点/色彩口径保留、中心线改判；其
    //   「转正」再被不锁视角轮整条作废（见最新条目）】
    // · 展开改判 X（2026-11-16，元灿两度点明：「打开
    //   后是一个 x」「我的意思不是放大，而是带子直接
    //   断开，变成 X」）：领结方向（含同轮在途的「股线
    //   弧度」工单）整套作废——展开态改直通配对：带在
    //   结点处断开重连，左上股直通右下股、左下股直通
    //   右上股，成为两条独立 S 形光带交叉成 X（参考图
    //   5EF04FF5），展开态不再有任何闭合瓣环。实现 =
    //   mobCenterOpen 按八分段重排点序（正描一臂＋回
    //   描同臂交替、回描段宽度由 mobOpenPinch 收至≈
    //   零藏进结点星芒）＋ mobOpenBandPoint 两带路径
    //   （落数/不变量复核见各函数注与 DATA-PLAN 本轮
    //   条目）；正对镜头、臂尖落点（距心 7.60 帧边内
    //   侧）、拉远 1.38、48 秒节律、色彩/辉光/粒子、
    //   点击高亮与信息牌全部保留，收拢端逐字不变。
    //   【本条的「正对镜头」与对称落点已被下条取代】
    // · 不锁视角＋X 不正＋原图重采样＋带面还原（2026-
    //   11-16，元灿三令：「变形的时候不用锁视角」「x
    //   形状不要太正，参考我之前给你的图」「色彩和参
    //   考图上的不像／变形前环上有很多效果和线，你要
    //   还原出来」）：① 转正整条作废——变形期间带组姿
    //   态恒静息、不做任何朝向锁定/抵消（帧段落框注）；
    //   ② X 改不正——四臂独立定参（角度 21°/17°/40°/
    //   47° 互不等、长度 7.60/7.35/6.55/6.30 互不等、
    //   波浪各异、带宽沿臂收放末端羽化，mobOpenBand-
    //   Point / mobOpenPinch 注），对称 X 作废；③ 色彩
    //   权威换源——旧采样表降为线索，带面/缘/芯/光场色
    //   逐值改从四张原图文件直采＋着色器饱和定版（管线
    //   洗淡按故障修，采样账见 DATA-PLAN 本轮条目）；
    //   ④ 收拢带面效果层五项还原（发丝线群/交叉交织＋
    //   层叠纱光/四角星尘/玻璃晶缘/珠点，带面着色器效
    //   果层注）——只加 (vU, vV) 效果层、随 morph 连续
    //   带过去，收拢中心线与既有机制逐字不动。48 秒节
    //   律、拉远 1.38、臂尖落点（帧边内侧）、点击高亮
    //   与信息牌不变。
    // · 色/光/粒子全套只从参考帧取（元灿令「不要自己乱
    //   定」）：展开蓝带芯 #3446D3/#474FE0/#5578F9、带缘
    //   #839DFC/#A4C6FD、结点紫 #6352DF/#7B81F9（慢放
    //   11.5s 帧＋元灿截图 3）；环绕粉紫 #CC9DCC/#DAB4D7/
    //   #C880B4、冰青 #5ACAE7/#A4D2E4、近白 #E6D5E0、暖
    //   弧珊瑚 #D16266（开屏 9.0s 帧）。【本条色值已被
    //   不锁视角轮的原图文件直采整套取代——旧表降为线
    //   索，见最新条目与带面着色器色板注】旧暖面虹彩（金橙
    //   →绿→青蓝）就此退役。光效：白热芯线＋宽幅柔辉光
    //   晕、结点四角星芒、展开态结点细直光针；粒子：四
    //   角星尘（粉/蓝/白）、带边玻璃水晶碎片、星扣花瓣
    //   与结晶迸散同语言对齐。规格取现行场景上限档（分
    //   段 360×12、辉光晕加宽、星尘/微粒增密），逐帧几何
    //   重建靠标架缓存共享（带面/光场共用一遍标架）承载。
    // 带宽（纠正轮 0.22 → 0.40 对参考的宽缎带比例；收拢
    // 态带面最远 4.72 + 0.20 = 4.92 仍在黄道环半径
    // 4.929 内侧；展开态瓣尖 7.60 越环，见涨满轮注）
    const MOB_W = 0.4;
    // morph 节律（2026-11-16 展开返工轮，元灿真机复判
    // 「环还是不能展开呀」后的诊断与重塑，诊断全账见
    // DATA-PLAN 本轮条目）：旧波形 m = 0.5 − 0.5·cos
    // (2π·clock/56) 全程爬行——展开与收拢各拖 28 秒、
    // m = 1 只是余弦顶点的一瞬路过、两端零停留，任何
    // 一眼瞥见的都是半开的过渡态，「展开」作为事件从
    // 未发生过。新波形改分段停留式：收拢停留 20s →
    // 7s 果断展开（smoothstep）→ 展开停留 14s（m 恒
    // 1、镜头拉远随 m 同步全程保持）→ 7s 收回，周期
    // 48s。展开自此是一个停留得住的状态。
    const MOB_MORPH_HOLD_WRAP_S = 20;
    const MOB_MORPH_EXPAND_S = 7;
    const MOB_MORPH_HOLD_OPEN_S = 14;
    const MOB_MORPH_CONTRACT_S = 7;
    /** morph 周期（秒）：四段之和 = 48 */
    const MOB_MORPH_PERIOD_S =
      MOB_MORPH_HOLD_WRAP_S +
      MOB_MORPH_EXPAND_S +
      MOB_MORPH_HOLD_OPEN_S +
      MOB_MORPH_CONTRACT_S;
    /** morph 波形：分段停留式（节律见上方注） */
    const mobMorphWave = (clock: number): number => {
      const ph = clock % MOB_MORPH_PERIOD_S;
      if (ph < MOB_MORPH_HOLD_WRAP_S) return 0;
      const expandEnd =
        MOB_MORPH_HOLD_WRAP_S + MOB_MORPH_EXPAND_S;
      if (ph < expandEnd) {
        const x =
          (ph - MOB_MORPH_HOLD_WRAP_S) / MOB_MORPH_EXPAND_S;
        return x * x * (3 - 2 * x);
      }
      const openEnd = expandEnd + MOB_MORPH_HOLD_OPEN_S;
      if (ph < openEnd) return 1;
      const x = (ph - openEnd) / MOB_MORPH_CONTRACT_S;
      const s = x * x * (3 - 2 * x);
      return 1 - s;
    };
    const MOB_PERIOD_S = 90;
    const MOB_U0 = 2.4;
    // —— 横置 ∞ 中心线（工单六定版，2026-11-15 20:22 元灿
    // 亲口：「你那个环也要做成 ♾️ 形，不能是圆形」；工单八：
    // 摆位/倾角锁定现行出货值，路径只在现摆位内部重做）——
    // 星扣相位 = ∞ 正中心交叉点（u = π/2 支）：光点每圈两
    // 次过心，ψ 的 π 扭转集中在此支窗口内累积、翻面与迸散
    // 都收在此处；另一支（u = 3π/2）以 y 错层在其下通过
    const MOB_U1 = Math.PI / 2;
    // 半扭转 ψ 的集中窗口半宽（相位弧度）：ψ 在星扣前后
    // ±MOB_TWIST_D 内以 smoothstep 累积满 π，其余相位恒 0/π
    const MOB_TWIST_D = 0.15;
    // ∞ 半宽基值（收拢态瓣尖距心）：瓣尖 |C| = 4.72、带
    // 面最远 ≈4.83，在黄道环半径 4.929 之内；展开态由
    // mobA 放大到 7.60（涨满轮，有意越环，见 mobA 注）
    const MOB_INF_A = 4.72;
    const mobWrapU = (uu: number): number =>
      ((uu % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    // —— morph 状态（双纽线缎带重生成轮）：mobMorphM ∈
    // [0, 1]（0 = 收拢环绕态、1 = 展开态），帧段按 48 秒
    // 分段停留节律推进（相位覆盖/reduced-motion 时冻结，
    // 见帧段与 MOB_MORPH_HOLD_WRAP_S 处注）；
    // mobWavePh = 带缘波浪相位（随会话时钟 mobTime 走、
    // 同口径冻结）。中心线/带宽/点位函数全部读这两个全
    // 局量，构建期初值 = 收拢态静帧
    let mobMorphM = 0;
    let mobWavePh = 0;
    let mobMorphPin: number | null = null;
    let mobSpinPin: number | null = null;
    /** 展开端点臂尖距心上限：7.60、有意越出黄道环
     * （涨满轮定版，见 MOB_DOLLY_MAX 注；X 不正轮起为
     * 四臂臂长上限——最长臂（左上）取此值、余臂各短，
     * 落点口径不变） */
    const MOB_OPEN_A = 7.6;
    /**
     * 展开端点单带路径 mobOpenBandPoint(band, t)——【X
     * 不正轮 2026-11-16，元灿：「x 形状不要太正，参考
     * 我之前给你的图」】X 改判轮的落点（两带同长 7.60、
     * 同走 45° 对角、交叉角 ≈91°、四臂镜像对称）整套
     * 作废——太正正是病。展开态照展开蓝图 5EF04FF5 的
     * 完整画面重描：两条带仍在结点断开直通（配对不
     * 变：band 0 = 左下↔右上、band 1 = 左上↔右下），
     * 但四臂各自独立定参（MOB_OPEN_ARMS）：角度互不
     * 相等（左上 21°／右下 17° 一带浅、右上 40°／左
     * 下 47° 一带陡，两带在结点处各带 4°／7° 折角、
     * 不共线）、长度互不相等（左上 7.60 最长、右下
     * 7.35 长尾、右上 6.55、左下 6.30）、波浪各异
     * （左上滚浪、右上隆峰后卷落、左下近直微垂、右下
     * 潜波长尾）。臂尖最大距心仍 = MOB_OPEN_A = 7.60
     * （落点口径不变、帧边内侧）。带身：a = |t|、拉
     * 伸坐标 sh = a^1.5（近结点波浪斜率归零、切向在
     * 结点处恒为本臂基向）、法向（基向在带面内旋
     * +90°）偏移 off = A1·sin(π·sh) + A2·sin(2π·sh)
     * （sh = 1 时恒 0、臂尖落基向延长线上）。纵深：
     * 0.38·off·(1−0.3a) ＋ 结点错层 ±0.17·exp(−(t/
     * 0.22)²)——band 1 在结点前方（+0.17）掠过、
     * band 0 在后方（−0.17），照参考图一前一后。臂
     * 尖 y 归零（落回带面）。
     */
    interface MobOpenArm {
      /** 基向（带面内单位向量 x/z 分量） */
      dx: number;
      dz: number;
      /** 臂长（臂尖距心） */
      len: number;
      /** 波浪一/二谐幅（法向，带符号） */
      a1: number;
      a2: number;
    }
    const mobOpenArm = (
      deg: number,
      len: number,
      a1: number,
      a2: number,
    ): MobOpenArm => {
      const r = (deg * Math.PI) / 180;
      return { dx: Math.cos(r), dz: Math.sin(r), len, a1, a2 };
    };
    // 四臂定参（照 5EF04FF5 帧上读数：结点近帧心、四
    // 臂出射角/相对长度/波浪走向逐臂读出后按落点口径
    // 落数）。角度口径 = 带的穿行方向（t 递增方向）自
    // +x 轴起、带面内量：正向臂的穿行方向即臂尖方向；
    // 负向臂穿行方向 = 臂尖方向 − 180°（臂尖落 −d·L
    // 处）——四臂臂尖方向 = 右上 40°／左下 227°／右
    // 下 −17°／左上 159°，互不等角
    const MOB_OPEN_ARMS = {
      // band 0 正向 = 右上：臂尖 40° 陡上、隆峰后卷落
      b0p: mobOpenArm(40, 6.55, 1.0, 0.35),
      // band 0 负向 = 左下：臂尖 227° 陡下、近直微垂
      b0n: mobOpenArm(47, 6.3, -0.38, -0.12),
      // band 1 正向 = 右下：臂尖 17° 浅出、潜波长尾
      b1p: mobOpenArm(-17, 7.35, -0.55, -0.14),
      // band 1 负向 = 左上：臂尖 159° 浅上、最长、滚浪
      b1n: mobOpenArm(-21, 7.6, 0.8, 0.3),
    };
    const mobOpenBandPoint = (
      band: 0 | 1,
      t: number,
      out: THREE.Vector3,
    ): THREE.Vector3 => {
      const arm =
        band === 0
          ? t >= 0
            ? MOB_OPEN_ARMS.b0p
            : MOB_OPEN_ARMS.b0n
          : t >= 0
            ? MOB_OPEN_ARMS.b1p
            : MOB_OPEN_ARMS.b1n;
      const a = Math.abs(t);
      const sh = Math.pow(a, 1.5);
      const off =
        arm.a1 * Math.sin(Math.PI * sh) +
        arm.a2 * Math.sin(2 * Math.PI * sh);
      const along = arm.len * t;
      const y =
        0.38 * off * (1 - 0.3 * a) +
        (band === 0 ? -0.17 : 0.17) *
          Math.exp(-((t / 0.22) * (t / 0.22)));
      return out.set(
        arm.dx * along - arm.dz * off,
        y,
        arm.dz * along + arm.dx * off,
      );
    };
    /**
     * 展开态带宽收分因子（X 改判轮建制、X 不正轮改剖
     * 面）：u 按八分段读——偶数段 = 臂的正描（结点→
     * 臂尖），奇数段 = 同臂回描（跳接段）。回描段因子
     * 0.012（≈零宽、渲染不可见，只承载点序把网格带回
     * 结点；取非零纯为避开 mobWaveDisp 的 |v|/hw 除
     * 零）；正描段沿臂收放（照 5EF04FF5 带宽读法）：
     * 结点端收细至 0.05（带在结点处断开、四臂各自收
     * 进星芒）、tau ≈ 0.30 涨到本臂峰宽（中段膨大）、
     * 末端 tau 0.78→1 羽化收尖至 ≈0.07（兼避回描折
     * 返点的切向退化列）。四臂峰宽互不相等（右上
     * 0.95／左下 0.90／左上 1.00／右下 0.92）、不镜
     * 像。mobHalfW 以 (1 − m·(1 − 本因子)) 混入：
     * m = 0 时恒 1、收拢态逐字不变。
     */
    const mobOpenPinch = (u: number): number => {
      const eighth = Math.floor(u / (Math.PI / 4)) % 8;
      if (eighth % 2 === 1) return 0.012;
      const tau =
        (u - Math.floor(u / (Math.PI / 4)) * (Math.PI / 4)) /
        (Math.PI / 4);
      // 偶数段 = 四臂正描（0 右上／2 左下／4 左上／6
      // 右下，段序见 mobCenterOpen 注）
      const peak =
        eighth === 0
          ? 0.95
          : eighth === 2
            ? 0.9
            : eighth === 4
              ? 1.0
              : 0.92;
      const grow =
        0.05 +
        (peak - 0.05) * THREE.MathUtils.smoothstep(tau, 0, 0.3);
      const tipT =
        1 - 0.93 * THREE.MathUtils.smoothstep(tau, 0.78, 1);
      return grow * tipT;
    };
    /** 全览镜头联动拉远上限（涨满轮 1.22 → 展开返工轮
     * 1.38）：展开端点处 solarTargetZ 的乘子，收拢端点
     * 恒 1（见帧段注）。落数依据：展开态带面横向半幅
     * ≈7.60（瓣尖）+ 波浪 0.55 + 半宽 0.34 ≈ 8.5、连
     * 同结点光针/星尘外扩约 9.3，对全览拟合半径 7.95
     * 需 ×1.17 起步才不裁边；1.38 让带体涨满宽幅的同
     * 时瓣尖与光针仍留边距，收拢回 1.000 定版取景 */
    const MOB_DOLLY_MAX = 1.38;
    /**
     * 带面半宽 hw(u)：沿程分布——基宽随 morph ×(1+0.45m)
     * （屏幕读数返工轮自 0.18 加大：展开态带面要有体量、
     * 不是一条薄纱线——开屏主图 A3B47D08 的宽阔缎带口
     * 径；m = 0 时系数恒 1、收拢态逐字不变）、瓣中段
     * （u ≈ π/4 + k·π/2）隆起 (0.10→0.45)、交叉与瓣尖
     * 回基宽。最宽（展开瓣中段）0.42、最窄（收拢）0.20
     */
    const mobHalfW = (u: number): number =>
      (MOB_W / 2) *
      (1 + 0.45 * mobMorphM) *
      (1 +
        (0.1 + 0.35 * mobMorphM) *
          (0.5 - 0.5 * Math.cos(4 * u))) *
      // X 改判轮：展开态按八分段收分（回描段≈零宽、四
      // 臂在结点断开，见 mobOpenPinch）；因子以 m 混入，
      // m = 0 恒 1、收拢态逐字不变
      (1 - mobMorphM * (1 - mobOpenPinch(u)));
    /**
     * 收拢端点中心线（定版 Gerono 双纽线，逐字 = 旧式在
     * m = 0 的取值：A = 4.72、kz = 0.50、D = 1.2、波浪
     * 恒零）：x = A·cos u、z = A·kz·sin u·cos u、y =
     * 0.06·sin u（扣处两支 ±0.06 错层）+ D·cos u·sin²u
     * （深度项：两瓣中段一前一后、瓣尖与交叉点归零）。
     * C(2π) ≡ C(0)（右瓣尖）
     */
    const mobCenterClosed = (
      u: number,
      out: THREE.Vector3,
    ): THREE.Vector3 => {
      const cu = Math.cos(u);
      const su = Math.sin(u);
      return out.set(
        MOB_INF_A * cu,
        0.06 * su + 1.2 * cu * su * su,
        MOB_INF_A * 0.5 * su * cu,
      );
    };
    /**
     * 展开端点中心线（X 改判轮 2026-11-16，直通配对重
     * 排点序）：u 按八分段（每段 π/4）走——偶数段正描
     * 一条臂（结点→臂尖）、奇数段回描同一条臂（臂尖→
     * 结点，t 乘 0.996 防折返点切向退化、路径偏离正描
     * ≤0.03 不可见），回描段带宽由 mobOpenPinch 收至
     * ≈零、藏进结点星芒/光针，渲染上只剩四条断开的臂：
     * 段序 = A(band 0 右上) 描/回、B(band 0 左下) 描/
     * 回、C(band 1 左上) 描/回、D(band 1 右下) 描/回。
     * 直通配对是几何的：A 与 B 同为 band 0 的一条带
     * （在结点两侧对穿、带 4°／7° 折角不共线——X 不
     * 正轮）、C 与 D 同为 band 1——展开态没有任何闭
     * 合瓣环，帧内只有两条波浪带交叉成不正的 X、四
     * 臂尖端各按本臂臂长（≤7.60）落帧边内侧（口径不
     * 变）。
     * C(0) ≡ C(2π) ≡ 结点（原点）：接缝与翻面不变量
     * 的结构前提与旧端点相同——离线复算（同 mobFrameAt
     * 式）m = 0/0.5/1 三点 |C(2π)−C(0)|、|W(2π)+W(0)|、
     * |N(2π)+N(0)| 与标记翻面 W/N 反号均为机器精度
     * （≤3e-16），不变量未因改判失效（账见 DATA-PLAN
     * 本轮条目）。行走点沿 u 走：回描段即沿原臂返回结
     * 点、随即出对侧臂——在结点星芒处完成「沿一条带穿
     * 过」的读法。
     */
    const mobCenterOpen = (
      u: number,
      out: THREE.Vector3,
    ): THREE.Vector3 => {
      const seg = Math.floor(u / (Math.PI / 4));
      const eighth = seg % 8;
      const tau = (u - seg * (Math.PI / 4)) / (Math.PI / 4);
      switch (eighth) {
        case 0:
          return mobOpenBandPoint(0, tau, out);
        case 1:
          return mobOpenBandPoint(0, (1 - tau) * 0.996, out);
        case 2:
          return mobOpenBandPoint(0, -tau, out);
        case 3:
          return mobOpenBandPoint(0, -(1 - tau) * 0.996, out);
        case 4:
          return mobOpenBandPoint(1, -tau, out);
        case 5:
          return mobOpenBandPoint(1, -(1 - tau) * 0.996, out);
        case 6:
          return mobOpenBandPoint(1, tau, out);
        default:
          return mobOpenBandPoint(1, (1 - tau) * 0.996, out);
      }
    };
    const mobCenterTmp = new THREE.Vector3();
    /**
     * 中心线 C(u) = 收拢端点与展开端点之间的逐点插值
     * （同一参数 u 点对点 lerp、权重 = mobMorphM；m = 0
     * 与 m = 1 走端点直达、与各自端点逐字一致）。标架
     * （mobFrameAt）由本中心线切线逐点重算、带宽
     * mobHalfW 随 morph 沿程分布——带面/扭转框全程随
     * 新中心线走。两端点均满足 C(2π) ≡ C(0)、ψ 累积
     * 与中心线形状无关：接缝 P(2π, v) ≡ P(0, −v) 与
     * 翻面不变量在任意 m（含 0.5）照旧成立（离线三点
     * 复核见 DATA-PLAN 本轮条目）
     */
    const mobCenterAt = (
      u: number,
      out: THREE.Vector3,
    ): THREE.Vector3 => {
      if (mobMorphM <= 0) return mobCenterClosed(u, out);
      if (mobMorphM >= 1) return mobCenterOpen(u, out);
      mobCenterClosed(u, out);
      mobCenterOpen(u, mobCenterTmp);
      return out.lerp(mobCenterTmp, mobMorphM);
    };
    /** 半扭转角 ψ(u)：总量 π、集中在星扣窗口内累积 */
    const mobPsi = (u: number): number => {
      const x = THREE.MathUtils.clamp(
        (u - (MOB_U1 - MOB_TWIST_D)) / (2 * MOB_TWIST_D),
        0,
        1,
      );
      return Math.PI * (x * x * (3 - 2 * x));
    };
    interface MobFrame {
      c: THREE.Vector3;
      t: THREE.Vector3;
      w: THREE.Vector3;
      n: THREE.Vector3;
    }
    const mobFrameTmpA = new THREE.Vector3();
    const mobFrameTmpB = new THREE.Vector3();
    /**
     * 局部标架（T 切向 / W 横向 / N 法向）：T 由中心线中央差
     * 分（跨星扣的切向折角被差分窗自然柔化）、E1 = T 在
     * (p, q) 面内旋 +90°、W = cosψ·E1 + sinψ·ŷ 后对 T 正交
     * 化、N = T×W。circuits = 已完成圈数：ψ 逐圈再累积 π，
     * 故 W/N 每圈反号、两圈复原——与几何网格（circuits = 0、
     * ψ(2π) = π 的接缝反号）同一条规矩。
     */
    const mobFrameAt = (
      u: number,
      circuits: number,
      fr: MobFrame,
    ): MobFrame => {
      mobCenterAt(u, fr.c);
      const du = 0.02;
      mobCenterAt(mobWrapU(u - du), mobFrameTmpA);
      mobCenterAt(mobWrapU(u + du), mobFrameTmpB);
      fr.t.subVectors(mobFrameTmpB, mobFrameTmpA).normalize();
      const e1p = fr.t.z;
      const e1q = fr.t.x;
      const psi = mobPsi(u) + circuits * Math.PI;
      const cp = Math.cos(psi);
      fr.w.set(e1p * cp, Math.sin(psi), -e1q * cp);
      fr.w.addScaledVector(fr.t, -fr.w.dot(fr.t)).normalize();
      fr.n.crossVectors(fr.t, fr.w);
      return fr;
    };
    const mobScratchFrame: MobFrame = {
      c: new THREE.Vector3(),
      t: new THREE.Vector3(),
      w: new THREE.Vector3(),
      n: new THREE.Vector3(),
    };
    /**
     * 带面点 P(u, v) = C(u) + v·W(u) + 波浪（材料坐标，
     * circuits = 0）。波浪 = 沿法向 N 的边缘起伏（纱带感）：
     * 幅 (0.045→0.095 随 morph)·sin(6u − 波浪相位)，按
     * (|v|/hw)³ 向带缘增长——带心不动、带缘翻卷；|v| 超
     * 带缘（光场/光尘采样）时因子钳在 1.15 不失控。接缝
     * 纪律不变：波浪只依赖 |v| 与 u，接缝列 v 反号后
     * P(2π, v) ≡ P(0, −v) 仍精确成立
     */
    const mobPoint = (
      u: number,
      v: number,
      out: THREE.Vector3,
    ): THREE.Vector3 => {
      mobFrameAt(u, 0, mobScratchFrame);
      out
        .copy(mobScratchFrame.c)
        .addScaledVector(mobScratchFrame.w, v);
      return out.addScaledVector(
        mobScratchFrame.n,
        mobWaveDisp(u, v),
      );
    };
    /** 带缘波浪位移（沿法向）：幅随 morph、按 (|v|/hw)³ 向带缘增长 */
    const mobWaveDisp = (u: number, v: number): number => {
      const hw = mobHalfW(u);
      const ef = Math.min(Math.abs(v) / hw, 1.15);
      return (
        (0.045 + 0.05 * mobMorphM) *
        Math.sin(6 * u - mobWavePh) *
        ef *
        ef *
        ef
      );
    };
    const mobOuter = new THREE.Group();
    // —— 位置上调（2026-11-15 22:42 元灿本人开口，八补充
    // 位置锁的例外条款）：整体沿 solarGroup 本地 +Y 刚性
    // 平移上抬 MOB_LIFT——本地 +Y 是组自转（rotation.y）
    // 的不变轴、且经组倾角 rotation.x = 0.55 投影后屏
    // 幕横偏恒为 0（中心恒在太阳的竖直中轴上、无横漂），
    // 大小/形状/双面色/翻面/门控一字不动，只动位置（倾角
    // 于 2026-11-16 轮经元灿授权微调，见下）。
    // 上限实测（离线同式复算，见 DATA-PLAN 本轮条目）：
    // 桌面全览取景半高 = 7.95×SOLAR_S×1.05 ≈ 5.175 本地
    // 单位（全览按最小半视场拟合、竖直半高恒 ≥ 此值，桌
    // 面/横屏即最紧侧）；旧倾角（0.42/0/0.16）下带体在最
    // 坏自转相位顶高 3.63、底 −3.66。屏幕顶高 = 3.63 +
    // L×cos(0.55)，余量 = 1.545 − 0.8525×L：抬 1.50 时顶
    // 4.91、余量 0.27 ≈ 画面高 2.6%；L ≈ 1.81 时余量归零
    // （硬天花板，元灿口径取整 1.8）。2026-11-15 23:39 元
    // 灿再令抬满：落点 L = 1.75——顶 5.12、余量 ≈0.05 本
    // 地单位 ≈ 画面高 0.5%，是不缩带、不改取景前提下带
    // 体完整在框的最后一格；中心屏幕上移 1.75×cos(0.55)
    // ≈ 1.49 世界单位 ≈ 画面高 14.4%。黄道环顶屏幕高
    // +2.58：带体自身投影高 ±3.63 > 取景半高与环顶之差，
    // 全带压到环顶之上需抬 ≈7.0、取景内不可能——全带脱
    // 环仍需元灿另裁缩带/取景，本轮不授权。
    // —— 再上抬 + 倾角微调（2026-11-16 元灿令「位置再调
    // 高一些，环的角度可以再稍微调整」，授权以倾角腾挪）：
    // mobTilt 由 (0.42, 0, 0.16) 微调为 (0.34, 0, 0.12)
    // （x 轴 24.1°→19.5°、z 轴 9.2°→6.9°，带面略向黄道
    // 面回平），同式复算带体顶高 3.63→3.42、底 −3.46、
    // 横 ±4.90 不变；MOB_LIFT 1.75 → 2.00（与前两步同幅
    // +0.25 一档）：顶 = 3.42 + 2.00×cos(0.55) ≈ 5.13、
    // 余量 ≈0.05 本地单位 ≈ 画面高 0.5%——与上一落点同
    // 一安全口径；中心屏幕上移 ≈1.71 世界单位 ≈ 画面高
    // 16.5%。附带核对（光鞘外展 +0.17 的含鞘口径，采样
    // v 至 ±0.37）：新态顶 5.25、名义余量 −0.075，与现行
    // 出货态（L=1.75 旧倾角）同口径的 −0.08 相当——鞘尖
    // alpha 本就归零，抬升后在框读法不劣于现状。带的大
    // 小/形状/色系/机制仍一字未动，动的只有位置与倾角。
    const MOB_LIFT = 2.0;
    mobOuter.position.set(0, MOB_LIFT, 0);
    const mobTilt = new THREE.Group();
    mobTilt.rotation.set(0.34, 0, 0.12);
    // 静息倾角四元数存档：帧段恒回此姿态（不锁视角轮起
    // 全程恒定、变形期间不做任何朝向解算），m = 0 时缩
    // 放恒 1，收拢端形态/取景一分不漂（见帧段落框注）
    const mobRestQuat = mobTilt.quaternion.clone();
    mobOuter.add(mobTilt);
    mobOuter.visible = false;
    solarGroup.add(mobOuter);
    // 分段取上限档（重生成轮）：360×12，波浪与宽窄分布都
    // 需要这个密度才不露折线；逐帧重建靠标架缓存承载
    const MOB_SEG_U = 360;
    const MOB_SEG_V = 12;
    // 带面材质（工单七色彩定版，2026-11-15：色彩只认 3.7
    // 开屏一个来源；2026-11-15 晚纠正轮按同一参考重做质
    // 感密度）：双面体系、以面定色——正面
    // （gl_FrontFacing）= 暖面渐变 金橙→绿→青蓝（饱和按
    // 参考帧上调），沿带面流动（相位随时间漂移，即开屏
    // 扭带的流转，不另叠虹彩层）+ 星光颗粒（双层、密度
    // 上调）；背面 = 银白→粉紫渐变（粉紫加深）。
    // 【2026-11-16 重生成轮覆盖】上句色板作废：双面改按
    // morph 在两套采样色之间插值——正面 环绕粉紫系（开
    // 屏 9.0s）⇄ 展开深蓝系（慢放 11.5s），背面 环绕冰
    // 青系 ⇄ 展开结点紫系（采样值见 fragment 内注）；流
    // 动/星光颗粒/热芯/光丝机制不变。哪一面
    // 朝外由半扭转几何决定：过星扣后两面互换从 ψ 的 π
    // 扭转长出来，shader 不手动换色。带面中线一条白色热
    // 芯（参考缎带的白炽芯线）、带缘向亮白提亮（与亮白
    // 发光边缘线 + 光鞘同口径）；极细光丝 = v 向高频亮
    // 度调制（只提亮不压暗）。uBandA = 整体不透明度
    // （逐帧驱动，峰值 0.50×提亮系数——纠正轮口径，旧
    // 0.16 压暗值已作废）
    const mobBandMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uBandA: { value: 0 },
        uPulseU: { value: 0 },
        uPulseA: { value: 1 },
        uMorph: { value: 0 },
      },
      vertexShader: `
        attribute float aU;
        attribute float aV;
        varying float vU;
        varying float vV;
        void main() {
          vU = aU;
          vV = aV;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform float uBandA;
        uniform float uPulseU;
        uniform float uPulseA;
        uniform float uMorph;
        varying float vU;
        varying float vV;
        float mobHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        // 色彩权威 = 四张原图文件直采（2026-11-16 原图重
        // 采样轮，元灿：「色彩和参考图上的不像」——旧采样
        // 表 #3446D3 等降为线索、不再作准，本轮逐值从
        // ~/workspace/user/files 原图带面像素分布落数，
        // 采样账见 DATA-PLAN 本轮条目）：展开（5EF04FF5
        // 四臂＋C784DF3E 深部）主蓝 #3D4DEF／亮蓝
        // #554FEF、深部 #222689；收拢（A3B47D08 粉紫缎
        // 带＋7EE50D9C 紫粉股）粉紫 #8E6FA8→深紫
        // #594699→粉 #C77BAE、暖弧橙 #D1703A
        vec3 mobPalWrap(float x) {
          vec3 col = mix(vec3(0.557, 0.435, 0.659), vec3(0.349, 0.275, 0.600), smoothstep(0.0, 0.30, x));
          col = mix(col, vec3(0.780, 0.482, 0.682), smoothstep(0.30, 0.52, x));
          col = mix(col, vec3(0.820, 0.439, 0.227), smoothstep(0.52, 0.68, x));
          col = mix(col, vec3(0.525, 0.384, 0.612), smoothstep(0.68, 0.84, x));
          return mix(col, vec3(0.557, 0.435, 0.659), smoothstep(0.84, 1.0, x));
        }
        vec3 mobPalOpen(float x) {
          vec3 col = mix(vec3(0.133, 0.149, 0.537), vec3(0.239, 0.302, 0.937), smoothstep(0.0, 0.45, x));
          col = mix(col, vec3(0.333, 0.310, 0.937), smoothstep(0.45, 0.80, x));
          return mix(col, vec3(0.133, 0.149, 0.537), smoothstep(0.80, 1.0, x));
        }
        // 背面：环绕 = 冰青（A3B47D08 青弧直采）#B9D9F2
        // →#62C0F9；展开 = 结点紫系（5EF04FF5 结点＋
        // C784DF3E 品紫直采）#5543E1→#7F5CFC→缘蓝
        // #6468FC
        vec3 mobPalWrapB(float x) {
          vec3 col = mix(vec3(0.725, 0.851, 0.949), vec3(0.384, 0.753, 0.976), smoothstep(0.10, 0.55, x));
          col = mix(col, vec3(0.592, 0.820, 0.961), smoothstep(0.55, 0.90, x));
          return mix(col, vec3(0.725, 0.851, 0.949), smoothstep(0.90, 1.0, x));
        }
        vec3 mobPalOpenB(float x) {
          vec3 col = mix(vec3(0.333, 0.263, 0.882), vec3(0.498, 0.361, 0.988), smoothstep(0.10, 0.55, x));
          col = mix(col, vec3(0.392, 0.408, 0.988), smoothstep(0.55, 0.90, x));
          return mix(col, vec3(0.333, 0.263, 0.882), smoothstep(0.90, 1.0, x));
        }
        void main() {
          float s = vU * 0.15915494;
          float flow = fract(s - uTime * 0.03);
          vec3 warm = mix(mobPalWrap(flow), mobPalOpen(flow), uMorph);
          // 流光亮带：一道亮脉冲随渐变同向缓行（参考缎带
          // 上流动的高光段）。高光只许往本态色族里亮：收
          // 拢 = 暖金奶油（A3B47D08 金弧芯直采 #F9E8D5
          // 家族）、展开 = 蓝紫——等通道纯白叠加是带面在
          // 帧里发白的洗色源，不许再用
          warm += pow(0.5 + 0.5 * sin((flow) * 6.2831853 * 2.0), 3.0) * 0.26 * mix(vec3(1.0, 0.86, 0.66), vec3(0.45, 0.55, 1.0), uMorph);
          // 星尘闪点（开屏主图 A3B47D08 口径：密集、遍布
          // 带面）：两层点闪阈值两态同降（收拢态还原轮：
          // 元灿指收拢带面星尘密度明显不够——旧收拢阈值
          // 0.978/0.99 作废）、展开态再加一层细闪；四角
          // 星形层见下方效果层 ③
          float sp = mobHash(floor(vec2(vU * 110.0, vV * 7.0)) + floor(uTime * 1.5) * 17.0);
          warm += step(mix(0.955, 0.915, uMorph), sp) * 0.8;
          float sp2 = mobHash(floor(vec2(vU * 190.0, vV * 11.0)) + floor(uTime * 2.3) * 31.0);
          warm += step(mix(0.972, 0.94, uMorph), sp2) * 0.5;
          float sp3 = mobHash(floor(vec2(vU * 260.0, vV * 15.0)) + floor(uTime * 3.1) * 47.0);
          warm += step(0.965, sp3) * 0.45 * uMorph;
          float bs = fract(s + 0.35);
          vec3 cool = mix(mobPalWrapB(bs), mobPalOpenB(bs), uMorph);
          cool += step(0.988, mobHash(floor(vec2(vU * 90.0, vV * 6.0)))) * 0.4;
          vec3 col = gl_FrontFacing ? warm : cool;
          // 结点紫晕：交叉相位（s = 0.25 / 0.75）附近向结
          // 点紫 #5543E1 靠拢（5EF04FF5 结点区直采），展
          // 开态更显
          float knot = exp(-pow((s - 0.25) / 0.045, 2.0)) + exp(-pow((s - 0.75) / 0.045, 2.0));
          col = mix(col, vec3(0.333, 0.263, 0.882), knot * 0.38 * (0.25 + 0.75 * uMorph));
          // 饱和定版（原图重采样轮，元灿：「变形前后的色
          // 彩还需要加强，不够鲜艳」）：败点不在采样值而
          // 在落地——半透混合＋等通道叠加把饱和洗淡，按
          // 管线故障修：带面基色在此做饱和 ×1.30 定版拉
          // 回原图分布（色相不动）；其后的白炽芯线/星尘/
          // 光涌等近白叠加不受影响、保持近白（参考图本
          // 就如此），不整体过曝
          float mobLum = dot(col, vec3(0.299, 0.587, 0.114));
          col = clamp(mix(vec3(mobLum), col, 1.30), 0.0, 1.0);
          // 周期光脉冲（特效增密轮）：一道光涌沿 ∞ 缓行
          // （uPulseU 由帧段以 22 秒/圈推进）——常驻光流
          // 动的起伏，两面同加、白粉色，与流光同向同源
          float pd = abs(vU - uPulseU);
          pd = min(pd, 6.2831853 - pd);
          float surge = exp(-pow(pd / 0.55, 2.0)) * uPulseA;
          // 光涌色随 morph 走原图色族：环绕粉白 → 展开品
          // 紫（C784DF3E 迸开品紫直采 #7F5CFC），展开态
          // 量同步收一档——旧白光涌是发白主源之一
          col += mix(vec3(0.98, 0.87, 0.93), vec3(0.498, 0.361, 0.988), uMorph) * surge * mix(0.38, 0.22, uMorph);
          float fil = 0.88 + 0.35 * pow(0.5 + 0.5 * sin(vV * 34.0), 10.0);
          col *= fil;
          // 白炽核心线：带面中线一条（辉光结构定版：白炽
          // 核心线＋宽幅柔光晕）——展开态收窄成细线（高斯
          // σ 减半）：细线读作辉光、宽芯读作洗色
          float core = exp(-pow(vV * mix(1.7, 3.4, uMorph), 2.0));
          col += vec3(1.0) * core * mix(0.38, 0.30, uMorph);
          // 带缘向原图带缘色提亮、不掺白（掺白混色是发白
          // 主源之三）：环绕 = 粉白 #DEC2DC、展开 = 缘蓝
          // #6468FC（5EF04FF5 缘部直采）
          float edge = smoothstep(0.62, 1.0, abs(vV));
          col = mix(col, mix(vec3(0.87, 0.76, 0.86), vec3(0.392, 0.408, 0.988), uMorph), edge * mix(0.65, 0.55, uMorph));
          // —— 带面效果层（2026-11-16 收拢态还原轮，元灿：
          // 「变形前环上有很多效果和线，你要还原出来」；
          // 照 A3B47D08 / 7EE50D9C 带面细读逐项还原）。
          // 全部只许是 (vU, vV) 的函数：贴带面走、随 morph
          // 连续带过去（tint 随 uMorph 在两态色族间插值、
          // 无跳变无凭空消失），展开态沿用同一套语言 ——
          // ① 发丝线群：五条平行细线随带面起伏（粉/青/白
          //    微色差、光纤束感），亮度沿程微闪
          for (int li = 0; li < 5; li++) {
            float lane = -0.66 + float(li) * 0.335;
            float lp = exp(-pow((vV - lane) / 0.05, 2.0));
            float shim = 0.72 + 0.28 * sin(vU * 3.0 - uTime * 0.7 + float(li) * 1.7);
            float sel = mod(float(li), 3.0);
            vec3 lt = sel < 0.5 ? vec3(1.0, 0.78, 0.90) : (sel < 1.5 ? vec3(0.68, 0.90, 1.0) : vec3(0.96, 0.97, 1.0));
            lt = mix(lt, vec3(0.62, 0.72, 1.0), uMorph * 0.55);
            col += lt * lp * shim * 0.13;
          }
          // ② 交叉交织＋层叠纱光：结点/交叉相位附近细密经
          //    纬线（股与股压叠处的交织感）；另叠一层异速
          //    慢纱光（多层半透压叠、不是单层渐变带）
          float weave = knot * (0.5 + 0.5 * sin(vU * 150.0)) * (0.5 + 0.5 * sin(vV * 24.0));
          col += mix(vec3(0.95, 0.85, 0.95), vec3(0.60, 0.65, 1.0), uMorph) * weave * 0.10;
          float flow2 = fract(s - uTime * 0.017 + 0.37);
          col += mix(vec3(0.92, 0.80, 0.90), vec3(0.45, 0.52, 1.0), uMorph) * pow(0.5 + 0.5 * sin(flow2 * 6.2831853), 2.0) * 0.10;
          // ③ 四角星尘层：铺满带面的四角星闪点（格内十字
          //    星芒近似、大小参差、各自闪烁）——与上方两层
          //    点闪叠加成原图的 dense 铺面感
          {
            vec2 cell = vec2(vU * 90.0, vV * 4.5);
            vec2 cid = floor(cell);
            vec2 cf = fract(cell) - 0.5;
            float h1 = mobHash(cid);
            vec2 off = (vec2(mobHash(cid + 7.0), mobHash(cid + 13.0)) - 0.5) * 0.5;
            vec2 dp = (cf - off) * (0.85 + 0.45 * mobHash(cid + 3.0));
            float tw = 0.55 + 0.45 * sin(uTime * (1.5 + h1 * 2.0) + h1 * 40.0);
            float star = exp(-dot(dp, dp) * 42.0)
              + exp(-abs(dp.x) * 34.0) * exp(-abs(dp.y) * 7.0) * 0.8
              + exp(-abs(dp.y) * 34.0) * exp(-abs(dp.x) * 7.0) * 0.8;
            float on = step(mix(0.86, 0.80, uMorph), h1);
            col += mix(vec3(1.0, 0.92, 0.97), vec3(0.82, 0.88, 1.0), uMorph) * star * on * tw * 0.55;
          }
          // ④ 玻璃晶缘线：两侧各一条锐利高光描边（玻璃晶
          //    体缘）＋内侧一条弱伴线
          float rim = exp(-pow((abs(vV) - 0.93) / 0.030, 2.0));
          float rim2 = exp(-pow((abs(vV) - 0.76) / 0.022, 2.0));
          vec3 rimC = mix(vec3(0.88, 0.94, 1.0), vec3(0.55, 0.64, 1.0), uMorph);
          col = mix(col, rimC, rim * 0.50);
          col += rimC * rim2 * 0.10;
          // ⑤ 珠点点缀：沿带两列小珠/宝石点（两列错位、格
          //    哈希决定在场与色——粉/青/金轮换，展开态转
          //    蓝紫）
          {
            float side = vV >= 0.0 ? 0.0 : 1.0;
            vec2 bc = vec2(vU * 30.0 + side * 0.5, (abs(vV) - 0.45) * 2.4);
            vec2 bf = fract(bc) - 0.5;
            float bh = mobHash(floor(bc));
            float bead = smoothstep(0.30, 0.12, length(vec2(bf.x, bf.y * 0.55))) * step(0.35, bh);
            float bsel = mod(floor(bc.x), 3.0);
            vec3 bt = bsel < 0.5 ? vec3(1.0, 0.80, 0.90) : (bsel < 1.5 ? vec3(0.70, 0.92, 1.0) : vec3(1.0, 0.88, 0.62));
            bt = mix(bt, vec3(0.66, 0.74, 1.0), uMorph * 0.6);
            col += bt * bead * (0.30 + 0.45 * bead);
          }
          // 纱感：alpha 向带缘再淡一档（半透如纱、柔焦收
          // 边，不许硬边）
          float gauze = 1.0 - 0.28 * smoothstep(0.55, 1.0, abs(vV));
          gl_FragColor = vec4(col, uBandA * gauze);
        }`,
    });
    // 常驻流动光覆膜材质（2026-11-16 更正轮，用户澄清：
    // 「我说的那个常驻效果不是周围的高光，而是那个点一
    // 下就随环带流动的那个光」）：前身是点选涟漪波前（点
    // 带才自点击处扩散一道光）——本轮把触发改恒开：uFlowU
    // = 流动光头部的带面相位，由帧段会话时钟直推、2.8 秒
    // 一圈（= 旧涟漪波前速度 π/1.4s，速度/亮度/粉白色系
    // 沿旧观感），头部紧（σ≈0.16）、身后拖尾渐隐
    // （σ≈0.62），一道亮光沿 ∞ 带面永续循环；点选与它彻
    // 底脱钩（点带只弹卡，关卡后流动照旧）。uWaveA = 随
    // 带可见度淡变
    const mobWaveMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uFlowU: { value: 0 },
        uWaveA: { value: 0 },
        uMorph: { value: 0 },
      },
      vertexShader: `
        attribute float aU;
        varying float vU;
        void main() {
          vU = aU;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uFlowU;
        uniform float uWaveA;
        uniform float uMorph;
        varying float vU;
        void main() {
          float d = mod(vU - uFlowU + 3.14159265, 6.2831853) - 3.14159265;
          float w = d > 0.0 ? 0.16 : 0.62;
          float g = exp(-pow(d / w, 2.0));
          // 流动光色随 morph 在原图直采色之间走：环绕粉
          // #F2C4DC → 展开芯线浅蓝 #C4D4FF（5EF04FF5 芯
          // 线直采）
          vec3 col = mix(vec3(0.949, 0.769, 0.863), vec3(0.769, 0.831, 1.0), uMorph);
          gl_FragColor = vec4(col, g * 0.6 * uWaveA);
        }`,
    });
    // —— 逐帧几何重建（morph/波浪驱动）：带面与整环光场
    // 共用 MOB_SEG_U 网格——每帧先把该网格的标架（C/W/N）
    // 算一遍存缓存，两张几何的顶点都从缓存拼（工程承载：
    // 标架只算一遍、顶点纯算术）；边界/光鞘与命中带各自
    // 网格、同理注册重建。各构建段把自己的重建函数推进
    // mobRebuilders，帧段统一调用 mobRebuildGeometry()
    const mobFrameCacheC = new Float32Array((MOB_SEG_U + 1) * 3);
    const mobFrameCacheW = new Float32Array((MOB_SEG_U + 1) * 3);
    const mobFrameCacheN = new Float32Array((MOB_SEG_U + 1) * 3);
    const mobCacheFrame: MobFrame = {
      c: new THREE.Vector3(),
      t: new THREE.Vector3(),
      w: new THREE.Vector3(),
      n: new THREE.Vector3(),
    };
    const mobFillFrameCache = (): void => {
      for (let i = 0; i <= MOB_SEG_U; i++) {
        const u = (i / MOB_SEG_U) * Math.PI * 2;
        mobFrameAt(u, 0, mobCacheFrame);
        mobFrameCacheC[i * 3] = mobCacheFrame.c.x;
        mobFrameCacheC[i * 3 + 1] = mobCacheFrame.c.y;
        mobFrameCacheC[i * 3 + 2] = mobCacheFrame.c.z;
        mobFrameCacheW[i * 3] = mobCacheFrame.w.x;
        mobFrameCacheW[i * 3 + 1] = mobCacheFrame.w.y;
        mobFrameCacheW[i * 3 + 2] = mobCacheFrame.w.z;
        mobFrameCacheN[i * 3] = mobCacheFrame.n.x;
        mobFrameCacheN[i * 3 + 1] = mobCacheFrame.n.y;
        mobFrameCacheN[i * 3 + 2] = mobCacheFrame.n.z;
      }
    };
    /** 缓存网格点 P(i, v)：与 mobPoint 同式（标架走缓存） */
    const mobCachePoint = (
      i: number,
      v: number,
      out: THREE.Vector3,
    ): THREE.Vector3 => {
      const u = (i / MOB_SEG_U) * Math.PI * 2;
      const wd = mobWaveDisp(u, v);
      return out.set(
        mobFrameCacheC[i * 3]! +
          mobFrameCacheW[i * 3]! * v +
          mobFrameCacheN[i * 3]! * wd,
        mobFrameCacheC[i * 3 + 1]! +
          mobFrameCacheW[i * 3 + 1]! * v +
          mobFrameCacheN[i * 3 + 1]! * wd,
        mobFrameCacheC[i * 3 + 2]! +
          mobFrameCacheW[i * 3 + 2]! * v +
          mobFrameCacheN[i * 3 + 2]! * wd,
      );
    };
    const mobRebuilders: Array<() => void> = [];
    const mobRebuildGeometry = (): void => {
      mobFillFrameCache();
      for (const f of mobRebuilders) f();
    };
    {
      const pos: number[] = [];
      const col: number[] = [];
      const aus: number[] = [];
      const avs: number[] = [];
      const idx: number[] = [];
      const tmp = new THREE.Vector3();
      // 缎带涡旋渐变（实机主参考）：沿程 白 → 粉 → 淡蓝 →
      // 白，接缝处同色无缝（u = 2π 与 u = 0 同为白）
      const cWhite = new THREE.Color(0xf7f3f5);
      const cPink = new THREE.Color(0xf3b7cd);
      const cBlue = new THREE.Color(0xbcd9f2);
      const cTmp = new THREE.Color();
      const mobRibbonColor = (u: number, out: THREE.Color): void => {
        const tt = u / (Math.PI * 2);
        if (tt < 0.4) {
          out.lerpColors(cWhite, cPink, tt / 0.4);
        } else if (tt < 0.75) {
          out.lerpColors(cPink, cBlue, (tt - 0.4) / 0.35);
        } else {
          out.lerpColors(cBlue, cWhite, (tt - 0.75) / 0.25);
        }
      };
      // 顶点位置：半宽沿程分布（mobHalfW）＋缓存标架拼点；
      // 接缝列（i = SEG_U）v 反号落位（P(2π,v) ≡ P(0,−v)）。
      // fillBandPos 构建期与逐帧重建共用（重建时写回同一
      // position 属性数组）
      const fillBandPos = (arr: number[] | Float32Array): void => {
        let k = 0;
        for (let i = 0; i <= MOB_SEG_U; i++) {
          const u = (i / MOB_SEG_U) * Math.PI * 2;
          const vFlip = i === MOB_SEG_U ? -1 : 1;
          const hw = mobHalfW(u);
          for (let j = 0; j <= MOB_SEG_V; j++) {
            const vGrid = -hw + (j / MOB_SEG_V) * 2 * hw;
            mobCachePoint(i, vGrid * vFlip, tmp);
            arr[k++] = tmp.x;
            arr[k++] = tmp.y;
            arr[k++] = tmp.z;
          }
        }
      };
      mobFillFrameCache();
      fillBandPos(pos);
      for (let i = 0; i <= MOB_SEG_U; i++) {
        const u = (i / MOB_SEG_U) * Math.PI * 2;
        for (let j = 0; j <= MOB_SEG_V; j++) {
          aus.push(u);
          // aV 归一到本截面半宽（−1..1）：宽度沿程变，着色
          // 器的带缘/热芯按归一坐标走、不随宽窄漂移
          avs.push(-1 + (j / MOB_SEG_V) * 2);
          const edgeK = Math.abs(-1 + (j / MOB_SEG_V) * 2);
          mobRibbonColor(u, cTmp);
          const bright = 0.7 + 0.3 * edgeK;
          cTmp.multiplyScalar(bright);
          // 顶点色仅作波前覆膜的调试底色（带面实际着色走
          // mobBandMat 的双面 shader、以面定色，工单七）
          col.push(cTmp.r, cTmp.g, cTmp.b);
        }
      }
      for (let i = 0; i < MOB_SEG_U; i++) {
        for (let j = 0; j < MOB_SEG_V; j++) {
          const a = i * (MOB_SEG_V + 1) + j;
          const b = a + MOB_SEG_V + 1;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      const mobGeo = new THREE.BufferGeometry();
      mobGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(pos, 3),
      );
      mobGeo.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(col, 3),
      );
      // aU：顶点沿带相位（流动光覆膜按它算环向距离）
      mobGeo.setAttribute(
        "aU",
        new THREE.Float32BufferAttribute(aus, 1),
      );
      // aV：顶点带宽向归一坐标（−1..1，带面 shader 按它做
      // 带缘亮白提亮与光丝调制）
      mobGeo.setAttribute(
        "aV",
        new THREE.Float32BufferAttribute(avs, 1),
      );
      mobGeo.setIndex(idx);
      const mobBand = new THREE.Mesh(mobGeo, mobBandMat);
      mobBand.renderOrder = 1;
      mobBand.frustumCulled = false;
      mobTilt.add(mobBand);
      // 常驻流动光覆膜：与带体共用几何，只画一道沿带面
      // 永续流动的粉白亮光（紧头拖尾），其余全透明
      const wave = new THREE.Mesh(mobGeo, mobWaveMat);
      wave.renderOrder = 2;
      wave.frustumCulled = false;
      mobTilt.add(wave);
      mobRebuilders.push(() => {
        const attr = mobGeo.attributes
          .position as THREE.BufferAttribute;
        fillBandPos(attr.array as Float32Array);
        attr.needsUpdate = true;
      });
    }
    // 边界：单条闭合曲线（双圈 τ∈[0, 2) 才回到起点）——莫比
    // 乌斯带只有一条边界，这一圈线本身就是「只有一个面」的
    // 注脚。颜色口径（工单七）：两条边缘统一改亮白发光线
    // （开屏缎带/翼带最醒目的线）；单面性的颜色读法已改挂
    // 带面双面体系（整面换色），边缘不再分色。纠正轮加厚：
    // 1px 线撑不起参考里的光边——边缘另配一条**光鞘**三
    // 角带（沿边界、向带内收 0.07 / 向带外展 0.17，alpha
    // 在边缘处最高、两侧归零、加色混合），主线 + 辉光线
    // 叠在鞘心，三层同几何同相位、不脱位
    const mobEdgeMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mobEdgeGlowMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mobEdgeSheathMat = new THREE.ShaderMaterial({
      uniforms: {
        uFade: { value: 0 },
        uTint: { value: new THREE.Color(0xd9b8d2) },
      },
      vertexShader: [
        "attribute float aA;",
        "varying float vA;",
        "void main() {",
        "  vA = aA;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform float uFade;",
        "uniform vec3 uTint;",
        "varying float vA;",
        "void main() {",
        "  gl_FragColor = vec4(uTint, vA * uFade);",
        "}",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    {
      const pts: THREE.Vector3[] = [];
      const dirs: THREE.Vector3[] = [];
      const cols: number[] = [];
      const tmp = new THREE.Vector3();
      const shFrame: MobFrame = {
        c: new THREE.Vector3(),
        t: new THREE.Vector3(),
        w: new THREE.Vector3(),
        n: new THREE.Vector3(),
      };
      const SEG = 512;
      // 边界点/外展向重算（构建与逐帧重建共用）：边界点在
      // 带缘 v = ±hw(u)（半宽沿程分布）、含带缘波浪
      const fillEdgePts = (): void => {
        for (let i = 0; i < SEG; i++) {
          const tau = (i / SEG) * 2;
          const uu = (tau < 1 ? tau : tau - 1) * Math.PI * 2;
          const sgn = tau < 1 ? 1 : -1;
          mobPoint(uu, sgn * mobHalfW(uu), tmp);
          if (pts[i]) pts[i]!.copy(tmp);
          else pts.push(tmp.clone());
          // 光鞘外展方向 = 带面横向 W 的向外侧（τ<1 支在
          // +v 侧、τ≥1 支在 −v 侧）
          mobFrameAt(uu, 0, shFrame);
          if (dirs[i])
            dirs[i]!.copy(shFrame.w).multiplyScalar(sgn);
          else
            dirs.push(
              shFrame.w.clone().multiplyScalar(sgn),
            );
        }
      };
      fillEdgePts();
      for (let i = 0; i < SEG; i++) cols.push(1, 1, 1);
      const edgeGeo = new THREE.BufferGeometry().setFromPoints(pts);
      edgeGeo.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(cols, 3),
      );
      const edge = new THREE.LineLoop(edgeGeo, mobEdgeMat);
      edge.frustumCulled = false;
      edge.renderOrder = 2;
      mobTilt.add(edge);
      const edgeGlow = new THREE.LineLoop(edgeGeo, mobEdgeGlowMat);
      edgeGlow.frustumCulled = false;
      edgeGlow.renderOrder = 3;
      mobTilt.add(edgeGlow);
      // 光鞘三角带（与边界线同采样、逐点同源）
      const shPos: number[] = [];
      const shA: number[] = [];
      const shIdx: number[] = [];
      const shProf: Array<[number, number]> = [
        [-0.07, 0.3],
        [0, 1],
        [0.17, 0],
      ];
      const fillSheathPos = (arr: number[] | Float32Array): void => {
        let k = 0;
        for (let i = 0; i < SEG; i++) {
          const p = pts[i]!;
          const d = dirs[i]!;
          for (const [off] of shProf) {
            arr[k++] = p.x + d.x * off;
            arr[k++] = p.y + d.y * off;
            arr[k++] = p.z + d.z * off;
          }
        }
      };
      fillSheathPos(shPos);
      for (let i = 0; i < SEG; i++) {
        for (const [, al] of shProf) shA.push(al);
      }
      for (let i = 0; i < SEG; i++) {
        const a = i * 3;
        const b = ((i + 1) % SEG) * 3;
        shIdx.push(
          a, b, a + 1, b, b + 1, a + 1,
          a + 1, b + 1, a + 2, b + 1, b + 2, a + 2,
        );
      }
      const shGeo = new THREE.BufferGeometry();
      shGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(shPos, 3),
      );
      shGeo.setAttribute(
        "aA",
        new THREE.Float32BufferAttribute(shA, 1),
      );
      shGeo.setIndex(shIdx);
      const sheath = new THREE.Mesh(shGeo, mobEdgeSheathMat);
      sheath.frustumCulled = false;
      sheath.renderOrder = 2;
      mobTilt.add(sheath);
      mobRebuilders.push(() => {
        fillEdgePts();
        const ea = edgeGeo.attributes
          .position as THREE.BufferAttribute;
        for (let i = 0; i < SEG; i++) {
          ea.setXYZ(i, pts[i]!.x, pts[i]!.y, pts[i]!.z);
        }
        ea.needsUpdate = true;
        const sa = shGeo.attributes
          .position as THREE.BufferAttribute;
        fillSheathPos(sa.array as Float32Array);
        sa.needsUpdate = true;
      });
    }
    // —— 星扣 + 双带尾：粉白星芒五角星扣压在 ∞ 正中心交叉
    // 点（两支错层相交处；渲染按开屏 00:06 双环中心的粉白
    // 星芒光晕，工单七——旧金属金色作废），两条短带尾自扣
    // 下垂落（一粉一蓝、随组轻摆）——
    const mobClasp = new THREE.Group();
    {
      const c0 = mobCenterAt(MOB_U1, new THREE.Vector3());
      // y 取两支错层（±0.06）的中位略上，星面压住交点
      mobClasp.position.set(c0.x, 0.02, c0.z);
    }
    mobTilt.add(mobClasp);
    const mobClaspStarMat = new THREE.MeshBasicMaterial({
      color: 0xffe9f4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mobClaspStar = ((): THREE.Mesh => {
      const shape = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2 + Math.PI / 2;
        const rr = i % 2 === 0 ? 0.17 : 0.074;
        const x = Math.cos(ang) * rr;
        const y = Math.sin(ang) * rr;
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();
      const m = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        mobClaspStarMat,
      );
      // 星面贴带面平面：局部 X→p 轴、Y→q 轴（3D (0, 0, −1)）、
      // 法向 +Y；星尖朝 q+（向大环环心）
      m.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(0, 1, 0),
        ),
      );
      m.renderOrder = 3;
      mobClasp.add(m);
      return m;
    })();
    const mobClaspGlowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(
        "rgba(255,238,246,0.95)",
        "rgba(244,170,205,0.30)",
      ),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const mobClaspGlow = new THREE.Sprite(mobClaspGlowMat);
    // 特效增密轮：星扣光晕 0.6→0.85 并带慢呼吸（帧段驱
    // 动 scale/opacity 的 ±7% 摆动，此处只是基准尺度）
    mobClaspGlow.scale.set(0.85, 0.85, 1);
    mobClaspGlow.renderOrder = 3;
    mobClasp.add(mobClaspGlow);
    // —— 四角星芒贴图（重生成轮，参考帧语言：结点与星尘
    // 的闪光都是四角星芒形，不是圆光点）：程序绘制——中
    // 心辉光 + 四向细长芒刺渐隐。星扣闪光、光尘、带周微
    // 粒共用这一张
    const mobStar4Tex = ((): THREE.CanvasTexture => {
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const g = c.getContext("2d")!;
      const core = g.createRadialGradient(64, 64, 1, 64, 64, 20);
      core.addColorStop(0, "rgba(255,255,255,0.95)");
      core.addColorStop(0.5, "rgba(255,255,255,0.35)");
      core.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = core;
      g.fillRect(44, 44, 40, 40);
      for (const rot of [0, Math.PI / 2]) {
        g.save();
        g.translate(64, 64);
        g.rotate(rot);
        const spike = g.createLinearGradient(-62, 0, 62, 0);
        spike.addColorStop(0, "rgba(255,255,255,0)");
        spike.addColorStop(0.5, "rgba(255,255,255,0.85)");
        spike.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = spike;
        g.fillRect(-62, -1.6, 124, 3.2);
        g.restore();
      }
      return new THREE.CanvasTexture(c);
    })();
    // 结点四角星芒闪光（参考帧：交叉点结点带四角星芒）：
    // 压在星扣上、帧段慢脉动 + 缓旋，采样白蓝系
    const mobClaspSparkMat = new THREE.SpriteMaterial({
      map: mobStar4Tex,
      color: 0xdceaff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mobClaspSpark = new THREE.Sprite(mobClaspSparkMat);
    mobClaspSpark.scale.set(0.62, 0.62, 1);
    mobClaspSpark.renderOrder = 4;
    mobClasp.add(mobClaspSpark);
    // 展开态结点光针（慢放 14s 后帧：结点向外发细直放射
    // 线）：30 条细线自结点向外、长短错落，色取结点紫/
    // 带缘蓝/白/粉（全采样色）；透明度随 morph 推进——
    // 收拢态不在场、展开态全开，帧段慢转
    const mobRaysMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mobRays = ((): THREE.LineSegments => {
      const pos: number[] = [];
      const col: number[] = [];
      const palette = [
        new THREE.Color(0x7c8ffb),
        new THREE.Color(0x7f5cfc),
        new THREE.Color(0xffffff),
        new THREE.Color(0xc77bae),
      ];
      for (let i = 0; i < 30; i++) {
        const th = Math.random() * Math.PI * 2;
        // 多数贴带面（局部 XZ）放射、少数略出面
        const tiltA = (Math.random() - 0.5) * 0.5;
        const len = 0.45 + Math.random() * 1.05;
        const dx = Math.cos(th);
        const dz = Math.sin(th);
        pos.push(0, 0, 0);
        pos.push(
          dx * len,
          Math.sin(tiltA) * len,
          dz * len,
        );
        const cc = palette[i % palette.length]!;
        col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(pos, 3),
      );
      geo.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(col, 3),
      );
      const lines = new THREE.LineSegments(geo, mobRaysMat);
      lines.frustumCulled = false;
      lines.renderOrder = 3;
      mobClasp.add(lines);
      return lines;
    })();
    const mobTailMats: THREE.MeshBasicMaterial[] = [];
    const mobTails = new THREE.Group();
    mobClasp.add(mobTails);
    {
      const tailDefs = [
        {
          dir: -0.55,
          colRoot: new THREE.Color(0xb45a96),
          colTip: new THREE.Color(0xc77bae),
        },
        {
          dir: 0.62,
          colRoot: new THREE.Color(0x62c0f9),
          colTip: new THREE.Color(0x97d1f5),
        },
      ];
      for (const td of tailDefs) {
        const SEG = 5;
        const LEN = 0.52;
        const pos: number[] = [];
        const col: number[] = [];
        const idx: number[] = [];
        // 下垂向（(p, q) 面内、自星扣向外下方斜置）与面内垂向
        const down = {
          x: Math.sin(td.dir),
          y: -Math.cos(td.dir),
        };
        const perp = { x: down.y, y: -down.x };
        const cTmp = new THREE.Color();
        for (let i = 0; i <= SEG; i++) {
          const s = i / SEG;
          const bend =
            0.07 * Math.sin(s * Math.PI) * Math.sign(td.dir);
          const cp = down.x * LEN * s + perp.x * bend;
          const cq = down.y * LEN * s + perp.y * bend;
          const hw = 0.062 * (1 - 0.45 * s);
          cTmp.lerpColors(td.colRoot, td.colTip, s);
          for (const sgn of [-1, 1]) {
            pos.push(
              cp + perp.x * hw * sgn,
              -0.01 - 0.02 * s,
              -(cq + perp.y * hw * sgn),
            );
            col.push(cTmp.r, cTmp.g, cTmp.b);
          }
        }
        for (let i = 0; i < SEG; i++) {
          const a = i * 2;
          idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(pos, 3),
        );
        g.setAttribute(
          "color",
          new THREE.Float32BufferAttribute(col, 3),
        );
        g.setIndex(idx);
        const mat = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        mobTailMats.push(mat);
        const mesh = new THREE.Mesh(g, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        mobTails.add(mesh);
      }
    }
    // 点按命中带（不可见、比带面宽 2.4 倍给指尖容差；材质
    // visible:false 的命中体是本场既有口径，见太阳/行星命中圈）
    const mobHitMat = new THREE.MeshBasicMaterial({ visible: false });
    const mobHitBand = ((): THREE.Mesh => {
      const pos: number[] = [];
      const idx: number[] = [];
      const tmp = new THREE.Vector3();
      const SU = 160;
      // 命中半宽 = 本截面带半宽 ×2.2（指尖容差随带宽分布
      // 走，变形中判定跟着带面走）
      const fillHitPos = (arr: number[] | Float32Array): void => {
        let k = 0;
        for (let i = 0; i <= SU; i++) {
          const u = (i / SU) * Math.PI * 2;
          const vFlip = i === SU ? -1 : 1;
          const hw = mobHalfW(u) * 2.2;
          for (let j = 0; j <= 1; j++) {
            const v = (-hw + j * 2 * hw) * vFlip;
            mobPoint(u, v, tmp);
            arr[k++] = tmp.x;
            arr[k++] = tmp.y;
            arr[k++] = tmp.z;
          }
        }
      };
      fillHitPos(pos);
      for (let i = 0; i < SU; i++) {
        const a = i * 2;
        const b = a + 2;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(pos, 3),
      );
      g.setIndex(idx);
      const m = new THREE.Mesh(g, mobHitMat);
      m.frustumCulled = false;
      mobTilt.add(m);
      mobRebuilders.push(() => {
        const attr = g.attributes
          .position as THREE.BufferAttribute;
        fillHitPos(attr.array as Float32Array);
        attr.needsUpdate = true;
      });
      return m;
    })();
    // —— 行走光点 + 不对称标记（局部标架系：X = 切向 T（行进
    // 方向）、Y = 横向 W、Z = 法向 N）：侧向箭鳍（鳍尖指 +W、
    // 贴带面 +N 微抬）+ 偏置小球（−T/−W/+N 的尾侧上方）——
    // 任一分量反号都看得出，W/N 同步反号时鳍尖与小球同时换边
    const mobWalker = new THREE.Group();
    mobTilt.add(mobWalker);
    const mobFinMat = new THREE.MeshBasicMaterial({
      color: 0xf6c9d4,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    {
      const shape = new THREE.Shape();
      shape.moveTo(-0.1, -0.085);
      shape.lineTo(0.1, -0.085);
      shape.lineTo(0, 0.3);
      shape.closePath();
      const fin = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        mobFinMat,
      );
      fin.position.z = 0.014;
      fin.renderOrder = 3;
      mobWalker.add(fin);
    }
    const mobCoreMat = new THREE.MeshBasicMaterial({
      color: 0xfff5f7,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    mobWalker.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 14, 10),
        mobCoreMat,
      ),
    );
    const mobBallMat = new THREE.MeshBasicMaterial({
      color: 0xf0e9ec,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mobBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.052, 14, 10),
      mobBallMat,
    );
    mobBall.position.set(-0.15, -0.1, 0.075);
    mobWalker.add(mobBall);
    const mobGlowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(
        "rgba(255,221,231,0.95)",
        "rgba(226,150,175,0.30)",
      ),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const mobGlow = new THREE.Sprite(mobGlowMat);
    mobGlow.scale.set(0.52, 0.52, 1);
    mobGlow.renderOrder = 4;
    mobWalker.add(mobGlow);
    const mobHit = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 8, 8),
      mobHitMat,
    );
    mobWalker.add(mobHit);
    const mobiusHitList: THREE.Object3D[] = [
      mobHitBand,
      mobHit,
      mobClaspStar,
    ];
    // —— 星尘微粒（昔涟定调；重生成轮按参考帧改四角星尘）：
    // 130 粒沿带面及带缘外稀疏漂移，逐帧只重算 130 个点
    // 位，廉价点云一张。色只取采样星尘色：粉 #DAB4D7 /
    // 蓝 #A4C6FD / 白 / 冰青 #5ACAE7
    const MOB_DUST_N = 130;
    const mobDustU = new Float32Array(MOB_DUST_N);
    const mobDustV = new Float32Array(MOB_DUST_N);
    const mobDustSp = new Float32Array(MOB_DUST_N);
    const mobDustPos = new Float32Array(MOB_DUST_N * 3);
    const mobDustCol = new Float32Array(MOB_DUST_N * 3);
    {
      const tmp = new THREE.Vector3();
      const palette = [
        new THREE.Color(0xc77bae),
        new THREE.Color(0x7c8ffb),
        new THREE.Color(0xffffff),
        new THREE.Color(0x62c0f9),
      ];
      for (let i = 0; i < MOB_DUST_N; i++) {
        mobDustU[i] = Math.random() * Math.PI * 2;
        mobDustV[i] = (Math.random() * 2 - 1) * 0.3;
        mobDustSp[i] = 0.008 + Math.random() * 0.02;
        mobPoint(mobDustU[i]!, mobDustV[i]!, tmp);
        mobDustPos[i * 3] = tmp.x;
        mobDustPos[i * 3 + 1] = tmp.y;
        mobDustPos[i * 3 + 2] = tmp.z;
        const pc = palette[i % palette.length]!;
        const bb = 0.6 + Math.random() * 0.4;
        mobDustCol[i * 3] = pc.r * bb;
        mobDustCol[i * 3 + 1] = pc.g * bb;
        mobDustCol[i * 3 + 2] = pc.b * bb;
      }
    }
    const mobDustGeo = new THREE.BufferGeometry();
    mobDustGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(mobDustPos, 3),
    );
    mobDustGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(mobDustCol, 3),
    );
    const mobDustMat = new THREE.PointsMaterial({
      map: mobStar4Tex,
      vertexColors: true,
      size: 0.115,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mobDust = new THREE.Points(mobDustGeo, mobDustMat);
    mobDust.frustumCulled = false;
    mobDust.renderOrder = 2;
    mobTilt.add(mobDust);
    // —— 粉紫花瓣漂移（工单四补充 3，元灿亲自指定开屏参考；
    // 工单七改色）：结周稀疏 6 片粉紫花瓣光斑（色相据开屏
    // 00:56 转场飘落花瓣）——漂移域收在星扣（∞ 正中心交叉
    // 点）邻域内：相位在 MOB_U1 ± 0.55 内各自小幅摆动、带
    // 面外侧浮沉自旋，不沿整条 ∞ 路径巡游；与光尘/星形光
    // 点并存，个位数精灵，不下花瓣雨。翻面迸散仍是水晶碎
    // 片，花瓣只出现在这一处漂移
    const MOB_PETAL_N = 6;
    const mobPetalTex = ((): THREE.CanvasTexture => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      const g = c.getContext("2d")!;
      const grad = g.createRadialGradient(32, 30, 2, 32, 32, 30);
      grad.addColorStop(0, "rgba(250,215,255,0.95)");
      grad.addColorStop(0.55, "rgba(216,150,235,0.55)");
      grad.addColorStop(1, "rgba(190,120,230,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(32, 4);
      g.bezierCurveTo(50, 22, 52, 40, 32, 60);
      g.bezierCurveTo(12, 40, 14, 22, 32, 4);
      g.closePath();
      g.fill();
      return new THREE.CanvasTexture(c);
    })();
    interface MobPetal {
      mat: THREE.SpriteMaterial;
      sprite: THREE.Sprite;
      baseU: number;
      v: number;
      oscAmp: number;
      oscSpd: number;
      spin: number;
      bobPh: number;
    }
    const mobPetals: MobPetal[] = [];
    for (let i = 0; i < MOB_PETAL_N; i++) {
      const mat = new THREE.SpriteMaterial({
        map: mobPetalTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const size = 0.15 + (i % 3) * 0.05;
      sprite.scale.set(size, size * 1.3, 1);
      sprite.renderOrder = 3;
      mobTilt.add(sprite);
      mobPetals.push({
        mat,
        sprite,
        baseU: MOB_U1 + (i - 2.5) * 0.22,
        v: (i % 2 === 0 ? 1 : -1) * (0.3 + (i % 3) * 0.1),
        oscAmp: 0.1 + (i % 3) * 0.06,
        oscSpd: 0.11 + (i % 3) * 0.037,
        spin: (i % 2 === 0 ? 1 : -1) * (0.3 + (i % 3) * 0.12),
        bobPh: i * 1.71,
      });
    }
    // —— 光点涟漪池（昔涟定调）：光点行进时身后在带面上扩散
    // 的细涟漪环，池 6 枚 LineLoop，躺带面局部 T-W 平面内扩
    // 散，半径到带宽量级时衰减消失 ——
    const MOB_RIPPLE_N = 6;
    const MOB_RIPPLE_LIFE = 2.6;
    const mobRipples: {
      line: THREE.LineLoop;
      mat: THREE.LineBasicMaterial;
      age: number;
      active: boolean;
    }[] = [];
    {
      const circ: THREE.Vector3[] = [];
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        circ.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
      }
      const circGeo = new THREE.BufferGeometry().setFromPoints(circ);
      for (let i = 0; i < MOB_RIPPLE_N; i++) {
        const mat = new THREE.LineBasicMaterial({
          color: 0xfcc9d8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const line = new THREE.LineLoop(circGeo, mat);
        line.frustumCulled = false;
        line.renderOrder = 2;
        line.visible = false;
        mobTilt.add(line);
        mobRipples.push({ line, mat, age: 0, active: false });
      }
    }
    let mobRippleTimer = 0;
    let mobRippleIdx = 0;
    // ════════════════════════════════════════════════════
    // —— 特效增密轮（2026-11-15 晚，元灿：「环上移后空间
    // 变大了，特效还要再加一些」）：五项全从 3.7 开屏视
    // 觉语言里长（暖面金橙→绿→青蓝 / 冷面银白→粉紫 / 白
    // 光边三系），不引入新花样；花瓣仍只许星扣邻域（本
    // 轮新微粒是圆点星光、不作花瓣形、不出带周域）——
    // ① 整环光场：沿 ∞ 中心线的宽幅辉光缎带（v ±1.05、
    // 带面处平台、向外高斯漫开），带从此带着一片光场出
    // 现，不再只有边缘发光；② 带周星光微粒：140 粒沿带
    // 周空间稀疏漂浮（白/粉/蓝），慢漂移、不成团；③ 行
    // 走光点长尾：光点身后 26 个采样点的渐隐光痕缎带
    // （既有涟漪的延伸——涟漪是面上的环、长尾是身后的
    // 痕）；④ 周期光脉冲：带面 shader 内一道光涌沿 ∞ 以
    // 22 秒一圈缓行（常驻光流动的起伏，不是另一套系
    // 统，见 mobBandMat 的 uPulseU）；⑤ 星扣光晕放大 +
    // 慢呼吸（帧段驱动）。新增绘制：光场缎带 1 + 微粒
    // 点云 1 + 长尾缎带 1 = 3，全廉价实现
    // ════════════════════════════════════════════════════
    const mobHaloMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uA: { value: 0 },
        uMorph: { value: 0 },
      },
      vertexShader: `
        attribute float aU;
        attribute float aV;
        varying float vU;
        varying float vV;
        void main() {
          vU = aU;
          vV = aV;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform float uA;
        uniform float uMorph;
        varying float vU;
        varying float vV;
        // 光场色与带面同源（原图直采色中段）：正面 环绕
        // 粉紫 #9A76B4 → 展开蓝 #3D4DEF；背面 环绕冰青
        // #97D1F5 → 展开结点紫 #5543E1，随 morph 插值
        vec3 mobWarmH(float x) {
          vec3 col = mix(vec3(0.604, 0.463, 0.706), vec3(0.239, 0.302, 0.937), uMorph);
          // 粉白脉冲掺入随 morph 收掉四分之三：光场在展开
          // 态须留在蓝紫家族、不许把带面罩成白纱
          return mix(col, vec3(0.851, 0.722, 0.824), pow(0.5 + 0.5 * sin(x * 6.2831853 * 2.0), 3.0) * 0.25 * (1.0 - 0.75 * uMorph));
        }
        void main() {
          float s = vU * 0.15915494;
          float flow = fract(s - uTime * 0.03);
          vec3 warm = mobWarmH(flow);
          vec3 cool = mix(vec3(0.592, 0.820, 0.961), vec3(0.333, 0.263, 0.882), uMorph);
          vec3 col = gl_FrontFacing ? warm : cool;
          // 饱和定版（与带面同口径 ×1.20）：加色混合最易
          // 洗淡，光场基色先拉回原图饱和分布再输出
          float hLum = dot(col, vec3(0.299, 0.587, 0.114));
          col = clamp(mix(vec3(hLum), col, 1.20), 0.0, 1.0);
          // vV 以带缘为 ±1 归一（几何 v ±1.35、带半宽
          // 0.2 → vV = v/0.2，带缘外即 |vV|>1）：带面平台
          // 0.13、向外高斯缓漫（柔焦扩散、无硬边）
          float d = max(0.0, abs(vV) - 1.0);
          float a = 0.13 * exp(-pow(d / 3.6, 2.0));
          gl_FragColor = vec4(col, a * uA);
        }`,
    });
    {
      const pos: number[] = [];
      const aus: number[] = [];
      const avs: number[] = [];
      const idx: number[] = [];
      const tmp = new THREE.Vector3();
      // 与带面共用 MOB_SEG_U 网格（标架缓存一份两用）；
      // 光场半宽 1.05 → 1.35（宽幅柔辉光晕、上限档）
      const SEG_U = MOB_SEG_U;
      const SEG_V = 10;
      const HALF = 1.35;
      const fillHaloPos = (arr: number[] | Float32Array): void => {
        let k = 0;
        for (let i = 0; i <= SEG_U; i++) {
          const vFlip = i === SEG_U ? -1 : 1;
          for (let j = 0; j <= SEG_V; j++) {
            const vGrid = -HALF + (j / SEG_V) * HALF * 2;
            mobCachePoint(i, vGrid * vFlip, tmp);
            arr[k++] = tmp.x;
            arr[k++] = tmp.y;
            arr[k++] = tmp.z;
          }
        }
      };
      fillHaloPos(pos);
      for (let i = 0; i <= SEG_U; i++) {
        const u = (i / SEG_U) * Math.PI * 2;
        for (let j = 0; j <= SEG_V; j++) {
          const vGrid = -HALF + (j / SEG_V) * HALF * 2;
          aus.push(u);
          avs.push(vGrid / (MOB_W / 2));
        }
      }
      for (let i = 0; i < SEG_U; i++) {
        for (let j = 0; j < SEG_V; j++) {
          const a = i * (SEG_V + 1) + j;
          const b = a + SEG_V + 1;
          idx.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      const haloGeo = new THREE.BufferGeometry();
      haloGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(pos, 3),
      );
      haloGeo.setAttribute(
        "aU",
        new THREE.Float32BufferAttribute(aus, 1),
      );
      haloGeo.setAttribute(
        "aV",
        new THREE.Float32BufferAttribute(avs, 1),
      );
      haloGeo.setIndex(idx);
      const halo = new THREE.Mesh(haloGeo, mobHaloMat);
      halo.renderOrder = 0;
      halo.frustumCulled = false;
      mobTilt.add(halo);
      mobRebuilders.push(() => {
        const attr = haloGeo.attributes
          .position as THREE.BufferAttribute;
        fillHaloPos(attr.array as Float32Array);
        attr.needsUpdate = true;
      });
    }
    // ② 带周星光微粒：沿带周（u 全程、v ±1.5、法向
    // ±0.5）稀疏布点，逐帧小幅漂移（相位各自、振幅
    // 0.05 内）。重生成轮：存 (u, v, 法向偏移) 参数、帧
    // 段按当前 morph 带面重算基点（变形时不脱带）；贴图
    // 换四角星芒、色换采样星尘色、增密 140 → 190
    const MOB_SPARK_N = 190;
    const mobSparkBase = new Float32Array(MOB_SPARK_N * 3);
    const mobSparkPos = new Float32Array(MOB_SPARK_N * 3);
    const mobSparkPh = new Float32Array(MOB_SPARK_N);
    const mobSparkU = new Float32Array(MOB_SPARK_N);
    const mobSparkV = new Float32Array(MOB_SPARK_N);
    const mobSparkN = new Float32Array(MOB_SPARK_N);
    const mobSparkGeo = new THREE.BufferGeometry();
    {
      const tmp = new THREE.Vector3();
      const fr: MobFrame = {
        c: new THREE.Vector3(),
        t: new THREE.Vector3(),
        w: new THREE.Vector3(),
        n: new THREE.Vector3(),
      };
      const cols = new Float32Array(MOB_SPARK_N * 3);
      const palette: Array<[number, number, number]> = [
        [1, 1, 1],
        [0.855, 0.706, 0.843],
        [0.643, 0.776, 0.992],
        [0.8, 0.616, 0.8],
      ];
      for (let i = 0; i < MOB_SPARK_N; i++) {
        const u = Math.random() * Math.PI * 2;
        const v = (Math.random() * 2 - 1) * 1.5;
        const nn = (Math.random() * 2 - 1) * 0.5;
        mobSparkU[i] = u;
        mobSparkV[i] = v;
        mobSparkN[i] = nn;
        mobFrameAt(u, 0, fr);
        tmp.copy(fr.c)
          .addScaledVector(fr.w, v)
          .addScaledVector(fr.n, nn);
        mobSparkBase[i * 3] = tmp.x;
        mobSparkBase[i * 3 + 1] = tmp.y;
        mobSparkBase[i * 3 + 2] = tmp.z;
        mobSparkPos[i * 3] = tmp.x;
        mobSparkPos[i * 3 + 1] = tmp.y;
        mobSparkPos[i * 3 + 2] = tmp.z;
        mobSparkPh[i] = Math.random() * Math.PI * 2;
        const pc = palette[i % palette.length]!;
        const bb = 0.55 + Math.random() * 0.45;
        cols[i * 3] = pc[0] * bb;
        cols[i * 3 + 1] = pc[1] * bb;
        cols[i * 3 + 2] = pc[2] * bb;
      }
      mobSparkGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(mobSparkPos, 3),
      );
      mobSparkGeo.setAttribute(
        "color",
        new THREE.BufferAttribute(cols, 3),
      );
    }
    const mobSparkMat = new THREE.PointsMaterial({
      map: mobStar4Tex,
      size: 0.105,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    const mobSparks = new THREE.Points(mobSparkGeo, mobSparkMat);
    mobSparks.frustumCulled = false;
    mobSparks.renderOrder = 2;
    mobTilt.add(mobSparks);
    // ③ 行走光点长尾：历史采样（位置 + W 向）环形缓冲，
    // 帧段按采样序拼渐隐缎带（aT：0 = 光点处、1 = 尾端）
    const MOB_TRAIL_N = 26;
    const mobTrailHist: Array<{
      p: THREE.Vector3;
      w: THREE.Vector3;
    }> = [];
    const mobTrailPos = new Float32Array(MOB_TRAIL_N * 2 * 3);
    const mobTrailA = new Float32Array(MOB_TRAIL_N * 2);
    for (let i = 0; i < MOB_TRAIL_N; i++) {
      mobTrailA[i * 2] = i / (MOB_TRAIL_N - 1);
      mobTrailA[i * 2 + 1] = i / (MOB_TRAIL_N - 1);
    }
    const mobTrailIdx: number[] = [];
    for (let i = 0; i < MOB_TRAIL_N - 1; i++) {
      const a = i * 2;
      mobTrailIdx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
    }
    const mobTrailGeo = new THREE.BufferGeometry();
    mobTrailGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(mobTrailPos, 3),
    );
    mobTrailGeo.setAttribute(
      "aT",
      new THREE.BufferAttribute(mobTrailA, 1),
    );
    mobTrailGeo.setIndex(mobTrailIdx);
    const mobTrailMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uA: { value: 0 } },
      vertexShader: `
        attribute float aT;
        varying float vT;
        void main() {
          vT = aT;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uA;
        varying float vT;
        void main() {
          float a = pow(1.0 - vT, 2.0) * 0.5;
          vec3 col = mix(vec3(1.0, 0.96, 0.98), vec3(0.96, 0.72, 0.82), vT);
          gl_FragColor = vec4(col, a * uA);
        }`,
    });
    const mobTrail = new THREE.Mesh(mobTrailGeo, mobTrailMat);
    mobTrail.frustumCulled = false;
    mobTrail.renderOrder = 2;
    mobTilt.add(mobTrail);
    let mobTrailLastU: number | null = null;
    // —— 带边漂浮水晶碎片（重生成轮，展开帧里的玻璃屑）：
    // 16 枚细长小棱柱贴带缘外侧缓慢漂移 + 自旋，色取采
    // 样冰蓝 #A4C6FD / 粉 #DAB4D7；存 (u, 侧, 法向偏移)
    // 参数、帧段按当前带面落位（与迸散碎片同语言：迸散
    // 是翻面瞬间飞散的、这一组是常驻漂浮的）
    const MOB_GLASS_N = 16;
    const mobGlassMats = [
      new THREE.MeshBasicMaterial({
        color: 0x7c8ffb,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
      new THREE.MeshBasicMaterial({
        color: 0xc77bae,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    ];
    const mobGlassGeo = new THREE.OctahedronGeometry(0.034);
    const mobGlass: {
      mesh: THREE.Mesh;
      u: number;
      side: number;
      nOff: number;
      drift: number;
      spin: THREE.Vector3;
    }[] = [];
    for (let i = 0; i < MOB_GLASS_N; i++) {
      const mesh = new THREE.Mesh(
        mobGlassGeo,
        mobGlassMats[i % 2]!,
      );
      mesh.scale.set(0.5, 1.8, 0.5);
      mesh.renderOrder = 3;
      mobTilt.add(mesh);
      mobGlass.push({
        mesh,
        u: Math.random() * Math.PI * 2,
        side: i % 2 === 0 ? 1 : -1,
        nOff: (Math.random() * 2 - 1) * 0.22,
        drift: 0.01 + Math.random() * 0.02,
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 1.6,
          (Math.random() - 0.5) * 1.6,
          (Math.random() - 0.5) * 1.6,
        ),
      });
    }
    const mobGlassFrame: MobFrame = {
      c: new THREE.Vector3(),
      t: new THREE.Vector3(),
      w: new THREE.Vector3(),
      n: new THREE.Vector3(),
    };
    // —— 翻面迸散（昔涟定调 · 实机修订）：光点走完一圈翻面
    // 瞬间迸出一小簇粉紫水晶碎片（细长八面体棱柱小片，品红
    // 芯色/青色折射边色两组材质）向外飞散 + 一点白色星爆，
    // 约 1.15 秒收净。实机没有花瓣雨——此处无任何花瓣/花朵
    // 元素 ——
    const MOB_SHARD_N = 14;
    const MOB_BURST_LIFE = 1.15;
    const mobShardGeo = new THREE.OctahedronGeometry(0.045);
    const mobShardMats = [
      new THREE.MeshBasicMaterial({
        color: 0xb45a96,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
      new THREE.MeshBasicMaterial({
        color: 0x62c0f9,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    ];
    const mobShards: {
      mesh: THREE.Mesh;
      vel: THREE.Vector3;
      spin: THREE.Vector3;
    }[] = [];
    for (let i = 0; i < MOB_SHARD_N; i++) {
      const mesh = new THREE.Mesh(
        mobShardGeo,
        mobShardMats[i % 2]!,
      );
      // 棱柱感：沿一轴拉长成细长水晶片
      mesh.scale.set(0.55, 1.9, 0.55);
      mesh.visible = false;
      mesh.renderOrder = 3;
      mobTilt.add(mesh);
      mobShards.push({
        mesh,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
      });
    }
    const mobStarMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(
        "rgba(255,255,255,0.98)",
        "rgba(255,240,248,0.35)",
      ),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mobStar = new THREE.Sprite(mobStarMat);
    mobStar.renderOrder = 4;
    mobStar.visible = false;
    mobTilt.add(mobStar);
    let mobBurstAge = MOB_BURST_LIFE + 1;
    let mobBurstCount = 0;
    const mobSpawnBurst = (
      origin: THREE.Vector3,
      tv: THREE.Vector3,
      wv: THREE.Vector3,
      nv: THREE.Vector3,
    ): void => {
      for (const sh of mobShards) {
        sh.mesh.position.copy(origin);
        const a = Math.random() * 0.9 - 0.2;
        const b = Math.random() * 1.6 - 0.8;
        const c = Math.random() * 0.9 + 0.1;
        const sp = 0.12 + Math.random() * 0.3;
        sh.vel
          .set(0, 0, 0)
          .addScaledVector(tv, a)
          .addScaledVector(wv, b)
          .addScaledVector(nv, c)
          .normalize()
          .multiplyScalar(sp);
        sh.spin.set(
          (Math.random() - 0.5) * 9,
          (Math.random() - 0.5) * 9,
          (Math.random() - 0.5) * 9,
        );
        sh.mesh.rotation.set(
          Math.random() * Math.PI,
          Math.random() * Math.PI,
          Math.random() * Math.PI,
        );
        sh.mesh.visible = true;
      }
      mobStar.position.copy(origin);
      mobStar.visible = true;
      mobBurstAge = 0;
      mobBurstCount++;
    };
    // —— 点选小卡（故事层款式：玫瑰色调底 + 细边，与数据层蓝
    // 玻璃卡分家；与彗星名卡同层 starLabelLayer、指针穿透，点
    // 别处/再点带体收起，见 handleTap 与 animate 莫比乌斯段）——
    const mobCard = document.createElement("div");
    mobCard.style.position = "absolute";
    mobCard.style.left = "12px";
    mobCard.style.bottom = "64px";
    mobCard.style.maxWidth = "min(78vw, 340px)";
    mobCard.style.padding = "9px 11px";
    mobCard.style.borderRadius = "10px";
    mobCard.style.background = "rgba(30,15,24,0.80)";
    mobCard.style.border = "1px solid rgba(240,180,200,0.45)";
    mobCard.style.boxShadow =
      "inset 0 1px 0 rgba(255,210,225,0.10), 0 2px 10px rgba(10,2,8,0.40)";
    mobCard.style.fontFamily = "'Noto Sans SC', system-ui, sans-serif";
    mobCard.style.opacity = "0";
    mobCard.style.visibility = "hidden";
    mobCard.style.willChange = "transform, opacity";
    {
      const head = document.createElement("div");
      head.style.display = "flex";
      head.style.alignItems = "baseline";
      head.style.gap = "8px";
      const title = document.createElement("span");
      title.textContent = "莫比乌斯带";
      title.style.fontSize = "13px";
      title.style.fontWeight = "600";
      title.style.letterSpacing = "0.04em";
      title.style.color = "rgba(252,238,243,0.97)";
      const tag = document.createElement("span");
      tag.textContent = "故事层 · 意象";
      tag.style.fontSize = "9px";
      tag.style.letterSpacing = "0.08em";
      tag.style.color = "#f0a8c0";
      tag.style.border = "1px solid rgba(240,168,192,0.5)";
      tag.style.borderRadius = "999px";
      tag.style.padding = "1px 6px";
      head.appendChild(title);
      head.appendChild(tag);
      mobCard.appendChild(head);
      const lines = [
        "莫比乌斯带只有一个面，沿它走完一圈，左右会翻转过来。",
        "它的「闭合版」是克莱因瓶，由两个莫比乌斯带粘合而成。",
        "宇宙整体可能有这类拓扑，但这仍是尚未被观测证实的假说；本元素是意象客串，不是数据。",
        "意象取自《崩坏：星穹铁道》昔涟与翁法罗斯的回环——原型是她右腕所戴、象征翁法罗斯的莫比乌斯手环；她终结技的名字里就写着「∞」；质感取自 3.7 开屏动画。",
      ];
      for (const text of lines) {
        const p = document.createElement("p");
        p.textContent = text;
        p.style.margin = "4px 0 0";
        p.style.fontSize = "11px";
        p.style.lineHeight = "1.55";
        p.style.color = "rgba(238,214,224,0.92)";
        mobCard.appendChild(p);
      }
    }
    starLabelLayer.appendChild(mobCard);
    // 莫比乌斯状态（animate 逐帧写、handleTap 读写选中态）
    // mobiusSelected 管小卡、迸散与带的高亮（2026-11-16
    // 元灿令「高亮可以改成点击后」：提亮改回点击触发——
    // mobSelK 向选中态趋近/回落，系数在常态基值与原点选
    // 态数值之间插值，点带提亮、关卡回落；此前一轮的常驻
    // 提亮作废）。流动光不读选中态：自 2026-11-16 更正轮
    // 起由时钟直推常开，点选与关卡都停不了它——高亮管点
    // 击、流动管恒在，两回事
    let mobiusSelected = false;
    /** 高亮趋近量 0=常态 / 1=点选提亮态（帧段逐帧趋近） */
    let mobSelK = 0;
    let mobiusVisNow = 0;
    let mobCardK = 0;
    let mobPhaseOverride: number | null = null;
    // morph 时钟（秒）：只在带在场、无相位覆盖、非
    // reduced-motion 时推进（冻结口径与行走光点同族）；
    // mobBuilt* = 上次几何重建时的 morph/波浪相位（变了
    // 才重建，静帧零成本）
    let mobMorphClock = 0;
    let mobBuiltM = -1;
    let mobBuiltWave = -1;
    // 边缘色调两端（原图直采）：环绕粉 #D9B8D2 → 展开
    // 缘蓝 #7C8FFB
    const mobTintWrapC = new THREE.Color(0xd9b8d2);
    const mobTintOpenC = new THREE.Color(0x7c8ffb);
    // 常驻流动光无点选状态（更正轮）：相位由帧段会话时钟
    // 直推（mobWaveMat.uFlowU），旧点选涟漪的进度/方向/原
    // 点/命中相位状态整套退役——点带只剩弹卡与迸散
    let mobPrevLoopFloor: number | null = null;
    const mobTmpV = new THREE.Vector3();
    // 展开落框解算临时量（帧段用；转正解算的相机基向
    // 量/四元数临时量已随不锁视角轮整段删除）
    const mobCenterWorldV = new THREE.Vector3();
    const mobCenterCamV = new THREE.Vector3();
    const mobWorldScaleV = new THREE.Vector3();
    const mobCamInvM = new THREE.Matrix4();
    const mobC = new THREE.Vector3();
    const mobTan = new THREE.Vector3();
    const mobWv = new THREE.Vector3();
    const mobNv = new THREE.Vector3();
    const mobBasisM = new THREE.Matrix4();
    const mobFrame: MobFrame = {
      c: new THREE.Vector3(),
      t: new THREE.Vector3(),
      w: new THREE.Vector3(),
      n: new THREE.Vector3(),
    };
    const mobState: {
      uDeg: number;
      loops: number;
      vis: number;
      selected: boolean;
      periodS: number;
      pos: [number, number, number];
      burstCount: number;
      ripplesActive: number;
      waveT: number;
      /** 星扣相位（度）：光点相位跨过它即过扣翻面 */
      claspDeg: number;
      /** 结周漂移的粉紫花瓣片数（工单四口径：个位数） */
      petalCount: number;
      /** 当前 morph（0 = 收拢环绕 / 1 = 展开），帧段逐帧写 */
      morph: number;
      /** morph 周期（秒） */
      morphPeriodS: number;
      /** 全览镜头联动拉远因子（涨满轮）：相机段逐帧写，
       * 收拢/非全览恒 1、展开端点 1.38 */
      dolly: number;
      /** 展开转正量（已退役）：不锁视角轮起恒 0——变
       * 形期间不再把带面转正对镜头；字段保留供探针读
       * 数，帧段逐帧写 0 */
      faceK: number;
      /** 展开落框倍率（落框轮）：mobTilt 当前等比缩放，
       * 收拢恒 1、展开停留段按相机深度解算（臂尖落
       * NDC ≈ 0.97、整带入框；窄屏可 < 1） */
      openScale: number;
    } = {
      uDeg: 0,
      loops: 0,
      vis: 0,
      selected: false,
      periodS: MOB_PERIOD_S,
      pos: [0, 0, 0],
      burstCount: 0,
      ripplesActive: 0,
      waveT: -1,
      claspDeg: (MOB_U1 * 180) / Math.PI,
      petalCount: MOB_PETAL_N,
      morph: 0,
      morphPeriodS: MOB_MORPH_PERIOD_S,
      dolly: 1,
      faceK: 0,
      openScale: 1,
    };
    (window as unknown as Record<string, unknown>).__financeGlobeMobius =
      {
        state: () => ({ ...mobState, pos: [...mobState.pos] }),
        // 确定性跳相位（入参 = 圈数，可带小数；null 回会话时钟）：
        // 跳相位期间整体自转冻结，同一 u 的两帧空间位置恒等，
        // 只剩标架翻转差异——翻面对比帧的取帧口径
        setPhase: (loops: number | null) => {
          mobPhaseOverride = loops;
        },
        // 确定性钉 morph（0 = 收拢 / 0.5 = 中间态 / 1 = 展
        // 开；null 回 48 秒节律自动变形）——收拢/展开/中
        // 间态三帧的取帧口径
        setMorph: (m: number | null) => {
          mobMorphPin =
            m === null
              ? null
              : THREE.MathUtils.clamp(m, 0, 1);
        },
        // 确定性钉整体自转角（弧度；null 回 300 秒/圈自
        // 转）——取「读得出前后层次」的角度帧用
        setSpin: (rad: number | null) => {
          mobSpinPin = rad;
        },
        select: (v: boolean) => {
          mobiusSelected = v;
        },
        // 翻面迸散确定性触发（验收取帧用）：在光点当前标架处
        // 迸散一簇，与走完一圈的自动迸散同一通道
        burst: () => {
          const q = mobWalker.quaternion;
          const tv = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
          const wv = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
          const nv = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
          mobSpawnBurst(mobWalker.position, tv, wv, nv);
        },
        // 光点屏幕坐标（画布相对 px，探针据此发真实点按）
        walkerPx: () => {
          const rect = el.getBoundingClientRect();
          const v = new THREE.Vector3();
          mobWalker.getWorldPosition(v);
          v.project(camera);
          return {
            x: ((v.x + 1) / 2) * rect.width,
            y: ((1 - v.y) / 2) * rect.height,
            behind: v.z >= 1,
          };
        },
        // 星扣屏幕坐标（画布相对 px）：星扣前后取帧/点按用
        claspPx: () => {
          const rect = el.getBoundingClientRect();
          const v = new THREE.Vector3();
          mobClasp.getWorldPosition(v);
          v.project(camera);
          return {
            x: ((v.x + 1) / 2) * rect.width,
            y: ((1 - v.y) / 2) * rect.height,
            behind: v.z >= 1,
          };
        },
        // 任意圈数处的标架数值（离线核验翻面用：同一 loops
        // 小数部分、圈数差 1 时 pos 恒等、w/n 严格反号）
        frameAt: (loops: number) => {
          const u = MOB_U0 + loops * Math.PI * 2;
          const circ = Math.floor(u / (Math.PI * 2));
          const fr: MobFrame = {
            c: new THREE.Vector3(),
            t: new THREE.Vector3(),
            w: new THREE.Vector3(),
            n: new THREE.Vector3(),
          };
          mobFrameAt(mobWrapU(u), circ, fr);
          return {
            pos: [fr.c.x, fr.c.y, fr.c.z],
            t: [fr.t.x, fr.t.y, fr.t.z],
            w: [fr.w.x, fr.w.y, fr.w.z],
            n: [fr.n.x, fr.n.y, fr.n.z],
          };
        },
      };
    await sl.yieldNow();
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
    // uCols/uOffs 5 停点、逐颗偏移），全五颗具名彗星同语
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
    // 五颗具名彗星共用本工厂；近日点喷流（makeCometSparks）
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
    // sharp）/ 5 坦普尔冰刃 纯白→冰青→靛紫（小粒快而亮的针
    // 点）；速度/尺寸/亮度系数逐颗走 def。绘制账：每颗 1
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
          "  else if (uMode > 3.5 && uMode < 4.5) { cNew = vec3(0.94, 1.0, 0.96); cMid = vec3(0.25, 0.91, 0.68); cOld = vec3(0.04, 0.56, 0.43); }",
          "  else if (uMode > 4.5) { cNew = vec3(1.0, 1.0, 1.0); cMid = vec3(0.60, 0.88, 1.0); cOld = vec3(0.42, 0.38, 0.92); }",
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
    // 几何）+ 近日点冰晶喷流 1 + 轨道线 1，五颗合计 ≈38 次绘
    // 制（任一时刻只一颗在场、实绘只一份）；无变红燃烧（物理色口径，见模块层注），但近日点粒子
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
      // 分片让行：逐彗星查一次时间预算（尾幕/喷流几何逐颗构建）
      await sl.tick();
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
      // 埃射线更疏更飘、艾森离子射线最密最稳（极细长直帘）、
      // 坦普尔次密而稳（窄直冰刃，波幅压到 0.009 不飘）
      const ion = makeTailCurtain(
        def.ionPalette,
        def.ionRim,
        def.ionLayers,
        def.id === "ison" ? 190 : def.id === "tempel" ? 180 : 150,
        0.55,
        def.id === "ison" ? 0.008 : def.id === "tempel" ? 0.009 : 0.012,
        def.id === "ison" ? 1.3 : def.id === "tempel" ? 1.25 : 1.15,
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
    await sl.yieldNow();
    // —— 月球组：细绕地轨道圈 + 月球本体 + 标签，随地球一同绕日 ——
    // 挂在 solarGroup 下、逐帧钉到地球轨道位（earthAnchor）；组平面带
    // 约 5° 倾角（月球轨道对黄道的真实倾角量级）。月球材质只留极弱的
    // 自发光模拟地照，盈亏完全由太阳点光源的真实照明决定。
    {
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
      await sl.yieldNow();
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
    // 邻域偏航惯性（拖动补完轮）：邻域拖动的松手甩速专属量——
    // 旧实现邻域分支写的是 velY，而 velY 只被地球段消费，邻域
    // 里惯性恒为零、数值还会泄漏成回主页后地球的一帧抖动。
    // galVelY 在邻域分支写入、银河帧段在邻域在位时消费（逐
    // 帧续推 galYawT、按 exp(−dt·3) 衰减，与地球惯性同一时
    // 间常数 τ≈0.33s）
    let galVelY = 0;
    // —— 手势双路驱动锁（移动端拖拽取证轮）——
    // 取证结论（全链审计，见 DATA-PLAN 本轮条目）：邻域手势
    // 只有 Pointer Events 一条输入路；宿主 WebView 一旦在手
    // 势中途把指针流掐断（pointercancel 或静默丢弃），或帧
    // 段驱动的 touch-action 切换晚于落指，拖动即死，而前两
    // 轮修的增益/惯性/求解时机都在这条流的下游，流断了全都
    // 无效。本轮补第二路：touchstart/touchmove 兜底通道（仅
    // 邻域在位时接管，{passive:false}+preventDefault），与指
    // 针路按 gestureDriver 加锁互斥——先激活者独占整场手
    // 势，另一路的事件一律忽略，绝不双重施加。
    // feedingTouch = 兜底通道正在把合成指针事件喂给共用处
    // 理函数（onDown/onMove/onUp/onCancel），处理函数内的驱
    // 动锁判定据此放行自身、且不执行指针路的驱动释放。
    let gestureDriver: "none" | "pointer" | "touch" = "none";
    let feedingTouch = false;
    // 邻域拖拽 1:1 直连的基准重锚：落指时快照当刻的偏航
    // 目标；首次越过拖动阈值的那一帧，把目标重锚到「当
    // 前实际角 + 本次手势已累积的目标位移」——入场摆入若尚
    // 未落定就被抓握，直连从当前画面角起步，不跳帧；纯点
    // 按从不越阈、不触发重锚，入场摆入不被点按打断。极角
    // 自 2026-11-15 晚纯方位角轮起不在重锚之列：邻域拖动
    // 根本不写极角目标，快照里不再有 galDragTiltT0。
    let galDragRebasePending = false;
    let galDragYawT0 = 0;
    /** 指针路的手势收尾释放驱动锁（兜底喂入的事件不走此路） */
    const releaseGestureDriver = () => {
      if (!feedingTouch) gestureDriver = "none";
    };
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
    /** 本次捏合归属银河（落指时 gTrans 占优）：缩放只写 galaxyZoom、不平移 */
    let pinchForGalaxy = false;
    /** 本次捏合落在银河邻域档：缩放改写邻域档内倍率 galaxyNearZoomT */
    let pinchGalaxyNear = false;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;
    let pinchStartMid = { x: 0, y: 0 };
    let pinchStartPan = { x: 0, y: 0 };

    /** 模式切换过渡进行中（进度未落位）：禁止一切交互，防误触穿透 */
    const transitionBusy = () =>
      Math.abs((stateRef.current.solarSystem ? 1 : 0) - trans) > 0.02 ||
      Math.abs((stateRef.current.galaxy ? 1 : 0) - gTrans) > 0.02;

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

    // 指针捕获（拖动补完轮）：鼠标/触控笔恒捕获（无页面平移手
    // 势，保拖出画布也能转）；触摸只在银河邻域在位时捕获——该
    // 态画布 touch-action 已是 none、页面滚动由 App 视口浮层
    // 遏制，捕获只让 move 流稳定跟手（指尖滑出画布边缘不丢事
    // 件、不被浮层内其他元素抢走），不改变手势语义；主页/太
    // 阳系的触摸不捕获，留给浏览器按 pan-y 接管竖滑滚页面
    const capturePtr = (e: PointerEvent) => {
      if (
        e.pointerType !== "touch" ||
        (stateRef.current.galaxy &&
          stateRef.current.galaxyView !== "full")
      ) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
      }
    };
    const releasePtr = (e: PointerEvent) => {
      try {
        if (el.hasPointerCapture(e.pointerId))
          el.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const onDown = (e: PointerEvent) => {
      if (transitionBusy()) return;
      // 驱动锁（取证轮）：触摸兜底路独占期间，真实指针事件
      // 一律忽略；兜底喂入的合成事件（feedingTouch）放行
      if (gestureDriver === "touch" && !feedingTouch) return;
      if (!feedingTouch) gestureDriver = "pointer";
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
          pinchForGalaxy = gTrans > 0.5;
          pinchGalaxyNear =
            pinchForGalaxy && stateRef.current.galaxyView !== "full";
          pinchStartZoom = pinchForGalaxy
            ? pinchGalaxyNear
              ? galaxyNearZoomT
              : galaxyZoom
            : solarZoom;
          pinchStartMid = {
            x: (p1.x + p2.x) / 2,
            y: (p1.y + p2.y) / 2,
          };
          pinchStartPan = { x: solarPan.x, y: solarPan.y };
          capturePtr(e);
          return;
        }
      }
      dragging = true;
      moved = 0;
      maxDisp = 0;
      velY = 0; // 清掉上一次拖拽的残留甩速，避免之后被误当惯性重放
      galVelY = 0; // 邻域惯性同清：新拖拽不继承上一次的甩速
      totalDx = 0;
      totalDy = 0;
      gesture = "none";
      lastX = e.clientX;
      lastY = e.clientY;
      downId = e.pointerId;
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
      // 邻域直连重锚快照（取证轮）：记住落指当刻的目标值，
      // 首次越阈时据此把目标重锚到当前实际角（见 onMove 邻
      // 域分支）；非邻域落指把待办清掉，不许跨态残留
      if (
        stateRef.current.galaxy &&
        stateRef.current.galaxyView !== "full"
      ) {
        galDragYawT0 = galYawT;
        galDragRebasePending = true;
      } else {
        galDragRebasePending = false;
      }
      // 捕获口径见 capturePtr 处注（邻域触摸本轮起也捕获）
      capturePtr(e);
    };
    const onMove = (e: PointerEvent) => {
      // 驱动锁（取证轮）：兜底路独占期间忽略真实指针流
      if (gestureDriver === "touch" && !feedingTouch) return;
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
          if (pinchForGalaxy) {
            if (pinchGalaxyNear) {
              // 邻域内连续变焦（真机修正轮）：同一视角内一路
              // 推近——倍率上限 24 对应取景窗半径 1.1 kpc/24
              // ≈ 46 pc，内圈四星（2.6–7.7 pc）在真实位置上
              // 自然分开看清；不设独立特写档位。下限 0.6 拉远
              // 到约 1.8 kpc 窗
              galaxyNearZoomT = THREE.MathUtils.clamp(
                pinchStartZoom * (dist / pinchStartDist),
                GAL_NEAR_ZOOM_MIN,
                24,
              );
            } else {
              galaxyZoom = THREE.MathUtils.clamp(
                pinchStartZoom * (dist / pinchStartDist),
                0.55,
                3,
              );
            }
            return;
          }
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
        // 银河邻域单指环视：不走下方方向锁——手势整场被邻域
        // 消费（画布 touch-action 已在邻域在位时切 none、帧段
        // 同步，浏览器不会把纵拖接管成页面滚动），但只有横向
        // 分量进视角：横 = 绕太阳环视偏航（增益 0.005），纵向
        // 分量整段不写任何状态——极角恒等于入场极角（2026-
        // 11-15 晚纯方位角轮，用户：「只左右旋转，不要加上
        // 下」；旧 pitch 通道 0.003 + 夹取 [0.15, 1.35] 在邻
        // 域停用）。只写目标、帧段阻尼落笔。旧逻辑在邻域里的
        // 实查缺陷（拖动修正轮）：①纵拖被方向锁判给页面滚动
        // （或判横向后把纵向分量整段丢弃）；②横拖转的是盘面
        // 自转角——邻域看着像原地转一张地图，不是绕太阳环
        // 视；③捏合写全览缩放、在邻域取景下视觉空操作（已在
        // 捏合段分流纠正）
        if (gTrans > 0.5 && stateRef.current.galaxyView !== "full") {
          if (moved > 4) {
            userHold = true;
            if (galDragRebasePending) {
              // 直连重锚（取证轮）：首次越阈先把偏航目标搬到
              // 当前实际角 + 已累积位移上，再吃本帧增量——帧
              // 段直连赋值（galYaw = galYawT）从这一帧起严丝
              // 合缝，入场摆入未落定时被抓握也不跳帧。极角目
              // 标不参与重锚：它恒为入场极角、拖动不许碰
              galDragRebasePending = false;
              galYawT = galYaw + (galYawT - galDragYawT0);
            }
            galYawT += dx * 0.005;
            galVelY = dx * 0.005;
          }
          return;
        }
        if (gesture === "none" && moved > 8) {
          gesture =
            Math.abs(totalDy) > Math.abs(totalDx) * 1.15 ? "v" : "h";
        }
        // 竖滑：什么都不做，等浏览器平移页面并以 pointercancel 收尾
        if (gesture !== "h") return;
        if (moved > 4) {
          userHold = true;
          // 银河系模式下横拖转银盘（绕银轴）；太阳系模式下横拖旋转
          // 的是太阳系（聚焦态改绕天体环视）；地球模式改拖拽偏移
          // （姿态在 animate 里合成，偏移不污染自转角）
          if (gTrans > 0.5) {
            galaxySpin.rotation.y += dx * 0.0045;
          } else if (trans > 0.5) {
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
        if (gTrans > 0.5) {
          if (stateRef.current.galaxyView !== "full") {
            // 邻域环视（与触摸同语法）：只有绕太阳偏航——纵向
            // 分量不进视角、极角恒等于入场极角（2026-11-15 晚
            // 纯方位角轮）；只写目标、帧段落笔；直连重锚与触
            // 摸路同一口径（取证轮，首次越阈搬偏航目标到当前
            // 实际角，极角目标不参与）
            if (galDragRebasePending) {
              galDragRebasePending = false;
              galYawT = galYaw + (galYawT - galDragYawT0);
            }
            galYawT += dx * 0.005;
          } else {
            // 全览：横拖绕银轴转盘、纵拖调俯角（目标制 + 帧段阻
            // 尼，旧实现直写组旋转无阻尼）
            galaxySpin.rotation.y += dx * 0.0045;
            galTiltT = THREE.MathUtils.clamp(
              galTiltT + dy * 0.003,
              0.18,
              1.25,
            );
          }
        } else if (trans > 0.5) {
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
        // 甩速分流：邻域写 galVelY（银河帧段消费），其余写
        // velY（地球段消费）——互不泄漏
        if (gTrans > 0.5 && stateRef.current.galaxyView !== "full") {
          galVelY = dx * 0.005;
        } else {
          velY = dx * 0.005;
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      // 驱动锁（取证轮）：兜底路独占期间，真实 pointerup 不
      // 许碰手势状态（兜底的收尾由 touchend 路径喂入）
      if (gestureDriver === "touch" && !feedingTouch) return;
      releasePtr(e);
      if (transitionBusy()) {
        // 过渡中抬手：只复位手势状态，不触发任何点按语义
        if (e.pointerType === "touch") touchPts.delete(e.pointerId);
        dragging = false;
        userHold = false;
        pinching = false;
        releaseGestureDriver();
        return;
      }
      if (e.pointerType === "touch") touchPts.delete(e.pointerId);
      if (pinching) {
        // 捏合收尾：不触发点按，释放保持锁（同拖拽松手规则）
        if (touchPts.size < 2) {
          pinching = false;
          userHold = false;
          // 邻域捏合改了倍率：同样置落定再求解待办
          if (pinchGalaxyNear) galLabelResolvePending = true;
        }
        if (touchPts.size === 0) releaseGestureDriver();
        return;
      }
      if (e.pointerId !== downId) return;
      dragging = false;
      // 松手即释放 userHold：惯性（velY）在 animate 里衰减，衰减完后
      // 自转按 autoRotate 开关恢复；不释放的话开关永远失效。
      userHold = false;
      // 邻域里真拖过（最大偏移已出点按阈值）：置落定再求解待
      // 办，帧段等手势与惯性都停稳后消费；纯点按不置（几何
      // 没动过，求解结果必然同值）
      if (
        maxDisp > (e.pointerType === "touch" ? 16 : 10) &&
        stateRef.current.galaxy &&
        stateRef.current.galaxyView !== "full"
      ) {
        galLabelResolvePending = true;
      }
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
      releaseGestureDriver();
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
        // 银河系模式点按（2026-11-15 改判，用户亲述逻辑为准：
        // 「点太阳系不该退出、点银心才回银河」——旧实现邻域里点
        // 太阳标记与全览共用一条互切，点太阳系就被弹出邻域）：
        // · 全览：点太阳标记 → 进太阳邻域（与邻域点银心回全览
        //   正好对称：点哪个中心去哪个尺度；底栏钮仍是明路）
        // · 邻域：点银心罗盘标记（含名签热区）→ 回银河全览；
        //   点太阳系标记（引力井 + 「太阳系」签）→ 只把镜头回
        //   正到入场朝向与默认倍率，绝不退出邻域
        // · 点空处不触发任何事。判定走屏幕距离（标记的世界坐
        //   标投影 / 帧段登记的罗盘落位），与天体点按同一口径
        if (gTrans > 0.5) {
          const tapX = clientX - rect.left;
          const tapY = clientY - rect.top;
          if (stateRef.current.galaxyView !== "full") {
            // —— 邻域内改判 ——
            // ① 银心罗盘：标记圆盘热区（半径 30px，标记本体
            // 36px + 呼吸环圈内）或名签矩形热区（签宽 168px /
            // 高约 38px，各留一点余量）→ 回全览（走既有邻域
            // 混合的连续镜头，不跳变）
            const cs2 = galCompassState;
            if (cs2.mkPxX >= 0) {
              const dMk = Math.hypot(
                tapX - cs2.mkPxX,
                tapY - cs2.mkPxY,
              );
              const inCompassLabel =
                Math.abs(tapX - cs2.lbPxX) <= 92 &&
                Math.abs(tapY - cs2.lbPxY) <= 26;
              if (dMk <= 30 || inCompassLabel) {
                stateRef.current.onGalaxyViewChange?.("full");
                return;
              }
            }
            // ② 太阳系标记：太阳恒钉画面中心（枢轴不变量），
            // 引力井足迹按井口 1.2 pc 的默认帧投影约 90px 半
            // 径取热区；「太阳系」签按其精灵实际世界位投影取
            // 矩形热区。命中 = 回正：与入场边沿同一套解算只写
            // 目标（偏航/极角/倍率），帧段阻尼平滑落位、不跳
            // 帧；galaxyView 一字不动，构造上不可能退出邻域
            galaxyGroup.updateMatrixWorld(true);
            const sunV = galaxySunWorld.clone().project(camera);
            if (sunV.z < 1) {
              const sunPxX = ((sunV.x + 1) / 2) * rect.width;
              const sunPxY = ((1 - sunV.y) / 2) * rect.height;
              const dSun = Math.hypot(
                tapX - sunPxX,
                tapY - sunPxY,
              );
              let inSunLabel = false;
              if (galSunLabel) {
                const lv = new THREE.Vector3();
                galSunLabel.getWorldPosition(lv);
                lv.project(camera);
                if (lv.z < 1) {
                  const lbX = ((lv.x + 1) / 2) * rect.width;
                  const lbY = ((1 - lv.y) / 2) * rect.height;
                  inSunLabel =
                    Math.abs(tapX - lbX) <= 62 &&
                    Math.abs(tapY - lbY) <= 22;
                }
              }
              if (dSun <= 92 || inSunLabel) {
                galVelY = 0;
                const entryPol = galEntryPol(galaxySpin.rotation.y);
                galTiltT = entryPol;
                const targetYaw = galEntryYaw(
                  galaxySpin.rotation.y,
                  entryPol,
                );
                let dYaw = (targetYaw - galYaw) % (Math.PI * 2);
                if (dYaw > Math.PI) dYaw -= Math.PI * 2;
                if (dYaw < -Math.PI) dYaw += Math.PI * 2;
                galYawT = galYaw + dYaw;
                galaxyNearZoomT = 11;
              }
            }
            return;
          }
          // —— 全览：点太阳标记进邻域 ——
          const cs = Math.cos(galaxySpin.rotation.y);
          const sn = Math.sin(galaxySpin.rotation.y);
          const sp = galSunBase.clone();
          sp.set(
            sp.x * cs + sp.z * sn,
            sp.y,
            -sp.x * sn + sp.z * cs,
          );
          galaxyGroup.updateMatrixWorld(true);
          galaxyGroup.localToWorld(sp);
          const v = sp.project(camera);
          if (v.z < 1) {
            const sx = ((v.x + 1) / 2) * rect.width;
            const sy = ((1 - v.y) / 2) * rect.height;
            const tapPx = Math.hypot(
              clientX - rect.left - sx,
              clientY - rect.top - sy,
            );
            if (tapPx <= 56) {
              stateRef.current.onGalaxyViewChange?.("near");
            }
          }
          return;
        }
        // 太阳系模式：点中任意天体（太阳/八大行星/月球的本体、放大命中
        // 圈或标签）→ 聚焦飞近观赏；点空处不触发任何事（不误触返回，
        // 返回走 App 的「返回太阳系」钮与点星球链路）。行星地球的本体
        // 是监控球 sphere，单独并入判定。
        if (trans > 0.5) {
          raycaster.camera = camera; // 精灵（标签）射线检测需要
          // 莫比乌斯带客串命中（故事层，见构建段）：先算命中、
          // 最后裁决——下方行星命中（聚焦优先/通用命中/地球球
          // 体）全部优先于它，既有点按行为零改动；只有点空处
          // 时才由它接：命中带体/光点 → 切换小卡，未命中 → 收
          // 起小卡。带体只在全览在位（mobiusVisNow > 0.5）时
          // 可点，近览/聚焦/银河恒不触发
          const mobHitObjs =
            mobiusVisNow > 0.5
              ? raycaster.intersectObjects(mobiusHitList, false)
              : [];
          const mobHit = mobHitObjs.length > 0;
          // 旧「命中点换算带面相位」是点选涟漪的扩散原点——
          // 流动光改常驻时钟驱动后无消费者，整段退役（更正轮）
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
            mobiusSelected = false;
            stateRef.current.onBodyFocus?.(
              hit.object.userData.bodyId as string,
            );
            return;
          }
          if (raycaster.intersectObject(sphere, false).length) {
            mobiusSelected = false;
            stateRef.current.onBodyFocus?.("earth");
            return;
          }
          // 点空处：莫比乌斯带最后裁决（命中切换小卡、未命中收起）
          mobiusSelected = mobHit ? !mobiusSelected : false;
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
      // 驱动锁（取证轮）：兜底路独占期间忽略真实指针的 cancel
      if (gestureDriver === "touch" && !feedingTouch) return;
      // 干净收尾（拖动补完轮）：释放捕获、清邻域惯性——被浏览
      // 器接管的手势不许留下甩速在松手后自己续转
      releasePtr(e);
      galVelY = 0;
      if (e.pointerType === "touch") touchPts.delete(e.pointerId);
      if (pinching) {
        if (touchPts.size < 2) {
          pinching = false;
          userHold = false;
        }
        if (touchPts.size === 0) releaseGestureDriver();
        return;
      }
      if (e.pointerId !== downId) return;
      dragging = false;
      userHold = false;
      // 被浏览器接管收尾的邻域拖动同样置落定再求解待办
      if (
        stateRef.current.galaxy &&
        stateRef.current.galaxyView !== "full"
      ) {
        galLabelResolvePending = true;
      }
      if (
        e.pointerType === "touch" &&
        trans > 0.5 &&
        performance.now() - downT < 400 &&
        maxDisp <= 18 &&
        Math.abs(totalDy) <= Math.abs(totalDx) * 1.2 + 6
      ) {
        handleTap(lastX, lastY);
      }
      releaseGestureDriver();
    };
    // 滚轮缩放（太阳系/银河系模式，桌面补充；移动端走双指捏合）
    const onWheel = (e: WheelEvent) => {
      if (gTrans > 0.5) {
        e.preventDefault();
        if (stateRef.current.galaxyView !== "full") {
          galaxyNearZoomT = THREE.MathUtils.clamp(
            galaxyNearZoomT * Math.exp(-e.deltaY * 0.0012),
            GAL_NEAR_ZOOM_MIN,
            24,
          );
        } else {
          galaxyZoom = THREE.MathUtils.clamp(
            galaxyZoom * Math.exp(-e.deltaY * 0.0012),
            0.55,
            3,
          );
        }
        return;
      }
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
    // —— 触摸兜底通道（移动端拖拽取证轮）——
    // 与指针路共用 onDown/onMove/onUp/onCancel 全部手势语
    // 义：把 Touch 翻译成合成指针事件（pointerId = 10^6 +
    // identifier，与真实指针 id 命名空间隔离；capturePtr 对
    // 合成 id 的 setPointerCapture 会抛错、已被其 try/catch
    // 吞掉，兜底路不依赖捕获——touch 事件天然跟指）。接管
    // 条件刻意收窄：只在邻域在位（画布本就该独占手势、
    // touch-action 已切 none）时才可能激活，非邻域态直接
    // 返回、主页 pan-y 与太阳系手势零影响。与指针路的互斥
    // 走 gestureDriver：指针路先激活则兜底整场旁观；唯一例
    // 外是残锁接管——driver 名义为 pointer 但手势状态已空
    // （流被宿主静默掐断、连 cancel 都没发），新触摸落指时
    // 兜底接管。兜底独占期间 touchmove 恒 preventDefault
    // （{passive:false}），宿主无从把手势仲裁给滚动/缩放。
    const TOUCH_PTR_BASE = 1_000_000;
    const asSyntheticPtr = (t: Touch): PointerEvent =>
      ({
        pointerType: "touch",
        pointerId: TOUCH_PTR_BASE + t.identifier,
        clientX: t.clientX,
        clientY: t.clientY,
      }) as PointerEvent;
    const feedTouch = (fn: (e: PointerEvent) => void, t: Touch) => {
      feedingTouch = true;
      try {
        fn(asSyntheticPtr(t));
      } finally {
        feedingTouch = false;
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      if (
        !stateRef.current.galaxy ||
        stateRef.current.galaxyView === "full"
      )
        return;
      if (gestureDriver === "pointer") {
        // 残锁判定：指针路手势状态全空才接管；真捏合/真拖
        // 拽在行时兜底绝不插手
        if (dragging || pinching || touchPts.size > 0) return;
        gestureDriver = "none";
      }
      if (gestureDriver !== "none") return;
      gestureDriver = "touch";
      e.preventDefault();
      for (const t of Array.from(e.changedTouches))
        feedTouch(onDown, t);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (gestureDriver !== "touch") return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches))
        feedTouch(onMove, t);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (gestureDriver !== "touch") return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches))
        feedTouch(onUp, t);
      if (e.touches.length === 0) gestureDriver = "none";
    };
    const onTouchCancel = (e: TouchEvent) => {
      if (gestureDriver !== "touch") return;
      for (const t of Array.from(e.changedTouches))
        feedTouch(onCancel, t);
      if (e.touches.length === 0) gestureDriver = "none";
    };
    el.addEventListener("touchstart", onTouchStart, {
      passive: false,
    });
    el.addEventListener("touchmove", onTouchMove, {
      passive: false,
    });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchCancel, {
      passive: false,
    });
    td.handlers = {
      down: onDown,
      move: onMove,
      up: onUp,
      cancel: onCancel,
      wheel: onWheel,
      touchStart: onTouchStart,
      touchMove: onTouchMove,
      touchEnd: onTouchEnd,
      touchCancel: onTouchCancel,
    };

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
      // 银河系全盘拟合：桌面维持 7.7 口径不动。移动端（粗指
      // 针）定标（真机修正轮二 E，用户两轮判「还是有些小」
      // 并亲定口径）：按亮盘对画布**高度**定标——亮盘 = 旋
      // 臂亮结构（半径 5.5 世界单位 ≈ 11 kpc），目标直径
      // 0.80 × 画布高：fitZ = 5.5/(0.80×tan21°) ≈ 17.9。世
      // 界→像素标尺在 x/y 同值、与宽高比无关。横向大幅出
      // 血（竖屏宽约半高、亮盘横径约 1.6 倍画布宽）——用户
      // 明示预期效果。落点复核（公式构造，宽高比约 0.53）：
      // 此定标下太阳真位最大横偏约 1.03 NDC 会出框，故全览
      // 落位另加最小取景偏移 frameK=0.22（见银河帧段）：太
      // 阳横偏压到约 0.81（标记+签在框内）、黑洞偏移 ≤0.23
      // NDC 仍在中央区；比例尺钉组南缘固定位（见构建处）、
      // 不随自转相位变。15 kpc 结构淡边出血更多，是同一定
      // 标的预期结果
      galaxyFitZ = THREE.MathUtils.clamp(
        isCoarse ? 5.5 / (0.8 * halfTan) : (7.7 / minTan) * 1.04,
        12,
        40,
      );
      if (gTrans === 0) smoothGalaxyZ = galaxyFitZ;
      // 点光大小换算：世界直径 → 设备像素（灯光层/流动点云共用）
      scaleUniform.value =
        (h * renderer.getPixelRatio()) /
        (2 * Math.tan(THREE.MathUtils.degToRad(21)));
      // 银河星点着色器的点径标尺：绘图缓冲高 × 0.5——与 three
      // 0.187 PointsMaterial 的 scale 口径逐像素同式（该值在
      // WebGLMaterials 里就是 height×0.5、size 另乘 pixelRatio，
      // 此处合并写入），呼吸改着色器后点径与旧版完全一致
      galPointScale.value = h * renderer.getPixelRatio() * 0.5;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    td.ro = ro;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const startMs = performance.now();
    // raf 句柄已提升到 effect 作用域（离屏暂停与卸载清理共用同一
    // 句柄，见 effect 头部 td/schedStats 登记处）
    let frame = 0;
    let prevSel: CountryCode | null = null;
    let prevAutoRotate = stateRef.current.autoRotate;
    let flashStart = -10;
    const burstStart = new Map<number, number>();
    // 太阳系过渡进度（0=监控球 / 1=太阳系）与帧间计时
    let trans = 0;
    let prevT = 0;
    // —— 离屏暂停（调度安全网 · MWG efficient-background-processing
    // 口径）：IntersectionObserver 观测挂载容器（实际渲染画布的
    // 直接容器），离开视口持续 250ms 才停渲染循环（防进出模式
    // 浮层与滚动回弹的瞬时离屏造成暂停抖动），回到视口立即恢
    // 复。暂停只停渲染：t 仍由 performance.now() 绝对推进，所
    // 有时间驱动状态在恢复帧按绝对时间对齐（见 animate 头部）
    let renderPaused = false;
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
    /** 黄道星座连线在位系数（0..1，指数趋近）：只在太阳系
     * **全览**在位时为 1（真机修正轮二，用户明示「黄道星座
     * 只在太阳系全览下出现」——上一轮「未聚焦即默认可见」
     * 撤销）：近览（移动端 solarNarrow && solarView=near）与
     * 聚焦任何行星时都归零，连线图随之淡出淡入，语法与标签
     * 避让的平滑淡变一致，绝不硬跳 */
    let zodiacFigK = 0;
    /** 彗星近览在位系数（2026-11-15 晚，用户：「全览隐藏
     * 彗星、星街彗星也隐藏」）：与 zodiacFigK 镜像的一对门
     * 控——有效近览（solarNarrow && solarView=near，与太阳
     * 系拟合距离同一条判定、桌面恒全览）时为 1、有效全览
     * 时为 0，指数趋近同语法（dt×3.2、约 1 秒走完、不闪不
     * 跳）。五颗具名彗星的整层淡化与星街彗星的本体/标签/
     * 专属光效同乘此系数；舞台钟 stageMt 不受门控影响、全
     * 览↔近览切换不重置，进近览即是当时幕位的那一颗 */
    let cometViewK = 0;
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
    await sl.yieldNow();
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
    await sl.yieldNow();
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
    /** 当前阶段起始的绝对会话秒（离屏暂停轮锚定，见帧段状态机注） */
    let visitAnchor = 0;
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

    await sl.yieldNow();
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
    await sl.yieldNow();
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
      /** 亮度阶级（2026-11-16 狮子座注入，取代旧 fire 布尔；
       * 当晚修订：火流星缩小并改火球形态、蓝绿改针形且速度回
       * 普通档、两阶级占比调低）：
       * 0 普通 / 1 明亮（旧火流星放大口径：同色系 1.6–2× 更亮
       * 更大）/ 2 火流星（新阶级：⑥ 档橙红燃烧色、不规则抖动
       * 火球头 + 断续光团尾 + 持久余迹 + 沿途火花/碎块剥落 +
       * 末端闪爆；头光盖印与普通同量级，亮度靠强度不靠个头）
       * / 3 蓝绿（新阶级：⑤ 档蓝绿实色、针形细直锐 streak +
       * 紧致小头、尾迹收束；速度与普通同档至多略快，身份靠颜
       * 色＋针形不靠速度）。最高阶不在此列——抽中最高阶直接
       * 顶替为陨石（curtainRocks），规则不变 */
      cls: 0 | 1 | 2 | 3;
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
      /** 火流星特效累加器（秒，仅 cls=2 用）：每约 0.05 秒在头
       * 后落一团余迹 + 剥落一粒火花 */
      fxAcc: number;
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
    // 末在落点闪爆。坠速比火流星更沉更慢（寿命 2.6–3.2 秒对旧
    // 火流星放大档 1.9–2.2 秒），本体直径 20–26px 不超原最大
    // 档占位。2026-11-16 狮子座注入（用户令，见 CURTAIN_VARIANTS
    // 处注）阶级初版（**已被当晚修订取代、现行口径见本段末**）：
    // 五路——普通 46% / 明亮 22%（旧放大档转正为独立阶级）/
    // 火流星 13%（橙红燃烧 + 余迹 + 火花 + 末端闪爆）/ 蓝绿
    // 16%（蓝绿实色 + 快端寿命 0.85–1.25 秒）/ 最高阶 3%（陨
    // 石顶替规则一字不动）；同屏存活上限 44→56（峰值稳态需
    // 求 ≈ 4.2 颗/秒 × 2.3 秒最长寿命 ≈ 9.7，56 为防波次叠
    // 加的封顶、非稳态）。当晚再修订
    // （用户三令：火流星不用这么大、特效和形状要和其他的有区
    // 别、蓝绿色也是 + 比例调低 + 蓝绿不用太快）：火流星 13→
    // 8%、蓝绿 16→10%，让出份额回普通/明亮（52 / 27），最高
    // 阶 3% 不动；火流星头光盖印 118→56px、轨宽基数 4.4→2.6，
    // 形态改不规则火球（见绘制段）；蓝绿寿命 0.85–1.25 秒作
    // 废、回普通同档（1.3–1.9 秒、表观速度约普通的 1.1 倍），
    // 形态改针形锐 streak（见绘制段）。
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
    // —— 火流星余迹池（2026-11-16 新增）：火流星（cls=2）沿途
    // 每约 0.05 秒在身后落一团发光余迹，滞留 2.4–3.8 秒——缓缓
    // 膨胀、微微上飘、渐隐消散（狮子座火流星的招牌持久尾迹，
    // 与转瞬即逝的拖尾光轨分工：光轨是「划过」，余迹是「留
    // 下」）。池封顶 240（峰值火流星约 2–3 颗同场 × 20 团/秒
    // × 3.1 秒均寿 ≈ 150 团稳态，240 留波次余量）；绘制走加色
    // 盖印 wakeSprite，压在流星本体之下、星尘场之上。
    type CurtainWake = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      /** 初生半径（CSS px），随龄膨胀约 3 倍 */
      r0: number;
      ph: number;
    };
    const curtainWakes: CurtainWake[] = [];
    let fireSpawnedTotal = 0;
    let tealSpawnedTotal = 0;
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
      fireballs: () => fireSpawnedTotal,
      teals: () => tealSpawnedTotal,
      wakes: () => curtainWakes.length,
      classes: () => {
        const c = [0, 0, 0, 0];
        for (const m of curtainMeteors) c[m.cls]!++;
        return { normal: c[0], bright: c[1], fireball: c[2], teal: c[3] };
      },
    };
    /** 调度安全网验收钩子（无 UI、不可见，同 __financeGlobeNight
     * 口径）：build = 建场总时长与最长单片（分片器实测）；frames =
     * 已渲染帧数（离屏暂停期间恒不增——离屏帧数口径 = 暂停起止
     * 两点 frames 之差，恒为 0）；paused / lastGapS = 当前暂停态与
     * 最近一次恢复帧追平的绝对时间缺口；stage / sessionT = 最近
     * 一帧的彗星舞台钟与会话钟，供恢复帧按公式 (t+30)%400 对照 */
    (window as unknown as Record<string, unknown>).__financeGlobeSched = {
      build: () => ({
        ms: schedStats.buildMs,
        longestSliceMs: schedStats.longestSliceMs,
        slices: schedStats.slices,
      }),
      frames: () => schedStats.frames,
      paused: () => schedStats.paused,
      framesWhilePaused: () => schedStats.framesWhilePaused,
      lastGapS: () => schedStats.lastGapS,
      stage: () => schedStats.stageMt,
      sessionT: () => schedStats.t,
    };
    /** 邻域手势验收钩子（移动端拖拽取证轮，无 UI、不可见，
     * 同 __financeGlobeSched 口径）：drag = 合成拖拽断言读数
     * （目标/实际偏航与倾角、跟随误差 actual−target、驱动锁
     * 当前归属、拖拽/捏合态）；sunNdc = 太阳世界坐标经当前
     * 相机投影的 NDC（枢轴不变量：邻域在位恒 (0,0)，容差只
     * 剩浮点与相机插值）；gains = 现行增益常数原样（偏航
     * 0.005 rad/px；俯仰 0.003 rad/px 仅银河全览——邻域在
     * 位时恒 0：2026-11-15 晚纯方位角轮起邻域纵拖不进视
     * 角、极角冻结于入场极角，gains().tiltPerPx 在邻域读
     * 0 即代码级断言） */
    (window as unknown as Record<string, unknown>).__financeGlobeGesture =
      {
        drag: () => ({
          yaw: galYaw,
          yawT: galYawT,
          tilt: galTilt,
          tiltT: galTiltT,
          lagYaw: galYawT - galYaw,
          lagTilt: galTiltT - galTilt,
          driver: gestureDriver,
          dragging,
          pinching,
          nearZoom: galaxyNearZoom,
          nearZoomT: galaxyNearZoomT,
        }),
        sunNdc: () => {
          const v = galaxySunWorld.clone().project(camera);
          return { x: v.x, y: v.y, z: v.z };
        },
        gains: () => ({
          yawPerPx: 0.005,
          tiltPerPx:
            stateRef.current.galaxy &&
            stateRef.current.galaxyView !== "full"
              ? 0
              : 0.003,
        }),
        // 轨道模型断言读数（本轮）：az/pol = 方位角/极角的目
        // 标与当前；roll/elev 改报盘面法线口径（转盘轮，见
        // orbit() 内注：elev 对方位角恒 = 极角、roll 恒 0，
        // 数值精度内）；横拖只动 az、纵拖只动 pol（邻域内
        // 纵拖连 pol 也不动：polT 恒等于入场极角），可由
        // azT/polT 的单变量变化直接断言
        orbit: () => {
          // 转盘轮（2026-11-16）：欧拉读回在别名分支上不
          // 可靠——改报盘面法线：n = 组四元数作用于
          // (0,1,0)；elev = asin(n.z) = 镜头在银道面上
          // 方的高度角（转盘口径下对方位角恒 = 极角，
          // 数值精度内不变）；roll 改报 asin(n.x)——纯转
          // 盘下 n.x 恒 0，任何非零即滚转/越面证据；
          // eulerX/Y 保留 XYZ 读回仅作参考（别名分支可
          // 能跳变，不作断言依据）
          const e = new THREE.Euler().setFromQuaternion(
            galaxyGroup.quaternion,
            "XYZ",
          );
          const n = new THREE.Vector3(0, 1, 0).applyQuaternion(
            galaxyGroup.quaternion,
          );
          return {
            az: galYaw,
            azT: galYawT,
            pol: galTilt,
            polT: galTiltT,
            roll: Math.asin(
              THREE.MathUtils.clamp(n.x, -1, 1),
            ),
            elev: Math.asin(
              THREE.MathUtils.clamp(n.z, -1, 1),
            ),
            nX: n.x,
            nY: n.y,
            nZ: n.z,
            eulerX: e.x,
            eulerY: e.y,
          };
        },
        // warp 读数（本轮）：公式 k(r) 在八星真实距离与四环半
        // 径处的满额倍率 + 显示距离（pc），与 DATA-PLAN 对照
        // 表同源同式
        warp: () => ({
          k: (rPc: number) => galWarpK(rPc),
          disp: (rPc: number) => rPc * galWarpK(rPc),
        }),
        // 罗盘读数（本轮）：最近一帧臂长 px 与屏幕系方向（单
        // 位向量，y 向下）——最远帧臂长应 = 72（下限主导）、
        // 默认帧应 = 80 pc 投影长（约 183 px @390×785 口径）
        compass: () => ({ ...galCompassState }),
        // 银河导航改判验收读数（2026-11-15）：当前取景态与邻
        // 域混合量（回正/退出判定）、「太阳系」签的画布相对
        // px（探针据此发真实点按走 handleTap 全链）
        galaxy: () => {
          let sunLabelPx: { x: number; y: number } | null = null;
          if (galSunLabel) {
            const rect = el.getBoundingClientRect();
            const lv = new THREE.Vector3();
            galSunLabel.getWorldPosition(lv);
            lv.project(camera);
            if (lv.z < 1) {
              sunLabelPx = {
                x: ((lv.x + 1) / 2) * rect.width,
                y: ((1 - lv.y) / 2) * rect.height,
              };
            }
          }
          // 转场/枢轴诊断（2026-11-15 晚转场轮）：gTrans/
          // scaleCur/camZ/groupPos/centerNdc 逐帧可读——转
          // 场结束帧与静态取景的中心偏移（centerNdc 恒
          // (0,0) ⇔ 银心逐像素钉死）与倍率差（scaleCur 对
          // 静态值 1.12）由此量，不靠肉眼判
          const cv = new THREE.Vector3();
          galaxyGroup.getWorldPosition(cv);
          const centerWorld = cv.clone();
          cv.project(camera);
          return {
            view: stateRef.current.galaxyView,
            inGalaxy: stateRef.current.galaxy,
            nearMix: galaxyNearMix,
            sunLabelPx,
            gTrans,
            scaleCur: galaxyScaleCur,
            camPos: {
              x: camera.position.x,
              y: camera.position.y,
              z: camera.position.z,
            },
            groupPos: {
              x: centerWorld.x,
              y: centerWorld.y,
              z: centerWorld.z,
            },
            centerNdc: { x: cv.x, y: cv.y },
          };
        },
      };
    /** —— 暂停恢复的瞬时粒子追平（调度安全网）——
     * 星幕瞬时粒子（流星/陨石/烟/烬/碎片/星点/闪光/爆点/闪芒）的
     * 位置都是 age 的解析函数或匀速/匀加速积分：暂停缺口 gap 内
     * 本应流逝的寿命在这里一次性补账——age += gap 后过期者静默
     * 移除（不触发落点闪/爆点等死亡演出：那都是暂停期间已经过
     * 去的瞬时事件，不补演）；存活者的位置由各自的推进式按补
     * 账后的 age/速度自然落到绝对时间应有之处。生成累加器
     * （curtainAcc/sparkleAcc）不补账：恢复后按夜空会话钟的当
     * 前窗口速率续生，不爆发补生。curtainTime 同步补账，波次相
     * 位与会话钟保持同相。 */
    const catchUpCurtain = (gap: number): void => {
      curtainTime += gap;
      const ageOut = <T extends { age: number; life: number }>(
        arr: T[],
      ): void => {
        for (let i = arr.length - 1; i >= 0; i--) {
          const p = arr[i]!;
          p.age += gap;
          if (p.age >= p.life) arr.splice(i, 1);
        }
      };
      ageOut(curtainFlashes);
      ageOut(curtainBooms);
      ageOut(curtainSparks);
      ageOut(curtainSparkles);
      for (let i = curtainWakes.length - 1; i >= 0; i--) {
        const wk = curtainWakes[i]!;
        wk.age += gap;
        wk.x += wk.vx * gap;
        wk.y += wk.vy * gap;
        if (wk.age >= wk.life) curtainWakes.splice(i, 1);
      }
      for (let i = curtainMeteors.length - 1; i >= 0; i--) {
        const dm = curtainMeteors[i]!;
        dm.age += gap;
        dm.glint -= gap;
        if (dm.age >= dm.life) curtainMeteors.splice(i, 1);
      }
      for (let i = curtainRocks.length - 1; i >= 0; i--) {
        const rk = curtainRocks[i]!;
        rk.age += gap;
        rk.fragT -= gap;
        while (rk.fragT <= 0) rk.fragT += 0.75;
        if (rk.age >= rk.life) curtainRocks.splice(i, 1);
      }
      for (let i = curtainPuffs.length - 1; i >= 0; i--) {
        const pf = curtainPuffs[i]!;
        pf.age += gap;
        pf.x += pf.vx * gap;
        pf.y += pf.vy * gap;
        if (pf.age >= pf.life) curtainPuffs.splice(i, 1);
      }
      for (let i = curtainEmbers.length - 1; i >= 0; i--) {
        const em = curtainEmbers[i]!;
        em.age += gap;
        em.x += em.vx * gap;
        em.y += em.vy * gap + 75 * gap * gap;
        em.vy += 150 * gap;
        if (em.age >= em.life) curtainEmbers.splice(i, 1);
      }
      for (let i = curtainFrags.length - 1; i >= 0; i--) {
        const fg = curtainFrags[i]!;
        fg.age += gap;
        fg.x += fg.vx * gap;
        fg.y += fg.vy * gap + 95 * gap * gap;
        fg.vy += 190 * gap;
        if (fg.age >= fg.life) curtainFrags.splice(i, 1);
      }
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
      // 彗星舞台时钟（轮值口径见 COMET_STAGE_S 处注）：五幕轮
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
      // —— 恢复帧绝对时间追平（离屏暂停轮）——
      // 帧间隔中超过 rawDt 上限（0.5 秒）的部分是任何逐帧推进都
      // 账不到的「缺口时间」：离屏暂停、标签页隐藏、长卡顿都会
      // 产生它。缺口出现时（首帧除外）：① 星幕瞬时粒子按缺口
      // 一次性补账（catchUpCurtain，过期者静默移除、不补演）；
      // ② 其余时间驱动状态无需补账——彗星舞台钟 stageMt、流星
      // 会话钟 nightCycleT 本帧已由绝对 t 推出，太阳/月球星历
      // 逐帧按真实 Date 求值，卫星钟 satClock 直接取 t，UFO 状
      // 态机由绝对锚点 visitAnchor 推出 visitT——恢复帧即绝对
      // 时间应有之态，不存在「按可见时长续跑」的漂移
      const gapS = t - prevT - rawDt;
      if (frame > 1 && gapS > 0.05) {
        catchUpCurtain(gapS);
        schedStats.lastGapS = gapS;
      }
      prevT = t;
      schedStats.t = t;
      schedStats.stageMt = stageMt;

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
      // —— 银河系过渡（约 2.6 秒，与太阳系过渡同一条缓动家族）：
      // 进入时太阳系组同步缩向中心（见太阳系帧段的 scale 乘子）、
      // 银河组由 0.15 放大落位，镜头距由太阳系拟合距续接到银河
      // 拟合距——一条连续飞出，不切镜。gTrans 落位后银河组接管
      // 逐帧驱动（见相机段后的银河帧段）。
      const gGoal = st.galaxy ? 1 : 0;
      gTrans += THREE.MathUtils.clamp(gGoal - gTrans, -dt / 2.6, dt / 2.6);
      gTrans = THREE.MathUtils.clamp(gTrans, 0, 1);
      const eG = easeInOutCubic(gTrans);
      // 莫比乌斯带客串是太阳系全览的故事层：进银河即收起选中
      // 态（小卡随 (1−eG) 在过渡内淡出，不许残留在银河画面上）
      if (st.galaxy) {
        mobiusSelected = false;
      }
      if (st.galaxy && !galaxyBuilt && !galaxyBuilding) {
        galaxyBuilding = true;
        // 分片构建与帧循环并行推进；卸载中止（BuildAbort）静默
        // 吞掉，galaxyBuilt 保持假、下次进入重新构建
        void buildGalaxy().catch(() => {
          galaxyBuilding = false;
        });
      }
      if (!st.galaxy && gTrans === 0) {
        galaxyZoom = 1;
        // 环视/倾角/邻域档内缩放一并复位：下次进入恒从标准构图起步
        galYawT = 0;
        galYaw = 0;
        galTiltT = GAL_FULL_TILT;
        galTilt = GAL_FULL_TILT;
        galaxyNearZoomT = 11;
        galaxyNearZoom = 11;
        galaxyGroup.rotation.set(GAL_FULL_TILT, 0, 0);
      }
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
        // 【绝对时间锚定（离屏暂停轮）】visitT 不再逐帧累加 dt：
        // 改由当前阶段起始的绝对会话秒 visitAnchor 推出（visitT
        // = t − visitAnchor）。离屏暂停期间状态机不运行，恢复帧
        // 的 visitT 自动落在绝对日程的正确值上；阶段切换时锚点
        // 按刚结束阶段的时长顺延（carry-over），下方 while 同帧
        // 可连过数个阶段——暂停跨过整个阶段时已过去的阶段一帧
        // 追平、不逐段补演，进行中阶段落在正确的阶段内偏移
        visitT = visitPhase === "idle" ? 0 : t - visitAnchor;
        if (visitPhase === "idle") {
          ufo.group.visible = false;
          if (
            (t > nextVisitAt || forceVisit) &&
            (trans === 0 || trans === 1)
          ) {
            const forced = forceVisit;
            forceVisit = false;
            visitPhase = "approach";
            // 日程触发的锚点钉在原定到访时刻（暂停跨过到访点
            // 时，恢复帧直接落在「本应已进行」的阶段偏移上）；
            // 强制触发（验收钩子）锚在当下
            visitAnchor = forced ? t : nextVisitAt;
            visitT = t - visitAnchor;
            ufoFrom.copy(computeUfoFrom());
            ufo.group.visible = true;
          }
        }
        while (
          visitPhase !== "idle" &&
          visitT >= VISIT_DUR[visitPhase]
        ) {
          visitAnchor += VISIT_DUR[visitPhase];
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
          visitT = t - visitAnchor;
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
      solarGroup.visible = trans > 0.01 && eG < 0.98;
      if (solarGroup.visible) {
        solarGroup.scale.setScalar(
          (0.15 + 0.85 * eTrans) * (1 - 0.85 * eG),
        );
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
        // 黄道十二宫环：坐标框随太阳系模式整体淡入淡出（sunFade）
        if (zodiacRingMat) zodiacRingMat.opacity = 0.5 * sunFade;
        if (zodiacTickMat) zodiacTickMat.opacity = 0.65 * sunFade;
        // 黄道图形（抠图）：门控（真机修正轮二，
        // 用户明示只在全览出现）：有效全览 = 非（窄屏近
        // 览）——与太阳系拟合距离同一条判定（solarFitZ
        // 处），桌面恒全览、移动端认 solarView；且未聚焦
        // 任何行星。近览/聚焦时淡出、回全览淡入；
        // zodiacFigK 指数趋近（约 1 秒走完），在位系数
        // zodiacFigVis = sunFade × zodiacFigK 驱动全层
        const zodiacFigTarget =
          !st.focusedBody && !(solarNarrow && st.solarView === "near")
            ? 1
            : 0;
        zodiacFigK +=
          (zodiacFigTarget - zodiacFigK) * Math.min(1, dt * 3.2);
        if (Math.abs(zodiacFigTarget - zodiacFigK) < 0.002) {
          zodiacFigK = zodiacFigTarget;
        }
        const zodiacFigVis = sunFade * zodiacFigK;
        // 彗星门控系数（与上同语法、判定镜像）：有效近览在
        // 位为 1、全览为 0；具名彗星段与行星段的星街彗星同
        // 乘此值（见各自段注）
        const cometViewTarget =
          solarNarrow && st.solarView === "near" ? 1 : 0;
        cometViewK +=
          (cometViewTarget - cometViewK) * Math.min(1, dt * 3.2);
        if (Math.abs(cometViewTarget - cometViewK) < 0.002) {
          cometViewK = cometViewTarget;
        }
        // （绘制版图形四层与 figDrawnK 回落机制已于
        // 2026-11-16 抠图轮整体删除；骨架星点与主星名签
        // 同日星点删除轮整体删除：此处不再有任何星点材
        // 质或星名签的赋值方，黄道层只剩环/刻度、宫名
        // 签、抠图三类，见构建段墓碑注。）
        // 抠图淡变：zodiacFigVis 口径（全览在位才在场）；
        // 系数近零时整组隐藏省绘制；加载失败的宫
        // （ok=false）恒 0、不复活任何图形
        if (zodiacCutoutGroup) {
          zodiacCutoutGroup.visible = zodiacFigVis > 0.01;
          for (const rec of zodiacCutoutMats)
            rec.mat.opacity = rec.ok ? rec.base * zodiacFigVis : 0;
        }
        for (const s of zodiacLabels) {
          (s.material as THREE.SpriteMaterial).opacity = 0.92 * sunFade;
        }
        // —— 莫比乌斯带客串逐帧（构建段有全口径注）：门控与黄
        // 道图形同款——全览在位（zodiacFigK）才在场，银河过渡
        // 乘 (1−eG) 同步收起；整体绕太阳轴缓慢自转（周期约
        // 300 秒）；行走光点相位走会话时钟，标记四元数逐帧由
        // 局部标架 makeBasis(T, W, N) 导出——走完一圈 W/N 同
        // 步反号、标记镜像翻转，第二圈复原
        {
          const mobTime =
            mobPhaseOverride !== null
              ? mobPhaseOverride * MOB_PERIOD_S
              : reducedMotion
                ? 0
                : t;
          const mobU =
            MOB_U0 + (Math.PI * 2 * mobTime) / MOB_PERIOD_S;
          const mobVis = sunFade * zodiacFigK * (1 - eG);
          mobiusVisNow = mobVis;
          mobOuter.visible = mobVis > 0.01;
          // —— morph 推进（展开返工轮波形，节律与诊断见
          // MOB_MORPH_HOLD_WRAP_S 处注）：m 由分段停留波
          // 形 mobMorphWave(mobMorphClock) 给出——收拢停
          // 留 20s / 展开 7s / 展开停留 14s / 收回 7s；
          // setMorph 钉住优先；reduced-motion 恒 0.3 静
          // 帧（该偏好下 morph 时钟不推进、带永不展开——
          // 诊断条目之一，口径与全场动效一致、不单独破
          // 例）；相位覆盖时时钟冻结、m 保持（setPhase
          // 「同 u 两帧空间位置恒等」口径不破）。时钟只
          // 在带在场（mobVis > 0.01，全览在位）时推进：
          // 切去近览/银河/主页期间暂停不重置，回来续走。
          // 波浪相位随 mobTime 走、同口径冻结
          if (
            mobVis > 0.01 &&
            !reducedMotion &&
            mobPhaseOverride === null &&
            mobMorphPin === null
          ) {
            mobMorphClock += rawDt;
          }
          mobMorphM =
            mobMorphPin ??
            (reducedMotion ? 0.3 : mobMorphWave(mobMorphClock));
          mobWavePh = mobTime * 0.9;
          mobState.morph = mobMorphM;
          if (mobOuter.visible) {
            mobOuter.rotation.y =
              mobSpinPin ??
              (mobPhaseOverride !== null || reducedMotion
                ? 0
                : t * 0.021);
            // —— 展开落框（2026-11-16 不锁视角轮，元灿：
            // 「变形的时候不用锁视角」）：屏幕读数返工轮的
            // ①转正（逐帧按相机基向量解算 mobTilt 目标世
            // 界姿态、把带面转正对镜头，场景倾斜/组自转/
            // 用户拖转全被抵消）整条作废删除——变形期间
            // 带组姿态恒为静息倾角，不再对带组或镜头做任
            // 何朝向锁定/抵消旋转：组自转照旧缓行、用户拖
            // 转照旧生效、视角全程自由。保留的只有等比落
            // 框（②旧口径）：倍率逐帧按带心的实际相机深
            // 度解算、让臂尖落在帧边内侧——放大落点是元
            // 灿自选联动、只动尺度不动朝向（与太阳段拉远
            // 1.38 分工不变、拉远只动距离）。拟合半幅按
            // 不正 X 的新落点改双轴分开取：本地 x 半幅
            // 7.45（左上臂尖横投 7.10＋波浪/半宽余量）、
            // 本地 z 半幅 5.00（左下臂尖纵投 4.61＋余
            // 量），目标 NDC 0.97、取两轴较小者。无转正
            // 后带面斜躺、投影被透视收分，拟合偏保守、臂
            // 尖恒在框内；组自转使用户视角下投影随相位缓
            // 变、落点在保守侧内浮动——这是不锁视角的应
            // 有之义，不再逐帧抵消。m = 0 时缩放恒 1、姿
            // 态恒静息——收拢端形态与取景（含拉远倍率
            // 1.000 基准）一分不漂；48 秒节律不变。子元素
            // （行走点/涟漪/迸散/星扣/光针/星尘/碎片/花
            // 瓣）全挂 mobTilt、随组同放；翻面标架在本地
            // 系内求值、与组姿态无关，不变量照旧（三点复
            // 核见 DATA-PLAN）。mobState.faceK 自本轮恒
            // 0（字段保留供探针读数、转正量语义退役）。
            const mobOpenK =
              mobMorphM * mobMorphM * (3 - 2 * mobMorphM);
            // 姿态恒静息（不锁视角轮：转正解算整段删除，
            // mobTilt 不再读相机基向量、不再 slerp）
            mobTilt.quaternion.copy(mobRestQuat);
            mobState.faceK = 0;
            if (mobOpenK <= 0) {
              mobTilt.scale.setScalar(1);
              mobState.openScale = 1;
            } else {
              camera.updateMatrixWorld();
              mobCamInvM.copy(camera.matrixWorld).invert();
              mobOuter.getWorldPosition(mobCenterWorldV);
              mobCenterCamV
                .copy(mobCenterWorldV)
                .applyMatrix4(mobCamInvM);
              const mobDepth = Math.max(1, -mobCenterCamV.z);
              const mobTanV =
                1 / camera.projectionMatrix.elements[5]!;
              const mobTanH = mobTanV * camera.aspect;
              // 双轴拟合（不正 X 落点，见本段头注）：本地
              // x 半幅 7.45 / z 半幅 5.00、目标 NDC 0.97，
              // 取较小者
              const mobKT = Math.max(
                0.012,
                Math.min(
                  (0.97 / 7.45) * mobTanH,
                  (0.97 / 5.0) * mobTanV,
                ),
              );
              mobOuter.getWorldScale(mobWorldScaleV);
              const mobSFull = THREE.MathUtils.clamp(
                (mobKT * mobDepth) /
                  Math.max(0.2, mobWorldScaleV.x),
                0.75,
                6.5,
              );
              const mobSNow = 1 + (mobSFull - 1) * mobOpenK;
              mobTilt.scale.setScalar(mobSNow);
              mobState.openScale = mobSNow;
            }
            // 几何重建：morph/波浪相位变了才重建（静帧零成
            // 本）；uMorph 三件套（带面/光场/流动光）同值；
            // 边缘线与光鞘色调随 morph 在采样色之间插值
            if (
              Math.abs(mobMorphM - mobBuiltM) > 0.0004 ||
              Math.abs(mobWavePh - mobBuiltWave) > 0.002
            ) {
              mobBuiltM = mobMorphM;
              mobBuiltWave = mobWavePh;
              mobRebuildGeometry();
            }
            mobBandMat.uniforms.uMorph!.value = mobMorphM;
            mobHaloMat.uniforms.uMorph!.value = mobMorphM;
            mobWaveMat.uniforms.uMorph!.value = mobMorphM;
            mobEdgeMat.color.lerpColors(
              mobTintWrapC,
              mobTintOpenC,
              mobMorphM,
            );
            mobEdgeGlowMat.color.lerpColors(
              mobTintWrapC,
              mobTintOpenC,
              mobMorphM,
            );
            (
              mobEdgeSheathMat.uniforms.uTint!
                .value as THREE.Color
            ).lerpColors(mobTintWrapC, mobTintOpenC, mobMorphM);
            // 高亮点击触发（2026-11-16 元灿令「莫比乌斯环
            // 的高亮可以改成点击后」，恢复最初「点选提亮、
            // 关闭还原」机制）：mobSelK 向 mobiusSelected 趋
            // 近（约 0.35 秒到位/回落），全部提亮系数在常态
            // 基值（×1.0）与原点选态数值（bright 1.85、带面
            // ×1.35、星扣辉光 ×1.4、光点辉光 ×1.5）之间按
            // mobSelK 插值——默认常态、点带（与弹卡同时）提
            // 亮、关卡回落常态。此前一轮把系数钉死点选态的
            // 「常驻亮态」作废。流动光是另一回事：它由时钟
            // 直推常开（见帧段常驻流动光注），不读 mobSelK、
            // 不随高亮起落；周围光场/星光微粒/光脉冲等特效
            // 增补亦不读它、照旧
            mobSelK +=
              ((mobiusSelected ? 1 : 0) - mobSelK) *
              Math.min(1, rawDt * 6);
            if (Math.abs((mobiusSelected ? 1 : 0) - mobSelK) < 0.003)
              mobSelK = mobiusSelected ? 1 : 0;
            const bright = 1 + 0.85 * mobSelK;
            // 带面峰值不透明度 0.58（原图重采样轮：浓度是
            // 饱和落地的一半——半透下带色与深空底色对半混
            // 合必然洗淡，基值自 0.50 抬到 0.58、与着色器
            // 饱和定版 ×1.30 配套）×提亮（常态 1.0 / 点选
            // 1.35）×展开体量系数 (1 + 0.35m)：展开停留段
            // 峰值 0.58 → 0.78——带面要有体量、不许透成白
            // 纱（帧里像素色相/饱和须对回原图分布）；m = 0
            // 时体量系数恒 1
            mobBandMat.uniforms.uBandA!.value =
              0.58 *
              mobVis *
              (1 + 0.35 * mobMorphM) *
              (1 + 0.35 * mobSelK);
            mobBandMat.uniforms.uTime!.value = reducedMotion
              ? 0
              : t;
            // 光脉冲相位（特效增密轮）：22 秒一圈沿 ∞ 缓
            // 行；reduced-motion 时幅度归零、光涌不在场
            mobBandMat.uniforms.uPulseU!.value =
              ((mobTime * Math.PI * 2) / 22) % (Math.PI * 2);
            mobBandMat.uniforms.uPulseA!.value = reducedMotion
              ? 0
              : 1;
            // 整环光场（同轮）：与带同相位流光、透明度随
            // mobVis；带周星光微粒：逐粒小幅漂移 + 整体
            // 微呼吸透明度（个体相位在 mobSparkPh）
            mobHaloMat.uniforms.uTime!.value = reducedMotion
              ? 0
              : t;
            mobHaloMat.uniforms.uA!.value = mobVis;
            {
              const sparkT = reducedMotion ? 0 : t;
              // 基点按当前 morph 带面重算（变形时微粒不脱带）
              for (let i = 0; i < MOB_SPARK_N; i++) {
                mobFrameAt(mobSparkU[i]!, 0, mobFrame);
                mobSparkBase[i * 3] =
                  mobFrame.c.x +
                  mobFrame.w.x * mobSparkV[i]! +
                  mobFrame.n.x * mobSparkN[i]!;
                mobSparkBase[i * 3 + 1] =
                  mobFrame.c.y +
                  mobFrame.w.y * mobSparkV[i]! +
                  mobFrame.n.y * mobSparkN[i]!;
                mobSparkBase[i * 3 + 2] =
                  mobFrame.c.z +
                  mobFrame.w.z * mobSparkV[i]! +
                  mobFrame.n.z * mobSparkN[i]!;
              }
              for (let i = 0; i < MOB_SPARK_N; i++) {
                const ph = mobSparkPh[i]!;
                mobSparkPos[i * 3] =
                  mobSparkBase[i * 3]! +
                  0.05 * Math.sin(sparkT * 0.11 + ph);
                mobSparkPos[i * 3 + 1] =
                  mobSparkBase[i * 3 + 1]! +
                  0.05 * Math.sin(sparkT * 0.09 + ph * 1.7);
                mobSparkPos[i * 3 + 2] =
                  mobSparkBase[i * 3 + 2]! +
                  0.05 * Math.cos(sparkT * 0.1 + ph * 0.6);
              }
              mobSparkGeo.attributes.position!.needsUpdate = true;
              // 星尘四角闪点随 morph 增亮（屏幕读数返工轮：
              // 开屏主图口径的密集星尘在展开态要读得出，
              // 0.55 → 0.85；收拢态旧值不变）
              mobSparkMat.opacity =
                (0.55 + 0.3 * mobMorphM) *
                mobVis *
                (reducedMotion
                  ? 1
                  : 0.85 + 0.15 * Math.sin(t * 0.7));
            }
            mobEdgeMat.opacity = 1 * mobVis * bright;
            mobEdgeGlowMat.opacity = 0.65 * mobVis * bright;
            mobEdgeSheathMat.uniforms.uFade!.value =
              0.55 * mobVis * bright;
            // 星扣与带尾随带体同拍淡变；带尾绕带面法向轻摆
            mobClaspStarMat.opacity = 0.95 * mobVis;
            // 结点收缩（涨满轮，照参考图「结点缩成正中小
            // 亮点」）：星扣本体与光晕随 morph 缩到 0.55
            // 倍（星芒闪光在下方同乘、并反向提亮——点更
            // 小、光更聚）；带尾与光针不缩（光针是展开态
            // 的放射语言、尾是扣下垂饰，缩了读不出）
            const claspShrink = 1 - 0.45 * mobMorphM;
            mobClaspStar.scale.setScalar(claspShrink);
            // 星扣光晕慢呼吸（特效增密轮）：尺度 ±7%、透
            // 明度 ±8%，周期约 7 秒，与带面流光不同步
            {
              const br = reducedMotion
                ? 1
                : 1 + 0.07 * Math.sin(t * 0.9);
              mobClaspGlow.scale.set(
                0.85 * br * claspShrink,
                0.85 * br * claspShrink,
                1,
              );
              mobClaspGlowMat.opacity =
                0.5 *
                mobVis *
                (1 + 0.4 * mobSelK) *
                (reducedMotion
                  ? 1
                  : 0.92 + 0.08 * Math.sin(t * 0.9 + 0.6));
            }
            for (const m of mobTailMats) {
              m.opacity = 0.55 * mobVis * bright;
            }
            mobTails.rotation.y = reducedMotion
              ? 0
              : 0.07 * Math.sin(t * 0.8);
            // 结点四角星芒闪光：慢脉动 + 缓旋（参考帧结点
            // 的星芒闪光）；展开态光针：透明度随 morph 推
            // 进（收拢不在场、展开全开）、慢转
            mobClaspSparkMat.opacity = Math.min(
              1,
              mobVis *
                (reducedMotion
                  ? 0.75
                  : 0.62 + 0.3 * Math.sin(t * 2.3)) *
                (1 + 0.25 * mobMorphM),
            );
            mobClaspSparkMat.rotation = reducedMotion
              ? 0.4
              : t * 0.35;
            // 星芒闪光同走结点收缩（涨满轮）：0.62 基准尺
            // 度随 morph 缩到 0.70 倍、与提亮对冲成「小而
            // 亮」的正中亮点
            mobClaspSpark.scale.set(
              0.62 * (1 - 0.3 * mobMorphM),
              0.62 * (1 - 0.3 * mobMorphM),
              1,
            );
            // 结点细直光针（迸开图 C784DF3E 口径：中心亮
            // 点放射）：系数 0.55 → 0.8（屏幕读数返工轮，
            // 展开停留段光针须在帧里读得出）；仍只随
            // morph 在场、收拢不在场
            mobRaysMat.opacity =
              0.8 *
              mobVis *
              mobMorphM *
              (reducedMotion
                ? 1
                : 0.85 + 0.15 * Math.sin(t * 1.3));
            mobRays.rotation.y = reducedMotion ? 0 : t * 0.05;
            // 标架：相位拆「圈内相位 + 已完成圈数」——ψ 逐圈
            // 再累积 π，W/N 每圈反号、两圈复原（mobFrameAt）
            const mobCircuits = Math.floor(mobU / (Math.PI * 2));
            mobFrameAt(mobWrapU(mobU), mobCircuits, mobFrame);
            mobC.copy(mobFrame.c);
            mobTan.copy(mobFrame.t);
            mobWv.copy(mobFrame.w);
            mobNv.copy(mobFrame.n);
            mobBasisM.makeBasis(mobTan, mobWv, mobNv);
            mobWalker.quaternion.setFromRotationMatrix(mobBasisM);
            mobWalker.position.copy(mobC);
            mobFinMat.opacity = mobVis;
            mobCoreMat.opacity = mobVis;
            mobBallMat.opacity = mobVis;
            mobGlowMat.opacity = 0.8 * mobVis * (1 + 0.5 * mobSelK);
            // 行走光点长尾（特效增密轮）：相位每推进 0.02
            // rad 采一个历史点（与帧率无关），缎带自光点
            // 处（宽 0.085）向尾端收细渐隐、跨度约 0.52
            // rad；历史不足时以当前点垫满（尾与头重合、无
            // 形）。采样在 mobTilt 本地系（mobC/mobWv 本
            // 就是本地量），缎带同挂 mobTilt、天然同位
            {
              if (
                mobTrailLastU === null ||
                Math.abs(mobU - mobTrailLastU) >= 0.02
              ) {
                mobTrailLastU = mobU;
                mobTrailHist.unshift({
                  p: mobC.clone(),
                  w: mobWv.clone(),
                });
                if (mobTrailHist.length > MOB_TRAIL_N) {
                  mobTrailHist.pop();
                }
              }
              const head = mobTrailHist[0];
              for (let i = 0; i < MOB_TRAIL_N; i++) {
                const h = mobTrailHist[i] ?? head;
                if (!h) break;
                const hw =
                  0.085 * (1 - i / (MOB_TRAIL_N - 1)) + 0.004;
                mobTrailPos[i * 6] = h.p.x + h.w.x * hw;
                mobTrailPos[i * 6 + 1] = h.p.y + h.w.y * hw;
                mobTrailPos[i * 6 + 2] = h.p.z + h.w.z * hw;
                mobTrailPos[i * 6 + 3] = h.p.x - h.w.x * hw;
                mobTrailPos[i * 6 + 4] = h.p.y - h.w.y * hw;
                mobTrailPos[i * 6 + 5] = h.p.z - h.w.z * hw;
              }
              mobTrailGeo.attributes.position!.needsUpdate = true;
              mobTrailMat.uniforms.uA!.value = mobVis;
            }
            mobState.uDeg =
              (((mobU * 180) / Math.PI) % 360 + 360) % 360;
            mobState.loops =
              mobTime / MOB_PERIOD_S + MOB_U0 / (Math.PI * 2);
            mobState.pos[0] = mobC.x;
            mobState.pos[1] = mobC.y;
            mobState.pos[2] = mobC.z;
            // —— 昔涟定调动效逐帧 ——
            // 光尘漂移：90 粒沿带面缓行（相位各自匀速推进）
            for (let i = 0; i < MOB_DUST_N; i++) {
              mobDustU[i] = mobDustU[i]! + mobDustSp[i]! * dt;
              mobPoint(mobDustU[i]!, mobDustV[i]!, mobTmpV);
              mobDustPos[i * 3] = mobTmpV.x;
              mobDustPos[i * 3 + 1] = mobTmpV.y;
              mobDustPos[i * 3 + 2] = mobTmpV.z;
            }
            mobDustGeo.attributes.position!.needsUpdate = true;
            mobDustMat.opacity = 0.7 * mobVis;
            // 粉紫花瓣漂移：6 片收在星扣邻域内小幅摆动（相
            // 位 MOB_U1 ± 0.55），轻摆自旋 + 浮沉，缓速少量
            for (const pt of mobPetals) {
              const petalT = reducedMotion ? 0 : t;
              const uu =
                pt.baseU +
                pt.oscAmp *
                  Math.sin(petalT * pt.oscSpd + pt.bobPh);
              mobPoint(uu, pt.v, mobTmpV);
              pt.sprite.position.copy(mobTmpV);
              pt.sprite.position.y +=
                0.05 * Math.sin(petalT * 0.6 + pt.bobPh);
              pt.mat.rotation = pt.bobPh + petalT * pt.spin;
              pt.mat.opacity = 0.5 * mobVis;
            }
            // 带边玻璃碎片：贴带缘外侧缓慢漂移 + 自旋，帧
            // 段按当前 morph 带面落位（变形全程贴带）
            for (const gl of mobGlass) {
              if (!reducedMotion && mobPhaseOverride === null)
                gl.u = mobWrapU(gl.u + gl.drift * dt);
              mobFrameAt(gl.u, 0, mobGlassFrame);
              gl.mesh.position
                .copy(mobGlassFrame.c)
                .addScaledVector(
                  mobGlassFrame.w,
                  gl.side * (mobHalfW(gl.u) + 0.14),
                )
                .addScaledVector(mobGlassFrame.n, gl.nOff);
              if (!reducedMotion) {
                gl.mesh.rotation.x += gl.spin.x * dt;
                gl.mesh.rotation.y += gl.spin.y * dt;
                gl.mesh.rotation.z += gl.spin.z * dt;
              }
            }
            for (const gm of mobGlassMats) {
              gm.opacity = 0.8 * mobVis;
            }
            // 光点涟漪：会话时钟下每约 0.85 秒在光点当前位置
            // 放一枚，躺标架 T-W 平面扩散，半径至带宽量级衰减
            if (
              !reducedMotion &&
              mobPhaseOverride === null &&
              mobVis > 0.5
            ) {
              mobRippleTimer += dt;
              if (mobRippleTimer > 0.85) {
                mobRippleTimer = 0;
                const rp = mobRipples[mobRippleIdx]!;
                mobRippleIdx =
                  (mobRippleIdx + 1) % MOB_RIPPLE_N;
                rp.active = true;
                rp.age = 0;
                rp.line.visible = true;
                rp.line.position.copy(mobC);
                rp.line.quaternion.setFromRotationMatrix(
                  mobBasisM,
                );
              }
            }
            let ripActive = 0;
            for (const rp of mobRipples) {
              if (!rp.active) continue;
              rp.age += dt;
              if (rp.age >= MOB_RIPPLE_LIFE) {
                rp.active = false;
                rp.line.visible = false;
                rp.mat.opacity = 0;
                continue;
              }
              ripActive++;
              const k = rp.age / MOB_RIPPLE_LIFE;
              // 扩散半径随新带宽走（半宽沿程 0.20–0.34、涟
              // 漪漫到带缘外一线衰减，重生成轮同步）
              const rad = 0.035 + (1 - (1 - k) * (1 - k)) * 0.45;
              rp.line.scale.set(rad, rad, rad);
              rp.mat.opacity = 0.5 * (1 - k) * mobVis;
            }
            mobState.ripplesActive = ripActive;
            // 翻面迸散：光点相位跨过星扣（u = MOB_U1 + 2πk、
            // ψ 窗口中心、标架在此翻转的那一瞬，此时光点恰在
            // 星扣处）触发一簇水晶碎片——迸散收在扣处爆发，
            // 只是视觉标点，翻面判定仍靠标记镜像
            const claspIdx = Math.floor(
              (mobU - MOB_U1) / (Math.PI * 2),
            );
            if (
              mobPrevLoopFloor !== null &&
              claspIdx > mobPrevLoopFloor &&
              mobVis > 0.3
            ) {
              mobSpawnBurst(mobC, mobTan, mobWv, mobNv);
            }
            mobPrevLoopFloor = claspIdx;
            if (mobBurstAge < MOB_BURST_LIFE) {
              mobBurstAge += dt;
              const bk = Math.max(
                0,
                1 - mobBurstAge / MOB_BURST_LIFE,
              );
              const damp = Math.max(0, 1 - 0.9 * dt);
              for (const sh of mobShards) {
                sh.mesh.position.addScaledVector(sh.vel, dt);
                sh.vel.multiplyScalar(damp);
                sh.mesh.rotation.x += sh.spin.x * dt;
                sh.mesh.rotation.y += sh.spin.y * dt;
                sh.mesh.rotation.z += sh.spin.z * dt;
              }
              for (const m of mobShardMats) {
                m.opacity = 0.95 * bk * mobVis;
              }
              // 白色星爆：前 0.35 秒胀开并淡去，比碎片收得快
              const sk = Math.max(0, 1 - mobBurstAge / 0.35);
              const ss = 0.12 + (1 - sk) * 0.42;
              mobStar.scale.set(ss, ss, 1);
              mobStarMat.opacity = 0.9 * sk * mobVis;
              if (mobBurstAge >= MOB_BURST_LIFE) {
                for (const sh of mobShards) {
                  sh.mesh.visible = false;
                }
                mobStar.visible = false;
              }
            }
            mobState.burstCount = mobBurstCount;
            // 常驻流动光（更正轮）：相位由会话时钟 mobTime 直
            // 推——2.8 秒一圈（旧点选涟漪波前速度 π/1.4s 的同
            // 值），未点选就在流、点选不触发也不打断、关卡后
            // 照旧；mobTime 已含相位覆盖/reduced-motion 冻结
            // 口径（冻结时光停在原相位、不流动）。waveT 钩子
            // 读数改报流动相位（0..1 圈内进度）
            const mobFlowU =
              ((mobTime * Math.PI * 2) / 2.8) % (Math.PI * 2);
            mobWaveMat.uniforms.uFlowU!.value = mobFlowU;
            mobWaveMat.uniforms.uWaveA!.value = mobVis;
            mobState.waveT = mobFlowU / (Math.PI * 2);
          }
          mobState.vis = mobVis;
          mobState.selected = mobiusSelected;
          // 小卡淡变（选中且带体在位才出；收起走同一平滑口径）
          const mobCardTarget =
            mobiusSelected && mobVis > 0.3 ? 1 : 0;
          mobCardK +=
            (mobCardTarget - mobCardK) * Math.min(1, dt * 5);
          if (Math.abs(mobCardTarget - mobCardK) < 0.002) {
            mobCardK = mobCardTarget;
          }
          mobCard.style.opacity = String(mobCardK * 0.98);
          mobCard.style.visibility =
            mobCardK > 0.02 ? "visible" : "hidden";
          mobCard.style.transform = `translateY(${((1 - mobCardK) * 6).toFixed(1)}px)`;
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
        // 本帧星历时刻：行星/地球/月球三处定角共用同一个 Date，
        // 与月相卡同一套函数求值——单一事实源（2026-11-14 同步改）
        const solarNow = new Date();
        for (let i = 0; i < planetVis.length; i++) {
          const pv = planetVis[i]!;
          const ang =
            pv.def.id === "suisei"
              ? suiseiLongitudeAt(solarNow)
              : planetLongitude(pv.def, solarNow);
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
          // 星街彗星全览门控（2026-11-15 晚，用户：「星街彗
          // 星也隐藏」）：与具名彗星同乘 cometViewK——有效全
          // 览时星体/专属光效/名签整层收起（本体材质不透明、
          // 无淡化通道：系数趋零时 visible 关 + 缩放趋零，
          // 命中圈随本体缩放同缩、全览点不到隐形星体；光效
          // 与名签走各自透明度平滑淡出，不闪不跳）；聚焦星
          // 街彗星本身时恒在场（点选聚焦行为不动），近览照
          // 旧。其轨道圈与行星环同列、不在隐藏之列
          const suiseiK =
            pv.def.id === "suisei"
              ? st.focusedBody === "suisei"
                ? 1
                : cometViewK
              : 1;
          if (pv.mesh) {
            pv.mesh.position.set(px, py, pz);
            pv.mesh.rotation.y =
              pv.def.id === "suisei"
                ? t * 0.085 // 偏快自转（旧客串口径不变）
                : t * 0.05 * (i % 2 === 0 ? 1 : -0.7);
            pv.mesh.scale.setScalar(
              (0.55 + 0.45 * pf) *
                (pv.def.id === "suisei" ? Math.max(suiseiK, 0.0001) : 1),
            );
            if (pv.def.id === "suisei") {
              pv.mesh.visible = suiseiK > 0.02;
            }
          }
          if (pv.label) {
            pv.label.position.set(px, py + pv.labelY + pv.labelDy, pz);
            (pv.label.material as THREE.SpriteMaterial).opacity =
              pf * pv.labelFade * suiseiK;
          }
          // 个性效应与本体同拍：fade = 该行星的 orbitFade，转场
          // 期间随本体一起淡入淡出，不留残留闪烁（星街彗星再
          // 乘门控系数 suiseiK）
          pv.fxTick?.(t, pf * suiseiK);
        }
        sunMesh.rotation.y = t * 0.008;
        // —— 具名彗星逐帧（哈雷/恩克/潘斯达斯/艾森/坦普尔–塔
        // 特尔）：登场走舞
        // 台轮值第 0–4 幕、哈雷起场（口径见 COMET_STAGE_S 处
        // 注）——各颗只在自己那一幕里在场：幕内时间以其近日点
        // 为幕中点、按 slotScale 缩放映射到其轨道时间，淡化 =
        // sunFade × 幕包络 × cometViewK（2026-11-15 晚全览隐
        // 藏轮：有效全览时 cometViewK=0——核/双尾/粒子/名卡/
        // 本颗轨道线整层不渲染，全览只剩环＋莫比乌斯＋行星
        // 盘的干净构图；近览照旧，舞台钟不受门控、切换不重
        // 置），非本幕恒 0（整组隐去、名卡随
        // fadeNow 同步隐去）；reduced-motion 时舞台冻结在哈雷
        // 幕、余四颗不在场。状态由真实根数的 namedCometStateAt
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
          const ncFade = sunFade * stageEnv(u) * cometViewK;
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
            // 性升腾、近日点（r = q）达 1，^1.35 收边。五颗的正
            // 切弯折时间轴把过境展开——prox>0.02 的窗口公式复算
            // 占各自幕的约 39–66 秒（幕长 80 秒；坦普尔 q≈0.98
            // 离 1.35 AU 阈值近、窗口最短约 39 秒），每颗过近日点都
            // 有一场粒子喷发，不再是旧客串喷流那种开场 30 秒
            // 错过即无的窗口。呼吸相位按 cardPrio 错开，五颗
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
          const ang = planetLongitude(eDef, solarNow);
          earthAnchor.position.set(
            Math.cos(ang) * eDef.orbitR * SOLAR_S,
            0,
            -Math.sin(ang) * eDef.orbitR * SOLAR_S,
          );
          // 月球：组钉在地球轨道位，本体逐帧按 moonLongitude(本帧
          // 时刻) 定角（与月相卡同源同值）；标签只在近览（或已捏
          // 合放大、或非窄屏）时显示，全览小屏防糊
          if (moonGroup && moonMesh && moonLabel) {
            moonGroup.position.copy(earthAnchor.position);
            const mAng = moonLongitude(solarNow);
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
        // —— 地心视线桥逐帧（构建段有全口径注）：只在点选状态在
        // 位；地球与目标天体都在动，逐帧按本帧场景位置重算。
        // 实线段 地球→目标（看的视线）；落点恒按地心链黄经落在
        // 环上（环点公式与行星落位同式：黄经 λ → 组内 (cosλ·R,
        // 0, −sinλ·R)，链黄经与场景黄经同为岁差对齐口径、同
        // 框可比）；虚线段 目标→落点（读数的投影延长）。太阳同
        // 理（地球→太阳即反地球方向）；月亮绕地球转、日心落宫
        // 对它没有占星意义，只给地心读数，视线照画（地球→月亮
        // 的场景方向即地心方向，折角只剩月轨倾角量级）。点选
        // 地球本身（补洞）：目标取太阳、读数取太阳地心黄经——
        // 视线即地球→太阳这一条，落点与标签同为太阳的落宫。
        {
          const fidS = st.focusedBody;
          const sightId = fidS && fidS !== "suisei" ? fidS : null;
          sightK +=
            ((sightId ? 1 : 0) - sightK) * Math.min(1, dt * 3.2);
          if (Math.abs((sightId ? 1 : 0) - sightK) < 0.002) {
            sightK = sightId ? 1 : 0;
          }
          const sightVis = sunFade * sightK;
          sightGroup.visible = sightVis > 0.01;
          sightState.id = sightId;
          sightState.k = sightK;
          if (sightGroup.visible && sightId && earthAnchor) {
            sightE.copy(earthAnchor.position);
            let haveT = true;
            if (sightId === "sun" || sightId === "earth") {
              // 点选地球：视线目标 = 太阳（组原点）——地球→太阳
              sightT.set(0, 0, 0);
            } else if (sightId === "moon" && moonMesh && moonGroup) {
              sightT
                .copy(moonMesh.position)
                .applyEuler(moonGroup.rotation)
                .add(moonGroup.position);
            } else {
              const pv = planetVis.find((p) => p.def.id === sightId);
              if (pv?.mesh) sightT.copy(pv.mesh.position);
              else haveT = false;
            }
            // 读数：地心链（与世事占星卡同源同函数）；点选地球
            // 时读数 = 太阳地心黄经（从地球看太阳的落宫）
            let geoLon: number | null = null;
            if (sightId === "sun" || sightId === "earth") {
              geoLon = sunGeocentricEcliptic(solarNow).lonDeg;
            } else if (sightId === "moon") {
              geoLon = moonEcliptic(solarNow).lonDeg;
            } else {
              const adef = ASTRO_PLANETS.find((p) => p.id === sightId);
              if (adef) {
                geoLon = planetGeocentricEcliptic(adef, solarNow).lonDeg;
              }
            }
            if (haveT && geoLon !== null) {
              const gRad = (geoLon * Math.PI) / 180;
              sightL.set(
                Math.cos(gRad) * SIGHT_RING_R,
                0,
                -Math.sin(gRad) * SIGHT_RING_R,
              );
              const posAttr = sightLineGeo.getAttribute(
                "position",
              ) as THREE.BufferAttribute;
              posAttr.setXYZ(0, sightE.x, sightE.y, sightE.z);
              posAttr.setXYZ(1, sightT.x, sightT.y, sightT.z);
              posAttr.needsUpdate = true;
              const extAttr = sightExtGeo.getAttribute(
                "position",
              ) as THREE.BufferAttribute;
              extAttr.setXYZ(0, sightT.x, sightT.y, sightT.z);
              extAttr.setXYZ(1, sightL.x, sightL.y, sightL.z);
              extAttr.needsUpdate = true;
              sightExtLine.computeLineDistances();
              sightDot.position.copy(sightL);
              sightHalo.position.copy(sightL);
              // 标签落到落点内侧（宫签所在的一侧）；字号按既有
              // 标签同一钳制口径（到镜头距离/currentSolarZ）收
              // 分——聚焦飞近不许巨字、拉远也不许缩没
              const inward = (SIGHT_RING_R - 0.66) / SIGHT_RING_R;
              sightLabel.position.set(
                sightL.x * inward,
                sightL.y + 0.05,
                sightL.z * inward,
              );
              sightLabel.getWorldPosition(tmpWorldV);
              const ratioS = THREE.MathUtils.clamp(
                tmpWorldV.distanceTo(camera.position) /
                  Math.max(currentSolarZ, 0.001),
                0.16,
                2.4,
              );
              sightLabel.scale.set(0.98 * ratioS, 0.245 * ratioS, 1);
              sightHalo.scale.setScalar(0.34 * ratioS);
              const labelText = `地心 ${zodiacSignFor(geoLon)} ${(geoLon % 30).toFixed(1)}°`;
              drawSightLabel(labelText);
              const sceneGeoDeg =
                ((Math.atan2(
                  -(sightT.z - sightE.z),
                  sightT.x - sightE.x,
                ) *
                  180) /
                  Math.PI +
                  360) %
                360;
              sightState.sceneGeoDeg = sceneGeoDeg;
              sightState.chainGeoDeg = geoLon;
              sightState.bendDeg =
                ((geoLon - sceneGeoDeg + 540) % 360) - 180;
              sightState.label = labelText;
            }
            sightLineMat.opacity = 0.55 * sightVis;
            sightExtMat.opacity = 0.5 * sightVis;
            sightDotMat.opacity = 0.95 * sightVis;
            sightHaloMat.opacity = 0.5 * sightVis;
            sightLabelMat.opacity = 0.95 * sightVis;
          }
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
      // —— 双纽线展开镜头联动（2026-11-16 涨满轮，元灿 B
      // 案「展开时镜头也缓缓拉远，要图片那种涨满感」）：
      // 展开相位（mobMorphM → 1）里全览镜头在现行取景
      // 上叠加拉远至 ×MOB_DOLLY_MAX = 1.38（展开返工轮
      // 自 1.22 加大），收拢相位（m → 0）精确回位——
      // 因子是 m 的纯函数、m = 0 时恒为 1.000（一分不
      // 多一分不少）；新 morph 波形展开段 7 秒走完、停
      // 留段 m 恒 1，拉远随之走完并全程保持，再经
      // smoothSolarZ 既有缓动（dt·5 + 落定吸附）二度平
      // 滑。门控 = sunFade × zodiacFigK：只在太阳系全
      // 览在位时非零——近览/聚焦时 zodiacFigK → 0、主
      // 页 sunFade → 0、银河镜头不走此距，邻域/银河/
      // 首页地球一概不被带走。叠加方式 = 乘在
      // solarTargetZ 上，与用户捏合 solarZoom 同为乘法
      // 口径：用户拖动/缩放时联动平滑叠加、不抢手势
      const mobDollyF =
        1 + (MOB_DOLLY_MAX - 1) * mobMorphM * sunFade * zodiacFigK;
      mobState.dolly = mobDollyF;
      const solarTargetZ = (solarFitZ / solarZoom) * mobDollyF;
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

      // —— 银河系帧段：镜头接管 + 组变换 + 锚点同步 ——
      // 镜头：总览相机已按太阳系口径摆好（太阳系在位时即 (0,0,太
      // 阳系拟合距)），此处按 eG 向银河机位 (0,0,smoothGalaxyZ)
      // 插值——进出都是同一条连续飞行。组变换：全盘 scale≈1 居
      // 中；近览把组放大 nearK 并平移，使太阳邻域落到画面中心
      // （平移按当下自转角解算，太阳点恒钉中心）。近览混合走
      // 1.5 秒线性进度 + 同一条 cubic 缓动，与模式过渡同家族。
      if (galaxyBuilt) {
        galaxyGroup.visible = eG > 0.01;
        if (galaxyGroup.visible) {
          const nearGoal = st.galaxyView !== "full" ? 1 : 0;
          galaxyNearMix += THREE.MathUtils.clamp(
            nearGoal - galaxyNearMix,
            -dt / 1.5,
            dt / 1.5,
          );
          galaxyNearMix = THREE.MathUtils.clamp(galaxyNearMix, 0, 1);
          const eNear = easeInOutCubic(galaxyNearMix);
          // 「已深入」进度 = 邻域混合本身（特写档已下线，只剩一
          // 档）——自转冻结、银心向图层退场、中心平移、八星淡入
          // 都按它走
          const eNC = eNear;
          // 入场朝向（邻域优化轮）：全览→邻域切换的边沿帧把
          // 环视偏航目标设为 galEntryYaw 的解——相机落在背离
          // 银心的一侧、越过太阳望向银心（黑洞），带既有俯角；
          // 只写目标、由下方阻尼平滑落位，用户入场后拖动改的
          // 还是同一目标，不强行复位
          if (nearGoal === 1 && galPrevNearGoal === 0) {
            // 入场朝向（旋转轴对齐轮）：极角恒 +0.62（galEntry
            // Pol 定版，不再按相位翻符号）；「银心在太阳上
            // 方」改由方位角选取——galEntryPhase 选入场自转
            // 相位分支，帧段自转驱动把盘面阻尼拨到该相位，
            // 偏航/签求解一律按拨正后相位解算（落定几何即求
            // 解几何）；轨道模型以此为初始方位/极角（拖动模
            // 型条）
            const entrySpin = galEntryPhase(galaxySpin.rotation.y);
            galSpinEntryTarget = entrySpin;
            const entryPol = galEntryPol(entrySpin);
            galTiltT = entryPol;
            const targetYaw = galEntryYaw(entrySpin, entryPol);
            let dYaw = (targetYaw - galYaw) % (Math.PI * 2);
            if (dYaw > Math.PI) dYaw -= Math.PI * 2;
            if (dYaw < -Math.PI) dYaw += Math.PI * 2;
            galYawT = galYaw + dYaw;
            // 星名签偏移按拨正后相位重算（构建预置的是相
            // 位 0 的版本；相位变了相对几何就滚了，签的优选
            // 方向必须跟着当次几何走）——锚定与呼出两套同帧
            // 换，求解/写回走 applyGalLabelSolve（落定再求解
            // 与入场共用同一口径）
            applyGalLabelSolve(entrySpin);
          }
          // 退出边沿：极角目标复位全览落定倾角 GAL_FULL_TILT
          // （全览盘面倾角恒为落定正值，邻域极角同为 +0.62，
          // 两态同号不镜像）；未完成的相位拨正一并取消
          if (nearGoal === 0 && galPrevNearGoal === 1) {
            galTiltT = GAL_FULL_TILT;
            galSpinEntryTarget = null;
          }
          galPrevNearGoal = nearGoal;
          // 环视/倾角/档内缩放的阻尼趋近（拖拽与手势只写目标，
          // 旧实现是直写组旋转、无阻尼）：偏航只在邻域在位时施
          // 加（×eNC 混入混出），倾角全程生效；组旋转在此统一
          // 落笔，位置钉住与签面夹取读的都是落笔后的值
          // 邻域偏航惯性（拖动补完轮）：松手后 galVelY 逐帧续
          // 推目标、按 exp(−dt·3) 衰减（τ≈0.33s 的轻惯性，与地
          // 球惯性同常数）；拖动/捏合中不推（目标由手指直
          // 写），退出邻域即清零，不许残速跨态泄漏
          if (nearGoal === 0) {
            galVelY = 0;
            galLabelResolvePending = false;
          } else if (
            !dragging &&
            !pinching &&
            Math.abs(galVelY) > 0.0001
          ) {
            galYawT += galVelY;
            galVelY *= Math.exp(-dt * 3);
          }
          // 跟手性（拖动补完轮）：邻域拖动/惯性活跃时趋近率
          // 9→16（时间常数 111ms→62ms），指尖匀速拖动时的稳
          // 态滞后近乎减半；稳态与入场落位仍走 9——只改手势
          // 期的跟随速度，不动任何坐标、取景与落位几何
          // 1:1 直连（移动端拖拽取证轮，用户第三次实报拖不
          // 动）：单指拖动态彻底摘掉趋近——galYaw/galTilt 直
          // 接等于目标，场景钉在指尖（稳态滞后 5.4°→0）；趋
          // 近只保留给入场摆入、稳态与松手后的惯性滑行。直
          // 连以重锚完成为前提（galDragRebasePending 已消费：
          // 偏航目标已搬到当前实际角，赋值不跳帧）；极角自
          // 纯方位角轮起在邻域恒为入场极角目标——直连赋值
          // galTilt = galTiltT 只是把入场落定提前钉死，拖动
          // 本身从不改这个值
          const galDirectDrag =
            nearGoal === 1 &&
            dragging &&
            !pinching &&
            !galDragRebasePending;
          if (galDirectDrag) {
            galYaw = galYawT;
            galTilt = galTiltT;
          } else {
            const orbitK = Math.min(
              1,
              dt *
                (nearGoal === 1 &&
                (dragging || Math.abs(galVelY) > 0.0001)
                  ? 16
                  : 9),
            );
            galYaw += (galYawT - galYaw) * orbitK;
            galTilt += (galTiltT - galTilt) * orbitK;
          }
          // 落定再求解（拖动补完轮，签求解的逐帧纪律）：拖动
          // 期间签只走已存偏移 + 逐帧投影的廉价路径（见锚点
          // 同步段），多方向搜索绝不逐帧重跑；手势与惯性都停
          // 稳后在此消费一次待办，按当次自转相位整体再求解
          // 写回（与入场边沿同一 applyGalLabelSolve）
          if (
            galLabelResolvePending &&
            !dragging &&
            !pinching &&
            Math.abs(galVelY) <= 0.0001 &&
            eNC > 0.5
          ) {
            galLabelResolvePending = false;
            applyGalLabelSolve(galaxySpin.rotation.y);
          }
          // 邻域捏合直连（取证轮）：捏合在行时倍率直接等于
          // 指距目标——旧口径经 dt·5 阻尼，缩放慢手指半拍；
          // 滚轮/非捏合期仍走阻尼（滚轮是离散步进、阻尼即平
          // 滑）。捏合全程无 cancel 路径：双指都登记在
          // touchPts、第二指落下只切语义不清手势状态
          if (pinching && pinchGalaxyNear) {
            galaxyNearZoom = galaxyNearZoomT;
          } else {
            galaxyNearZoom +=
              (galaxyNearZoomT - galaxyNearZoom) * Math.min(1, dt * 5);
          }
          // 朝向合成（转盘模型，2026-11-16 改判）：方位角
          // galYaw（×eNC 混入混出）+ 极角 galTilt 两角经
          // galOrbitEuler（XYZ、z 恒 0）成四元数 R =
          // Rx(极角)·Ry(方位角)——偏航是绕世界竖轴的纯转
          // 盘、极角在世界系外层，盘面法线对方位角恒定、
          // 镜头高度恒在银道面上方 +极角（旧 YXZ 合成下
          // 高度随方位 +0.62→0→−0.62 上下翻，已废）；roll
          // 通道构造上不存在。下游需要倾角数值者读状态量
          // galTilt（夹取/fan 已替换），不读 rotation.x
          // 读回（别名分支会翻符号）
          galOrbitEuler.set(galTilt, galYaw * eNC, 0);
          galaxyGroup.quaternion.setFromEuler(galOrbitEuler);
          // 邻域在位时画布手势归画布独占：touch-action 切 none，
          // 单指环视的纵拖不再被浏览器接管成页面滚动；邻域混合
          // 落下（含退出转场）即恢复 pan-y。切 none 的时机（拖
          // 动补完轮）：不等混合过半——邻域目标一在位首帧即
          // 切，入场转场里抢先拖动也不会被 pan-y 半路接管；
          // 退出仍等混合落下过半（eNC>0.5 一侧）才恢复
          const wantTouchNone = nearGoal === 1 || eNC > 0.5;
          if (wantTouchNone !== galTouchNone) {
            galTouchNone = wantTouchNone;
            // touch-action 铺满祖先链（移动端拖拽取证轮）：
            // touch-action 的语义是手势点到「首个可滚动祖
            // 先」之间每一层的交集——只切画布一层时，中间容
            // 器的 pan-y 仍可能让宿主把纵向分量判给滚动仲
            // 裁。同一开关同步切画布 + 挂载容器两层；链再往
            // 上是 App 舞台浮层根，其 CSS 在模式激活时恒为
            // touch-action:none（桌面 lg 例外为 auto，指针设
            // 备无此仲裁），链上无缺口
            el.style.touchAction = wantTouchNone ? "none" : "pan-y";
            mount.style.touchAction = wantTouchNone ? "none" : "pan-y";
          }
          // 自转：整盘绕银心缓转——原 2π/26 分钟（0.00403
          // rad/s）在真机上与静止无异，2026-11-16 活银河返工
          // 轮按用户授权带（8–12 分钟一圈）提速到 2π/600 秒
          // （0.01047 rad/s、10 分钟一圈）：全览尺度下亮盘缘
          // （约 5.5 wu）5 秒弧移约 0.26 wu ≈ 13–15 px、内盘
          // 2 wu 处约 5 px——整体活气靠它打底，逐粒子游移叠
          // 在其上（与枢轴定版同轴：galaxySpin 原点即银心、
          // 全览组位移恒 0，银心仍钉画面中心）；近览冻结
          // （邻域不许漂移）、reduced-motion 冻结。入场相位
          // 拨正在位时（旋转轴对齐轮）先把自转角按最短角距
          // 阻尼拨到目标相位（转场飞行内完成、落定清零）——
          // 拨正本身是入场摆入的一部分，与偏航/极角阻尼同
          // 族，不受 reduced-motion 冻结（冻结的是常速慢转
          // 与游移时钟）
          if (galSpinEntryTarget !== null) {
            let dSpin =
              (galSpinEntryTarget - galaxySpin.rotation.y) %
              (Math.PI * 2);
            if (dSpin > Math.PI) dSpin -= Math.PI * 2;
            if (dSpin < -Math.PI) dSpin += Math.PI * 2;
            galaxySpin.rotation.y +=
              dSpin * Math.min(1, dt * 2.6);
            if (Math.abs(dSpin) < 0.002) galSpinEntryTarget = null;
          } else if (!reducedMotion) {
            galaxySpin.rotation.y += dt * 0.01047 * (1 - eNC);
          }
          // 粒子游移时钟（同轮）：全览在位时推进、邻域按
          // (1−eNC) 渐冻（校准层恒静）、reduced-motion 冻结
          if (!reducedMotion) {
            galOrbitClock += dt * (1 - eNC);
            galOrbitUniform.value = galOrbitClock;
          }
          const galaxyTargetZ = galaxyFitZ / galaxyZoom;
          smoothGalaxyZ +=
            (galaxyTargetZ - smoothGalaxyZ) * Math.min(1, dt * 5);
          if (Math.abs(galaxyTargetZ - smoothGalaxyZ) < 0.01) {
            smoothGalaxyZ = galaxyTargetZ;
          }
          // 近览倍率：让 ±拟合半径 kpc 的邻域填满画面竖向半幅；
          // 2026-11-14 精致轮拉近一档（只动取景、不动任何坐标）：
          // 移动端 1.15→1.04 kpc（邻域放大 ×1.11）；桌面 1.15→1.08
          // 微调。移动端拟合值其后经实体轮探针复核再修为 1.10，
          // 见下方 nearFitKpc 注。邻域优化轮（同日）再叠默认档
          // 内倍率 11：基准拟合不变、默认取景由 ±1.1 kpc 收紧
          // 为 ±100 pc（约 200 pc 见方），变焦域两端（0.25 →
          // ±4.4 kpc 银心本体完整进帧，2026-11-16 进帧轮放
          // 宽，见 GAL_NEAR_ZOOM_MIN 处注 / 24 → ±46 pc）由
          // 倍率行程覆盖
          const halfTanV = Math.tan(THREE.MathUtils.degToRad(21));
          // 移动端 1.04→1.10（2026-11-14 实体轮探针复核修正）：
          // 1.04 时天津四（面内距 0.802 kpc）在最坏自转朝向下球心
          // 达横向半幅的约 90%、签尾（含「光年」后缀）蹭出右缘约
          // 10px——精致轮的交界值没覆盖该朝向；1.10 后最坏约 85%、
          // 签尾留约 7px 余量。桌面横向半幅 = 拟合半径×宽高比
          // （约 1.9 kpc），天津四占比约 42%，无此风险，不动
          const nearFitKpc = isCoarse ? 1.1 : 1.08;
          const nearK = THREE.MathUtils.clamp(
            (smoothGalaxyZ * halfTanV) / (nearFitKpc * GAL_S),
            6,
            24,
          );
          // 邻域档内缩放（捏合/滚轮写 galaxyNearZoom）：直接乘
          // 进组缩放，取景窗在本档范围内放大缩小（旧实现捏合写
          // 的是全览 galaxyZoom——邻域取景由 nearFitKpc 锁死，
          // 相机距与组缩放同比抵消，捏合视觉上是空操作，本轮
          // 纠正）
          const scaleGoal =
            (0.15 + 0.85 * eG) *
            (1 + (nearK * galaxyNearZoom - 1) * eNear) *
            (1 + GAL_FULL_BOOST * (1 - eNear));
          galaxyScaleCur +=
            (scaleGoal - galaxyScaleCur) * Math.min(1, dt * 3.5);
          // 落定吸附（转场轮）：阻尼尾段的残差（实测量级
          // <1%）在转场结束后还会续收数帧、全盘像轻微呼吸
          // ——差 <0.002 时直接落定，转场结束帧与静态取景
          // 严丝合缝、无回弹（口径同 smoothSolarZ 的吸附）
          if (Math.abs(scaleGoal - galaxyScaleCur) < 0.002) {
            galaxyScaleCur = scaleGoal;
          }
          // 邻域捏合直连（取证轮）：邻域已落定（eNC≈1）且捏
          // 合在行时组缩放直达目标——指距变化当帧见效；入场
          // 混合未落定时 scaleGoal 还在随 eNear 演化，仍走上
          // 方阻尼合成，不抢转场
          if (pinching && pinchGalaxyNear && eNC > 0.99) {
            galaxyScaleCur = scaleGoal;
          }
          galaxyGroup.scale.setScalar(galaxyScaleCur);
          // 深变焦尺寸收敛（真机修正轮）：**太阳标记**的世界
          // 尺寸档按默认邻域取景定；连续变焦再推近（约 46 pc
          // 窗）时世界尺寸若不变会胀满画面——倍率过默认档后
          // 按 (默认档/倍率)^1.65 逐级收敛。收敛基准随邻域优
          // 化轮的默认倍率改定：旧基准 2.6 对应旧默认取景，
          // 现默认倍率 11（200 pc 窗）即基准——默认帧太阳标
          // 记尺寸与旧默认帧（1.1 kpc 窗、倍率 1）同为不收敛
          // 的原始档，推近到 24 时收敛到约 0.28。八星实体/光
          // 晕自真机修正轮二起不走此路：改屏幕尺寸补偿（表
          // 观恒定带宽，见下方锚点/实体段），本量只余太阳一路
          const galDotShrink =
            galaxyNearZoom <= 11
              ? 1
              : Math.pow(11 / galaxyNearZoom, 1.65);
          // 太阳点在组内的当前坐标（自转后）→ 近览平移目标
          const spinA = galaxySpin.rotation.y;
          const cs = Math.cos(spinA);
          const sn = Math.sin(spinA);
          const sunSpinX = galSunBase.x * cs + galSunBase.z * sn;
          const sunSpinZ = -galSunBase.x * sn + galSunBase.z * cs;
          // 太阳偏移（组旋转+缩放后、未平移）：邻域钉中心与转场
          // 锚定共用同一份量
          galaxyTmpV.set(sunSpinX, galSunBase.y, sunSpinZ);
          galaxyTmpV.multiplyScalar(galaxyScaleCur).applyEuler(galaxyGroup.rotation);
          // 钉住系数 pinK：邻域在位（eNC）恒钉之外，模式转场
          // 全程锚定太阳的盘面真位（真机修正轮二，用户真机
          // 判旧版「缩向银心黑洞」——旧式 pinK = 1−eG：太阳随
          // eG 推进一路滑向原点，而全览落位时黑洞正在原点，
          // 收缩中的太阳系看着就是奔黑洞去的）。新式：钉力不
          // 随 eG 线性撤——转场主体段（eG ≤ 0.78）恒钉满格：
          // 太阳标记恒在场景原点 = 收缩中太阳系本体的位置，
          // 银盘绕它（即绕太阳真位）展开、黑洞在盘面坐标里离
          // 太阳 8.15 kpc、随组放大一路向外走，绝不与太阳系
          // 本体交汇；只在收尾段（eG 0.78→1、太阳系本体已缩
          // 没、只剩标记）钉力经 settleK 平滑撤尽，标记沿连
          // 续轨迹滑到全览构图里的真位（银心居中落位）。出
          // 场逆行：settle 先复钉、太阳回到原点后太阳系才长
          // 出来交接。全程同一枚太阳标记、无跳切
          const settleK = sstep((eG - 0.78) / 0.22);
          // 转场锚点分向（2026-11-15 晚转场轮，元灿：「缩
          // 放转场位置还是不太对」+ 枢轴轮同令）：进入方向
          // （st.galaxy 为真）锚点 = 银心——pinK 只剩邻域分
          // 量 eNC，全览与进入转场全程 galaxyPosTarget 恒
          // 为 0、银心逐帧代数钉死画面中心，缩放只绕银心
          // 展开；退出方向锚点 = 太阳——保留 settle 语义
          // （eG 跌出收尾段后钉力渐回、太阳缓归中心与太阳
          // 系静态取景衔接）。两式在切换帧取值一致（eG=1
          // 时同为 eNC；eG=0 时银河不可见），方向翻转无跳
          // 变。旧进入式（1−settleK 钉太阳至 0.78 再滑向银
          // 心）的问题正是锚点在转场尾段横移——落点看着
          // 「漂过去再停」，本轮废除
          const pinK = st.galaxy
            ? eNC
            : Math.max(eNC, 1 - settleK);
          galaxyPosTarget.copy(galaxyTmpV).multiplyScalar(-pinK);
          // 枢轴精确解算（真机修正轮，用户真机判「旋转中心不
          // 是太阳系」）：旧实现对平移再套一层 dt*3.5 的 lerp
          // 追赶——而偏航/倾角的阻尼是 dt*9、缩放 dt*3.5，两
          // 条时间常数不一致，持续拖动时平移永远追不上旋转后
          // 的太阳偏移，太阳被拖离画面中心打转、松手后才缓缓
          // 归位（落位帧质心居中 ≠ 拖动枢轴居中，探针静帧验
          // 不出、真机一拖即现）。平移是旋转/缩放/自转角的纯
          // 派生量：本帧输入全部落笔后直接解算赋值，不再单独
          // 平滑——输入本身（galYaw/galTilt/galaxyScaleCur/
          // eG/eNC）都是平滑量，解出的轨迹同样连续无跳
          galaxyPosCur.copy(galaxyPosTarget);
          // 【frameK 取景偏移已废除（2026-11-15 晚枢轴轮，
          // 元灿真机判「旋转的时候并不是按银心为中心旋
          // 转」）】旧制（真机修正轮二 E）：全览落位后把取
          // 景中心沿太阳当前偏移方向挪 0.22 份（移动端），
          // 保太阳标记不出框——代价是组原点（银心）被拖着
          // 随自转/拖动的相位绕行：galaxyTmpV 随 spin 旋转，
          // 偏移方向逐帧跟着转，银心在画面上画圈、盘面像绕
          // 偏心点摆（NDC 摆幅约 ±0.22×4.075/6.87 ≈ ±0.13、
          // 390px 宽约 ±26px）。本轮整条删除：全览（含转
          // 场）组位移逐帧代数恒为 galaxyPosTarget（进入/
          // 全览 = 0），银心恒在画面正中、旋转只绕它。太阳
          // 标记在窄屏侧位相位下可出框，是枢轴精确的代价
          // （邻域才是太阳的校准层，全览为银心枢轴让位；
          // 口径见 DATA-PLAN 本轮条目）
          galaxyGroup.position.copy(galaxyPosCur);
          galaxySunWorld.copy(galaxyPosCur).add(galaxyTmpV);
          // 镜头接管（聚焦相机在银河模式下不该在位——App 只从太
          // 阳系总览进入银河，focusedBody 恒空；此处仍以 eG 混合
          // 兜底，万一在位也不硬切）。注视点在转场期间追太阳锚
          // 点（权重 1−eG：出发时盯着太阳、落位时归零回到银心
          // 原点）；邻域在位时太阳本就钉在原点，两式恒等
          galaxyTmpV.set(0, 0, smoothGalaxyZ);
          camera.position.lerp(galaxyTmpV, eG);
          galaxyLook.copy(galaxySunWorld).multiplyScalar(1 - eG);
          camera.lookAt(galaxyLook);
          // 呼吸时钟：只推进这一枚共享 uniform，逐星呼吸全在
          // GPU 顶点着色器里算（CPU 逐帧开销 = 一次赋值）；
          // reduced-motion 时不推进、呼吸冻结在当前相位
          if (!reducedMotion) galTimeUniform.value = t;
          // 材质淡变：盘面层随 eG 统一亮起；银心向图层近览再退
          const galFade = Math.min(1, eG * 1.6);
          for (const rec of galFadeMats) {
            // 星点层已是着色器材质：淡变写 uOpacity uniform
            // （材质自带的 opacity 属性对 ShaderMaterial 不生
            // 效）；精灵/线等普通材质仍走 opacity 属性
            const sm = rec.mat as THREE.ShaderMaterial;
            if (sm.uniforms && sm.uniforms.uOpacity)
              sm.uniforms.uOpacity.value = rec.base * galFade;
            else rec.mat.opacity = rec.base * galFade;
          }
          for (const rec of galHubMats) {
            rec.mat.opacity = rec.base * galFade * (1 - eNC);
          }
          // 连续光场层（辉光底片/尘带暗幕）：全览读法专属，
          // 随邻域混合 (1−eNC) 退场——写 uOpacity 同 galFadeMats
          for (const rec of galHazeMats) {
            const sm = rec.mat as THREE.ShaderMaterial;
            if (sm.uniforms && sm.uniforms.uOpacity)
              sm.uniforms.uOpacity.value = rec.base * galFade * (1 - eNC);
            else rec.mat.opacity = rec.base * galFade * (1 - eNC);
          }
          // 邻域定位家具（网格/垂线/距离环/引力井）：只在邻
          // 域档随 eNC 淡入，全览恒隐
          for (const rec of galNearMats) {
            rec.mat.opacity = rec.base * galFade * eNC;
          }
          // warp 几何（本轮）：距离环/垂线只在 eNC 变化时从真
          // 值重写（转场期逐帧、落位后静止零开销）
          if (Math.abs(eNC - galWarpGeoApplied) > 1e-5) {
            applyGalWarpGeos(eNC);
            galWarpGeoApplied = eNC;
          }
          // 锚点同步：位置按自转角旋转，尺寸按组缩放反算（世界
          // 尺寸恒定），透明度按类别（臂签/银心签全盘档、八星签
          // 近览档、太阳标记两档都在）。屏幕系签偏移换算用的
          // 逆旋转先在此算一次，八签共用
          galInvQ.copy(galaxyGroup.quaternion).invert();
          // 呼出混合权重（签验收补完轮）：倍率 ≥2.6 纯锚定、
          // ≤1.1 纯呼出，之间平滑——galaxyNearZoom 本身带阻尼，
          // 捏合缩远时签沿引线连续滑向呼出位、无跳变
          const galWCall = 1 - sstep((galaxyNearZoom - 1.1) / 1.5);
          for (const a of galAnchors) {
            // 邻域 warp 落位（本轮）：base 恒真坐标——mode 1 绕
            // 太阳三维径向混合、mode 2（足点）只放 x/z 且 y 钉
            // 0；eNC=0（全览）时 fb 恒 1、逐分量恒等真值。引线
            // 星点端读的正是此 warp 后落位，与星体恒重合
            let bx = a.base.x;
            let by = a.base.y;
            let bz = a.base.z;
            if (a.warpMode !== 0 && eNC > 0.001) {
              const fb = 1 + (a.warpK - 1) * eNC;
              bx = galSunBase.x + (bx - galSunBase.x) * fb;
              bz = galSunBase.z + (bz - galSunBase.z) * fb;
              by =
                a.warpMode === 2
                  ? 0
                  : galSunBase.y + (by - galSunBase.y) * fb;
            }
            a.obj.position.set(
              bx * cs + bz * sn,
              by,
              -bx * sn + bz * cs,
            );
            // 引线星点端：偏移/rise 落笔前的显示点位置（邻域里
            // = warp 后星点），先记下，签面端在本轮迭代末尾补
            if (a.leader && galLeaderPos && a.leaderIdx >= 0) {
              const o6 = a.leaderIdx * 6;
              galLeaderPos[o6] = a.obj.position.x;
              galLeaderPos[o6 + 1] = a.obj.position.y;
              galLeaderPos[o6 + 2] = a.obj.position.z;
            }
            const rise =
              (a.riseFull + (a.riseNear - a.riseFull) * eNC) /
              galaxyScaleCur;
            a.obj.position.y += rise;
            // 签面偏移（只挪签面，星点恒在真实位置）：星名签走
            // 屏幕系恒定偏移——fan 存画面右/上向的世界偏移，
            // 经组旋转的逆变换落回本地坐标，用户任意旋转后签
            // 恒在本星同一侧同一档距离；太阳系签沿用旧本地系
            // 扇开（fan 是世界量，落到局部坐标除以组缩放，纵
            // 向再除 cos(当前倾角) 约化到屏幕上方）
            if (
              eNC > 0.001 &&
              (a.fanX !== 0 ||
                a.fanY !== 0 ||
                a.fanCX !== 0 ||
                a.fanCY !== 0)
            ) {
              if (a.fanScreen) {
                galFanV
                  .set(
                    a.fanX + (a.fanCX - a.fanX) * galWCall,
                    a.fanY + (a.fanCY - a.fanY) * galWCall,
                    0,
                  )
                  .applyQuaternion(galInvQ);
                a.obj.position.addScaledVector(
                  galFanV,
                  eNC / galaxyScaleCur,
                );
              } else {
                a.obj.position.x += (a.fanX * eNC) / galaxyScaleCur;
                a.obj.position.y +=
                  (a.fanY * eNC) /
                  (galaxyScaleCur * Math.cos(galTilt));
              }
            }
            const wWorld = a.wFull + (a.wNear - a.wFull) * eNear;
            // 星签横向夹取（探针复核沉淀）：星签在最坏自转朝向
            // 下签面按星心居中 + fan 偏移后尾端可能出右缘。星签
            // 属注释层（与 fan 同纪律：只挪签面、星体恒在真实坐
            // 标），邻域在位时把星签中心横向夹回画面内（留 0.12
            // 世界单位边距），天津四签尾同受此兜底——只对星名
            // 签（clampLabel 旗）生效：光晕点与球体不经此路，
            // 距离环数签深变焦时随环离场、不许被拽回画缘
            if (a.clampLabel && eNC > 0.001) {
              // 画面中心 = 太阳锚点的当前本地坐标（sunSpinX，组
              // 平移已把太阳钉在画面中心）——夹取相对它算，不
              // 是相对组原点（银心在邻域里远在画面外）。
              // 边界按标签自身深度算：近相机侧的星签被透视放大
              // 10%+，用太阳平面的半幅夹会被放大顶出界（探针二
              // 轮实测）——故先由标签相对
              // 太阳的世界偏移（经组倾角）得其深度 wz，再以该
              // 深度处的投影半幅为界（留 2% NDC 边距）
              const offWY =
                (a.obj.position.y - galSunBase.y) * galaxyScaleCur;
              const offWZ =
                (a.obj.position.z - sunSpinZ) * galaxyScaleCur;
              // 组倾角读状态量 galTilt（转盘轮：rotation.x
              // 读回在 |偏航|>90° 走别名分支、符号会翻，不
              // 许再读——本式与求解器 ctx.pol 同值同源）
              const wz =
                offWY * Math.sin(galTilt) +
                offWZ * Math.cos(galTilt);
              const depth = smoothGalaxyZ - wz;
              if (depth > 1) {
                const limWorld =
                  0.98 * depth * halfTanV * camera.aspect - wWorld / 2;
                if (limWorld > 0) {
                  const lim = limWorld / galaxyScaleCur;
                  // 锚定优先于夹取（邻域优化轮）：夹取只救「星
                  // 在框内、签尾出框」——本星横偏已超过夹取界
                  // 一个签宽以上时（默认 200 pc 取景下的天津
                  // 四/参宿四/天鹅座β，本就该在框外），不许把
                  // 签硬拽到画缘冒充锚定：签随本星离场，缩远
                  // 后星入框、夹取自动恢复
                  if (
                    Math.abs(a.obj.position.x - sunSpinX) <=
                    lim + wWorld / galaxyScaleCur
                  ) {
                    a.obj.position.x =
                      sunSpinX +
                      THREE.MathUtils.clamp(
                        a.obj.position.x - sunSpinX,
                        -lim,
                        lim,
                      );
                  }
                }
              }
            }
            let w = wWorld / galaxyScaleCur;
            if (a.aspect === 1 && a.pxT > 0) {
              // 八星光晕：屏幕尺寸补偿（真机修正轮二 C）——
              // 按本帧相机到该星的距离反解世界直径，使表观
              // 直径恒为 pxT（CSS px，构建时定 = 实体 pxT ×
              // 1.9）：缩远时相对世界变大、不缩没，推近时不
              // 膨胀。落点小点 pxT=0 不入此路
              a.obj.getWorldPosition(galCompV);
              const distS = camera.position.distanceTo(galCompV);
              w =
                (2 *
                  distS *
                  halfTanV *
                  a.pxT *
                  renderer.getPixelRatio()) /
                renderer.domElement.height /
                galaxyScaleCur;
            } else if (
              a.aspect === 1 &&
              (a.kind === "star" || a.kind === "sun")
            ) {
              // 其余点状锚点（落点/太阳核与光环）随深变焦收
              // 敛世界尺寸（见 galDotShrink 注）；文字签不经
              // 此路
              w *= galDotShrink;
            }
            if (a.pulse) w *= 1 + 0.13 * Math.sin(t * 1.35);
            a.obj.scale.set(w, w * a.aspect, 1);
            const kindFade =
              a.kind === "arm"
                ? 1 - eNC
                : a.kind === "hub"
                  ? 1 - eNC
                  : a.kind === "star"
                    ? eNC
                    : 1;
            a.mat.opacity = a.baseOpacity * kindFade * galFade;
            // 引线签面端：本轮迭代的最终落位（偏移+夹取后）
            if (a.leader && galLeaderPos && a.leaderIdx >= 0) {
              const o6 = a.leaderIdx * 6;
              galLeaderPos[o6 + 3] = a.obj.position.x;
              galLeaderPos[o6 + 4] = a.obj.position.y;
              galLeaderPos[o6 + 5] = a.obj.position.z;
            }
          }
          if (galLeaderAttr) galLeaderAttr.needsUpdate = true;
          // 八星实体同步：球心恒在真实坐标（与光晕锚点同
          // base，无 fan、无 rise）；直径走屏幕尺寸补偿（真
          // 机修正轮二 C，用户：「领域里面缩小之后，星球也
          // 跟着缩小了，而不是放大」）——逐帧按相机到球心的
          // 距离反解世界直径，使表观直径在整个邻域变焦域
          // （倍率 0.6–24）内恒为 pxT（CSS px，带宽 16–30，
          // 构建时按 dNear 相对序定）：缩远时世界直径随距离
          // 反涨、球不缩没；推近时表观被 pxT 夹死、不膨胀
          // 失控。旧世界尺寸档 + galDotShrink 收敛退役（该
          // 量只余太阳标记一路）。全览档整体隐藏
          for (const b of galStarBodies) {
            const show = eNC > 0.02;
            b.mesh.visible = show;
            if (!show) continue;
            // 邻域 warp 落位（本轮）：与光晕/星签同一倍率同一
            // 混合（eNC），球心恒与光晕锚点重合
            let bx = b.base.x;
            let by = b.base.y;
            let bz = b.base.z;
            if (eNC > 0.001 && b.warpK !== 1) {
              const fb = 1 + (b.warpK - 1) * eNC;
              bx = galSunBase.x + (bx - galSunBase.x) * fb;
              by = galSunBase.y + (by - galSunBase.y) * fb;
              bz = galSunBase.z + (bz - galSunBase.z) * fb;
            }
            b.mesh.position.set(
              bx * cs + bz * sn,
              by,
              -bx * sn + bz * cs,
            );
            b.mesh.getWorldPosition(galCompV);
            const distB = camera.position.distanceTo(galCompV);
            const worldD =
              (2 *
                distB *
                halfTanV *
                b.pxT *
                renderer.getPixelRatio()) /
              renderer.domElement.height;
            b.mesh.scale.setScalar(worldD / galaxyScaleCur);
            b.mat.uniforms.uOpacity!.value = eNC * galFade;
          }
          // —— 银心罗盘落位（本轮）：屏幕系常驻方向标记 ——
          // 方位 = 太阳→银心真方向的世界向量投到相机右/上轴
          // 的屏幕分量（拖动改方位时它随之转动、与三维场景恒
          // 一致）；臂长 = max(80 pc 投影长， 72 px)，再沿同
          // 一射线按「圆盘＋签」刚性整体包围盒夹进画布（只
          // 截长、不偏向，整体完整在框、见落位段钳制注）；
          // 标记/签固定屏幕尺寸（36 px / 168 px 宽），
          // 落位平面 = 过太阳且平行于屏幕的平面（罗盘语义，
          // 非尺度内天体）。透明度与邻域家具同拍（galFade×eNC）
          if (galCompass) {
            const cp = galCompass;
            const showC = eNC > 0.02;
            cp.line.visible = showC;
            cp.marker.visible = showC;
            cp.pulse.visible = showC;
            cp.label.visible = showC;
            if (!showC) {
              galCompassState.mkPxX = -1;
              galCompassState.mkPxY = -1;
              galCompassState.lbPxX = -1;
              galCompassState.lbPxY = -1;
            }
            if (showC) {
              const cwC = mount.clientWidth || 390;
              const chC = mount.clientHeight || 785;
              const sunW = galaxySunWorld;
              // 银心世界位 = 组原点（galaxyGroup.position 即其
              // 世界位，父级为场景）；方向自太阳指向银心
              galWarpV.copy(galaxyGroup.position).sub(sunW);
              const dirLen = galWarpV.length();
              const me = camera.matrixWorld.elements;
              const cxv =
                galWarpV.x * me[0]! +
                galWarpV.y * me[1]! +
                galWarpV.z * me[2]!;
              const cyv =
                galWarpV.x * me[4]! +
                galWarpV.y * me[5]! +
                galWarpV.z * me[6]!;
              const len2 = Math.hypot(cxv, cyv);
              if (dirLen > 1e-6 && len2 > 1e-6) {
                // 退化相位兜底：银心恰在正前方（投影方向无定
                // 义，len2/dirLen ≈ 0）时沿用上一帧方向——初值
                // 正上，与入场「银心在上方」口径一致
                if (len2 / dirLen >= 0.05) {
                  galCompassState.sdx = cxv / len2;
                  galCompassState.sdy = -cyv / len2;
                }
                const sdx = galCompassState.sdx;
                const sdy = galCompassState.sdy; // 屏幕 y 向下
                galCompV.copy(sunW).project(camera);
                const sunPxX = ((galCompV.x + 1) / 2) * cwC;
                const sunPxY = ((1 - galCompV.y) / 2) * chC;
                const distSun = camera.position.distanceTo(sunW);
                const wpp = (2 * distSun * halfTanV) / chC;
                // 80 pc 段的世界长经组缩放后投到屏幕的 px 长：
                // 世界长 × 方向在屏幕面内的分量比 / 每 px 世界长
                const proj80 =
                  (0.04 * galaxyScaleCur * (len2 / dirLen)) / wpp;
                let armPx = Math.max(proj80, 72);
                // —— 屏幕空间刚性钳制（2026-11-16 可见性修
                // 复轮，元灿真机判「必须缩小特别多银心才
                // 能出现，而且还显示不全，只能看见一
                // 半」）：旧制只把标记心夹进内缩 44 px 的
                // 框、签再各自夹 [88/24]——两件脱钩，标记
                // 钉在顶边时签被自夹回拽、圆盘与呼吸环的
                // 实际半径也没进过账，正是半裁来源。本轮
                // 改判：标记圆盘（本体 r 18、呼吸环 r≈28，
                // 按 30 计）与文字签（心沿方位外推 44、半
                // 宽 84 / 半高 19）作**刚性整体**——按当前
                // 方位先算整体包围盒相对标记心的偏移域，
                // 再求标记心在画布内（四边留 10 px）能待
                // 的允许盒；臂长沿太阳→银心射线夹到与允
                // 许盒的交点为止：出框即钉在最近的帧边内
                // 侧、方向不偏，入框则臂长 = 真投影长、标
                // 记回到真实投影位。射线够不到允许盒的退
                // 化相位（太阳本身出框）标记心就近夹进盒
                // 内保命。签恒随标记刚性落位、不再单独夹
                // 取；点按热区读 galCompassState 的同一份
                // 落位（下方登记），自动跟随钳制后位置
                const bbMinX = Math.min(-30, sdx * 44 - 84);
                const bbMaxX = Math.max(30, sdx * 44 + 84);
                const bbMinY = Math.min(-30, sdy * 44 - 19);
                const bbMaxY = Math.max(30, sdy * 44 + 19);
                const boxLoX = 10 - bbMinX;
                const boxHiX = cwC - 10 - bbMaxX;
                const boxLoY = 10 - bbMinY;
                const boxHiY = chC - 10 - bbMaxY;
                let mkPxX = sunPxX + sdx * armPx;
                let mkPxY = sunPxY + sdy * armPx;
                if (boxLoX <= boxHiX && boxLoY <= boxHiY) {
                  let tMax = Infinity;
                  if (sdx > 1e-9)
                    tMax = Math.min(tMax, (boxHiX - sunPxX) / sdx);
                  if (sdx < -1e-9)
                    tMax = Math.min(tMax, (boxLoX - sunPxX) / sdx);
                  if (sdy > 1e-9)
                    tMax = Math.min(tMax, (boxHiY - sunPxY) / sdy);
                  if (sdy < -1e-9)
                    tMax = Math.min(tMax, (boxLoY - sunPxY) / sdy);
                  if (Number.isFinite(tMax) && tMax >= 0) {
                    armPx = Math.min(armPx, tMax);
                    mkPxX = sunPxX + sdx * armPx;
                    mkPxY = sunPxY + sdy * armPx;
                  } else {
                    mkPxX = THREE.MathUtils.clamp(
                      mkPxX,
                      boxLoX,
                      boxHiX,
                    );
                    mkPxY = THREE.MathUtils.clamp(
                      mkPxY,
                      boxLoY,
                      boxHiY,
                    );
                    armPx = Math.hypot(
                      mkPxX - sunPxX,
                      mkPxY - sunPxY,
                    );
                  }
                }
                galCompassState.lenPx = armPx;
                galCompassState.sdx = sdx;
                galCompassState.sdy = sdy;
                // 签心 = 标记心沿方位外推 44 px（标记半径
                // 18 + 间隔 7 + 签半高约 19），与标记刚性
                // 同行——整体包围盒已在上方钳制里保它完
                // 整在框，此处不再单独夹取
                const lbPxX = mkPxX + sdx * 44;
                const lbPxY = mkPxY + sdy * 44;
                // px → 世界（过太阳的屏幕平行面）：右轴/上轴取
                // 相机矩阵列，y 分量翻号（屏幕向下）
                const rxv = me[0]!;
                const ryv = me[1]!;
                const rzv = me[2]!;
                const uxv = me[4]!;
                const uyv = me[5]!;
                const uzv = me[6]!;
                const toWorld = (
                  px: number,
                  py: number,
                  out: THREE.Vector3,
                ): void => {
                  const ox = (px - sunPxX) * wpp;
                  const oy = -(py - sunPxY) * wpp;
                  out.set(
                    sunW.x + rxv * ox + uxv * oy,
                    sunW.y + ryv * ox + uyv * oy,
                    sunW.z + rzv * ox + uzv * oy,
                  );
                };
                toWorld(mkPxX, mkPxY, galWarpV);
                cp.linePos[0] = sunW.x;
                cp.linePos[1] = sunW.y;
                cp.linePos[2] = sunW.z;
                cp.linePos[3] = galWarpV.x;
                cp.linePos[4] = galWarpV.y;
                cp.linePos[5] = galWarpV.z;
                cp.lineAttr.needsUpdate = true;
                cp.line.computeLineDistances();
                cp.lineMat.dashSize = 5.5 * wpp;
                cp.lineMat.gapSize = 4 * wpp;
                cp.lineMat.opacity = 0.55 * galFade * eNC;
                cp.marker.position.copy(galWarpV);
                cp.marker.scale.set(36 * wpp, 36 * wpp, 1);
                cp.markerMat.opacity = galFade * eNC;
                // 热区落位登记（点按判定与验收钩子共用本帧真值）
                galCompassState.mkPxX = mkPxX;
                galCompassState.mkPxY = mkPxY;
                galCompassState.lbPxX = lbPxX;
                galCompassState.lbPxY = lbPxY;
                // 呼吸环（可点暗示，见构建处）：与标记同心，尺
                // 寸 ±6%、透明度同相浮动——克制，不抢罗盘本体
                const pulsePh = 0.5 + 0.5 * Math.sin(t * 1.7);
                cp.pulse.position.copy(galWarpV);
                const pulsePx = 52 * (1 + 0.06 * Math.sin(t * 1.7));
                cp.pulse.scale.set(pulsePx * wpp, pulsePx * wpp, 1);
                cp.pulseMat.opacity =
                  (0.22 + 0.16 * pulsePh) * galFade * eNC;
                toWorld(lbPxX, lbPxY, galWarpV);
                cp.label.position.copy(galWarpV);
                cp.label.scale.set(
                  168 * wpp,
                  168 * wpp * (76 / 336),
                  1,
                );
                cp.labelMat.opacity = galFade * eNC;
              }
            }
          }
        }
        if (!galaxyGroup.visible && galTouchNone) {
          galTouchNone = false;
          el.style.touchAction = "pan-y";
          mount.style.touchAction = "pan-y";
        }
        // 地球收尾：太阳系组缩去后地球（场景级、不在太阳系组内）
        // 会冻在轨道位残留画面——随 eG 同步缩，吃到 0.97 藏起；
        // 退出时太阳系帧段照常驱动它，银河一退场即恢复
        if (eG > 0.01) {
          earth.visible = eG < 0.97;
          if (eG < 0.97) earth.scale.multiplyScalar(1 - 0.9 * eG);
        } else if (!earth.visible) {
          earth.visible = true;
        }
      }

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
        // 卫星钟按绝对会话秒对齐（离屏暂停轮）：旧口径逐帧累加
        // 钳制后的 dt，暂停/卡顿都会让轨道相位与真实时间脱节；
        // 改为直接取绝对 t——satClock 与 t 同零点，轨道角 = 基准
        // + ct×角速率的公式不变，恢复帧卫星自动落在绝对时间应
        // 有的位置（reduced-motion 下仍冻结于 0，口径不变）
        if (!reducedMotion) satClock = t;
        for (const f of satFadeMats) f.mat.opacity = f.base * globeFade;
        for (const tick of satTickers) tick(satClock);
      }

      // —— 流星雨速率曲线（与彗星同一条 3 分钟会话时钟）：1:30
      // 前速率为零（窗口外零痕迹）；1:30–2:30 由约 0.1 颗/秒渐
      // 强到约 2.7 颗/秒；2:30–3:00 峰值约 4.2 颗/秒（设计口径
      // 3–5）。阶级占比全时段恒定（2026-11-16 晚修订定版：普通
      // 52 / 明亮 27 / 火流星 8 / 蓝绿 10 / 最高阶陨石 3，见生
      // 成段——火流星与蓝绿占比按用户令调低、份额回普通/明亮，
      // 最高阶 3% 是陨石无条件规则的锚、一字不动）。
      // reduced-motion 不生成（快速闪
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
              if (curtainMeteors.length < 56) {
                // —— 阶级分流（2026-11-16 狮子座注入定版、当晚
                // 修订，一掷定阶级）：最高阶 3% → 陨石顶替 /
                // 火流星 8%（cls 2、⑥ 档橙红）/ 蓝绿 10%（cls
                // 3、⑤ 档蓝绿）/ 其余 79% 进常规池——池内再抽
                // 四档色（月白紫 50 / 蓝白 27 / 钙紫粉 15 / 镁
                // 绿白 8）并以约 34% 升明亮阶级（cls 1，池内占
                // 比 → 全口径普通 ≈52% / 明亮 ≈27%）。全口径
                // 色板：月白紫 ≈39.5%（仍第一大色、主调不变）/
                // 蓝白 ≈21% / 钙紫粉 ≈12% / 蓝绿 10% / 火流星
                // 橙 8% / 镁绿白 ≈6% / 陨石 3%。修订前口径（火
                // 流星 13 / 蓝绿 16 / 普通 46 / 明亮 22）按用户
                // 令「比例调低」作废：火流星降到高个位数、蓝绿
                // 降到一成，让出份额回普通/明亮；最高阶 3% 是
                // 陨石无条件规则的锚，不动。同屏存活上限 56 不
                // 变：峰值稳态需求 = 4.2 颗/秒 × 最长寿命 2.3 秒
                // ≈ 9.7 颗，56 只作防波次叠加失控的封顶（绘制
                // 全走 2D 批绘：多边形填充 + 预渲染盖印，无逐颗
                // 纹理/着色器切换，见交付账）。
                const cr = Math.random();
                // 陨石顶替判定（口径见 curtainRocks 处注）：最高
                // 阶（3%）直接顶替为陨石——无概率掷骰、不限峰值
                // 段、无每循环硬顶（JI 2026-11-13 终令，本轮一
                // 字不动：新火流星阶级 cls=2 是独立的光轨阶级，
                // 不经此判定、不落陨石）
                const toRock = cr < 0.03;
                let cls: 0 | 1 | 2 | 3 = 0;
                let v = 0;
                if (toRock) {
                  v = 0;
                } else if (cr < 0.11) {
                  cls = 2;
                  v = 5;
                } else if (cr < 0.21) {
                  cls = 3;
                  v = 4;
                } else {
                  const vr = Math.random();
                  v = vr < 0.5 ? 0 : vr < 0.77 ? 1 : vr < 0.92 ? 2 : 3;
                  cls = Math.random() < 0.34 ? 1 : 0;
                }
                // 档位偏置（变体即参数：蓝白生来最快最细、钙紫粉
                // 生来较慢较粗——边际权重精确，相关性由参数偏置
                // 保证，不事后筛选；只作用于常规池 cls 0/1，新阶
                // 级 cls 2/3 有自己的速度/尺寸口径、不吃偏置）
                // 速度定版（2026-11-13 09:30，用户：「星辰坠落
                // 的速度不能太快」）：普通单颗寿命 1.4–2.2 秒、
                // 明亮 1.9–2.2 秒，行程不变 → 坠速降到旧约
                // 1/2–1/3，匀速直坠、头尾全程可读。2026-11-16
                // 新阶级速度口径（当晚修订）：火流星 1.9–2.3 秒
                // （最长寿、拖得住余迹），轨宽基数由 4.4 收回
                // 2.6——与明亮 3.0 / 普通 1.9 同量级，「不用这么
                // 大」靠缩小个头、亮度靠头光强度（见绘制段）；
                // 蓝绿原「71 km/s 快端」口径（寿命 0.85–1.25 秒、
                // 表观速度约普通 1.6–2 倍）按用户令「蓝绿色也不
                // 用太快」作废——寿命回 1.3–1.9 秒、行程 50%–80%
                // 幕高，表观速度 ≈ 普通的 1.1 倍（至多略快），
                // 身份改由蓝绿实色 + 针形承担（见绘制段）
                let life: number;
                let dist: number;
                let len: number;
                let wBase: number;
                if (cls === 2) {
                  life = 1.9 + Math.random() * 0.4;
                  dist = curtainH * (0.72 + Math.random() * 0.2);
                  len = curtainH * (0.4 + Math.random() * 0.1);
                  wBase = 2.6;
                } else if (cls === 3) {
                  life = 1.3 + Math.random() * 0.6;
                  dist = curtainH * (0.5 + Math.random() * 0.3);
                  len = curtainH * (0.26 + Math.random() * 0.08);
                  wBase = 1.15;
                } else if (cls === 1) {
                  life = 1.9 + Math.random() * 0.3;
                  dist = curtainH * (0.7 + Math.random() * 0.2);
                  len = curtainH * (0.37 + Math.random() * 0.09);
                  wBase = 3.0;
                } else {
                  life = 1.4 + Math.random() * 0.8;
                  dist = curtainH * (0.5 + Math.random() * 0.35);
                  len = curtainH * (0.21 + Math.random() * 0.11);
                  wBase = 1.9;
                }
                let wMul = 1;
                if (cls <= 1 && v === 1) {
                  life *= 0.9;
                  dist *= 1.08;
                  len *= 0.92;
                  wMul = 0.8;
                } else if (cls <= 1 && v === 2) {
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
                  // 陨石顶替本颗最高阶：更沉更慢（行程 78%–95%
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
                } else {
                  if (cls === 2) fireSpawnedTotal++;
                  if (cls === 3) tealSpawnedTotal++;
                  curtainMeteors.push({
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
                  w: wBase * wMul * (isCoarse ? 1.1 : 1),
                  cls,
                  v,
                  cols,
                  sparkRgb: cols[2] ?? cols[0]!,
                  ph: Math.random() * Math.PI * 2,
                  shed: 0,
                  glint: 0.15 + Math.random() * 0.4,
                  fxAcc: 0,
                  });
                }
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
            // —— 火流星特效（2026-11-16，仅 cls=2）：沿途每约
            // 0.05 秒在身后落一团持久余迹（curtainWakes，滞留
            // 2.4–3.8 秒缓缓飘散）+ 剥落一粒火花（并入余烬池、
            // 吃轻重力坠落）——余迹是狮子座火流星的招牌：流星
            // 本体划走后，光迹还留在天上
            if (dm.cls === 2 && dm.age < dm.life) {
              dm.fxAcc += rawDt;
              while (dm.fxAcc >= 0.05) {
                dm.fxAcc -= 0.05;
                const spd2 = Math.hypot(dm.vx, dm.vy) || 1;
                const bux = dm.vx / spd2;
                const buy = dm.vy / spd2;
                if (curtainWakes.length < 240) {
                  curtainWakes.push({
                    x: dhx - bux * dm.w * 2 + (Math.random() - 0.5) * 6,
                    y: dhy - buy * dm.w * 2 + (Math.random() - 0.5) * 6,
                    vx: -dm.vx * 0.03 + (Math.random() - 0.5) * 7,
                    vy: -dm.vy * 0.03 - 5 - Math.random() * 6,
                    age: 0,
                    life: 2.4 + Math.random() * 1.4,
                    r0: 9 + Math.random() * 6,
                    ph: Math.random() * Math.PI * 2,
                  });
                }
                if (curtainEmbers.length < 320) {
                  curtainEmbers.push({
                    x: dhx - bux * dm.w * (1 + Math.random() * 2),
                    y: dhy - buy * dm.w * (1 + Math.random() * 2),
                    vx: -dm.vx * 0.14 + (Math.random() - 0.5) * 34,
                    vy: -dm.vy * 0.14 + (Math.random() - 0.5) * 34,
                    age: 0,
                    life: 0.35 + Math.random() * 0.35,
                    sz: 1 + Math.random() * 1.3,
                  });
                }
                // 碎块剥落（2026-11-16 晚形态修订）：约 45% 的
                // fx 节拍再剥一块带明显侧向分量的碎块——垂直轨
                // 向分叉、寿数更长（0.5–0.85 秒），读作火球翻
                // 滚时甩出、掉队的小火星，与贴身火花（上）分工
                if (Math.random() < 0.45 && curtainEmbers.length < 320) {
                  const side = Math.random() < 0.5 ? -1 : 1;
                  const fsp = 26 + Math.random() * 32;
                  curtainEmbers.push({
                    x: dhx - bux * dm.w * 2,
                    y: dhy - buy * dm.w * 2,
                    vx: -dm.vx * 0.1 - buy * side * fsp,
                    vy: -dm.vy * 0.1 + bux * side * fsp,
                    age: 0,
                    life: 0.5 + Math.random() * 0.35,
                    sz: 1.1 + Math.random() * 1.2,
                  });
                }
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
                  size:
                    (dm.cls === 2 ? 13 : dm.cls === 1 ? 15 : 11) +
                    Math.random() * 4,
                  rgb: hv.halo.join(","),
                });
              }
            }
            if (dm.age >= dm.life) {
              const ex = dm.x + dm.vx * dm.life;
              const ey = dm.y + dm.vy * dm.life;
              // 落点星闪：终点炸开一枚四角星芒小闪光（机制不变；
              // 火流星另加一圈闪爆 + 火花迸溅——末端闪爆是其第
              // 三件套，与陨石的落点闪爆同池 curtainBooms）
              if (curtainFlashes.length < 24) {
                curtainFlashes.push({
                  x: ex,
                  y: ey,
                  age: 0,
                  life: 0.24 + Math.random() * 0.1,
                  size: dm.cls === 2 ? 34 : dm.cls === 1 ? 30 : 19,
                });
              }
              if (dm.cls === 2) {
                if (curtainBooms.length < 6) {
                  curtainBooms.push({ x: ex, y: ey, age: 0, life: 0.45 });
                }
                for (let bi = 0; bi < 10 && curtainEmbers.length < 320; bi++) {
                  const ba = Math.random() * Math.PI * 2;
                  const bs = 35 + Math.random() * 110;
                  curtainEmbers.push({
                    x: ex,
                    y: ey,
                    vx: Math.cos(ba) * bs,
                    vy: Math.sin(ba) * bs - 24,
                    age: 0,
                    life: 0.4 + Math.random() * 0.45,
                    sz: 0.9 + Math.random() * 1.5,
                  });
                }
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
              if (curtainEmbers.length < 320 && rk.age < rk.life) {
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
              if (curtainBooms.length < 6) {
                curtainBooms.push({ x: ex, y: ey, age: 0, life: 0.5 });
              }
              for (let bi = 0; bi < 16 && curtainEmbers.length < 320; bi++) {
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
          // 火流星余迹推进：恒速缓漂（微上飘），只长老消亡——膨
          // 胀与渐隐在绘制段按龄期算
          for (let i = curtainWakes.length - 1; i >= 0; i--) {
            const wk = curtainWakes[i]!;
            wk.age += rawDt;
            wk.x += wk.vx * rawDt;
            wk.y += wk.vy * rawDt;
            if (wk.age >= wk.life) curtainWakes.splice(i, 1);
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
            curtainWakes.length > 0 ||
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
            // 火流星余迹（2026-11-16）：滞留光迹——每团随龄膨胀
            // 约 3 倍、alpha 快速亮起后按 (1−n)^1.25 缓退，带一
            // 点燃闪微颤；整片余迹是断续的光团链而非实线，读作
            // 「烟似的光迹」，压在流星本体之下
            for (const wk of curtainWakes) {
              const wn = wk.age / wk.life;
              const wa =
                Math.min(1, wn / 0.08) *
                Math.pow(1 - wn, 1.25) *
                0.5 *
                (0.85 + 0.15 * Math.sin(curtainTime * 17 + wk.ph * 3));
              if (wa < 0.01) continue;
              const ws = wk.r0 * 2 * (1 + wn * 2.1);
              curtainCtx.globalAlpha = wa;
              curtainCtx.drawImage(
                wakeSprite,
                wk.x - ws / 2,
                wk.y - ws / 2,
                ws,
                ws,
              );
            }
            curtainCtx.globalAlpha = 1;
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
                env * (m.cls === 0 ? 0.92 : 1) * flick,
              );
              // 拖尾渐变（00:08 变体定版）：按这颗星的档位取生成
              // 时预抖的停点——芯白 → 头微染 → 尾段色 → 透明渐
              // 隐；各阶级共用本档渐变，形态分化在轨层选择与
              // 头部画法上（见下）
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
              // —— 2026-11-16 晚形态分化（用户令「特效和形状要
              // 和其他的有区别、蓝绿色也是」）：普通/明亮保持
              // 四层柔尾作全幕基准不动；火流星与蓝绿各走自己的
              // 形态语言，与基准一眼可分——
              // · 火流星：废掉光滑长尾，只留一条压淡的底光 + 一
              //   条细芯，其上断续排 8 团抖动火焰团（wakeSprite
              //   小盖印、垂直轨向正弦抖动、向尾渐小渐淡）——
              //   尾是「一团团火」，不是「一条光带」；飞行中的
              //   火焰团链与落地后的持久余迹（curtainWakes）同
              //   精灵不同寿数，前者随星走、后者留在原地
              // · 蓝绿：针形——只留收束的两层细轨（薄鞘 + 芯
              //   线），不铺宽晕、不散开，快慢已回普通档、靠
              //   「细、直、锐」立身份
              if (m.cls === 3) {
                drawTail(m.w * 1.5, 0.9, 1, 0.55);
                drawTail(m.w * 0.62, 1.1, 1, 1);
              } else if (m.cls === 2) {
                drawTail(m.w * 2.6, 0.6, 1, 0.16);
                drawTail(m.w * 0.55, 1.0, 0.8, 0.85);
                const puffs = 8;
                for (let k = 1; k <= puffs; k++) {
                  const t = k / (puffs + 1);
                  const jx =
                    Math.sin(curtainTime * 26 + m.ph * 3 + k * 1.9) *
                    (2 + t * 5);
                  const cxp = hx - ux * tl * t + px * jx;
                  const cyp = hy - uy * tl * t + py * jx;
                  const ps =
                    (30 - t * 16) *
                    (0.8 +
                      0.25 *
                        Math.sin(curtainTime * 31 + m.ph + k * 2.7));
                  curtainCtx.globalAlpha = headA * 0.5 * (1 - t * 0.75);
                  curtainCtx.drawImage(
                    wakeSprite,
                    cxp - ps / 2,
                    cyp - ps / 2,
                    ps,
                    ps,
                  );
                }
                curtainCtx.globalAlpha = 1;
              } else {
                drawTail(m.w * 3.6, 0.62, 1, 0.2);
                drawTail(m.w * 2.1, 0.72, 1, 0.5);
                drawTail(m.w * 1.15, 0.85, 1, 0.78);
                drawTail(m.w * 0.5, 1.05, 0.8, 1);
              }
              // 头：先盖按档预渲染柔光晕，其上按阶级分形态——
              // · 普通/明亮：星芒爆点（卡图签名）——外层本档
              //   halo 色四角长芒 + 四条 45° 斜细芒，内层近白
              //   四角星收一档，最后压一枚纯白小核（基准形态，
              //   不动）
              // · 火流星：不规则火球——9 顶点多边形、每顶点半
              //   径被两频正弦逐帧抖动（边缘翻滚感），外焰橙 /
              //   中焰亮橙 / 白炽芯三层同心叠；头后拖两枚更小
              //   的抖动火团（贴身翻滚的碎焰）。无星芒——与
              //   「干净星芒头」一眼可分
              // · 蓝绿：针头——一枚 halo 色紧致小光斑 + 纯白极
              //   小核，无星芒、无斜芒，小而紧
              // 盖印尺寸 2026-11-16 晚修订：火流星 118→56px
              // （与明亮 68 / 普通 42 同量级——用户令「火流星
              // 不用这么大」；金星级指的是亮度强度：头光 alpha
              // 与芯光不降、只收个头）；蓝绿 48→30px（针头小
              // 而紧）
              const gs =
                (m.cls === 2 ? 56 : m.cls === 1 ? 68 : m.cls === 3 ? 30 : 42) *
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
              if (m.cls === 2) {
                // —— 火流星火球头：不规则抖动多边形三层叠（外
                // 焰 / 中焰 / 白炽芯）+ 头后两枚贴身碎焰团；顶
                // 点半径两频正弦逐帧抖动 → 边缘恒在翻滚，无一
                // 帧与上一帧同形
                const blob = (
                  cxp: number,
                  cyp: number,
                  R: number,
                  seed: number,
                  fill: string,
                ): void => {
                  curtainCtx.fillStyle = fill;
                  curtainCtx.beginPath();
                  const NV = 9;
                  for (let vi = 0; vi < NV; vi++) {
                    const a = (vi / NV) * Math.PI * 2;
                    const rr =
                      R *
                      (1 +
                        0.26 *
                          Math.sin(
                            curtainTime * 21 + m.ph * 3 + seed + vi * 2.4,
                          ) +
                        0.16 *
                          Math.sin(
                            curtainTime * 33 + m.ph * 1.3 + seed * 2 + vi * 4.1,
                          ));
                    const vx2 = cxp + Math.cos(a) * rr;
                    const vy2 = cyp + Math.sin(a) * rr;
                    if (vi === 0) curtainCtx.moveTo(vx2, vy2);
                    else curtainCtx.lineTo(vx2, vy2);
                  }
                  curtainCtx.closePath();
                  curtainCtx.fill();
                };
                for (let bi = 2; bi >= 1; bi--) {
                  const bx2 = hx - ux * m.w * 2.6 * bi;
                  const by2 = hy - uy * m.w * 2.6 * bi;
                  const jxp =
                    Math.sin(curtainTime * 24 + m.ph + bi * 2.2) * 2.4;
                  const jyp =
                    Math.cos(curtainTime * 27 + m.ph * 1.4 + bi * 1.7) * 2.4;
                  blob(
                    bx2 + px * jxp,
                    by2 + py * jxp + jyp * 0.4,
                    m.w * (bi === 2 ? 1.05 : 1.5),
                    bi * 3.7,
                    `rgba(240,84,26,${headA * (bi === 2 ? 0.4 : 0.55)})`,
                  );
                }
                blob(
                  hx,
                  hy,
                  m.w * 3.3,
                  0,
                  `rgba(240,84,26,${headA * 0.75})`,
                );
                blob(
                  hx,
                  hy,
                  m.w * 2.1,
                  5.1,
                  `rgba(255,166,66,${headA * 0.9})`,
                );
                blob(hx, hy, m.w * 1.2, 9.3, `rgba(255,246,224,${headA})`);
              } else if (m.cls === 3) {
                // —— 蓝绿针头：紧致小光斑 + 极小白核，无星芒
                curtainCtx.fillStyle = `rgba(${haloRgb},${headA * 0.75})`;
                curtainCtx.beginPath();
                curtainCtx.arc(hx, hy, Math.max(2.6, m.w * 2), 0, Math.PI * 2);
                curtainCtx.fill();
                curtainCtx.fillStyle = `rgba(255,255,255,${headA})`;
                curtainCtx.beginPath();
                curtainCtx.arc(
                  hx,
                  hy,
                  Math.max(1.4, m.w * 1.05),
                  0,
                  Math.PI * 2,
                );
                curtainCtx.fill();
              } else {
                const bR = (m.cls === 1 ? 34 : 22) * (0.92 + 0.16 * (flick - 1));
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
        const boardFade = sunFade * (1 - eG);
        // 全览整组隐藏（2026-11-15 用户点名口径：太阳系背景
        // 八星——冬/夏大三角 + 天鹅座β + 角宿一——在全览模
        // 式整组收起，星体/连线/名签一并淡出；默认近距模式
        // 按现行季节权重逻辑正常体现。zodiacFigK 即全览在
        // 位系数（与上方太阳系帧段同一份状态），故模式淡变
        // = boardFade × (1 − zodiacFigK)，与骨架图形的淡入
        // 严格互补、同拍交叉。角宿一名签的季节常驻破例只
        // 管季节口径、不对抗模式口径——全览里同样收起）
        const starModeFade = boardFade * (1 - zodiacFigK);
        starBoard.visible = boardFade > 0.02 && eG < 0.05;
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
            if (target > 0 && starModeFade > 0.05) {
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
            // 全览在位时目标恒 0（随 zodiacFigK 平滑收起，
            // 彗星名卡的八星障碍矩形读同一份 labelFadeT、全
            // 览里自动不再占位）
            ns.labelFadeT = target * (1 - zodiacFigK);
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
          // 幅度（提亮轮 2026-11-16 再改，元灿：「亮度要
          // 调很高」）：细芒轮的 ±22% 在旧低基线上压得看
          // 不见——本轮在新高基线（加色混合 + 透明度全
          // 额，见下方 vis/opacity 注）上恢复可辨呼吸：
          // twAmp = 0.38×clamp((wgt−0.25)/0.55)：满权重
          // 亮度 ±38%、仍随权重缩放、<0.25 不闪；芒长随
          // 亮度作等比 ±10% 呼吸（下方 vis 处注），不再
          // 纵横异幅拉伸。只动星芒本体（名签/连线不闪）；
          // 天狼星额外带极轻微色温微闪，其余星不动色。
          // opacity 以 1 封顶防峰值削平。
          const twAmp =
            0.38 * THREE.MathUtils.clamp((wgt - 0.25) / 0.55, 0, 1);
          let tw = 1;
          let twS = 0;
          if (twAmp > 0.001) {
            twS = Math.sin(
              (2 * Math.PI * t) / ns.twPeriod + ns.twPhase,
            );
            tw = 1 + twAmp * twS;
          }
          // 非当令退微光：星点尚在，不当令不消失（模式淡
          // 变 starModeFade：全览整组收起、近距原样）；
          // 提亮轮地板 0.15 → 0.35——八颗同为近览地标，
          // 淡季一组也须一眼可辨，季节只拉开明暗座次、
          // 不再把一组压回微光
          const vis = starModeFade * (0.35 + 0.65 * wgt) * tw;
          // 提亮轮落数（2026-11-16，元灿：「亮度要调
          // 很高」）：主星芒透明度系数 0.96 → 1.00 全额、
          // 外层柔光晕 0.30 → 0.85，两槽均已改加色混合
          // （见 addNamedStar 处注）——当令满权重星的芯/
          // 芒有效亮度约为细芒轮的 2.5–3 倍、晕约 4 倍
          // （加色叠加增益另计）；闪烁 = 亮度（vis 内的
          // tw，满权重 ±38%）+ 芒长等比呼吸（主芒
          // ×(1+0.10·(tw−1))、晕 ×(1+0.07·(tw−1))，横
          // 竖同幅——十字芒不许被拉成纵长贴纸）。周期/
          // 相位逐星定表不变（STAR_TW_TABLE），各星相
          // 位独立、不许整组同频
          // 光晕收小轮（同日，元灿：「光晕小一些」）：晕
          // 尺寸已收至 STAR_GLOW_K（见该常量处注），本处
          // 透明度系数随之略降 0.85 → 0.72——收的是晕的
          // 占幅与面密度，芯/芒透明度（下方 coreMat 一
          // 行）与闪烁幅度一字不动
          ns.glowMat.opacity = Math.min(1, 0.72 * ns.base * vis);
          ns.coreMat.opacity = Math.min(1, ns.base * vis);
          const twP = tw - 1;
          ns.glow.scale.set(
            ns.glowBase * (1 + twP * 0.07),
            ns.glowBase * (1 + twP * 0.07),
            1,
          );
          ns.core.scale.set(
            ns.coreScaleBase * (1 + twP * 0.1),
            ns.coreScaleBase * (1 + twP * 0.1),
            1,
          );
          if (ns.sirius) {
            ns.coreMat.color
              .copy(ns.coreBase)
              .lerp(
                siriusBlue,
                (0.5 + 0.5 * twS) * 0.4 * (twAmp / 0.38),
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
            const lo = starModeFade * ns.labelFade;
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
        winterTri.mat.opacity = 0.32 * starWeights.winter * starModeFade;
        summerTri.mat.opacity = 0.32 * starWeights.summer * starModeFade;
      }

      // —— 具名彗星名卡（哈雷/恩克/潘斯达斯/艾森/坦普尔–塔特
      // 尔）：与八星名卡
      // 同层同纪律——starLabelLayer 最高层级、不让位任何数据标
      // 签；逐帧直锚彗头世界投影（彗星在 solarGroup 内、组带旋
      // 转/缩放/平移，必须经 matrixWorld 转世界坐标，不许拿本地
      // 坐标冒充）；背面/离屏剔除时 transform 归零停泊（横向出
      // 界纪律同八星段）；贴边翻转整卡留屏内。互避每 6 帧判定：
      // 八星已落位卡面作固定障碍、五张彗星卡之间按优先级扇开
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
              ? nc.fadeNow * (0.45 + 0.55 * nc.act) * (1 - eG)
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
      schedStats.frames++;
      if (disposed) cancelAnimationFrame(raf);
    };

    // —— 离屏暂停：观测与启停（调度安全网）——
    // 观测对象 = 挂载容器（WebGL 画布与覆盖层的直接容器，即实
    // 际渲染面）。离开视口（intersectionRatio 归零）持续 250ms
    // 才停循环：模式浮层展开/收起的布局切换、滚动回弹都会产生
    // 瞬时离屏读数，防抖窗口把它们滤掉，进出模式不产生暂停抖
    // 动；定时器触发时再查一次模式态——太阳系/银河浮层激活期
    // 间（画布整屏在位）绝不暂停。恢复无防抖：回到视口立即重
    // 启循环，首帧按绝对时间追平（见 animate 头部）。数据获取
    // 与 App 侧状态更新不经过本循环，暂停期间照常进行，恢复
    // 帧读到的即最新数据。
    const pauseLoop = (): void => {
      if (disposed || renderPaused) return;
      if (stateRef.current.solarSystem || stateRef.current.galaxy) return;
      renderPaused = true;
      schedStats.paused = true;
      schedStats.framesAtPauseStart = schedStats.frames;
      cancelAnimationFrame(raf);
    };
    const resumeLoop = (): void => {
      if (disposed || !renderPaused) return;
      renderPaused = false;
      schedStats.paused = false;
      // 离屏帧数口径：暂停期间渲染帧数 = 恢复点 frames − 暂停点
      // frames（循环已停，恒为 0；此读数即验收计数）
      schedStats.framesWhilePaused =
        schedStats.frames - schedStats.framesAtPauseStart;
      raf = requestAnimationFrame(animate);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (td.pauseTimer !== null) {
              clearTimeout(td.pauseTimer);
              td.pauseTimer = null;
            }
            resumeLoop();
          } else if (!renderPaused && td.pauseTimer === null) {
            td.pauseTimer = window.setTimeout(() => {
              td.pauseTimer = null;
              pauseLoop();
            }, 250);
          }
        }
      },
      { threshold: 0 },
    );
    td.io = io;
    io.observe(mount);
    schedStats.buildMs = performance.now() - buildT0;
    if (!renderPaused) animate();
      } catch (e) {
        // 建场中途卸载：分片器抛 BuildAbort 静默收场（资源清理
        // 走 effect 作用域的 teardown 槽）；其余异常照常上抛
        if (!(e instanceof BuildAbort)) throw e;
      }
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (td.pauseTimer !== null) {
        clearTimeout(td.pauseTimer);
        td.pauseTimer = null;
      }
      td.io?.disconnect();
      td.ro?.disconnect();
      if (td.el && td.handlers) {
        td.el.removeEventListener("pointerdown", td.handlers.down);
        td.el.removeEventListener("pointermove", td.handlers.move);
        td.el.removeEventListener("pointerup", td.handlers.up);
        td.el.removeEventListener("pointercancel", td.handlers.cancel);
        td.el.removeEventListener("wheel", td.handlers.wheel);
        td.el.removeEventListener("touchstart", td.handlers.touchStart);
        td.el.removeEventListener("touchmove", td.handlers.touchMove);
        td.el.removeEventListener("touchend", td.handlers.touchEnd);
        td.el.removeEventListener("touchcancel", td.handlers.touchCancel);
      }
      td.renderer?.dispose();
      if (td.el && td.el.parentElement === mount) mount.removeChild(td.el);
      if (td.curtain && td.curtain.parentElement === mount) {
        mount.removeChild(td.curtain);
      }
      td.scene?.traverse((obj) => {
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
