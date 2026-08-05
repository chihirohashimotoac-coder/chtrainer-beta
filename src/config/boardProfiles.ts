import type { BoardType, ScoringStyle } from "../types/models";

/**
 * ダーツボードの寸法プロファイル。
 * 半径はすべて「外側ダブル外周 = 1.0」の正規化値。
 * 実寸の根拠は README を参照。将来プロファイルを追加できるよう配列で管理する。
 */
export interface BoardProfile {
  id: string;
  name: string;
  type: BoardType;
  radii: {
    innerBullOuter: number;
    outerBullOuter: number;
    tripleInner: number;
    tripleOuter: number;
    doubleInner: number;
    doubleOuter: number;
    inputAreaOuter: number;
  };
  segmentOrder: number[];
  /**
   * 外側ダブル外周の実寸半径(mm)。正規化座標(半径=1.0)を実寸へ換算する係数として使う。
   * 正規化値 1.0 = この値(mm)。
   */
  doubleOuterRadiusMm: number;
  /** このボードで標準的な01のスコアリング形式(開始前設定の初期値) */
  defaultScoringStyle: ScoringStyle;
}

/** 20を頂点として時計回りの標準ナンバー配列 */
export const STANDARD_SEGMENT_ORDER = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

/**
 * スティール: WDF/PDC標準寸法(mm)を正規化。
 * innerBull=6.35, outerBull=15.9, tripleInner=99, tripleOuter=107,
 * doubleInner=162, doubleOuter=170
 */
export const STEEL_BOARD: BoardProfile = {
  id: "steel_standard",
  name: "スティール標準 (WDF/PDC準拠)",
  type: "steel",
  radii: {
    innerBullOuter: 6.35 / 170,
    outerBullOuter: 15.9 / 170,
    tripleInner: 99 / 170,
    tripleOuter: 107 / 170,
    doubleInner: 162 / 170,
    doubleOuter: 1.0,
    inputAreaOuter: 1.3,
  },
  segmentOrder: STANDARD_SEGMENT_ORDER,
  doubleOuterRadiusMm: 170,
  defaultScoringStyle: "steel",
};

/**
 * ソフト(15.5インチ): 一般的な電子ダーツボードの概算寸法(mm)を正規化。
 * 製品差があるため概算値。innerBull=9, outerBull=21.5, tripleInner=105,
 * tripleOuter=120, doubleInner=180, doubleOuter=196
 */
export const SOFT_BOARD: BoardProfile = {
  id: "soft_155",
  name: "ソフト15.5インチ (概算)",
  type: "soft",
  radii: {
    innerBullOuter: 9 / 196,
    outerBullOuter: 21.5 / 196,
    tripleInner: 105 / 196,
    tripleOuter: 120 / 196,
    doubleInner: 180 / 196,
    doubleOuter: 1.0,
    inputAreaOuter: 1.3,
  },
  segmentOrder: STANDARD_SEGMENT_ORDER,
  doubleOuterRadiusMm: 196,
  defaultScoringStyle: "fat_bull",
};

export const BOARD_PROFILES: BoardProfile[] = [STEEL_BOARD, SOFT_BOARD];

export function getBoardProfile(id: string): BoardProfile {
  return BOARD_PROFILES.find((p) => p.id === id) ?? STEEL_BOARD;
}

export function defaultBoardProfileFor(type: BoardType): BoardProfile {
  return type === "steel" ? STEEL_BOARD : SOFT_BOARD;
}

/** ボード種別に応じたスコアリング形式の初期値 */
export function defaultScoringStyleFor(type: BoardType): ScoringStyle {
  return defaultBoardProfileFor(type).defaultScoringStyle;
}
