/**
 * ローカルコーチのA/B評価用フィクスチャ。
 *
 * 目的:
 *  - 同一データに対する「Production相当」「改善前Beta相当」「改善後Beta」の
 *    3種類のPromptを、決定論的に生成できるようにする。
 *  - 期待するローカル所見と、出してはいけない断定（Ground Truth）を
 *    フィクスチャ側に持ち、テストとA/B採点の両方から参照できるようにする。
 *
 * 重要:
 *  Dataset名・Ground Truth・期待値は、回答モデルへ渡すPrompt本文へ
 *  混入させてはならない。buildPrompts() が返すのは依頼文だけであり、
 *  期待値は別フィールド（expectation）に分けている。
 */
import { STEEL_BOARD } from "../../config/boardProfiles";
import {
  landingBounceOut,
  landingFromCoordinate,
  landingFromSegment,
} from "../landing";
import { calculateStatistics } from "../stats";
import { makeSegmentTarget } from "../targets";
import { buildThrows, fixtureSession, D16, T20 } from "../../test/fixtures";
import type { FixtureThrowSpec } from "../../test/fixtures";
import type {
  SelfAssessment,
  SessionStatistics,
  TargetDefinition,
  ThrowRecord,
  TrainingSession,
} from "../../types/models";

const REP = T20.representativePoint;
const CALCULATED_AT = "2026-01-01T11:00:00.000Z";

export const T19: TargetDefinition = {
  ...makeSegmentTarget("triple", STEEL_BOARD, 19),
  id: "fixture-target-t19",
};

export interface SessionFixture {
  session: TrainingSession;
  throws: ThrowRecord[];
  stats: SessionStatistics;
}

/** Ground Truth（採点の基準。Prompt本文へは混入させない）。 */
export interface FixtureExpectation {
  /** 期待するローカル所見の要旨 */
  expectedFindings: string[];
  /** 出してはいけない断定 */
  forbiddenAssertions: string[];
  /** 分析不能であることが正しいか */
  expectInsufficient: boolean;
  /** 課題が0件であることが正しいか */
  expectNoIssues: boolean;
}

export interface LocalCoachFixture {
  /** 内部識別子。Prompt本文へは出さない。 */
  key: string;
  /** 人が読むための説明。Prompt本文へは出さない。 */
  description: string;
  current: SessionFixture;
  /** 比較可能な過去セッション（古い順） */
  history: SessionFixture[];
  expectation: FixtureExpectation;
}

const NEUTRAL_ASSESSMENTS: SelfAssessment[] = [
  {
    timing: "before",
    recordedAt: "2026-01-01T09:59:00.000Z",
    fatigue: 3,
    concentration: 7,
    pain: 0,
    confidence: 6,
  },
  {
    timing: "after",
    recordedAt: "2026-01-01T10:40:00.000Z",
    fatigue: 3,
    concentration: 7,
    pain: 0,
    confidence: 6,
  },
];

function makeSession(
  id: string,
  setCount: number,
  overrides?: Partial<TrainingSession>
): TrainingSession {
  return fixtureSession({
    id,
    setCount,
    plannedThrowCount: setCount * 3,
    plannedTargets: Array.from({ length: setCount }, () => [T20, T20, T20]),
    assessments: NEUTRAL_ASSESSMENTS,
    ...overrides,
  });
}

function build(
  id: string,
  specs: FixtureThrowSpec[],
  overrides?: Partial<TrainingSession>,
  mode?: string
): SessionFixture {
  const setCount = Math.ceil(specs.length / 3);
  const session = makeSession(id, setCount, overrides);
  const throws = buildThrows(specs, specs.length).map((t) => ({
    ...t,
    sessionId: id,
  }));
  const stats = calculateStatistics(
    id,
    session.plannedThrowCount,
    throws,
    mode ?? session.trainingMode,
    CALCULATED_AT
  );
  return { session, throws, stats };
}

