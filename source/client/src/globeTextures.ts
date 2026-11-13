// Globe 画布纹理/精灵工厂（2026-11-13 第 1 档拆分·档一：自 Globe.tsx
// 原样抽出，零行为变化）：辉光/圆点/地图/光圈纹理与城市标签、当地
// 时间、指数板精灵的构造器。全部无状态——每次调用新建画布与纹理，
// 不持有组件状态。

import * as THREE from "three";
import { COUNTRY_RINGS } from "./countryData";
import type { IndexBoardInfo } from "./globeTypes";

export function makeGlowTexture(inner: string, outer: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, outer);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeDotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  // 柔边小圆点：中心实、边缘缓缓淡出，避免大颗粒圆点的硬边锯齿感
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.32, "rgba(255,255,255,0.92)");
  grad.addColorStop(0.62, "rgba(255,255,255,0.42)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(32, 32, 32, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

/** 三个监控国在地图纹理上的填充色（ISO numeric id → 颜色，与节点配色一致） */
export const FOCUS_COUNTRY_FILL: Record<string, string> = {
  "840": "#38b6e3", // 美国（青蓝）
  "156": "#ff6b6b", // 中国（暖红）
  "392": "#ff9ec4", // 日本（粉樱）
};

/**
 * 真实地图纹理：Natural Earth 50m 国家多边形（countryData.ts）画到
 * 等距圆柱画布上作球体贴图——大陆是连续填充面、国界线可辨，
 * 美/中/日三国以各自配色高亮，不再只是同色点阵。
 * 球面 UV 对应关系（three.js SphereGeometry）：u=(lon+180)/360，
 * 画布左缘=-180°、上缘=90°N，与 latLonToVec3 的经纬约定一致，
 * 城市节点因此正落在各自海岸/国土上。
 * 跨日界线多边形（俄罗斯远东、阿拉斯加等）：环内经度先展开（unwrap），
 * 再以 -W/0/+W 三个横向偏移各画一遍，跨界部分从另一侧绕回。
 */
export function makeEarthTexture(maxAniso: number, width: number): THREE.Texture {
  const W = width;
  const H = width / 2;
  const sw = W / 4096; // 线宽/发光按纹理分辨率等比缩放，移动端细线不糊成团
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;

  // 海洋底：深蓝竖向渐变（极地略沉、赤道略亮）
  const ocean = g.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, "#081c38");
  ocean.addColorStop(0.5, "#0c2a52");
  ocean.addColorStop(1, "#081c38");
  g.fillStyle = ocean;
  g.fillRect(0, 0, W, H);

  const px = (lon: number) => ((lon + 180) / 360) * W;
  const py = (lat: number) => ((90 - lat) / 180) * H;

  const buildPath = (rings: number[][]): Path2D => {
    const path = new Path2D();
    for (const ring of rings) {
      const n = ring.length / 2;
      if (n < 2) continue;
      let prevLon = ring[0]!;
      let shift = 0;
      path.moveTo(px(prevLon), py(ring[1]!));
      for (let i = 1; i < n; i++) {
        const rawLon = ring[i * 2]!;
        const d = rawLon - prevLon;
        if (d > 180) shift -= 360;
        else if (d < -180) shift += 360;
        prevLon = rawLon;
        path.lineTo(px(rawLon + shift), py(ring[i * 2 + 1]!));
      }
      path.closePath();
    }
    return path;
  };

  const drawAll = (style: string, mode: "fill" | "stroke", width = 1) => {
    if (mode === "fill") g.fillStyle = style;
    else {
      g.strokeStyle = style;
      g.lineWidth = width;
      g.lineJoin = "round";
    }
    for (const country of COUNTRY_RINGS) {
      const path = buildPath(country.rings);
      for (const off of [-W, 0, W]) {
        g.save();
        g.translate(off, 0);
        if (mode === "fill") g.fill(path);
        else g.stroke(path);
        g.restore();
      }
    }
  };

  // 陆地填充：比海洋亮两档的钢蓝，整块大陆成面
  drawAll("#2a4f78", "fill");
  // 陆地内侧提亮一遍（同色低透明叠加，让陆地与点阵层之间有厚度感）
  g.globalAlpha = 0.35;
  drawAll("#3d6ea3", "fill");
  g.globalAlpha = 1;
  // 国界线
  drawAll("rgba(168,214,255,0.38)", "stroke", Math.max(0.7, 1.1 * sw));

  // 美/中/日高亮：配色半透明填充 + 同色描边 + 外发光
  for (const country of COUNTRY_RINGS) {
    const color = FOCUS_COUNTRY_FILL[country.id];
    if (!color) continue;
    const path = buildPath(country.rings);
    for (const off of [-W, 0, W]) {
      g.save();
      g.translate(off, 0);
      g.globalAlpha = 0.42;
      g.fillStyle = color;
      g.fill(path);
      g.globalAlpha = 1;
      g.shadowColor = color;
      g.shadowBlur = 16 * sw;
      g.strokeStyle = color;
      g.lineWidth = Math.max(1, 2.4 * sw);
      g.lineJoin = "round";
      g.stroke(path);
      g.restore();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, maxAniso);
  return tex;
}

export function makeRingTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 5;
  g.shadowColor = "rgba(255,255,255,0.8)";
  g.shadowBlur = 8;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.stroke();
  return new THREE.CanvasTexture(c);
}

