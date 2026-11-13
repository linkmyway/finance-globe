// 赛伯星人（拟态）纸片人素材 —— 单一事实源（第三路线，2026-11-10
// 用户拍板）：不再手绘，直接用官方人偶图抠图做 billboard 精灵。
//
// 素材出处（用户私人空间自用）：
//   - 正面：MegaHouse「オカルティックソフビコレクション TV アニメ
//     『ダンダダン』セルポ星人」官方商品图（正面全身，电击 Hobby
//     Web 掲載图 dg_12 同源拍摄）→ rembg 抠图 + 边缘清理（最大连
//     通域 + 1px 腐蚀 + 轻羽化）→ 统一画布 360×460（鞋底 y=444、
//     脚下补一层柔和接触影）。
//   - 眼色：三体セット（プレミアムバンダイ限定，赤/青/黄目）的眼色
//     方案。该套装宣传图三只相互遮挡、带描边辉光与背景残影，逐只
//     抠图边缘不合格，故眼色改为在单只官方正面图上按实测眼位
//     （视觉定位：双眼中心）点染发光眼，色值照三体套装的赤/青/黄。
//     5 只编制 = 赤、青、黄、赤、青（克隆重复用色，用户口径允许）。
//   - 背面：官方商品图全套（MegaHouse 商品页 7 图 + 电击 Hobby 6
//     图）只有正面/四分之三/侧面，没有背面图。按用户定的替补规
//     则，用同款人偶的官方侧面图（dg_11）作「背离镜头」面，并在
//     此注明。将来找到官方背面图可直接替换 serpo-side.png。
//
// 历史路线（一句存档）：几何拼脸（已下线）→ 手绘 SVG 两稿（按软
// 胶实测比例重描，docs/serpo-compare-v2.png）→ 本路线（官方图）。
// 手绘稿 serpoSvg 已删除，不并存。

import frontRedUrl from "./assets/serpo-front-red.png";
import frontBlueUrl from "./assets/serpo-front-blue.png";
import frontYellowUrl from "./assets/serpo-front-yellow.png";
import sideUrl from "./assets/serpo-side.png";

/** 每只居民的正面图（按编制顺序：赤、青、黄、赤、青） */
export const SERPO_FRONTS: string[] = [
  frontRedUrl,
  frontBlueUrl,
  frontYellowUrl,
  frontRedUrl,
  frontBlueUrl,
];

/** 「背离镜头」面：官方侧面图（无官方背面图的替补，见文件头注） */
export const SERPO_AWAY_URL: string = sideUrl;
