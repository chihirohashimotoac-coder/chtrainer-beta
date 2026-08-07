/**
 * ローカルコーチ分析（ルールベース）の型定義。
 *
 * この機能は生成AI・機械学習モデルを一切使用しない。アプリ内の決定ルールと
 * 統計計算だけで、同じ入力から必ず同じ結果を返す（決定論的・純粋関数）。
 * 外部API、クラウド、追加の重量級ライブラリには依存しない。
 */

/**
 * 所見の種別。
 *  fact               : 観測された事実（分母が十分で、比較を伴わない単純な観測）
 *  statistical_trend  : 条件間の差として観測された傾向（断定ではない）
 *  rule_based_suggestion : 上記から決定ルールで導いた提案
 *  not_analyzable     : データ不足・未測定のため判定できない
 */
export type LocalCoachFindingKind =
  | "fact"
  | "statistical_trend"
  | "rule_based_suggestion"
  | "not_analyzable";

/** 確からしさ。サンプル数・裏付け条件数・完了率から決定論的に決まる。 */
export type LocalCoachConfidence = "high" | "medium" | "low";

/**
 * 所見の根拠となる単一の数値。
 * 表示層は必ず sampleSize（分母）を併記すること。分母0は 0% ではなく N/A。
 */
export interface LocalCoachEvidence {
  /** 指標名（例: "3投目の横方向ばらつき(SD)"） */
  metric: string;
  /** 今回の値。未測定なら undefined（N/A） */
  current?: number;
  /** 比較基準値（他条件の値、または比較可能な過去セッションの平均） */
  baseline?: number;
  /** current - baseline。片方でも未測定なら undefined */
  difference?: number;
  /** この指標の分母（該当投擲数・有効セット数など） */
  sampleSize: number;
  /**
   * 推定の95%区間（[low, high]）。分母が小さいほど広くなる。
   * 出力では「95%区間」とだけ示し、「有意」とは述べない
   * （多数の指標を同時に見ているため、単独の区間で有意性は主張できない）。
   * 区間を定義できない指標（件数など）では undefined。
   */
  interval?: { low: number; high: number };
  /** 値の単位・表示形式 */
  unit?: LocalCoachUnit;
  /** 補足（入力精度の別、スコープ名など） */
  note?: string;
}

/**
 * 根拠値の表示形式。
 *  normalized : 外側ダブル半径=1.0 の正規化座標（小数3桁）
 *  rate       : 0-1 の率（%表示）
 *  count      : 件数（整数）
 *  ratio      : 相対比（%表示。1.0 = 基準と同じ）
 */
export type LocalCoachUnit = "normalized" | "rate" | "count" | "ratio";

// ---------------------------------------------------------------------------
// v3: 観測事実 / 個人基準 / 反証可能な仮説 / 1変数実験
// ---------------------------------------------------------------------------

/** 事実の元になった入力精度。混在を同一母集団として扱わないために持つ。 */
export type FactPrecision =
  /** 詳細座標のみで算出 */
  | "coordinate"
  /** 簡易入力(セグメント代表点)のみで算出。mm換算・SDの絶対値は扱わない */
  | "approximate"
  /** 入力精度に依存しない指標(件数・率など) */
  | "precision_independent";

/**
 * 観測事実。「何が観測されたか」だけを持ち、原因は一切含めない。
 * 原因候補は CoachHypothesis 側にのみ置き、同じフィールドへ混ぜない。
 */
export interface ObservedFact {
  metric: string;
  value?: number;
  /** 比較相手の名前（例: 「他の投順をまとめた値」） */
  comparisonLabel?: string;
  comparisonValue?: number;
  /** value - comparisonValue、または相対差 */
  difference?: number;
  unit?: LocalCoachUnit;
  /** この事実の分母。0 は 0% ではなく N/A として表示する。 */
  sampleSize: number;
  precision: FactPrecision;
  interval?: { low: number; high: number };
  note?: string;
}

/**
 * 個人基準。比較可能な過去履歴からのみ作る。
 * 履歴が足りない場合は捏造せず unavailable とする。
 */
