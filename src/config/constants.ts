/** アプリ全体の上限・閾値を一元管理する定数 */

export const APP_NAME = "CH Darts Training Analyzer";
export const APP_VERSION = "2.7.0-beta.4";

/**
 * 配布チャネル。"beta" のとき、UIへβバッジと注意書きを表示する。
 * 本番版へ取り込む際はここを "stable" に戻すだけで表示が切り替わる。
 */
export const APP_CHANNEL: "stable" | "beta" = "beta";

/** βバッジのラベル(アプリ名の隣に表示する短い識別子) */
export const BETA_BADGE_LABEL = "BETA";

/** 情報画面などで使うアプリ表示名(ベータ版は末尾にβを付ける) */
export const APP_DISPLAY_NAME =
  APP_CHANNEL === "beta" ? `${APP_NAME} β` : APP_NAME;

/**
 * ベータ版の注意書き。本番版と保存領域が分離されていること、
 * 自動同期されないこと、バックアップを推奨することを明示する。
 */
export const BETA_NOTICE = [
  "このアプリはベータ版です。",
  "本番版とは別の保存領域を使用しており、記録データは自動同期されません。",
  "重要な記録は定期的にJSONバックアップしてください。",
].join("\n");

/** セット数の制約 */
export const MIN_SETS = 20;
export const MAX_SETS = 333;
export const DARTS_PER_SET = 3;
export const MAX_THROWS = 999;

/** セット数プリセット */
export const SET_PRESETS = [20, 30, 40, 60] as const;

/** 自己評価スケール */
export const ASSESSMENT_MIN = 0;
export const ASSESSMENT_MAX = 10;

/**
 * ズレ方向を「中心付近」と判定する誤差距離の閾値(正規化座標)。
 * 外側ダブル半径 = 1.0 に対する比率。
 */
export const CENTER_NEAR_THRESHOLD = 0.05;

/** SVG入力可能範囲: 外側ダブル半径の倍率 */
export const INPUT_AREA_FACTOR = 1.3;

/** バックアップ形式バージョン */
export const BACKUP_VERSION = 3;

/** 表示時の小数点以下桁数(内部計算は丸めない) */
export const DISPLAY_DECIMALS = 3;
export const RATE_DECIMALS = 1;

/** Above this size, summary + CSV is recommended (token count remains an estimate). */
export const MAX_EMBEDDED_MARKDOWN_CHARS = 10_000;
