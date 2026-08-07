import type { LocalCoachConfidence } from "./types";
import {
  LOW_COMPLETION_RATIO,
  MIN_ANALYZABLE_SAMPLE,
  MIN_CORROBORATING_CONDITIONS_FOR_HIGH,
  MIN_HIGH_CONFIDENCE_SAMPLE,
} from "./config";

export interface ConfidenceInput {
  /**
   * その所見の該当サンプル数（分母）。セッション全体の投擲数ではなく、
   * その判定に実際に使った投擲数・セット数を渡すこと。
   */
  sampleSize: number;
  /**
   * 同じ向きの結果を示した独立な条件・指標の数。
   * 例: 投順別SDと過去セッション比較の両方で同じ悪化が出ていれば2。
   */
  corroboratingConditions: number;
  /**
   * 完了率（完了投擲数 / 予定投擲数）。
   * undefined = 予定投擲数が不明（旧データ）。この場合は減点しない。
   */
  completionRatio?: number;
}

const ORDER: LocalCoachConfidence[] = ["high", "medium", "low"];

/** 確からしさを1段階下げる（low が下限）。 */
export function downgrade(value: LocalCoachConfidence): LocalCoachConfidence {
  const index = ORDER.indexOf(value);
  return ORDER[Math.min(index + 1, ORDER.length - 1)] as LocalCoachConfidence;
}

/**
 * サンプル数が傾向を語れる水準に達しているか。
 * これが false の所見は kind="not_analyzable" 以外で出力してはならない。
 */
export function isAnalyzableSample(sampleSize: number): boolean {
  return sampleSize >= MIN_ANALYZABLE_SAMPLE;
}

/**
 * 所見の確からしさを決定論的に算出する。
 *
 * ルール:
 *  - 該当サンプルが MIN_ANALYZABLE_SAMPLE(10) 未満 → "low"
 *    （そもそも所見として出さない。出す場合でも「高」「中」にしない）
 *  - 10〜29投 → 最大 "medium"
 *  - 30投以上 → 裏付け条件が MIN_CORROBORATING_CONDITIONS_FOR_HIGH 以上なら
 *    "high"、1条件だけの観測なら "medium"（1指標の再現は「高」に足りない）
 *  - 完了率が LOW_COMPLETION_RATIO(50%) 未満の中断セッションは1段階下げる
 */
export function calculateConfidence(input: ConfidenceInput): LocalCoachConfidence {
  const { sampleSize, corroboratingConditions, completionRatio } = input;
  let value: LocalCoachConfidence;
  if (sampleSize < MIN_ANALYZABLE_SAMPLE) {
    value = "low";
  } else if (sampleSize < MIN_HIGH_CONFIDENCE_SAMPLE) {
    value = "medium";
  } else if (corroboratingConditions >= MIN_CORROBORATING_CONDITIONS_FOR_HIGH) {
    value = "high";
  } else {
    value = "medium";
  }
  if (completionRatio != null && completionRatio < LOW_COMPLETION_RATIO) {
    value = downgrade(value);
  }
  return value;
}

export const CONFIDENCE_LABELS: Record<LocalCoachConfidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};
