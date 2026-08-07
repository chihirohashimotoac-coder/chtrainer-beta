import { APP_CHANNEL, BETA_BADGE_LABEL } from "../config/constants";

/**
 * ベータ版であることを示すバッジ。
 *
 * 本番版と誤認されないよう、アプリ名の近くへ常時表示する。
 * APP_CHANNEL が "stable" のときは何も描画しないため、
 * 本番版へ取り込む際にこのコンポーネントの呼び出しを消す必要はない。
 *
 * レイアウト注意: バッジ自体は inline-block の短いテキストで、
 * 親側で flex-wrap を効かせて横スクロールを起こさないようにする
 * (320px幅でも見出しを押し出さない)。
 */
export function BetaBadge({ className }: { className?: string }) {
  if (APP_CHANNEL !== "beta") return null;
  return (
    <span
      className={`badge beta${className ? ` ${className}` : ""}`}
      title="ベータ版。本番版とは別の保存領域を使用します。"
    >
      {BETA_BADGE_LABEL}
    </span>
  );
}
