/**
 * ローカルコーチ分析（ルールベース）のエントリポイント。
 *
 * - 完全ローカル・決定論的。同じ入力からは必ず同じ結果を返す。
 * - 外部API・生成AI・クラウド・外部DBを一切使用しない。
 * - この関数の内部からIndexedDBを読み込まない。必要なデータは呼び出し元が
 *   取得して引数で渡す（単体テストと再現性を確保するため）。
 * - 結果は保存しない。Markdown生成時に毎回再計算する。
 */
import type {
  SessionStatistics,
  ThrowRecord,
  TrainingSession,
} from "../../types/models";
import { normalizeScoringStyle } from "../../types/models";
import { mean } from "../stats";
import {
  ENGINE_VERSION,
  MAX_COMPARISON_SESSIONS,
  MAX_EVIDENCE_PER_FINDING,
  MAX_ISSUE_FINDINGS,
  MAX_POSITIVE_FINDINGS,
  MIN_ANALYZABLE_SAMPLE,
  MIN_COMPARISON_SESSION_THROWS,
  MIN_GROUPING_SETS,
} from "./config";
import { buildAction } from "./actions";
import {
  LOCAL_COACH_RULES,
  withCorroboration,
  type LocalCoachBaseline,
  type RuleContext,
  type RuleFinding,
} from "./rules";
import type {
  LocalCoachComparisonSource,
  LocalCoachFinding,
  LocalCoachReport,
  LocalCoachScopeSummary,
} from "./types";

export interface SessionWithStats {
  session: TrainingSession;
  stats: SessionStatistics;
}

export interface AnalyzeLocalCoachInput {
  session: TrainingSession;
  stats: SessionStatistics;
  throws: readonly ThrowRecord[];
  /** ユーザーが明示的に選んだ比較対象（条件が合わないものは自動的に除外する） */
  comparisons?: readonly SessionWithStats[];
  /** 同モードの直近セッション（比較候補の補完に使う） */
  recentSessions?: readonly SessionWithStats[];
}

/**
 * 記録済み着弾の精度区分。比較可能性の判定に使う。
 * 設定値(inputMethod)ではなく実際に記録された着弾から決める。
 */
export type PrecisionProfile = "coordinate" | "simple" | "mixed" | "none";

export function precisionProfileOf(stats: SessionStatistics): PrecisionProfile {
  const coordinate = stats.coordinateInputCount ?? 0;
  const approximate = stats.approximateInputCount ?? 0;
  if (coordinate > 0 && approximate > 0) return "mixed";
  if (coordinate > 0) return "coordinate";
  if (approximate > 0) return "simple";
  return "none";
}

/**
 * 比較対象として使ってよい過去セッションかを判定する。
 *
 * 統計の意味が異なるセッションを混ぜないため、次をすべて満たすものだけを採用する。
 *  - 同じトレーニングモード
 *  - 同じ出題方式（01の反復とフィニッシュ3投指定では統計の意味が異なる）
 *  - 同じボード種別
 *  - 同じスコアリング形式（スキル診断はR2・R3の主役/副が入れ替わるため）
 *  - 入力精度の内訳が同じ（概算値と実測値を同じ誤差指標として比較しない）
 *  - 進行中でない
 *  - 完了投擲数が MIN_COMPARISON_SESSION_THROWS 以上
 */
export function isComparableSession(
  base: SessionWithStats,
  candidate: SessionWithStats
): boolean {
  if (candidate.session.id === base.session.id) return false;
  if (candidate.session.status === "active") return false;
  if (candidate.session.trainingMode !== base.session.trainingMode) return false;
  if ((candidate.session.arrangement ?? null) !== (base.session.arrangement ?? null)) {
    return false;
  }
  if (candidate.session.boardType !== base.session.boardType) return false;
  if (
    (normalizeScoringStyle(candidate.session.scoringStyle) ?? null) !==
    (normalizeScoringStyle(base.session.scoringStyle) ?? null)
  ) {
    return false;
  }
  if (precisionProfileOf(candidate.stats) !== precisionProfileOf(base.stats)) {
    return false;
  }
  if (candidate.stats.completedThrows < MIN_COMPARISON_SESSION_THROWS) return false;
  return true;
}

/**
 * 条件を満たす直近最大 MAX_COMPARISON_SESSIONS セッションを選ぶ。
 * 明示的な比較対象を優先し、足りない分を同モードの直近セッションから補う。
 * 開始日時の降順（新しい順）で決定論的に並べる。
 */