/** 決定論的な擬似乱数（同じ種から必ず同じ列を返す）。 */
function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 座標入力の投擲列を作る。offset/spread は投順ごとに指定できる。 */
function coordinateSpecs(options: {
  id: string;
  setCount: number;
  /** 投順ごとの中心オフセット [1投目, 2投目, 3投目] */
  offsetX?: [number, number, number];
  offsetY?: [number, number, number];
  /** 投順ごとの散らばり幅 */
  spreadX?: [number, number, number];
  spreadY?: [number, number, number];
  /** 後半（セット後半）で散らばりを何倍にするか */
  secondHalfSpreadFactor?: number;
  seed?: number;
}): FixtureThrowSpec[] {
  const {
    id,
    setCount,
    offsetX = [0, 0, 0],
    offsetY = [0, 0, 0],
    spreadX = [0.03, 0.03, 0.03],
    spreadY = [0.03, 0.03, 0.03],
    secondHalfSpreadFactor = 1,
    seed = 42,
  } = options;
  const random = pseudoRandom(seed);
  const specs: FixtureThrowSpec[] = [];
  const halfSet = Math.ceil(setCount / 2);
  for (let set = 0; set < setCount; set += 1) {
    const factor = set >= halfSet ? secondHalfSpreadFactor : 1;
    for (const dart of [0, 1, 2] as const) {
      const jitterX = (random() - 0.5) * 2;
      const jitterY = (random() - 0.5) * 2;
      specs.push({
        target: T20,
        landing: landingFromCoordinate(
          REP.x + offsetX[dart] + jitterX * spreadX[dart] * factor,
          REP.y + offsetY[dart] + jitterY * spreadY[dart] * factor,
          STEEL_BOARD
        ),
        setId: `${id}-set-${set + 1}`,
      });
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// フィクスチャ本体
// ---------------------------------------------------------------------------

/** 安定: 全投順・前後半で判定基準を超える差が出ない。 */
export function stableFixture(): LocalCoachFixture {
  return {
    key: "stable",
    description: "60投すべてが同程度に安定。課題を作ってはいけない。",
    current: build(
      "stable",
      coordinateSpecs({ id: "stable", setCount: 20, seed: 7 })
    ),
    history: [],
    expectation: {
      expectedFindings: [],
      forbiddenAssertions: ["投順", "後半", "偏り"],
      expectInsufficient: false,
      expectNoIssues: true,
    },
  };
}

/** 3投目のみ悪化（横方向のばらつきが増える）。 */
export function thirdDartFixture(): LocalCoachFixture {
  return {
    key: "third_dart",
    description: "3投目だけ横方向のばらつきが大きい。投順問題として検出されるべき。",
    current: build(
      "third-dart",
      coordinateSpecs({
        id: "third-dart",
        setCount: 20,
        spreadX: [0.03, 0.03, 0.16],
        seed: 11,
      })
    ),
    history: [],
    expectation: {
      expectedFindings: ["3投目", "横方向", "ばらつき"],
      forbiddenAssertions: ["グリップ", "肘", "リリース"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 後半のみ悪化（散らばりが後半で拡大）。 */
export function secondHalfFixture(): LocalCoachFixture {
  return {
    key: "second_half",
    description: "後半のセットで散らばりが拡大。時間区間の問題として検出されるべき。",
    current: build(
      "second-half",
      coordinateSpecs({
        id: "second-half",
        setCount: 20,
        spreadX: [0.03, 0.03, 0.03],
        spreadY: [0.03, 0.03, 0.03],
        secondHalfSpreadFactor: 5,
        seed: 13,
      })
    ),
    history: [],
    expectation: {
      expectedFindings: ["後半"],
      forbiddenAssertions: ["疲労が原因", "集中力"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 系統偏り: 平均が右へ寄っているが散らばりは小さい。 */
export function rightBiasFixture(): LocalCoachFixture {
  return {
    key: "right_bias",
    description: "平均が右へ+0.12寄り、散らばりは小さい。偏りとして検出されるべき。",
    current: build(
      "right-bias",
      coordinateSpecs({
        id: "right-bias",
        setCount: 20,
        offsetX: [0.12, 0.12, 0.12],
        spreadX: [0.03, 0.03, 0.03],
        seed: 17,
      })
    ),
    history: [],
    expectation: {
      expectedFindings: ["横方向", "右"],
      forbiddenAssertions: ["再現性不足", "ばらつきが大きい"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 分散増大: 平均は中央付近だが散らばりが大きい。 */
export function dispersionFixture(): LocalCoachFixture {
  return {
    key: "dispersion",
    description: "平均は0付近だが標準偏差が大きい。再現性不足として検出されるべき。",
    current: build(
      "dispersion",
      coordinateSpecs({
        id: "dispersion",
        setCount: 20,
        offsetX: [0, 0, 0],
        spreadX: [0.28, 0.28, 0.28],
        seed: 19,
      })
    ),
    history: [],
    expectation: {
      expectedFindings: ["ばらつき"],
      forbiddenAssertions: ["寄っています"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 複合問題: 3投目悪化・後半悪化・右偏りが同時に成立。 */
export function compositeFixture(): LocalCoachFixture {
  return {
    key: "composite",
    description:
      "投順・時間区間・偏りが同時に成立。上位2件と未掲載候補の両方が必要。",
    current: build(
      "composite",
      coordinateSpecs({
        id: "composite",
        setCount: 20,
        offsetX: [0.1, 0.1, 0.1],
        spreadX: [0.03, 0.03, 0.18],
        secondHalfSpreadFactor: 3,
        seed: 23,
      })
    ),
    history: [],
    expectation: {
      expectedFindings: ["優先候補1", "優先候補2", "未掲載の検出候補"],
      forbiddenAssertions: ["肘", "肩", "手首"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 9投しかない（最小分析数10投未満）。 */
export function insufficientFixture(): LocalCoachFixture {
  return {
    key: "insufficient",
    description: "9投のみ。原因仮説も練習メニューも生成してはいけない。",
    current: build(
      "insufficient",
      coordinateSpecs({ id: "insufficient", setCount: 3, seed: 29 }),
      { status: "aborted" }
    ),
    history: [],
    expectation: {
      expectedFindings: ["分析可能性: 不足"],
      forbiddenAssertions: ["仮説1", "1変数実験", "優先候補"],
      expectInsufficient: true,
      expectNoIssues: true,
    },
  };
}

/** 簡易入力のみ（座標SD・mm値を出してはいけない）。 */
export function approximateFixture(): LocalCoachFixture {
  const specs: FixtureThrowSpec[] = [];
  for (let i = 0; i < 60; i += 1) {
    // 3回に2回は右側(5)へ外し、外れ方向を右へ偏らせる
    const miss = i % 3 !== 0;
    specs.push({
      target: T20,
      landing: miss
        ? landingFromSegment("outer_single", STEEL_BOARD, 5)
        : landingFromSegment("triple", STEEL_BOARD, 20),
      setId: `approximate-set-${Math.ceil((i + 1) / 3)}`,
    });
  }
  return {
    key: "approximate",
    description: "簡易入力のみ60投。座標由来の標準偏差やmm換算を出してはいけない。",
    current: build("approximate", specs),
    history: [],
    expectation: {
      expectedFindings: ["外れ方向"],
      forbiddenAssertions: ["標準偏差", "mm"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 詳細座標と簡易入力の混在（別母集団として扱う必要がある）。 */
export function mixedInputFixture(): LocalCoachFixture {
  const specs: FixtureThrowSpec[] = [];
  for (let i = 0; i < 60; i += 1) {
    const setId = `mixed-set-${Math.ceil((i + 1) / 3)}`;
    specs.push(
      i < 30
        ? {
            target: T20,
            landing: landingFromCoordinate(
              REP.x + (i % 2 === 0 ? 0.2 : -0.2),
              REP.y,
              STEEL_BOARD
            ),
            setId,
          }
        : {
            target: T20,
            landing: landingFromSegment("outer_single", STEEL_BOARD, 5),
            setId,
          }
    );
  }
  return {
    key: "mixed_input",
    description:
      "詳細座標30投＋簡易入力30投。座標由来の指標は詳細座標30投のみを分母にすべき。",
    current: build("mixed", specs),
    history: [],
    expectation: {
      expectedFindings: ["詳細座標のみ"],
      forbiddenAssertions: [],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 比較可能な履歴あり（個人基準が算出できる）。 */
export function withHistoryFixture(): LocalCoachFixture {
  const history = [0.03, 0.035, 0.04].map((spread, index) =>
    build(
      `history-${index}`,
      coordinateSpecs({
        id: `history-${index}`,
        setCount: 20,
        spreadX: [spread, spread, spread],
        seed: 31 + index,
      }),
      { startedAt: `2026-01-0${index + 1}T10:00:00.000Z` }
    )
  );
  return {
    key: "with_history",
    description:
      "同条件の履歴3件あり。個人基準（過去中央値・変動幅）が算出できる。",
    current: build(
      "with-history",
      coordinateSpecs({
        id: "with-history",
        setCount: 20,
        spreadX: [0.16, 0.16, 0.16],
        seed: 37,
      }),
      { startedAt: "2026-01-05T10:00:00.000Z" }
    ),
    history,
    expectation: {
      expectedFindings: ["本人基準"],
      forbiddenAssertions: [],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 履歴と当日傾向が矛盾（過去より良いのに当日内では悪化）。 */
export function conflictingHistoryFixture(): LocalCoachFixture {
  const history = [0.3, 0.32, 0.34].map((spread, index) =>
    build(
      `conflict-history-${index}`,
      coordinateSpecs({
        id: `conflict-history-${index}`,
        setCount: 20,
        spreadX: [spread, spread, spread],
        seed: 41 + index,
      }),
      { startedAt: `2026-01-0${index + 1}T10:00:00.000Z` }
    )
  );
  return {
    key: "conflicting_history",
    description:
      "過去より全体は良いが、当日内では3投目だけ悪化。個人基準と当日傾向が逆を向く。",
    current: build(
      "conflict",
      coordinateSpecs({
        id: "conflict",
        setCount: 20,
        spreadX: [0.04, 0.04, 0.16],
        seed: 47,
      }),
      { startedAt: "2026-01-05T10:00:00.000Z" }
    ),
    history,
    expectation: {
      expectedFindings: ["3投目"],
      forbiddenAssertions: [],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/**
 * adversarial: ローカルの上位候補が誤りやすいケース。
 * 効果量は大きいが分母が小さい候補と、効果量は中程度だが分母が大きい候補が混在する。
 */
export function adversarialFixture(): LocalCoachFixture {
  const specs: FixtureThrowSpec[] = [];
  for (let set = 0; set < 20; set += 1) {
    const setId = `adversarial-set-${set + 1}`;
    // 1・2投目はT20で安定、3投目はD16（出題数が少ない別ターゲット）
    specs.push({
      target: T20,
      landing: landingFromCoordinate(REP.x + 0.02, REP.y, STEEL_BOARD),
      setId,
    });
    specs.push({
      target: T20,
      landing: landingFromCoordinate(REP.x - 0.02, REP.y, STEEL_BOARD),
      setId,
    });
    specs.push({
      target: D16,
      landing: landingFromCoordinate(
        D16.representativePoint.x + (set % 2 === 0 ? 0.25 : -0.25),
        D16.representativePoint.y,
        STEEL_BOARD
      ),
      setId,
    });
  }
  return {
    key: "adversarial",
    description:
      "3投目のターゲットが別（D16）。投順の問題とターゲット難度の問題が交絡している。",
    current: build("adversarial", specs, {
      plannedTargets: Array.from({ length: 20 }, () => [T20, T20, D16]),
    }),
    history: [],
    expectation: {
      expectedFindings: [],
      // 投順とターゲット難度が交絡しているため、投順固有と断定してはいけない
      forbiddenAssertions: ["投順そのものが原因", "3投目の投げ方が原因"],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 閾値付近の弱い効果（判定基準ぎりぎり）。 */
export function weakEffectFixture(): LocalCoachFixture {
  return {
    key: "weak_effect",
    description:
      "3投目の散らばりが他の投順の約1.3倍。判定基準の直上で、確からしさを高にしてはいけない。",
    current: build(
      "weak-effect",
      coordinateSpecs({
        id: "weak-effect",
        setCount: 20,
        spreadX: [0.05, 0.05, 0.067],
        seed: 53,
      })
    ),
    history: [],
    expectation: {
      expectedFindings: [],
      forbiddenAssertions: [],
      expectInsufficient: false,
      expectNoIssues: false,
    },
  };
}

/** 位置なし（全投擲がバウンスアウト）。 */
export function noPositionFixture(): LocalCoachFixture {
  const specs: FixtureThrowSpec[] = Array.from({ length: 60 }, (_, i) => ({
    target: T20,
    landing: landingBounceOut(),
    setId: `no-position-set-${Math.ceil((i + 1) / 3)}`,
  }));
  return {
    key: "no_position",
    description: "全投擲がバウンスアウト。位置に基づく所見を出してはいけない。",
    current: build("no-position", specs),
    history: [],
    expectation: {
      expectedFindings: [],
      forbiddenAssertions: ["標準偏差", "平均誤差"],
      expectInsufficient: false,
      expectNoIssues: true,
    },
  };
}

/** A/B評価に使う全フィクスチャ（決定論的な順序）。 */
export const ALL_FIXTURES: readonly (() => LocalCoachFixture)[] = [
  stableFixture,
  thirdDartFixture,
  secondHalfFixture,
  rightBiasFixture,
  dispersionFixture,
  compositeFixture,
  insufficientFixture,
  approximateFixture,
  mixedInputFixture,
  withHistoryFixture,
  conflictingHistoryFixture,
  adversarialFixture,
  weakEffectFixture,
  noPositionFixture,
];

/**
 * 主要6 Dataset（A/B評価の平均点を出す対象）。
 * 既存の評価と揃えるため、代表的な6パターンに固定する。
 */
export const PRIMARY_FIXTURE_KEYS: readonly string[] = [
  "stable",
  "third_dart",
  "second_half",
  "right_bias",
  "dispersion",
  "composite",
];
