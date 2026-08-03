import type {
  SessionStatistics,
  TrainingSession,
} from "../types/models";

export interface ComparisonCandidate {
  session: TrainingSession;
  score: number;
  reasons: string[];
}

function scoreCandidate(
  base: TrainingSession,
  session: TrainingSession,
  baseLabels: string,
  baseTime: number
): ComparisonCandidate {
  let score = 0;
  const reasons: string[] = [];
  if (session.trainingMode === base.trainingMode) {
    score += 1000;
    reasons.push("同じトレーニングモード");
  }
  if (
    base.scoringStyle != null &&
    session.scoringStyle === base.scoringStyle
  ) {
    score += 500;
    reasons.push("同じスコアリング形式");
  }
  // スコアリング形式が異なるスキル診断は、ターゲットのラベル集合が一致しても
  // R2(主役)・R3同一3投(副)の主役/副が入れ替わる。ラベル集合が同じというだけで
  // 「同じターゲット構成」と表示すると誤解を生むため、その旨を明示する。
  const scoringDiffers =
    base.scoringStyle != null &&
    session.scoringStyle != null &&
    session.scoringStyle !== base.scoringStyle;
  if (targetSignature(session) === baseLabels) {
    if (scoringDiffers) {
      score += 150;
      reasons.push("ターゲットの種類は共通(スコアリング形式でR2・R3の主役/副が入れ替わり)");
    } else {
      score += 400;
      reasons.push("同じターゲット構成");
    }
  }
  if (session.boardType === base.boardType) {
    score += 250;
    reasons.push("同じボード種別");
  }
  if (session.inputMethod === base.inputMethod) {
    score += 120;
    reasons.push("同じ入力方式");
  }
  if (
    session.equipmentProfileId != null &&
    session.equipmentProfileId === base.equipmentProfileId
  ) {
    score += 100;
    reasons.push("同じ使用機材");
  }
  if (session.status === "completed") {
    score += 80;
  } else {
    reasons.push("中断セッション");
  }
  // 日付の近さ: 30日以内で最大50点
  const days = Math.abs(baseTime - Date.parse(session.startedAt)) / 86400000;
  score += Math.max(0, 50 - Math.min(50, days * (50 / 30)));
  return { session, score, reasons };
}

/**
 * 「おすすめの比較候補」= 同一トレーニングモードのセッションのみ。
 * モードが異なるセッションは統計の意味が違うため、おすすめには決して含めない
 * (参考として見たい場合は rankDissimilarCandidates を明示的に使う)。
 * 同モード内の優先順位: スコアリング形式 > ターゲット構成 > ボード種別 >
 * 入力方式 > 機材 > 完了状態 > 日付の近さ
 */
export function rankComparisonCandidates(
  base: TrainingSession,
  others: readonly TrainingSession[]
): ComparisonCandidate[] {
  const baseLabels = targetSignature(base);
  const baseTime = Date.parse(base.startedAt);
  return others
    .filter(
      (s) =>
        s.id !== base.id &&
        s.status !== "active" &&
        s.trainingMode === base.trainingMode
    )
    .map((session) => scoreCandidate(base, session, baseLabels, baseTime))
    .sort((a, b) => b.score - a.score);
}

/**
 * 条件の異なる(=モードが違う)セッションの参考リスト。
 * ユーザーが明示的に「条件の異なるセッションを表示」を選んだ場合だけ使う。
 */
export function rankDissimilarCandidates(
  base: TrainingSession,
  others: readonly TrainingSession[]
): ComparisonCandidate[] {
  const baseLabels = targetSignature(base);
  const baseTime = Date.parse(base.startedAt);
  return others
    .filter(
      (s) =>
        s.id !== base.id &&
        s.status !== "active" &&
        s.trainingMode !== base.trainingMode
    )
    .map((session) => scoreCandidate(base, session, baseLabels, baseTime))
    .sort((a, b) => b.score - a.score);
}

/** ターゲット構成の識別子(ラベルの集合) */
export function targetSignature(session: TrainingSession): string {
  const labels = new Set<string>();
  for (const set of session.plannedTargets) {
    for (const t of set) labels.add(t.label);
  }
  return [...labels].sort().join(",");
}

/** 比較条件が大きく異なるかどうか(警告表示の要否判定用) */
export function isDissimilarComparison(
  base: TrainingSession,
  other: TrainingSession
): boolean {
  const m = comparisonMismatches(base, other);
  return m.mode || m.board || m.input || m.scoring;
}

/** 比較可能性に関わる条件の一致/不一致(警告理由の正確な表示に使う) */
export interface ComparisonMismatch {
  mode: boolean;
  board: boolean;
  input: boolean;
  /** スコアリング形式。両方が記録されていて異なる場合のみ true */
  scoring: boolean;
}

/**
 * 2セッションの比較条件の差分を実データから判定する。
 * スコアリング形式は「両方が記録されていて異なる」場合だけ差分とみなす
 * (片方が旧データで未記録なら、形式差では非類似としない)。
 */