export function selectComparableSessions(
  input: AnalyzeLocalCoachInput
): SessionWithStats[] {
  const base = { session: input.session, stats: input.stats };
  const seen = new Set<string>();
  const pool: SessionWithStats[] = [];
  for (const candidate of [
    ...(input.comparisons ?? []),
    ...(input.recentSessions ?? []),
  ]) {
    if (seen.has(candidate.session.id)) continue;
    seen.add(candidate.session.id);
    if (!isComparableSession(base, candidate)) continue;
    pool.push(candidate);
  }
  return pool
    .slice()
    .sort((a, b) => {
      const diff =
        Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt);
      return diff !== 0 ? diff : a.session.id.localeCompare(b.session.id);
    })
    .slice(0, MAX_COMPARISON_SESSIONS);
}

/** 比較可能なセッション群から基準線を作る。対象0件なら undefined。 */
export function buildBaseline(
  sessions: readonly SessionWithStats[]
): LocalCoachBaseline | undefined {
  if (sessions.length === 0) return undefined;
  const hitRates = sessions
    .map((x) => x.stats.scorableExactHitRate ?? x.stats.exactHitRate)
    .filter((v): v is number => v != null);
  const hitRateSamples = sessions.reduce(
    (sum, x) => sum + (x.stats.scorableThrows ?? x.stats.completedThrows),
    0
  );
  const hitCountTotal = sessions.reduce((sum, x) => sum + x.stats.exactHits, 0);
  // 単調性の判定は時系列でなければ意味がないため、古い順へ並べ直す
  const chronological = sessions
    .slice()
    .sort((a, b) => {
      const diff =
        Date.parse(a.session.startedAt) - Date.parse(b.session.startedAt);
      return diff !== 0 ? diff : a.session.id.localeCompare(b.session.id);
    });
  const coordinateErrors = sessions
    .map((x) => x.stats.coordinateError.averageErrorDistance)
    .filter((v): v is number => v != null);
  const coordinateErrorSamples = sessions.reduce(
    (sum, x) => sum + x.stats.coordinateError.sampleCount,
    0
  );
  const groupingSessions = sessions.filter(
    (x) =>
      x.stats.grouping?.status === "available" &&
      (x.stats.grouping.validSetCount ?? 0) >= MIN_GROUPING_SETS &&
      x.stats.grouping.averageDiameter != null
  );
  const groupingDiameters = groupingSessions
    .map((x) => x.stats.grouping?.averageDiameter)
    .filter((v): v is number => v != null);
  const groupingSets = groupingSessions.reduce(
    (sum, x) => sum + (x.stats.grouping?.validSetCount ?? 0),
    0
  );
  return {
    sessionCount: sessions.length,
    hitRate: mean(hitRates),
    hitRateSamples,
    hitCountTotal,
    coordinateErrorMean: mean(coordinateErrors),
    coordinateErrorSamples,
    groupingDiameter: mean(groupingDiameters),
    groupingSets,
    history: chronological.map((x) => ({
      hitRate: x.stats.scorableExactHitRate ?? x.stats.exactHitRate,
      coordinateErrorMean: x.stats.coordinateError.averageErrorDistance,
    })),
  };
}

const SKILL_ROUND_LABELS: Record<string, string> = {
  grouping: "R1 グルーピング",
  scoring: "R2 スコアリング",
  bull: "R2 スコアリング",
  number: "R3 ナンバー",
  checkout: "R4 チェックアウト",
};

interface AnalysisScope {
  key: string;
  label: string;
  throws: ThrowRecord[];
  /** このスコープでセッション単位のグルーピング統計を使ってよいか */
  allowGroupingStats: boolean;
  /** このスコープでセッション単位の基準線を使ってよいか */
  allowBaselineComparison: boolean;
}

/**
 * 分析対象スコープを決める。
 *
 * スキル診断は4ラウンドで測定内容（命中評価の有無・ターゲット構造）が
 * 異なるため、ラウンドをまたいだ投順・前後半・命中率の合算は行わない。
 * ラウンド識別子があるセッションだけラウンド別に分割し、それ以外は
 * セッション全体を1スコープとして扱う。
 */
