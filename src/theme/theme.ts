/**
 * 外観テーマ。端末ローカルのUI設定として localStorage に保存し、
 * <html data-theme="..."> を付け替えることで styles.css のトークン(CSS変数)を切り替える。
 *
 * - "default" は既存(ネイビー×ゴールド)。data-theme を外した素の :root がこれに当たる。
 * - 盤面SVG(BoardSVG.tsx)は独自の固定色で描画されるため、テーマの影響を受けない。
 * - IndexedDBのスキーマやバックアップ形式には一切影響しない(純粋な表示設定)。
 */
export type ThemeId =
  | "default"
  | "slate"
  | "cobalt"
  | "bronze"
  | "graphite"
  | "hyperdrive";

export const THEME_IDS: readonly ThemeId[] = [
  "default",
  "slate",
  "cobalt",
  "bronze",
  "graphite",
  "hyperdrive",
] as const;

export interface ThemePreview {
  id: ThemeId;
  /** ダーク基調か(選択画面のラベル用) */
  dark: boolean;
  /** プレビュー用スウォッチ [背景, 面, アクセント, 文字] */
  swatch: [string, string, string, string];
}

export const THEME_PREVIEWS: readonly ThemePreview[] = [
  { id: "default", dark: true, swatch: ["#07141f", "#163344", "#e4ad50", "#f4f7f9"] },
  { id: "slate", dark: true, swatch: ["#16211d", "#1f2c27", "#e8b84b", "#ece6d6"] },
  { id: "cobalt", dark: true, swatch: ["#08132a", "#0f1f3d", "#3d8bff", "#eaf1ff"] },
  { id: "bronze", dark: false, swatch: ["#f4efe6", "#fbf8f1", "#a97b3f", "#221f1a"] },
  { id: "graphite", dark: false, swatch: ["#f3f2ee", "#ffffff", "#d0342b", "#16181c"] },
  { id: "hyperdrive", dark: true, swatch: ["#07060d", "#0d0b1c", "#ff2d8f", "#16f0e0"] },
];

// ベータ版は本番版と同一オリジンのため、localStorage キーもベータ専用にする。
// index.html の FOUC 防止スクリプトのキーと必ず一致させること。
const STORAGE_KEY = "chtrainer-beta-theme";

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return value != null && (THEME_IDS as readonly string[]).includes(value);
}

/** 保存済みテーマを取得する。未設定・不正値・localStorage不可なら "default"。 */
export function getStoredTheme(): ThemeId {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isThemeId(value) ? value : "default";
  } catch {
    return "default";
  }
}

/** テーマを即時適用し、localStorage へ保存する。 */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id === "default") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", id);
  }
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // プライベートモード等で保存不可でも、当該セッションの表示は反映済みなので無視する。
  }
}
