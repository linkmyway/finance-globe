// 全球主要海底光缆精选（策展值，非全量）——慢变量，不进每日刷新。
// 参数口径：全长/设计容量/投产年份/业主以 TeleGeography、运营商与
// 财团公告为准（2026-11-10 核订，逐条来源见 DATA-PLAN）；查不到的
// 容量写 null，页面渲染为「未查到」，绝不估算。状态层（公开故障
// 记录 + IODA 国家级中断信号）在服务端 cables 区块里，与本表按
// id 对应；本表自身的 status 是建设状态（在役/分段投产）。

/**
 * 登陆大区（一条缆可登陆多个大区，筛选时在每个登陆大区下都出现）。
 * oceania 只作数据标注：现有精选里没有纯大洋洲的缆，筛选钮不设
 * 大洋洲（用户口径）；Hawaiki 等经大洋洲登陆点的如实标注。
 */
export type CableContinent =
  | "asia"
  | "americas"
  | "europe"
  | "africa"
  | "oceania";

export interface CableInfo {
  id: string;
  name: string;
  continents: CableContinent[];
  /** 是否登陆日本（千叶/三重/志摩等）——与用户最相关，置顶分组 */
  jp: boolean;
  /** 连接示意：两端 + 主要中途点 */
  route: string;
  km: string;
  tbps: string | null;
  year: string;
  owners: string;
  status: "在役" | "在役（分段投产）";
}

/**
 * 光缆状态分档（与主页光缆板块徽标同一口径、同一数据源：服务端
 * cables 区块的公开故障记录）。无记录 = ok「未见异常报告」（不是
 * 健康证明）；有记录且已修复 = watch（观察档，板块显示琥珀色
 * 「有公开故障记录（已修复）」）；有记录且未修复 = fault（红档）。
 * 地球仪光带颜色与本分档同步：板块变色，球上必须同色。
 */
export type CableTier = "fault" | "watch" | "ok";

export interface CableStatusInfo {
  tier: CableTier;
  /** 与板块徽标逐字相同的状态文案 */
  label: string;
}

export function cableStatusFor(
  incident: { status: string } | null | undefined,
): CableStatusInfo {
  if (!incident) return { tier: "ok", label: "未见异常报告" };
  if (incident.status.includes("已修复")) {
    return {
      tier: "watch",
      label: `有公开故障记录（${incident.status}）`,
    };
  }
  return { tier: "fault", label: `已报告故障（${incident.status}）` };
}

/**
 * 地球仪光带走向（[纬度, 经度]）：按上方 route 的两端 + 主要中途
 * 登陆点落的示意折线，渲染时逐段按大圆贴球面走（非两点直连、
 * 非精确路由——运营商不公开精确路径）。分支缆（Grace Hopper 的
 * 英国支线、PEACE 的肯尼亚支线等）只画主干，登陆点取主干点。
 */