export function buildAnalysisScopes(
  session: TrainingSession,
  throws: readonly ThrowRecord[]
): AnalysisScope[] {
  const sorted = throws
    .slice()
    .sort((a, b) => a.globalThrowNumber - b.globalThrowNumber);
  const roundKeys = new Set(
    sorted.map((t) => t.target.roundId ?? t.target.roundKind).filter(Boolean)
  );
  if (session.trainingMode !== "skill_check" || roundKeys.size < 2) {
    return [
      {
        key: "session",
        label: "セッション全体",
        throws: sorted,
        allowGroupingStats: true,
        allowBaselineComparison: true,
      },
    ];
  }
  const groups = new Map<string, ThrowRecord[]>();
  for (const t of sorted) {
    const key = t.target.roundId ?? t.target.roundKind ?? "unknown";
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, list]) => ({
      key,
      label: SKILL_ROUND_LABELS[list[0]?.target.roundKind ?? ""] ?? key,
      throws: list,
      // R1(grouping_only)のみ、既存のグルーピング実測値がこのスコープの測定に一致する
      allowGroupingStats: list[0]?.target.roundKind === "grouping",
      // ラウンドごとの測定内容が異なるため、セッション単位の平均比較は行わない
      allowBaselineComparison: false,
    }));
}

/**
 * 同じ主題（subject）の所見を1件に絞る。
 * 例: 3投目の横方向ばらつきと3投目の命中率低下は同じ投順の話なので、
 * 限られた出力枠を同一主題の再掲で埋めない。
 * 入力は priority 昇順に並んでいる前提で、各主題の先頭（=最優先）を残す。
 */
function dedupeBySubject(findings: readonly RuleFinding[]): RuleFinding[] {
  const seen = new Set<string>();
  const out: RuleFinding[] = [];
  for (const finding of findings) {
    const key = finding.subject ?? finding.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/**
 * 所見の並べ替え。
 *
 * ルールの記述順ではなく「大きくて確からしい所見」を先頭にするため、
 * severity(効果量 × 確からしさの重み)の降順を第1キーにする。
 * severity が同じときは種別の既定優先度、最後に id の辞書順で安定させる
 * （同じ入力から必ず同じ順序になることを保証する）。
 */
function sortFindings(findings: readonly RuleFinding[]): RuleFinding[] {
  return findings.slice().sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });
}

function trimEvidence(finding: RuleFinding): LocalCoachFinding {
  // polarity と confidenceInput はエンジン内部の作業用フィールドなので出力しない
  const { polarity: _polarity, confidenceInput: _input, ...rest } = finding;
  return {
    ...rest,
    evidence: finding.evidence.slice(0, MAX_EVIDENCE_PER_FINDING),
  };
}

/**
 * 同じ主題(subject)を同じ向きで指している所見が複数あれば、それらは互いの
 * 裏付けになる。例えば「3投目の横方向ばらつきが大きい」と「3投目の命中率が
 * 低い」は独立した指標で同じ投順を指しており、確からしさ「高」の条件である
 * 「複数指標で再現」に当たる。
 *
 * ルール個々では自分以外の所見を知り得ないため、全ルールの結果が出そろった
 * この段階でまとめて裏付け条件数を数え直す。
 */
