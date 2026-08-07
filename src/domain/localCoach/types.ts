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
  /** 対応する推奨メニューのテンプレート識別子（課題所見のみ） */
  actionTemplateId?: string;
}

/** 推奨練習メニュー。検出した課題と1対1で対応させる。 */
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
  /** 推奨メニュー（最大1件） */
  recommendedAction?: LocalCoachAction;
  /** 分析できなかった理由（データ不足・未測定） */
  unavailableReasons: string[];
}
