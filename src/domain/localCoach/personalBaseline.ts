/**
 * 個人基準（本人の過去履歴に基づく基準値）。
 *
 * 固定閾値だけで「大きい/小さい」を判断すると、本人にとって普通の値を
 * 課題として出したり、本人にとって異常な値を見逃したりする。
 * ここでは比較可能な過去セッションだけから、頑健な代表値（中央値）と
 * 変動幅を作り、今回の値がその内側か外側かを区別する。
 *
 * 履歴が足りない場合は基準を捏造せず、必ず unavailable として理由を残す。
 */
import { median } from "../stats";
import {
  ENGINE_VERSION,
  MIN_PERSONAL_BASELINE_SESSIONS,
  MIN_TREND_SESSIONS,
} from "./config";
import { monotonicDirection } from "./statistics";
import type { PersonalBaseline } from "./types";

/** 個人基準を作るための、古い順に並んだ本人の履歴値。 */
export interface BaselineSeriesInput {
  metric: string;
  /** 今回の値 */
  currentValue?: number;
  /** 比較可能な過去セッションの値（古い順）。今回は含めない。 */
  history: readonly (number | undefined)[];
  /** 値が小さいほど良い指標か（誤差距離・ばらつきなど） */
  lowerIsBetter: boolean;
}

/**
 * 履歴不足で個人基準を作れない場合の値。
 * 「基準なし」を undefined ではなく明示的な値として持つことで、
 * 表示層が誤って固定閾値の判定を本人基準として出すことを防ぐ。
 */
export function unavailableBaseline(
  metric: string,
  sessionCount: number,
  reason: string
): PersonalBaseline {
  return {
    metric,
    sessionCount,
    pattern: "unavailable",
    engineVersion: ENGINE_VERSION,
    unavailableReason: reason,
  };
}

/**
 * 個人基準を算出する。
 *
 * 判定:
 *  - 過去の変動幅（最小〜最大）の内側 → within_variation（通常のばらつき）
 *  - 変動幅の外で、履歴＋今回が単調に同じ方向へ動いている → continuing_trend
 *  - 変動幅の外だが方向が続いていない → single_deviation
 *
 * 単発変動と継続傾向を区別するのは、前者が「今回だけの揺れ」、
 * 後者が「積み重なっている変化」で、次に取るべき行動が違うため。
 */
export function buildPersonalBaseline(
  input: BaselineSeriesInput
): PersonalBaseline {
  const history = input.history.filter((v): v is number => v != null);
  if (history.length < MIN_PERSONAL_BASELINE_SESSIONS) {
    return unavailableBaseline(
      input.metric,
      history.length,
      `比較可能な過去セッションが${history.length}件で、個人基準に必要な${MIN_PERSONAL_BASELINE_SESSIONS}件に達していません`
    );
  }
  const representative = median(history);
  const low = Math.min(...history);
  const high = Math.max(...history);
  const current = input.currentValue;
  if (current == null || representative == null) {
    return unavailableBaseline(
      input.metric,
      history.length,
      "今回の値が未測定のため、本人基準との差は算出できません"
    );
  }
  // 相対差。代表値が0では相対差を定義できないため undefined（0%として扱わない）
  const differenceFromMedian =
    representative === 0
      ? undefined
      : (current - representative) / Math.abs(representative);

  const outsideVariation = current < low || current > high;
  let pattern: PersonalBaseline["pattern"] = "within_variation";
  if (outsideVariation) {
    const series = [...history, current];
    const direction =
      series.length >= MIN_TREND_SESSIONS ? monotonicDirection(series) : undefined;
    // 「悪化の方向へ連続している」場合だけ継続傾向として扱う。
    // 良い方向への連続は継続傾向だが課題ではないため、方向の一致だけを見る。
    pattern = direction ? "continuing_trend" : "single_deviation";
  }
  return {
    metric: input.metric,
    currentValue: current,
    sessionCount: history.length,
    median: representative,
    range: { low, high },
    differenceFromMedian,
    pattern,
    engineVersion: ENGINE_VERSION,
  };
}

/** 個人基準の位置づけを日本語ラベルにする。 */
export const BASELINE_PATTERN_LABELS: Record<
  PersonalBaseline["pattern"],
  string
> = {
  within_variation: "過去の変動幅の内側",
  single_deviation: "変動幅の外・単発変動",
  continuing_trend: "変動幅の外・継続傾向",
  unavailable: "N/A(履歴不足)",
};

/**
 * 今回の値が本人にとって悪い側へ外れているか。
 * 優先順位付けの補助に使う（本人基準の外側なら優先度を上げる）。
 */
export function isWorseThanPersonalBaseline(
  baseline: PersonalBaseline,
  lowerIsBetter: boolean
): boolean {
  if (baseline.pattern === "unavailable" || baseline.pattern === "within_variation") {
    return false;
  }
  if (baseline.currentValue == null || baseline.median == null) return false;
  return lowerIsBetter
    ? baseline.currentValue > baseline.median
    : baseline.currentValue < baseline.median;
}
