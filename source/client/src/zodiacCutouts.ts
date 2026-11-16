// 十二宫抠图（2026-11-16 元灿工单「你要把星座本体抠出
// 来呀，不要整张图贴在那」）：元灿亲发《十二星座》海报
// PDF 的单宫卡经抠图后的透明底单体图——只有星座本体＋
// 自带辉光，无卡底、无宫名/元素/日期文字。场景版 700 px
// 宽 RGBA PNG（约 214–437 KB/张），全分辨率版存
// ~/workspace/zodiac-images/cutouts/，场景不用。
// 按宫序（白羊 0 … 双鱼 11，与 ZODIAC_SIGNS 同序）。
// 图内水晶身体里的星线是原画自带的设计（海报自注「星
// 图连线 · 水晶星象」），不在删除范围。
// 落位/尺寸口径在 Globe.tsx 的 zodiacCutout 构建段：
// 最大边统一 2.0 世界单位、按各宫原始宽高比定另一边、
// 图心对格心。W/H 为源图像素尺寸（决定宽高比与落数）。
import aries from "./assets/zodiac-cutouts/01_aries.png";
import taurus from "./assets/zodiac-cutouts/02_taurus.png";
import gemini from "./assets/zodiac-cutouts/03_gemini.png";
import cancer from "./assets/zodiac-cutouts/04_cancer.png";
import leo from "./assets/zodiac-cutouts/05_leo.png";
import virgo from "./assets/zodiac-cutouts/06_virgo.png";
import libra from "./assets/zodiac-cutouts/07_libra.png";
import scorpius from "./assets/zodiac-cutouts/08_scorpius.png";
import sagittarius from "./assets/zodiac-cutouts/09_sagittarius.png";
import capricornus from "./assets/zodiac-cutouts/10_capricornus.png";
import aquarius from "./assets/zodiac-cutouts/11_aquarius.png";
import pisces from "./assets/zodiac-cutouts/12_pisces.png";

export interface ZodiacCutout {
  url: string;
  /** 源图宽（px） */
  w: number;
  /** 源图高（px） */
  h: number;
}

export const ZODIAC_CUTOUTS: ZodiacCutout[] = [
  { url: aries, w: 700, h: 575 },
  { url: taurus, w: 700, h: 557 },
  { url: gemini, w: 700, h: 622 },
  { url: cancer, w: 700, h: 634 },
  { url: leo, w: 700, h: 610 },
  { url: virgo, w: 700, h: 508 },
  { url: libra, w: 700, h: 609 },
  { url: scorpius, w: 700, h: 616 },
  { url: sagittarius, w: 700, h: 527 },
  { url: capricornus, w: 700, h: 572 },
  { url: aquarius, w: 700, h: 551 },
  { url: pisces, w: 700, h: 595 },
];
