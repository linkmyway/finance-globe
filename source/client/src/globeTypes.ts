// Globe 共享类型（2026-11-13 第 1 档拆分·档一：自 Globe.tsx 原样抽出，
// 零行为变化）：监控三国代码、金融中心信息、指数板行数据。
// Globe.tsx 再导出这三个类型，App 的导入路径不变。

export type CountryCode = "US" | "CN" | "JP";

export interface CenterInfo {
  id: string;
  name: string;
  en: string;
  country: string;
  tier: 1 | 2 | 3;
  coreCountry?: CountryCode;
}

/** 地球上交易所指数板的一行数据（服务端 volatility.boards 快照） */
export interface IndexBoardInfo {
  /** 锚点 id：多为金融中心 id；szx=深圳、ndx=纽约第二板（纳斯达克
   * 100，与标普 500 双板）是板专用锚点 */
  id: string;
  /** 指数简称（如「日经 225」） */
  name: string;
  price: number | null;
  changePct: number | null;
  /** 开市状态（源数据交易时段推导）；null = 时段未知，不标休市 */
  open: boolean | null;
  /** 该板数值的真实日期（交易所时区 YYYY-MM-DD）：已收盘市场为其
   * 最近一个交易日；旧快照无此字段时为 null，板面不标日期 */
  asOf?: string | null;
}
