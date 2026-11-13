// 虾蛄星人父子（多佛恶魔 / 边新 + 奇克奇塔）纸片人素材 —— 与
// serpoArt.ts 同一路（官方图抠图做 billboard 精灵，私人空间自用）。
//
// 素材出处（2026-11-11 核清，全部官方视觉，零手绘、零自绘）：
//   - 父·正面：TV 动画《ダンダダン》官方角色页立绘
//     （https://anime-dandadan.com/character/ 的ドーバーデーモン条目，
//     damon_pc.png，官方图自带透明底）——亮黄肌肉身、黑泳裤式短裤、
//     红拳套（腕带「3510」）、黑领带、宽檐圆盘帽 + 双眼柄，与档案
//     （DATA-PLAN 虾蛄星人条目）逐项对得上。
//   - 子·正面：同页チキチータ条目立绘（chiquitita_pc.png，官方透明
//     底）——圆黄脸大眼、飞行员皮帽 + 风镜、蓝背带裤。
//   - 父·背离面：官方角色页无背面/侧面图，按赛伯星人的替补规则用
//     MegaHouse「オカルティックソフビコレクション ドーバーデー
//     モン」官方商品侧面照（纯侧面、拳击架势；经 Banpresto 西班牙
//     官方店同源图 fantopic 镜像取得）→ rembg(u2net) 抠图。
//   - 子·背离面：同系列チキチータ官方商品侧面照（Banpresto 西班牙
//     官方店 846182-5）→ rembg 抠图。
//   抠图后处理与赛伯同口径：最大连通域 → alpha 1px 腐蚀 → 0.7px
//   羽化 → 统一画布 360×460（人物高 428、鞋底 y=444），与纸片人
//   精灵的锚点/宽高比口径一致（见 Globe.tsx makePaperWalker）。
//   体型比例：父子在各自画布里同高归一，真实大小差由行走系统的
//   height 参数给出（子 ≈ 父 × 0.52；官方软胶父约 150mm 级、
//   子 80mm，动画里奇克奇塔也是明显小一号的幼体）。

import fatherFrontUrl from "./assets/mantis-father-front.png";
import fatherSideUrl from "./assets/mantis-father-side.png";
import sonFrontUrl from "./assets/mantis-son-front.png";
import sonSideUrl from "./assets/mantis-son-side.png";

/** 父（虾蛄星人 / 多佛恶魔）：正面 = 官方立绘，背离面 = 官方商品侧面图 */
export const MANTIS_FATHER = { front: fatherFrontUrl, away: fatherSideUrl };
/** 子（奇克奇塔）：正面 = 官方立绘，背离面 = 官方商品侧面图 */
export const MANTIS_SON = { front: sonFrontUrl, away: sonSideUrl };

/**
 * 定居点（2026-11-11 搬家，用户改判）：北极点旁的冰面，与北极
 * UFO 停机坪同一片场地（设计与施工见 DATA-PLAN「北极停机坪 +
 * 虾蛄父子改住北极」条）。原北海道富良野农场点位（43.34,
 * 142.39）已撤销——父子全网只此一处，不许两处同时存在。
 * 选址理由（用户原话）：北海道元素太密、父子太小看不清；极地
 * 两层数据天然全空，父子可放大约 1.5–2 倍仍克制，且与停机坪
 * 做成一个整体（父子是港口地主，访客落冰时迎上去同场活动）。
 * 场地布局（极点 = 停机坪心，角距 = 距极点的角距离）：
 *   - 父之家：角距 0.175 rad、方位取经度 150° 一侧（环外缘旁）
 *   - 访客落点：角距 0.185 rad、经度 −35° 一侧（见 Globe.tsx）
 *   - 子绕环跑半径：角距约 0.185 rad（见 Globe.tsx）
 * lat = 90 − 角距(°)：0.175 rad ≈ 10.03° → lat ≈ 79.97。
 * 叙事注：原作父子在地球务农定居的落点不变（仍在地球），只是
 * 本空间内的住址按用户改判迁到极地冰面，不再声称富良野农场。
 */
export const MANTIS_POLE_HOME: { lat: number; lon: number } = {
  lat: 79.97,
  lon: 150,
};