export function makeLabelSprite(
  text: string,
  color: string,
  scale = 0.34,
  fontPx = 34,
  strong = false,
): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 72;
  const g = c.getContext("2d")!;
  g.font = `600 ${fontPx}px 'Noto Sans SC', system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  // 第一梯队标签加一层半透明深色底衬：即使压在其他标签或亮区之上也可读
  if (strong) {
    const tw = g.measureText(text).width;
    const bw = tw + 30;
    const bh = fontPx * 1.42;
    const x0 = 128 - bw / 2;
    const y0 = 38 - bh / 2;
    const r = 12;
    g.beginPath();
    g.moveTo(x0 + r, y0);
    g.lineTo(x0 + bw - r, y0);
    g.arcTo(x0 + bw, y0, x0 + bw, y0 + r, r);
    g.lineTo(x0 + bw, y0 + bh - r);
    g.arcTo(x0 + bw, y0 + bh, x0 + bw - r, y0 + bh, r);
    g.lineTo(x0 + r, y0 + bh);
    g.arcTo(x0, y0 + bh, x0, y0 + bh - r, r);
    g.lineTo(x0, y0 + r);
    g.arcTo(x0, y0, x0 + r, y0, r);
    g.closePath();
    g.fillStyle = "rgba(3,8,18,0.52)";
    g.fill();
    g.strokeStyle = "rgba(160,205,255,0.28)";
    g.lineWidth = 2;
    g.stroke();
  }
  // 极轻暗色描边：标签压在亮区（灯光/高亮国土）上也可读
  g.lineWidth = 7;
  g.lineJoin = "round";
  g.strokeStyle = "rgba(3,8,18,0.88)";
  g.strokeText(text, 128, 38);
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.fillStyle = "#eef6ff";
  g.fillText(text, 128, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale, scale * (72 / 256), 1);
  return sprite;
}

/**
 * 城市当地时间小标签：名称标签下方的一行 HH:MM，按城市 IANA 时区用
 * Intl 实时计算（与左上角东京时钟同一套浏览器时区库，含夏令时）。
 * 纹理只在分钟变化时重绘（update() 内部比对文本），逐帧零成本。
 */
export function makeTimeSprite(color: string, tz: string) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 60;
  const g = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  let last = "";
  const update = () => {
    let text: string;
    try {
      text = fmt.format(new Date());
    } catch {
      return;
    }
    if (text === last) return;
    last = text;
    g.clearRect(0, 0, 256, 60);
    g.font = "600 30px 'Noto Sans SC', system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 6;
    g.lineJoin = "round";
    g.strokeStyle = "rgba(3,8,18,0.88)";
    g.strokeText(text, 128, 31);
    g.shadowColor = color;
    g.shadowBlur = 8;
    g.fillStyle = "#cfe4fb";
    g.fillText(text, 128, 31);
    tex.needsUpdate = true;
  };
  update();
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.26, 0.26 * (60 / 256), 1);
  sprite.renderOrder = 9;
  return { sprite, update };
}

/**
 * 交易所迷你指数板：玻璃芯片（与第一梯队标签底衬同一设计语言的
 * 加深版），两行——简称（休市时带「· 休市」弱化小字）/ 点位 +
 * 当日涨跌幅（涨红跌绿，中国习惯，与全站 glow-up/glow-down 同
 * 色）。精灵贴在交易所所在城市的球面位置、随球自转，显隐/避让
 * 与城市标签同一套规则（见 animate 的统一避让池）。redraw 原地
 * 重画纹理：后台刷新换值时不新建精灵、不闪；无数据的板不进
 * 避让池、整板不出现（诚实缺省）。
 * 清晰度（2026-11-11 修）：画布按 2 倍超采样（768×288 实体像素、
 * 逻辑坐标仍 384×144 全程 setTransform 缩放绘制）+ 各向异性过滤
 * 拉满 16——旧版 384×144 写死位图在高分屏/斜视下发虚，是移动端
 * 板面模糊的主因；粗指针（移动端）另给放大补偿（其余标签元素
 * 都有、旧版独缺板）。
 * 尺寸沿革：桌面基准 0.335→0.27（2026-11-11，用户判板面偏大）。
 * 全场统一两行 + 再缩一档（2026-11-13，用户：「亚洲的交易所卡
 * 片还是回归其他地区交易所卡片的两行式样、位置准确一些、小一
 * 点」）：2026-11-11 起亚洲六板专用的紧凑单行芯片（单行排版、
 * 内容自适应宽、4 倍超采样）整套退役——亚洲六板与欧美五板同走
 * 本函数的两行全板，全场 11 板版式/字体/画布口径自此一致；尺
 * 寸取全场统一偏小档：桌面基准 0.27→0.24（移动端 ×1.15 补偿不
 * 变，实际 0.3105→0.276），欧美板随全场同缩（版式统一的前提
 * 下不留两套尺寸）。纹理超采样不变，缩小后单位面积像素密度反
 * 而更高，不回退清晰度；避让池按 sprite.scale 算框，自动跟随
 * 新尺寸。
 */
export function makeBoardSprite(
  maxAniso: number,
  coarse: boolean,
): {
  sprite: THREE.Sprite;
  redraw: (b: IndexBoardInfo | undefined) => void;
} {
  const ss = 2;
  const logicalW = 384;
  const logicalH = 144;
  const c = document.createElement("canvas");
  c.width = logicalW * ss;
  c.height = logicalH * ss;
  const g = c.getContext("2d")!;
  g.setTransform(ss, 0, 0, ss, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(16, maxAniso);
  let lastKey = "";
  const redraw = (b: IndexBoardInfo | undefined) => {
    const key = b
      ? `${b.name}|${b.price}|${b.changePct}|${b.open}|${b.asOf}`
      : "none";
    if (key === lastKey) return;
    lastKey = key;
    g.clearRect(0, 0, logicalW, logicalH);
    if (b) {
      const closed = b.open === false;
      g.save();
      if (closed) g.globalAlpha = 0.66;
      // 玻璃芯片本体
      g.beginPath();
      g.roundRect(6, 6, 372, 132, 20);
      g.fillStyle = "rgba(5,12,24,0.80)";
      g.fill();
      g.strokeStyle = "rgba(150,200,255,0.38)";
      g.lineWidth = 2;
      g.stroke();
      // 第一行：简称（+ 休市弱化小字）
      g.textBaseline = "middle";
      g.font = "600 29px 'Noto Sans SC', system-ui, sans-serif";
      g.fillStyle = "#c9dcf2";
      g.fillText(b.name, 26, 40);
      if (closed) {
        const nw = g.measureText(b.name).width;
        g.font = "500 24px 'Noto Sans SC', system-ui, sans-serif";
        g.fillStyle = "#8fa5c0";
        g.fillText("· 休市", 26 + nw + 10, 41);
      }
      // 第二行：点位 + 涨跌幅（涨红跌绿）。长点位（如深证成指
      // 11,344.78）+ 涨跌幅会超出芯片宽——先量后画，总宽超限时
      // 等比缩字号（下限 0.68），不许把涨跌幅挤出画布。
      if (b.price != null) {
        const priceText = b.price.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const pctText =
          b.changePct != null
            ? `${b.changePct >= 0 ? "▲" : "▼"}${Math.abs(b.changePct).toFixed(2)}%`
            : null;
        let pricePx = 44;
        let pctPx = 32;
        g.font = `700 ${pricePx}px 'Noto Sans SC', system-ui, sans-serif`;
        let pw = g.measureText(priceText).width;
        let pctW = 0;
        if (pctText) {
          g.font = `600 ${pctPx}px 'Noto Sans SC', system-ui, sans-serif`;
          pctW = g.measureText(pctText).width;
        }
        const total = pw + (pctText ? 16 + pctW : 0);
        const avail = 372 - 26;
        if (total > avail) {
          const k = Math.max(0.68, avail / total);
          pricePx = Math.floor(44 * k);
          pctPx = Math.floor(32 * k);
          g.font = `700 ${pricePx}px 'Noto Sans SC', system-ui, sans-serif`;
          pw = g.measureText(priceText).width;
        }
        g.font = `700 ${pricePx}px 'Noto Sans SC', system-ui, sans-serif`;
        g.fillStyle = "#f2f8ff";
        g.fillText(priceText, 26, 100);
        if (pctText && b.changePct != null) {
          g.font = `600 ${pctPx}px 'Noto Sans SC', system-ui, sans-serif`;
          g.fillStyle = b.changePct >= 0 ? "#ff6b6b" : "#3ddc97";
          g.fillText(pctText, 26 + pw + 16, 102);
        }
      } else {
        g.font = "700 44px 'Noto Sans SC', system-ui, sans-serif";
        g.fillStyle = "#8fa5c0";
        g.fillText("—", 26, 100);
      }
      g.restore();
    }
    tex.needsUpdate = true;
  };
  redraw(undefined);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const sprite = new THREE.Sprite(mat);
  const boardScale = 0.24 * (coarse ? 1.15 : 1);
  sprite.scale.set(boardScale, boardScale * (144 / 384), 1);
  sprite.renderOrder = 8;
  return { sprite, redraw };
}