export interface PersonalBaseline {
  metric: string;
  currentValue?: number;
  /** 比較条件を満たした過去セッション数 */
  sessionCount: number;
  /** 頑健な代表値（中央値）。外れ値1回で基準が動かないようにする。 */
  median?: number;
  /** 過去の変動幅（最小〜最大） */
  range?: { low: number; high: number };
  /** 今回と中央値の相対差 */
  differenceFromMedian?: number;
  /**
   * 今回の値の位置づけ。
   *  within_variation   : 過去の変動幅の内側（通常のばらつきの範囲）
   *  single_deviation   : 変動幅の外だが、方向が継続していない（単発変動）
   *  continuing_trend   : 変動幅の外で、方向が連続している（継続傾向）
   *  unavailable        : 履歴不足で判定しない
   */
  pattern:
    | "within_variation"
    | "single_deviation"
    | "continuing_trend"
    | "unavailable";
  /** 基準を算出したルールエンジンの版数（版が違う基準を無言で混ぜない） */
  engineVersion: string;
  /** unavailable のときの理由 */
  unavailableReason?: string;
}

/**
 * 反証可能な原因仮説。断定ではなく「次回どうなれば支持され、
 * どうなれば否定されるか」まで持つ候補として扱う。
 */
export interface CoachHypothesis {
  id: string;
  /** 短い見出し（例: 「投順そのものに依存」） */
  label: string;
  /** 候補としての言い回し。断定形にしない。 */
  statement: string;
  /** この仮説と整合する観測値 */
  supporting: string[];
  /** この仮説と矛盾する観測値。無い場合は「現時点で矛盾する観測なし」を入れる。 */
  contradicting: string[];
  /** 現在不足しているデータ */
  missingData: string[];
  /** 仮説が正しければ次回どうなるか */
  ifTrue: string;
  /** 仮説が誤りなら次回どうなるか */
  ifFalse: string;
  /** 他の仮説と区別する方法（同じ内容なら今回のデータでは区別不能） */
  distinguishedBy: string;
  /**
   * 身体・心理・医学に関わる要因を含む場合の扱い。
   * 着弾データだけでは断定できないため、必ず外部確認手段を指定する。
   */
  requiresExternalCheck?: string;
}

/** 実験の1条件。 */
export interface ExperimentCondition {
  label: string;
  description: string;
  /** この条件の投擲数。最小サンプル基準を満たすこと。 */
  throwCount: number;
}

/** 上位2件に入らなかった検出候補（存在自体は必ず外部AIへ伝える）。 */
export interface UnrankedCandidate {
  id: string;
  subject?: string;
  /** 全候補内での順位（1始まり） */
  rank: number;
  title: string;
  confidence: LocalCoachConfidence;
  effect: number;
  severity: number;
  /** 表示しなかった理由 */
  hiddenReason: string;
}

/** 単一の所見。 */
export interface LocalCoachFinding {
  /** ルール識別子（例: "dart_order_lateral_spread"）。エンジン内で一意。 */
  id: string;
  kind: LocalCoachFindingKind;
  /** 優先度。小さいほど優先。同値のときは id の辞書順で安定ソートする。 */
  priority: number;
  title: string;
  summary: string;
  confidence: LocalCoachConfidence;
  /**
   * 効果の大きさを0〜1へ正規化した値。確からしさの重みと掛け合わせて
   * 課題の順位を決める（ルールの記述順ではなく、実際に大きい課題を先頭にする）。
   */
  effect: number;
  /**
   * 並べ替えに使う総合スコア = effect × 確からしさの重み。
   * 同値のときは種別の既定優先度、次に id の辞書順で安定させる。
   */
  severity: number;
  evidence: LocalCoachEvidence[];
  /**
   * この所見の主対象となる指標名。推奨メニューの成功判定はこの指標で書く。
   * 未指定なら evidence[0].metric を使う。
   */
  primaryMetric?: string;
  /**
   * 所見の主題キー。同じ主題（例: 同じ投順の悪化）の所見を
   * 課題欄へ重複して並べないための重複排除に使う。
   */
  subject?: string;
  /** この所見で言えないこと・注意点 */
  limitations: string[];
  /** 対応する実験テンプレートの識別子（課題所見のみ） */
  actionTemplateId?: string;

