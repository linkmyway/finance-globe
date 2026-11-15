// 十二宫 3D 水晶模型（元灿 2026-11-16 亲发分体包
// zodiac_12_separate_glb.zip 施工）：12 个单宫 GLB、按宫序
// （白羊 0 … 双鱼 11，与 ZODIAC_SIGNS / ZODIAC_FIGS 同序）。
// 每宫 1 网格 2 图元（StarLight 星光件 + Crystal 元素色水晶
// 件、alphaMode BLEND 普通 alpha 混合、无贴图），总载荷
// 689,460 字节。字节由构建管线作文件资产发出（Bun file
// loader），本表只登记 URL，落位/朝向/材质口径在 Globe.tsx
// 的 zodiacModel 构建段。
import aries from "./assets/zodiac/01_Aries.glb";
import taurus from "./assets/zodiac/02_Taurus.glb";
import gemini from "./assets/zodiac/03_Gemini.glb";
import cancer from "./assets/zodiac/04_Cancer.glb";
import leo from "./assets/zodiac/05_Leo.glb";
import virgo from "./assets/zodiac/06_Virgo.glb";
import libra from "./assets/zodiac/07_Libra.glb";
import scorpius from "./assets/zodiac/08_Scorpius.glb";
import sagittarius from "./assets/zodiac/09_Sagittarius.glb";
import capricornus from "./assets/zodiac/10_Capricornus.glb";
import aquarius from "./assets/zodiac/11_Aquarius.glb";
import pisces from "./assets/zodiac/12_Pisces.glb";

export const ZODIAC_MODEL_URLS: string[] = [
  aries,
  taurus,
  gemini,
  cancer,
  leo,
  virgo,
  libra,
  scorpius,
  sagittarius,
  capricornus,
  aquarius,
  pisces,
];