export const CABLE_ROUTES: Record<string, Array<[number, number]>> = {
  faster: [
    [35.0, 140.3], [34, 150], [32, 168], [33, -178], [36, -160],
    [40, -142], [43.1, -124.4],
  ],
  jupiter: [
    [35.0, 140.3], [30, 134], [20, 126], [14.1, 123.0], [15, 135],
    [24, 155], [30, 175], [33, -165], [34, -140], [33.86, -118.4],
  ],
  ncp: [
    [31.0, 121.9], [34, 127.5], [35.1, 129.1], [28, 123], [25.3, 121.9],
    [30, 130], [35.0, 140.3], [36, 152], [38, 168], [40, -178],
    [42, -158], [44, -138], [45.6, -123.9],
  ],
  "sea-us": [
    [-6.0, 106.8], [0, 112], [18.4, 121.5], [20, 128], [13.4, 144.7],
    [18, 155], [21.5, -158.0], [30, -140], [33.7, -118.4],
  ],
  hawaiki: [
    [-33.9, 151.3], [-36, 168], [-36.1, 174.6], [-30, -178], [-22, -168],
    [21.3, -157.8], [30, -145], [43.3, -124.2],
  ],
  bifrost: [
    [1.35, 103.8], [4, 112], [-2, 118], [6, 126], [13, 133],
    [13.4, 144.7], [20, 158], [28, 175], [34, -165], [36, -145],
    [35.1, -120.6],
  ],
  echo: [
    [40.8, -124.2], [36, -135], [28, -150], [20, -165], [13.4, 144.7],
    [10, 138], [5, 125], [1.35, 103.8],
  ],
  aag: [
    [3.8, 103.3], [1.35, 103.8], [8, 107], [10.35, 107.1], [22.2, 114.2],
    [16, 120.3], [18, 128], [13.4, 144.7], [17, 155], [21.5, -158.0],
    [28, -145], [35.2, -120.9],
  ],
  apricot: [
    [34.3, 136.8], [28, 128], [25.0, 121.9], [21, 130], [16, 140],
    [13.4, 144.7], [14, 132], [16, 122], [10, 118], [-2, 112],
    [1.35, 103.8],
  ],
  apg: [
    [31.0, 121.9], [25, 119], [22.2, 114.2], [23, 119.5], [28, 127],
    [33, 133], [35.0, 140.3], [36, 133], [38, 127], [35.1, 129.1],
    [30, 124], [22, 116], [16, 110], [8, 106], [3, 104], [1.35, 103.8],
  ],
  sjc: [
    [35.0, 140.3], [28, 128], [22.2, 114.2], [23.4, 116.7], [15, 114],
    [5, 115], [10, 118], [14, 120.5], [8, 112], [1.35, 103.8],
  ],
  "eac-c2c": [
    [35.0, 140.3], [36, 131], [35.1, 129.1], [33, 124], [31.0, 121.9],
    [27, 121], [25.0, 121.9], [22.2, 114.2], [15, 110], [6, 106],
    [1.35, 103.8], [8, 110], [16, 114], [22, 118], [28, 124], [34, 136],
  ],
  marea: [
    [36.85, -75.98], [38, -65], [40, -50], [42, -35], [44, -22],
    [45, -12], [43.4, -2.98],
  ],
  dunant: [
    [36.85, -75.98], [40, -60], [42, -45], [44, -30], [46, -18],
    [47.5, -8], [46.7, -1.95],
  ],
  "grace-hopper": [
    [40.8, -72.87], [43, -52], [45, -38], [48, -24], [50, -13],
    [50.8, -4.55], [49, -8], [46, -6], [43.4, -2.98],
  ],
  equiano: [
    [38.44, -9.1], [30, -13], [20, -17], [12, -16], [6.14, 1.22],
    [6.45, 3.4], [0, -2], [-8, 10], [-18, 11.5], [-28, 15],
    [-34.8, 18.4],
  ],
  "2africa": [
    [50.8, -4.55], [46, -7], [38.7, -9.4], [36, -6], [38, 0],
    [41.3, 2.1], [43.3, 5.4], [40, 10], [37, 11], [31.2, 29.9],
    [27, 34], [22, 38], [15, 42], [11.6, 43.1], [10, 48],
    [-4.05, 39.67], [-12, 42], [-19, 35], [-34.8, 18.4], [-28, 15],
    [-13, 12], [6.45, 3.4], [5.6, -0.2], [14.7, -17.4], [22, -17],
    [33, -8.5], [36, -9],
  ],
  peace: [
    [24.86, 67.0], [16, 55], [11.6, 43.3], [18, 40], [27, 34.5],
    [29.1, 32.65], [33, 33.5], [35.1, 33.4], [38, 22], [41, 12],
    [43.3, 5.4],
  ],
  aae1: [
    [22.2, 114.2], [16, 110], [10.35, 107.1], [8, 104], [1.35, 103.8],
    [6, 95], [10, 80], [12, 68], [24.86, 67.0], [23.6, 58],
    [11.6, 43.1], [22, 38], [28, 34], [29.9, 32.5], [35.3, 23.5],
    [41.1, 16.9], [43.3, 5.4],
  ],
  monet: [
    [26.4, -80.1], [22, -72], [15, -55], [8, -42], [-3.7, -38.5],
    [-12, -38], [-24.0, -46.3],
  ],
  curie: [
    [33.9, -118.4], [28, -112], [20, -105], [8.95, -79.56], [2, -82],
    [-8, -78], [-33.0, -71.6],
  ],
};

