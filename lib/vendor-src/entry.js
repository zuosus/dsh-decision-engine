/**
 * microcharts 的**按需子集**（只导出统计页真正用到的图型）。
 *
 * 为什么不导出整个目录：本插件的硬约束之一是首屏体积。整包 106 种图型
 * 即使 tree-shaking 也带着共享几何，而统计页只用得到「比较大小」「占比」
 * 「目标达成」这三类。少一种图型就少一份要审的第三方代码。
 */
export { Sparkline } from "@microcharts/react/sparkline";
export { SparkBar } from "@microcharts/react/sparkbar";
export { Bullet } from "@microcharts/react/bullet";
export { SegmentedBar } from "@microcharts/react/segmented-bar";
export { Delta } from "@microcharts/react/delta";
export { MiniBar } from "@microcharts/react/mini-bar";