function applyCorroboration(findings: readonly RuleFinding[]): RuleFinding[] {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    if (finding.polarity === "unavailable") continue;
    const key = `${finding.polarity}:${finding.subject ?? finding.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return findings.map((finding) => {
    if (finding.polarity === "unavailable") return finding;
    const key = `${finding.polarity}:${finding.subject ?? finding.id}`;
    return withCorroboration(finding, counts.get(key) ?? 1);
  });
}

/** 比較可能な過去セッションがない場合の定型文（推測で差を作らない）。 */
export const NO_COMPARABLE_SESSION_REASON =
  "比較可能な過去セッションがないため、本人平均との差は分析できません。";

/**
 * ローカルコーチ分析を実行する。純粋関数。
 */
export function analyzeLocalCoach(
  input: AnalyzeLocalCoachInput
): LocalCoachReport {
  const { session, stats } = input;
  const sortedThrows = input.throws
    .slice()
    .sort((a, b) => a.globalThrowNumber - b.globalThrowNumber);
  const plannedThrowCount = session.plannedThrowCount ?? stats.totalThrows ?? 0;
  const completionRatio =
    plannedThrowCount > 0 ? stats.completedThrows / plannedThrowCount : undefined;
  const comparable = selectComparableSessions(input);
  const baseline = buildBaseline(comparable);
  const scopes = buildAnalysisScopes(session, sortedThrows);
  const comparisonSources: LocalCoachComparisonSource[] = comparable.map((x) => ({
    sessionId: x.session.id,
    startedAt: x.session.startedAt,
    completedThrows: x.stats.completedThrows,
  }));
  const scopeSummaries: LocalCoachScopeSummary[] = scopes.map((scope) => ({
    key: scope.key,
    label: scope.label,
    throwCount: scope.throws.length,
  }));
  const generatedFrom: LocalCoachReport["generatedFrom"] = {
    completedThrows: stats.completedThrows,
    plannedThrowCount,
    completionRatio,
    coordinateInputCount: stats.coordinateInputCount ?? 0,
    approximateInputCount: stats.approximateInputCount ?? 0,
    comparisonSessionCount: comparable.length,
    comparisonSources,
    scopes: scopeSummaries,
  };

  // データ不足のゲート: 完了投擲数が最低分析数未満なら、架空の分析を生成しない
  if (stats.completedThrows < MIN_ANALYZABLE_SAMPLE) {
    const reasons: string[] = [
      `完了投擲数が最低分析数${MIN_ANALYZABLE_SAMPLE}投を下回っています(完了${stats.completedThrows}投)`,
    ];
    const half = Math.ceil(stats.completedThrows / 2);
    reasons.push(
      `前半・後半比較の各区間が${half}投と${stats.completedThrows - half}投しかありません`
    );
    if (comparable.length === 0) reasons.push(NO_COMPARABLE_SESSION_REASON);
    return {
      engineVersion: ENGINE_VERSION,
      generatedFrom,
      analyzable: false,
      issueFindings: [],
      unavailableReasons: reasons,
    };
  }

  const raw: RuleFinding[] = [];
  for (const scope of scopes) {
    const ctx: RuleContext = {
      session,
      stats,
      throws: scope.throws,
      scopeKey: scope.key,
      scopeLabel: scope.label,
      multiScope: scopes.length > 1,
      completionRatio,
      baseline,
      allowGroupingStats: scope.allowGroupingStats,
      allowBaselineComparison: scope.allowBaselineComparison,
    };
    for (const rule of LOCAL_COACH_RULES) raw.push(...rule(ctx));
  }
  const ordered = sortFindings(applyCorroboration(raw));
  const positives = dedupeBySubject(
    ordered.filter((f) => f.polarity === "positive")
  );
  const issues = dedupeBySubject(ordered.filter((f) => f.polarity === "issue"));
  const unavailable = ordered.filter((f) => f.polarity === "unavailable");

  const issueFindings = issues
    .slice(0, MAX_ISSUE_FINDINGS)
    .map((f) => trimEvidence(f));
  const positiveFinding = positives
    .slice(0, MAX_POSITIVE_FINDINGS)
    .map((f) => trimEvidence(f))[0];
  // 推奨メニューは最優先の課題1件にだけ対応させる
  const recommendedAction = buildAction(issueFindings[0]);

  const unavailableReasons: string[] = unavailable.map((f) => f.summary);
  if (comparable.length === 0) {
    unavailableReasons.push(NO_COMPARABLE_SESSION_REASON);
  }
  if ((stats.coordinateInputCount ?? 0) < MIN_ANALYZABLE_SAMPLE) {
    unavailableReasons.push(
      `詳細座標の投擲が${stats.coordinateInputCount ?? 0}投で、左右・上下の偏差に基づく分析には不足しています。`
    );
  }
  const grouping = stats.grouping;
  if (!grouping || grouping.status !== "available") {
    unavailableReasons.push(
      "有効な詳細座標3投セットがないため、グルーピングは分析できません。"
    );
  } else if (grouping.validSetCount < MIN_GROUPING_SETS) {
    unavailableReasons.push(
      `グルーピングの有効セット数が${grouping.validSetCount}セットで、最低${MIN_GROUPING_SETS}セットに達していません。`
    );
  }
  if (issueFindings.length === 0) {
    unavailableReasons.push(
      "判定基準を超える課題傾向は検出されませんでした(基準未満の差は傾向として扱いません)。"
    );
  }

  return {
    engineVersion: ENGINE_VERSION,
    generatedFrom,
    analyzable: true,
    positiveFinding,
    issueFindings,
    recommendedAction,
    unavailableReasons,
  };
}