/** 登陆点（地球仪上的小点）：每条缆的两端 + 主要中途登陆点 */
export const CABLE_LANDINGS: Record<string, Array<[number, number]>> = {
  faster: [[35.0, 140.3], [43.1, -124.4]],
  jupiter: [[35.0, 140.3], [34.3, 136.8], [14.1, 123.0], [33.86, -118.4]],
  ncp: [[31.0, 121.9], [35.1, 129.1], [25.3, 121.9], [35.0, 140.3], [45.6, -123.9]],
  "sea-us": [[-6.0, 106.8], [18.4, 121.5], [13.4, 144.7], [21.5, -158.0], [33.7, -118.4]],
  hawaiki: [[-33.9, 151.3], [-36.1, 174.6], [21.3, -157.8], [43.3, -124.2]],
  bifrost: [[1.35, 103.8], [13.4, 144.7], [35.1, -120.6]],
  echo: [[40.8, -124.2], [13.4, 144.7], [1.35, 103.8]],
  aag: [[3.8, 103.3], [1.35, 103.8], [10.35, 107.1], [22.2, 114.2], [13.4, 144.7], [21.5, -158.0], [35.2, -120.9]],
  apricot: [[34.3, 136.8], [25.0, 121.9], [13.4, 144.7], [1.35, 103.8]],
  apg: [[31.0, 121.9], [22.2, 114.2], [35.0, 140.3], [35.1, 129.1], [1.35, 103.8]],
  sjc: [[35.0, 140.3], [22.2, 114.2], [23.4, 116.7], [5, 115], [1.35, 103.8]],
  "eac-c2c": [[35.0, 140.3], [35.1, 129.1], [31.0, 121.9], [25.0, 121.9], [22.2, 114.2], [1.35, 103.8]],
  marea: [[36.85, -75.98], [43.4, -2.98]],
  dunant: [[36.85, -75.98], [46.7, -1.95]],
  "grace-hopper": [[40.8, -72.87], [50.8, -4.55], [43.4, -2.98]],
  equiano: [[38.44, -9.1], [6.14, 1.22], [6.45, 3.4], [-34.8, 18.4]],
  "2africa": [[50.8, -4.55], [38.7, -9.4], [41.3, 2.1], [43.3, 5.4], [31.2, 29.9], [11.6, 43.1], [-4.05, 39.67], [-34.8, 18.4], [6.45, 3.4], [14.7, -17.4]],
  peace: [[24.86, 67.0], [11.6, 43.3], [29.1, 32.65], [35.1, 33.4], [43.3, 5.4]],
  aae1: [[22.2, 114.2], [10.35, 107.1], [1.35, 103.8], [10, 80], [24.86, 67.0], [11.6, 43.1], [29.9, 32.5], [43.3, 5.4]],
  monet: [[26.4, -80.1], [-3.7, -38.5], [-24.0, -46.3]],
  curie: [[33.9, -118.4], [8.95, -79.56], [-33.0, -71.6]],
};

export const CABLE_CONTINENT_LABEL: Record<
  CableContinent | "all" | "jp",
  string
> = {
  all: "全部",
  jp: "日本",
  asia: "亚洲",
  americas: "美洲",
  europe: "欧洲",
  africa: "非洲",
  oceania: "大洋洲",
};

