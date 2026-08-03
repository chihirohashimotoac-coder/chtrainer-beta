export type UUID = string;
export type ISODateTime = string;

export type BoardType = "steel" | "soft";

export type Ring =
  | "inner_single"
  | "outer_single"
  | "double"
  | "triple"
  | "outer_bull"
  | "inner_bull"
  | "outboard"
  | "bounce_out"
  | "unknown";

export type PositionPrecision =
  | "coordinate"
  | "segment_approximation"
  | "direction_only"
  | "unknown";

export type DailyCondition = "better_than_usual" | "usual" | "worse_than_usual";

export type MissDirection =
  | "center"
  | "up"
  | "up_right"
  | "right"
  | "down_right"
  | "down"
  | "down_left"
  | "left"
  | "up_left";

export type OutboardDirection =
  | "up"
  | "up_right"
  | "right"
  | "down_right"
  | "down"
  | "down_left"
  | "left"
  | "up_left"
  | "unknown";

export type InputMethod = "simple" | "coordinate";

export type TrainingMode =
  | "zero_one"
  | "cricket"
  | "bull"
  | "random"
  | "skill_check"
  // 以下は旧バージョンで記録されたセッションとの互換用
  | "same_target"
  | "per_dart_targets"
  | "sequence"
  | "double"
  | "triple"
  | "number";

export type RandomVariant = "balanced" | "pure";

/**
 * 01のスコアリング形式。ブルのルールにより「削りの主役ターゲット」が変わる。
 *  fat_bull: ファットブル(ブル一律50点のソフト) → 主役はBull
 *  separate_bull: インナー50/アウター25のソフト → 主役はT20
 *  steel: ハード(スティール) → 主役はT20
 *
 * 正式な機械可読値は fat_bull。旧誤記「フィットブル」に由来する fit_bull は
 * 過去に保存されたデータ(IndexedDB・旧バックアップ・旧CSV)にのみ存在し、
 * 読み込み時に normalizeScoringStyle で fat_bull へ正規化する(後方互換専用)。
 */
export type ScoringStyle = "fat_bull" | "separate_bull" | "steel";

/** 旧値 fit_bull を含む、外部から読み込む可能性のあるスコアリング形式の入力型。 */
export type LegacyScoringStyle = ScoringStyle | "fit_bull";

/**
 * スコアリング形式を正式な機械可読値へ正規化する(後方互換専用)。
 * 旧誤記由来の fit_bull を fat_bull として受理する。それ以外はそのまま返す。
 * 未設定(undefined)は未設定のまま返す。
 */
export function normalizeScoringStyle(
  style: LegacyScoringStyle | string | undefined
): ScoringStyle | undefined {
  if (style == null) return undefined;
  if (style === "fit_bull") return "fat_bull";
  if (style === "fat_bull" || style === "separate_bull" || style === "steel") {
    return style;
  }
  // 未知の値は破棄せず、型としては ScoringStyle を要求する箇所以外で扱えるよう
  // そのまま返す(呼び出し側の既存フォールバックに委ねる)。
  return style as ScoringStyle;
}

/** 永続データ共通のスキーマバージョン */
export const SCHEMA_VERSION = 3;

export type EvaluationKind = "exact_hit" | "grouping_only" | "cricket_marks" | "score_only";
export type RequiredInputPrecision = "coordinate" | "any";
export type SkillRoundKind =
  | "grouping"
  | "scoring"
  | "number"
  | "checkout"
  // schema v1 compatibility: newly created R2 records use "scoring".
  | "bull";