export function comparisonMismatches(
  base: TrainingSession,
  other: TrainingSession
): ComparisonMismatch {
  return {
    mode: base.trainingMode !== other.trainingMode,
    board: base.boardType !== other.boardType,
    input: base.inputMethod !== other.inputMethod,
    scoring:
      base.scoringStyle != null &&
      other.scoringStyle != null &&
      base.scoringStyle !== other.scoringStyle,
  };
}

export interface StatDiff {
  base: number | undefined;
  other: number | undefined;
  diff: number | undefined;
  /**
   * その値の分母(率なら命中判定対象数、平均なら誤差サンプル数)。
   * 少数サンプル同士の差を大きな改善・悪化と読み違えないよう、
   * 表示層は必ず値と一緒にこの分母を出すこと。undefined = 分母不明(旧データ)。
   */
  baseSample?: number;
  otherSample?: number;
}

function diffOf(
  base: number | undefined,
  other: number | undefined,
  baseSample?: number,
  otherSample?: number
): StatDiff {
  return {
    base,
    other,
    diff: base != null && other != null ? base - other : undefined,
    ...(baseSample != null ? { baseSample } : {}),
    ...(otherSample != null ? { otherSample } : {}),
  };
}

/**
 * 比較する2セッションの入力精度の内訳。
 * 詳細座標と簡易入力(エリア代表点による概算)では平均誤差距離の意味が違うため、
 * 差分値だけを見て精度が改善・悪化したと判断してはならない。
 */
export interface PrecisionSummary {
  coordinateInputCount: number;
  approximateInputCount: number;
  /** 概算(簡易入力)を1投でも含むか */
  includesApproximation: boolean;
}

export function precisionSummaryOf(stats: SessionStatistics): PrecisionSummary {
  const approximateInputCount = stats.approximateInputCount ?? 0;
  return {
    coordinateInputCount: stats.coordinateInputCount ?? 0,
    approximateInputCount,
    includesApproximation: approximateInputCount > 0,
  };
}

export interface SessionComparison {
  hitRate: StatDiff;
  averageErrorDistance: StatDiff;
  byDartInSet: Record<"1" | "2" | "3", { hitRate: StatDiff; averageErrorDistance: StatDiff }>;
  byTarget: Record<string, { hitRate: StatDiff; averageErrorDistance: StatDiff }>;
  firstHalfHitRate: StatDiff;
  secondHalfHitRate: StatDiff;
  /** 平均誤差距離の解釈に必要な入力精度の内訳 */
  precision: { base: PrecisionSummary; other: PrecisionSummary };
}

/** 命中率の分母(命中判定対象数)。未記録の旧データは総投擲数で代替する。 */
function scorableOf(
  group: { scorableThrows?: number; throwCount: number } | undefined
): number | undefined {
  if (!group) return undefined;
  return group.scorableThrows ?? group.throwCount;
}

/** 2セッションの統計を比較する(diff = 基準 - 過去) */
export function compareStatistics(
  base: SessionStatistics,
  other: SessionStatistics
): SessionComparison {
  const orders = ["1", "2", "3"] as const;
  const byDartInSet = {} as SessionComparison["byDartInSet"];
  for (const o of orders) {
    byDartInSet[o] = {
      hitRate: diffOf(
        base.byDartInSet[o].hitRate,
        other.byDartInSet[o].hitRate,
        scorableOf(base.byDartInSet[o]),
        scorableOf(other.byDartInSet[o])
      ),
      averageErrorDistance: diffOf(
        base.byDartInSet[o].averageErrorDistance,
        other.byDartInSet[o].averageErrorDistance
      ),
    };
  }
  const byTarget: SessionComparison["byTarget"] = {};
  const labels = new Set([
    ...Object.keys(base.byTarget),
    ...Object.keys(other.byTarget),
  ]);
  for (const label of labels) {
    byTarget[label] = {
      hitRate: diffOf(
        base.byTarget[label]?.hitRate,
        other.byTarget[label]?.hitRate,
        scorableOf(base.byTarget[label]),
        scorableOf(other.byTarget[label])
      ),
      averageErrorDistance: diffOf(
        base.byTarget[label]?.averageErrorDistance,
        other.byTarget[label]?.averageErrorDistance
      ),
    };
  }
  return {
    hitRate: diffOf(
      base.exactHitRate,
      other.exactHitRate,
      base.scorableThrows ?? base.completedThrows,
      other.scorableThrows ?? other.completedThrows
    ),
    averageErrorDistance: diffOf(
      base.combinedError.averageErrorDistance,
      other.combinedError.averageErrorDistance,
      base.combinedError.sampleCount,
      other.combinedError.sampleCount
    ),
    byDartInSet,
    byTarget,
    firstHalfHitRate: diffOf(
      base.firstHalf.hitRate,
      other.firstHalf.hitRate,
      scorableOf(base.firstHalf),
      scorableOf(other.firstHalf)
    ),
    secondHalfHitRate: diffOf(
      base.secondHalf.hitRate,
      other.secondHalf.hitRate,
      scorableOf(base.secondHalf),
      scorableOf(other.secondHalf)
    ),
    precision: {
      base: precisionSummaryOf(base),
      other: precisionSummaryOf(other),
    },
  };
}