export const CABLES: CableInfo[] = [
  {
    id: "faster",
    name: "FASTER",
    continents: ["asia", "americas"],
    jp: true,
    route: "日本·千叶/三重 — 美国·俄勒冈（班登）",
    km: "11,629",
    tbps: "60",
    year: "2016",
    owners: "Google、KDDI、中国移动、中国电信、Singtel、Global Transit",
    status: "在役",
  },
  {
    id: "jupiter",
    name: "JUPITER",
    continents: ["asia", "americas"],
    jp: true,
    route: "日本·千叶/三重 — 菲律宾 — 美国·加州（赫莫萨海滩）",
    km: "14,000",
    tbps: "60（初始设计）",
    year: "2020",
    owners: "NTT、SoftBank、PLDT、PCCW Global、Meta、Amazon",
    status: "在役",
  },
  {
    id: "ncp",
    name: "NCP（新跨太平洋）",
    continents: ["asia", "americas"],
    jp: true,
    route: "中国·上海 — 韩国 — 台湾 — 日本 — 美国·俄勒冈",
    km: "13,618",
    tbps: "80",
    year: "2018",
    owners: "微软、中国移动、中国电信、中国联通、中华电信、KT",
    status: "在役",
  },
  {
    id: "sea-us",
    name: "SEA-US",
    continents: ["asia", "oceania", "americas"],
    jp: false,
    route: "印度尼西亚 — 菲律宾 — 关岛 — 夏威夷 — 美国·洛杉矶",
    km: "约 15,000",
    tbps: "20",
    year: "2017",
    owners: "Telin、PLDT、Globe、RTI 等财团",
    status: "在役",
  },
  {
    id: "hawaiki",
    name: "Hawaiki",
    continents: ["oceania", "americas"],
    jp: false,
    route: "澳大利亚·悉尼 — 新西兰 — 夏威夷 — 美国·俄勒冈",
    km: "15,000",
    tbps: "43.8",
    year: "2018",
    owners: "BW Digital",
    status: "在役",
  },
  {
    id: "bifrost",
    name: "Bifrost",
    continents: ["asia", "oceania", "americas"],
    jp: false,
    route: "新加坡 — 印度尼西亚 — 菲律宾 — 关岛 — 美国·加州",
    km: "20,000+",
    tbps: "260",
    year: "2025",
    owners: "Meta、Keppel、Telin",
    status: "在役",
  },
  {
    id: "echo",
    name: "Echo",
    continents: ["americas", "oceania", "asia"],
    jp: false,
    route: "美国·加州（尤里卡） — 关岛 — 新加坡（全程规划）",
    km: "约 16,500",
    tbps: "260（已投产段）",
    year: "2024（首段）",
    owners: "Google、Meta",
    status: "在役（分段投产）",
  },
  {
    id: "aag",
    name: "AAG（亚美网关）",
    continents: ["asia", "oceania", "americas"],
    jp: false,
    route: "马来西亚 — 新加坡 — 越南 — 香港 — 菲律宾 — 关岛 — 夏威夷 — 美国",
    km: "20,000",
    tbps: "2.88",
    year: "2009",
    owners: "19 家运营商财团（PLDT、Singtel、Telstra 等）",
    status: "在役",
  },
  {
    id: "apricot",
    name: "Apricot",
    continents: ["asia", "oceania"],
    jp: true,
    route: "日本 — 台湾 — 关岛 — 菲律宾 — 印度尼西亚 — 新加坡",
    km: "约 12,000",
    tbps: "290",
    year: "2024（首段）",
    owners: "Google、Meta、NTT、中华电信、PLDT",
    status: "在役（分段投产）",
  },
  {
    id: "apg",
    name: "APG（亚太网关）",
    continents: ["asia"],
    jp: true,
    route: "中国 — 香港 — 台湾 — 日本 — 韩国 — 马来西亚 — 新加坡 等",
    km: "10,900",
    tbps: "54",
    year: "2016",
    owners: "Meta、微软、中国电信、NTT、KT 等财团",
    status: "在役",
  },
  {
    id: "sjc",
    name: "SJC（东南亚—日本）",
    continents: ["asia"],
    jp: true,
    route: "日本 — 香港 — 中国 — 文莱 — 菲律宾 — 新加坡",
    km: "8,900",
    tbps: "28",
    year: "2013",
    owners: "Google、中国移动、Singtel、Globe 等财团",
    status: "在役",
  },
  {
    id: "eac-c2c",
    name: "EAC-C2C",
    continents: ["asia"],
    jp: true,
    route: "东亚环网（日本 — 韩国 — 中国 — 台湾 — 香港 — 新加坡）",
    km: "36,800",
    tbps: null,
    year: "2002",
    owners: "Telstra",
    status: "在役",
  },
  {
    id: "marea",
    name: "MAREA",
    continents: ["americas", "europe"],
    jp: false,
    route: "美国·弗吉尼亚海滩 — 西班牙·毕尔巴鄂",
    km: "6,605",
    tbps: "200",
    year: "2018",
    owners: "Meta、微软、Telxius",
    status: "在役",
  },
  {
    id: "dunant",
    name: "Dunant",
    continents: ["americas", "europe"],
    jp: false,
    route: "美国·弗吉尼亚海滩 — 法国·圣伊莱尔德列兹",
    km: "6,400",
    tbps: "250",
    year: "2021",
    owners: "Google",
    status: "在役",
  },
  {
    id: "grace-hopper",
    name: "Grace Hopper",
    continents: ["americas", "europe"],
    jp: false,
    route: "美国·纽约 — 英国·布德 / 西班牙·毕尔巴鄂",
    km: "约 6,300",
    tbps: "350",
    year: "2022",
    owners: "Google",
    status: "在役",
  },
  {
    id: "equiano",
    name: "Equiano",
    continents: ["europe", "africa"],
    jp: false,
    route: "葡萄牙 — 多哥 — 尼日利亚 — 纳米比亚 — 南非",
    km: "15,000",
    tbps: "144",
    year: "2022",
    owners: "Google",
    status: "在役",
  },
  {
    id: "2africa",
    name: "2Africa",
    continents: ["africa", "europe", "asia"],
    jp: false,
    route: "环非洲 — 欧洲 — 中东 — 南亚（33 国 · 46 个登陆点）",
    km: "45,000（含 Pearls 延伸段）",
    tbps: "180（干线）",
    year: "2024（核心段 2025 年完工）",
    owners: "Meta、中国移动、Orange、Vodafone、MTN Bayobab、WIOCC 等",
    status: "在役（分段投产）",
  },
  {
    id: "peace",
    name: "PEACE",
    continents: ["asia", "africa", "europe"],
    jp: false,
    route: "巴基斯坦 — 肯尼亚 — 埃及 — 法国（经塞浦路斯）",
    km: "约 12,000",
    tbps: "192",
    year: "2022",
    owners: "PEACE Cable International",
    status: "在役",
  },
  {
    id: "aae1",
    name: "AAE-1（亚非欧一号）",
    continents: ["asia", "africa", "europe"],
    jp: false,
    route: "香港 — 越南 — 新加坡 — 巴基斯坦 — 埃及 — 法国/意大利 等",
    km: "25,000",
    tbps: "40",
    year: "2017",
    owners: "中国联通、PCCW、Viettel 等 19 家运营商",
    status: "在役",
  },
  {
    id: "monet",
    name: "Monet",
    continents: ["americas"],
    jp: false,
    route: "美国·佛州（博卡拉顿） — 巴西·福塔莱萨/桑托斯",
    km: "10,556",
    tbps: "64",
    year: "2018",
    owners: "Google、Angola Cables、Antel、Algar Telecom",
    status: "在役",
  },
  {
    id: "curie",
    name: "Curie",
    continents: ["americas"],
    jp: false,
    route: "美国·洛杉矶 — 巴拿马 — 智利·瓦尔帕莱索",
    km: "10,500",
    tbps: "72",
    year: "2019",
    owners: "Google",
    status: "在役",
  },
];