export interface EquipmentProfile {
  schemaVersion: number;
  id: UUID;
  name: string;
  barrel?: {
    maker?: string;
    model?: string;
    weightG?: number;
    lengthMm?: number;
    maxDiameterMm?: number;
  };
  shaft?: {
    maker?: string;
    model?: string;
    lengthMm?: number;
  };
  flight?: {
    maker?: string;
    model?: string;
    shape?: string;
    colors?: string[];
  };
  point?: {
    maker?: string;
    model?: string;
    lengthMm?: number;
  };
  notes?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type DominantEye = "right" | "left" | "unknown";

export type PlayerGoal =
  | "rating"
  | "recovery"
  | "zero_one"
  | "cricket"
  | "pro"
  | "form_check"
  | "bull";

/** レーティング体系(体系ごとに同じ数字でも意味が異なるため必ずセットで保持する) */
export type RatingSystem = "darts_live" | "phoenix";

/** 自己申告のレーティング(体系＋数値)。AI依頼文の参照・目標ギャップ算出に使う。 */
export interface PlayerRating {
  system: RatingSystem;
  /** レーティング値。DARTSLIVE=1〜18 / PHOENIX=1〜30 */
  value: number;
}
export type Stance = "closed" | "middle" | "open";

export type GripFingerCount = "2" | "3" | "4" | "other" | "unknown";
export type GripPosition = "front" | "center" | "rear" | "unknown";
export type TakebackDepth = "shallow" | "standard" | "deep" | "unknown";
export type ThrowingTempo = "slow" | "standard" | "fast" | "unknown";

/**
 * 任意のフォーム背景情報。着弾から原因を断定するためではなく、
 * AIが原因仮説を絞る際の追加文脈としてのみ使用する。
 */
export interface FormInformation {
  gripFingerCount?: GripFingerCount;
  gripPosition?: GripPosition;
  takeback?: TakebackDepth;
  throwingTempo?: ThrowingTempo;
  concern?: string;
}

export interface PlayerProfile {
  schemaVersion: number;
  id: UUID;
  displayName: string;
  dominantHand: "right" | "left" | "ambidextrous";
  /** 利き目(任意・後から追加されたフィールド) */
  dominantEye?: DominantEye;
  /** スタンス(任意・後から追加されたフィールド) */
  stance?: Stance;
  /** フォーム背景情報(すべて任意・後から追加されたフィールド) */
  form?: FormInformation;
  /** 練習の目的(任意) */
  goal?: PlayerGoal;
  /**
   * @deprecated v2.1 以降は levelNote に統合。読み込み・旧データ互換のため型に残す。
   * 現在のレベル(自由記述・自己申告)。
   */
  currentLevel?: string;
  /**
   * @deprecated v2.1 以降は levelNote に統合。読み込み・旧データ互換のため型に残す。
   * 目標レベル(自由記述)。
   */
  targetLevel?: string;
  /**
   * 実力・目標の補足メモ(自由記述)。レーティング欄と重複しない、言葉での補足用。
   * 旧 currentLevel / targetLevel を統合した後継フィールド(任意)。
   */
  levelNote?: string;
  /** 現在のレーティング(体系＋数値・任意) */
  currentRating?: PlayerRating;
  /** 目標のレーティング(体系＋数値・任意) */
  targetRating?: PlayerRating;
  /** 直近の悩み・重点課題(自由記述) */
  concern?: string;
  defaultBoardType: BoardType;
  defaultEquipmentProfileId?: UUID;
  /** 1投目・2投目・3投目の識別用フライト色 */
  dartColors: [string, string, string];
  defaultInputMethod: InputMethod;
  vibrationEnabled: boolean;
  soundEnabled: boolean;
  autoAdvanceEnabled: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type TargetType =
  | "exact_segment"
  | "number_sector"
  | "bull_any"
  | "custom_selection";

export interface TargetArea {
  number?: number;
  ring: Ring;
}

export interface TargetDefinition {
  id: UUID;
  label: string;
  type: TargetType;
  number?: number;
  ring?: Ring;
  /** 投擲画面に表示する、狙い方と測定内容の説明(スキル診断等で使用) */
  instruction?: string;
  /** Machine-readable semantics. Optional only for records created before schema v2. */
  evaluationKind?: EvaluationKind;
  roundId?: string;
  roundKind?: SkillRoundKind;
  /** スキル診断内のデータ駆動パターン識別子(旧データでは未設定) */
  patternId?: string;
  /** 同一ターゲット固定か、セット内ターゲット切替か */
  patternKind?: "fixed" | "switch";
  /** AI集計用カテゴリ(例: route20 / position_spread) */
  analysisCategory?: string;
  requiredInputPrecision?: RequiredInputPrecision;
  /** custom_selection 用: 命中と見なす複数エリア */
  areas?: TargetArea[];
  /** 誤差計算用の代表点(正規化座標) */
  representativePoint: {
    x: number;
    y: number;
  };
}

export interface EquipmentSnapshot {
  name: string;
  barrel?: EquipmentProfile["barrel"];
  shaft?: EquipmentProfile["shaft"];
  flight?: EquipmentProfile["flight"];
  point?: EquipmentProfile["point"];
  notes?: string;
}

/** Immutable analysis context captured before the first throw. */
export interface SessionContextSnapshot {
  capturedAt: ISODateTime;
  displayName: string;
  dominantHand: PlayerProfile["dominantHand"];
  dominantEye?: DominantEye;
  stance?: Stance;
  form?: FormInformation;
  goal?: PlayerGoal;
  /** @deprecated levelNote に統合。旧セッションのスナップショット互換のため残す。 */
  currentLevel?: string;
  /** @deprecated levelNote に統合。旧セッションのスナップショット互換のため残す。 */
  targetLevel?: string;
  /** 実力・目標の補足メモ(自由記述)。 */
  levelNote?: string;
  currentRating?: PlayerRating;
  targetRating?: PlayerRating;
  concern?: string;
  dartColors: [string, string, string];
  boardType: BoardType;
  inputMethod: InputMethod;
  equipmentSnapshot?: EquipmentSnapshot;
}

/** 必須スケール(0-10)の項目名。未回答判定に使う。 */
export type RequiredScaleKey =
  | "fatigue"
  | "concentration"
  | "pain"
  | "confidence";

export interface SelfAssessment {
  timing: "before" | "middle" | "after";
  recordedAt: ISODateTime;
  /** 0-10 */
  fatigue: number;
  concentration: number;
  pain: number;
  confidence: number;
  /**
   * ユーザーが一度も操作せず、既定値のまま記録された必須スケール項目。
   * 値そのものは既定値(疲労度/集中度/自信度=5, 痛み=0)が入るため、
   * 表示・出力層はこの一覧に含まれる項目を「未回答」として扱い、
   * 測定済みの自己申告値と混同してはならない。
   * 旧セッションでは未記録(undefined)＝判別不能。
   */
  untouchedScales?: RequiredScaleKey[];
  conditionChange?: "better" | "same" | "worse";
  /** メンタル評価(任意): 投げる前の不安 0-10 */
  anxiety?: number;
  /** メンタル評価(任意): リリースの怖さ・違和感 0-10 */
  releaseFear?: number;
  /** メンタル評価(任意): ルーティンを守れた度 0-10 */
  routineAdherence?: number;
  /** 命中率ではなく、一連の投擲動作を止まらず完了できた主観割合 (0-100) */
  uninterruptedThrowRate?: number;
  /** リリース動作が止まる主なタイミング。旧セッションでは未記録。 */
  releaseStopTiming?: ReleaseStopTiming;
  note?: string;
}

export type ReleaseStopTiming =
  | "none"
  | "during_setup"
  | "before_takeback"
  | "after_takeback"
  | "during_forward"
  | "before_release"
  | "unknown"
  | "other";

export interface SessionEnvironment {
  location?: string;
  boardName?: string;
  lighting?: string;
  temperatureC?: number;
  ocheNote?: string;
  formChangeNote?: string;
  gripChangeNote?: string;
  stanceChangeNote?: string;
  otherNote?: string;
}

export interface TrainingPlan {
  schemaVersion: number;
  id: UUID;
  name: string;
  trainingMode: TrainingMode;
  randomVariant?: RandomVariant;
  /** セットごとに3つのターゲット、または全セット共通ターゲットの素 */
  targets: TargetDefinition[];
  setCount: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface TrainingSession {
  schemaVersion: number;
  id: UUID;
  playerId: UUID;
  boardType: BoardType;
  boardProfileId: string;
  equipmentProfileId?: UUID;
  trainingMode: TrainingMode;
  randomVariant?: RandomVariant;
  /** 出題方式 (balanced/pure/same_per_set/fixed_three/cycle) */
  arrangement?: string;
  /** スコアリング形式(スキル診断で使用。旧データは未設定=ファットブル配列で出題) */
  scoringStyle?: ScoringStyle;
  inputMethod: InputMethod;
  dominantHand: "right" | "left" | "ambidextrous";
  /** Absent on legacy sessions; exports then explicitly use the current profile. */
  contextSnapshot?: SessionContextSnapshot;
  setCount: number;
  plannedThrowCount: number;
  /** セットごとの出題ターゲット3件 x setCount (開始時に確定) */
  plannedTargets: TargetDefinition[][];
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
  dailyCondition: DailyCondition;
  dailyConditionNote?: string;
  environment?: SessionEnvironment;
  assessments: SelfAssessment[];
  sessionNote?: string;
  status: "active" | "completed" | "aborted";
  /** 進行状態の復元用 */
  progress: {
    currentSetNumber: number;
    middleAssessmentDone: boolean;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ThrowSet {
  schemaVersion: number;
  id: UUID;
  sessionId: UUID;
  setNumber: number;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  roundId?: string;
  roundKind?: SkillRoundKind;
  patternId?: string;
  patternKind?: "fixed" | "switch";
  analysisCategory?: string;
  evaluationKind?: EvaluationKind;
  requiredInputPrecision?: RequiredInputPrecision;
  inputMethod?: InputMethod;
}

export interface LandingRecord {
  number?: number;
  ring: Ring;
  score?: number;
  x?: number;
  y?: number;
  radius?: number;
  angleDeg?: number;
  outboardDirection?: OutboardDirection;
  positionPrecision: PositionPrecision;
}

export interface DerivedRecord {
  /**
   * 完全命中したか。命中を評価しないラウンド(grouping_only)では undefined (N/A)。
   * 表示層は undefined を必ず N/A として扱い、false(ミス)と混同してはならない。
   */
  exactHit?: boolean;
  errorX?: number;
  errorY?: number;
  errorDistance?: number;
  errorAngleDeg?: number;
  missDirection?: MissDirection;
  targetChangedFromPrevious: boolean;
  previousThrowWasHit?: boolean;
  sameSetAsPrevious?: boolean;
  previousThrowWasHitInSameSet?: boolean;
  sameTargetAsPrevious?: boolean;
  /** 0-1 */
  sessionProgress: number;
}

export interface ThrowRecord {
  schemaVersion: number;
  id: UUID;
  sessionId: UUID;
  setId: UUID;
  globalThrowNumber: number;
  dartInSet: 1 | 2 | 3;
  dartColor?: string;
  target: TargetDefinition;
  thrownAt: ISODateTime;
  /** セッション開始からの経過ミリ秒 */
  elapsedMs: number;
  landing: LandingRecord;
  derived: DerivedRecord;
  /** 矢速(km/h・任意入力。マシン計測等の値をユーザーが転記する) */
  speedKmh?: number;
  note?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * 率の値は「分母が0(未測定)の場合は undefined」で統一する。
 * 0 は「分母が存在し、該当が0件だった」ことだけを意味する。
 * 表示層は undefined を必ず N/A として扱い、0% と混同してはならない。
 */
export interface DartOrderStats {
  throwCount: number;
  scorableThrows?: number;
  hitCount: number;
  /** 命中率。命中判定対象数が0なら undefined (N/A) */
  hitRate?: number;
  averageErrorDistance?: number;
  outboardCount: number;
  /** アウトボード率。投擲数0なら undefined (N/A) */
  outboardRate?: number;
}

export interface TargetStats {
  label: string;
  throwCount: number;
  scorableThrows?: number;
  hitCount: number;
  /** 命中率。命中判定対象数が0なら undefined (N/A) */
  hitRate?: number;
  averageErrorDistance?: number;
  mainMissDirection?: MissDirection;
  outboardCount: number;
}

export interface HalfStats {
  throwCount: number;
  scorableThrows?: number;
  hitCount: number;
  /** 命中率。命中判定対象数が0なら undefined (N/A) */
  hitRate?: number;
  averageErrorDistance?: number;
  outboardCount: number;
  /** アウトボード率。投擲数0なら undefined (N/A) */
  outboardRate?: number;
}

export interface ErrorStats {
  sampleCount: number;
  averageErrorDistance?: number;
  medianErrorDistance?: number;
  averageErrorX?: number;
  averageErrorY?: number;
  byDirection: Record<MissDirection, number>;
}

/** クリケット専用統計 (マーク換算: T=3, D=2, S=1, IB=2, OB=1) */
export interface CricketStats {
  totalMarks: number;
  /** 3投あたり平均マーク (MPR相当)。投擲数0なら undefined (N/A) */
  marksPerThreeDarts?: number;
  /** 1マーク以上を得た投擲の割合 (有効マーク率)。投擲数0なら undefined (N/A) */
  effectiveMarkRate?: number;
  /** マーク0の投擲の割合。投擲数0なら undefined (N/A) */
  noMarkRate?: number;
  byTarget: Record<
    string,
    {
      throwCount: number;
      totalMarks: number;
      marksPerThreeDarts: number;
      effectiveMarkRate: number;
      noMarkRate: number;
    }
  >;
  /** 同一セット内の2・3投目だけを、実際のターゲット列で分類した比較。 */
  continuity: {
    sameTarget: CricketTransitionStats;
    afterSwitch: CricketTransitionStats;
  };
}

export interface CricketTransitionStats {
  throwCount: number;
  totalMarks: number;
  marksPerDart?: number;
  noMarkRate?: number;
}

/** 01練習専用統計 */
export interface ZeroOneStats {
  bullThrowCount: number;
  bullHitRate?: number;
  tripleThrowCount: number;
  tripleHitRate?: number;
  doubleThrowCount: number;
  doubleHitRate?: number;
  /** 3投すべて命中したセットの割合 (フィニッシュ成立率) */
  allHitSetRate?: number;
}

export interface SessionStatistics {
  schemaVersion: number;
  sessionId: UUID;
  totalThrows: number;
  completedThrows: number;
  exactHits: number;
  scorableThrows: number;
  /** 命中判定対象の完全命中率。命中判定対象数が0なら undefined (N/A) */
  scorableExactHitRate?: number;
  groupingOnlyThrows: number;
  errorSampleCount: number;
  /** 完全命中率。命中判定対象数が0なら undefined (N/A) */
  exactHitRate?: number;
  outboardCount: number;
  /** アウトボード率。完了投擲数が0なら undefined (N/A) */
  outboardRate?: number;
  bounceOutCount: number;
  coordinateInputCount: number;
  approximateInputCount: number;
  /** 座標入力のみの誤差統計 */
  coordinateError: ErrorStats;
  /** 簡易入力の概算を含む誤差統計 */
  combinedError: ErrorStats;
  byDartInSet: Record<"1" | "2" | "3", DartOrderStats>;
  byTarget: Record<string, TargetStats>;
  byDirection: Record<MissDirection, number>;
  firstHalf: HalfStats;
  secondHalf: HalfStats;
  /** クリケット練習セッションのみ */
  cricket?: CricketStats;
  /** 01練習セッションのみ */
  zeroOne?: ZeroOneStats;
  grouping?: {
    status: "available" | "insufficient_data" | "unavailable_non_coordinate";
    validSetCount: number;
    /** グルーピング評価対象投擲数 (= validSetCount × 3) */
    groupingThrowCount?: number;
    /** 有効な3投座標セットにならなかった具体的な理由 */
    unavailableReasons?: (
      | "no_valid_three_dart_coordinate_set"
      | "bounce_out"
      | "outboard"
      | "unknown_position"
      | "fewer_than_three_throws"
      | "segment_approximation"
    )[];
    averagePairDistance?: number;
    maximumPairDistance?: number;
    medianPairDistance?: number;
    /** 有効セットごとの3投間距離(セット実施順)。値は正規化座標(外側ダブル半径=1.0) */
    perSet?: {
      /** 3点の全ペア距離の最大値(=グルーピング径) */
      maxPairDistance: number;
      /** 3点の全ペア距離の平均値 */
      averagePairDistance: number;
    }[];
    /** 各セットのグルーピング径(=最大ペア距離)のセッション平均 */
    averageDiameter?: number;
    /** 各セットのグルーピング径の中央値 */
    medianDiameter?: number;
    /** 前半セット(有効セットを実施順で半分に割った前側)の平均グルーピング径 */
    firstHalfAverageDiameter?: number;
    /** 後半セットの平均グルーピング径 */
    secondHalfAverageDiameter?: number;
    /** 投順間距離の平均(1→2投目 / 2→3投目 / 1→3投目)。分母は有効セット数 */
    interDartDistances?: {
      d1d2?: number;
      d2d3?: number;
      d1d3?: number;
    };
  };
  calculatedAt: ISODateTime;
}

export interface AppSettings {
  schemaVersion: number;
  id: "app";
  onboardingCompleted: boolean;
  activePlayerId?: UUID;
  updatedAt: ISODateTime;
}

export interface BackupFile {
  format: "darts-training-analyzer-backup";
  backupVersion: number;
  createdAt: ISODateTime;
  appVersion: string;
  counts: Record<string, number>;
  data: {
    settings: AppSettings[];
    players: PlayerProfile[];
    equipmentProfiles: EquipmentProfile[];
    trainingPlans: TrainingPlan[];
    sessions: TrainingSession[];
    throwSets: ThrowSet[];
    throws: ThrowRecord[];
    sessionStatistics: SessionStatistics[];
  };
}