  // --- v3: 構造化フィールド ---
  /** 観測事実（原因を含まない）。evidence の構造化版。 */
  observedFacts?: ObservedFact[];
  /** 本人の過去履歴に基づく基準。履歴不足なら pattern="unavailable"。 */
  personalBaseline?: PersonalBaseline;
  /** なぜこの候補を優先したか（効果量・裏付け指標数・継続性） */
  priorityReason?: string;
  /** この所見と矛盾する、または反証となる観測 */
  counterEvidence?: string[];
  /** この所見について現在測定できていない事項 */
  unmeasured?: string[];
  /** 反証可能な原因仮説（最大2件）。観測事実とは別フィールドに保つ。 */
  hypotheses?: CoachHypothesis[];
  /** 全候補内での順位（1始まり） */
  rank?: number;
}

/** 推奨練習メニュー。検出した課題と1対1で対応させる。 */
/**
 * 1変数実験計画。一般的な練習アドバイスではなく、
 * 複数の原因仮説を区別するための対照実験として構成する。
 * 既存フィールド（purpose/method/throwCount/focus/avoid/…）は互換のため維持する。
 */
export interface LocalCoachAction {
  id: string;
  /** 対応する課題所見の id。成功判定はこの課題の指標で書く。 */
  targetFindingId: string;
  title: string;
  purpose: string;
  method: string;
  throwCount: number;
  focus: string;
  avoid: string;
  /** 練習中に記録する項目 */
  recordItems: string[];
  successCriteria: string[];
  stopOrChangeCriteria: string[];

  // --- v3: 1変数実験としての構造 ---
  /** 区別しようとしている仮説の id */
  hypothesisIds?: string[];
  /** 条件間で変更する唯一の要因 */
  changedFactor?: string;
  /** 対照条件（いつも通り） */
  control?: ExperimentCondition;
  /** 介入条件（変更する要因だけを変える） */
  intervention?: ExperimentCondition;
  /** ブロック順・交互実施の指定 */
  blockOrder?: string;
  /** 所見に対応する主要評価指標 */
  primaryMetric?: string;
  /** 主要指標を追う代わりに悪化させてはいけない指標 */
  guardrailMetrics?: string[];
  /** 仮説を否定する基準 */
  falsificationCriteria?: string[];
  /** 結果に応じた次の分岐 */
  nextBranch?: string;
}

/** 比較対象として採用した過去セッションの要約（根拠の追跡用）。 */
export interface LocalCoachComparisonSource {
  sessionId: string;
  startedAt: string;
  completedThrows: number;
}

/** 分析対象スコープ（スキル診断のようにラウンドで測定内容が異なる場合に分割する）。 */
export interface LocalCoachScopeSummary {
  key: string;
  label: string;
  throwCount: number;
}

export interface LocalCoachReport {
  /** 分析エンジンのバージョン。ルール変更時に更新する。 */
  engineVersion: string;
  generatedFrom: {
    completedThrows: number;
    plannedThrowCount: number;
    /** 完了率（予定投擲数が0なら undefined = N/A） */
    completionRatio?: number;
    coordinateInputCount: number;
    approximateInputCount: number;
    comparisonSessionCount: number;
    comparisonSources: LocalCoachComparisonSource[];
    scopes: LocalCoachScopeSummary[];
  };
  /** 分析が成立したか。false のとき findings は出力せず理由だけを示す。 */
  analyzable: boolean;
  /** 良かった点（最大1件） */
  positiveFinding?: LocalCoachFinding;
  /** 優先課題（最大2件） */
  issueFindings: LocalCoachFinding[];
  /** 推奨メニュー（最大1件）。v3では1変数実験計画。 */
  recommendedAction?: LocalCoachAction;
  /**
   * 検出したすべての課題候補（表示件数で切り捨てる前）。
   * 上位2件に入らなかったという理由だけで候補の存在が消えないよう、
   * 内部で保持して検査・出力できるようにする。
   */
  allCandidates: UnrankedCandidate[];
  /** 上位2件に入らなかった候補（短い補助情報として出力する） */
  unrankedCandidates: UnrankedCandidate[];
  /** 課題が0件だった場合に示す、今回確認できた安定範囲 */
  stableRange?: string[];
  /** 分析できなかった理由（データ不足・未測定） */
  unavailableReasons: string[];
}
