import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildSessionCsv,
  csvToBlob,
  csvWithBom,
  escapeCsvField,
  UTF8_BOM,
  CSV_COLUMNS,
} from "./csv";
import {
  ANALYSIS_PERSONA,
  OUTPUT_FORMAT_INSTRUCTIONS,
  buildAnalysisMarkdown,
  inputPrecisionModeOf,
} from "./markdown";
import { buildBackup, parseBackup, serializeBackup, validateBackup } from "./backup";
import { calculateStatistics } from "../domain/stats";
import {
  buildThrows,
  fixtureSession,
  handComputedThrows,
  mixedPrecisionThrows,
  T20,
} from "../test/fixtures";
import type { ThrowRecord, TrainingSession } from "../types/models";
import {
  landingFromCoordinate,
  landingBounceOut,
  landingFromSegment,
} from "../domain/landing";
import { fmtNum } from "../utils/format";
import { SOFT_BOARD, STEEL_BOARD } from "../config/boardProfiles";
import { BACKUP_VERSION } from "../config/constants";
import { buildAnalysisZip } from "./zip";
import { buildSkillCheckPlan } from "../domain/skillCheck";

const session = fixtureSession();
const throws = handComputedThrows();
const stats = calculateStatistics(session.id, 6, throws);
const setNumberOf = (setId: string) => Number(setId.replace("set-", ""));

describe("CSV生成", () => {
  it("エスケープ: カンマ・引用符・改行", () => {
    expect(escapeCsvField("plain")).toBe("plain");
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("line\nbreak")).toBe('"line\nbreak"');
  });

  it("ヘッダーと行数", () => {
    const csv = buildSessionCsv(session, throws, setNumberOf);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(1 + throws.length);
  });

  it("行の内容 (1投目)", () => {
    const csv = buildSessionCsv(session, throws, setNumberOf);
    const lines = csv.trim().split("\r\n");
    const first = (lines[1] ?? "").split(",");
    expect(first[0]).toBe(session.id);
    expect(first[CSV_COLUMNS.indexOf("set_number")]).toBe("1");
    expect(first[CSV_COLUMNS.indexOf("dart_in_set")]).toBe("1");
    expect(first[CSV_COLUMNS.indexOf("target_label")]).toBe("T20");
    expect(first[CSV_COLUMNS.indexOf("exact_hit")]).toBe("true");
  });

  it("scoring_style列: 記録ありは値、未記録は空フィールド", () => {
    const styled = fixtureSession({
      trainingMode: "skill_check",
      scoringStyle: "separate_bull",
    });
    const csv = buildSessionCsv(styled, throws, setNumberOf);
    const lines = csv.trim().split("\r\n");
    expect(CSV_COLUMNS).toContain("scoring_style");
    const col = CSV_COLUMNS.indexOf("scoring_style");
    expect((lines[1] ?? "").split(",")[col]).toBe("separate_bull");
    const legacyCsv = buildSessionCsv(session, throws, setNumberOf);
    const legacyLines = legacyCsv.trim().split("\r\n");
    expect((legacyLines[1] ?? "").split(",")[col]).toBe("");
  });

  it("開始・中間・終了の投擲プロセス評価を明確な列へ出力する", () => {
    const assessed = fixtureSession({ assessments: [
      { timing: "before", recordedAt: "2026-01-01T09:00:00Z", fatigue: 1, concentration: 5, pain: 0, confidence: 4, uninterruptedThrowRate: 30, releaseStopTiming: "during_setup" },
      { timing: "middle", recordedAt: "2026-01-01T09:30:00Z", fatigue: 2, concentration: 6, pain: 0, confidence: 5, uninterruptedThrowRate: 50, releaseStopTiming: "before_takeback" },
      { timing: "after", recordedAt: "2026-01-01T10:00:00Z", fatigue: 3, concentration: 7, pain: 0, confidence: 6, uninterruptedThrowRate: 70, releaseStopTiming: "none" },
    ] });
    const first = (buildSessionCsv(assessed, throws, setNumberOf).trim().split("\r\n")[1] ?? "").split(",");
    expect(first[CSV_COLUMNS.indexOf("assessment_before_uninterrupted_throw_rate_percent")]).toBe("30");
    expect(first[CSV_COLUMNS.indexOf("assessment_middle_uninterrupted_throw_rate_percent")]).toBe("50");
    expect(first[CSV_COLUMNS.indexOf("assessment_after_uninterrupted_throw_rate_percent")]).toBe("70");
    expect(first[CSV_COLUMNS.indexOf("assessment_after_release_stop_timing")]).toBe("none");
  });

  it("R4パターンとセット境界の意味をCSV列へ一致させる", () => {
    const target = {
      ...T20,
      evaluationKind: "exact_hit" as const,
      roundId: "skill-r4",
      roundKind: "checkout" as const,
      patternId: "r4-route-20",
      patternKind: "switch" as const,
      analysisCategory: "route20",
    };
    const [record] = buildThrows([{ target, landing: landingFromCoordinate(
      target.representativePoint.x,
      target.representativePoint.y,
      STEEL_BOARD
    ) }], 1);
    const csv = buildSessionCsv(session, [record!], setNumberOf);
    const first = (csv.trim().split("\r\n")[1] ?? "").split(",");
    expect(first[CSV_COLUMNS.indexOf("round_kind")]).toBe("checkout");
    expect(first[CSV_COLUMNS.indexOf("pattern_id")]).toBe("r4-route-20");
    expect(first[CSV_COLUMNS.indexOf("pattern_kind")]).toBe("switch");
    expect(first[CSV_COLUMNS.indexOf("analysis_category")]).toBe("route20");
    expect(first[CSV_COLUMNS.indexOf("pattern_metadata_source")]).toBe("recorded");
    expect(first[CSV_COLUMNS.indexOf("previous_throw_was_hit")]).toBe("");
    expect(first[CSV_COLUMNS.indexOf("same_target_as_previous")]).toBe("");
    expect(first[CSV_COLUMNS.indexOf("target_changed")]).toBe("");
  });

  it("speed_kmh列はtarget_changedの後・elapsed_msの前に位置する", () => {
    const idx = CSV_COLUMNS.indexOf("speed_kmh");
    expect(idx).toBeGreaterThan(-1);
    expect(CSV_COLUMNS[idx - 1]).toBe("target_changed");
    expect(CSV_COLUMNS[idx + 1]).toBe("elapsed_ms");
  });

  it("speed_kmhの小数値を保持し、ヘッダーとデータの列数が一致する", () => {
    const withSpeed = throws.map((record, i) => ({
      ...record,
      ...(i === 0 ? { speedKmh: 58.9 } : {}),
    }));
    const csv = buildSessionCsv(session, withSpeed, setNumberOf);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    const headerCols = lines[0]!.split(",").length;
    expect(headerCols).toBe(CSV_COLUMNS.length);
    const first = lines[1]!.split(",");
    expect(first).toHaveLength(headerCols);
    expect(first[CSV_COLUMNS.indexOf("speed_kmh")]).toBe("58.9");
    // CRLF改行で終端する
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("Unicode・改行・カンマ・引用符を含むメモを正しくエスケープし読み戻せる", () => {
    const trickyNote = 'メモ🎯 "quote", カンマ,\n改行あり';
    const withNote = throws.map((record, i) =>
      i === 0 ? { ...record, note: trickyNote } : record
    );
    const csv = buildSessionCsv(session, withNote, setNumberOf);
    // RFC4180: 引用符は2重化され、フィールドは引用符で囲まれる
    expect(csv).toContain('"メモ🎯 ""quote"", カンマ,\n改行あり"');
    // 引用符内の改行を考慮した簡易パースで読み戻し検証
    const unquoted = csv
      .match(/"((?:[^"]|"")*)"/g)
      ?.map((f) => f.slice(1, -1).replace(/""/g, '"'));
    expect(unquoted).toContain(trickyNote);
  });

  it("speed_kmh列: 記録ありは値、未記録は空フィールド", () => {
    const withSpeed = throws.map((record, i) =>
      i === 0 ? { ...record, speedKmh: 64.2 } : record
    );
    const csv = buildSessionCsv(session, withSpeed, setNumberOf);
    const lines = csv.trim().split("\r\n");
    const col = CSV_COLUMNS.indexOf("speed_kmh");
    expect((lines[1] ?? "").split(",")[col]).toBe("64.2");
    expect((lines[2] ?? "").split(",")[col]).toBe("");
  });

  it("座標なしの投擲は空フィールド", () => {
    const csv = buildSessionCsv(session, throws, setNumberOf);
    const lines = csv.trim().split("\r\n");
    const bounce = (lines[5] ?? "").split(",");
    expect(bounce[CSV_COLUMNS.indexOf("landing_ring")]).toBe("bounce_out");
    expect(bounce[CSV_COLUMNS.indexOf("landing_x")]).toBe("");
    expect(bounce[CSV_COLUMNS.indexOf("error_distance")]).toBe("");
  });

  it("BOM付きBlobを生成する", () => {
    const blob = csvToBlob("a,b\r\n");
    expect(blob.type).toContain("text/csv");
    expect(blob.size).toBeGreaterThan(6);
  });
});

describe("Markdown生成", () => {
  const markdown = buildAnalysisMarkdown({
    session,
    player: undefined,
    equipment: undefined,
    stats,
    throws,
    setNumberOf,
    comparisons: [],
    embedAllThrows: true,
  });

  it("必須セクションを含む", () => {
    for (const heading of [
      "# ダーツ投擲データ分析依頼",
      "## AIへの分析指示",
      "## セッション概要",
      "## 環境情報",
      "## 開始前・中間・終了後の自己評価",
      "## アプリ算出の基本統計",
      "## 過去セッションとの比較",
      "## 全投擲データ",
      "## セッションメモ",
      "## データ利用上の注意",
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("未回答の自己評価を既定値のまま測定値として出力しない", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({
        assessments: [
          {
            timing: "before",
            recordedAt: "2026-01-01T09:59:00.000Z",
            // 既定値のまま送信された(ユーザーが一度も操作していない)ケース
            fatigue: 5,
            concentration: 5,
            pain: 0,
            confidence: 5,
            untouchedScales: ["fatigue", "concentration", "pain", "confidence"],
          },
          {
            timing: "after",
            recordedAt: "2026-01-01T11:00:00.000Z",
            // 疲労度だけ回答し、残りは既定値のまま
            fatigue: 8,
            concentration: 5,
            pain: 0,
            confidence: 5,
            untouchedScales: ["concentration", "pain", "confidence"],
          },
        ],
      }),
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: true,
    });
    // 未回答の項目は値の直後に(未回答)が付く
    expect(md).toContain("| 開始前 | 5(未回答) | 5(未回答) | 0(未回答) | 5(未回答) |");
    // 回答済みの項目には付かない
    expect(md).toContain("| 終了後 | 8 | 5(未回答) | 0(未回答) | 5(未回答) |");
    // AIへ測定値として扱わないよう明示する
    expect(md).toContain("「(未回答)」付きの数値はユーザーが操作しなかった既定値です");
    expect(md).toContain(
      "自己評価の数値に「(未回答)」が付いている項目は、ユーザーが操作しなかった既定値です"
    );
  });

  it("すべて回答済みの自己評価には未回答注記を付けない", () => {
    // fixtureSession の既定 assessments は untouchedScales を持たない
    expect(markdown).toContain("| 開始前 | 3 | 7 | 0 | 6 |");
    // 値へのマーカーも、条件付きの注記行も出さない
    expect(markdown).not.toContain("(未回答) |");
    expect(markdown).not.toContain(
      "「(未回答)」付きの数値はユーザーが操作しなかった既定値です"
    );
  });

  it("分析指示のルールを含む", () => {
    expect(markdown).toContain("医学的診断、心理的診断、性格診断は禁止");
    expect(markdown).toContain("【事実】");
    expect(markdown).toContain("#### 1-2. ユーザーの問題点");
    expect(markdown).toContain("優先して改善すべき項目");
    expect(markdown).toContain("原因候補・仮説");
    expect(markdown).toContain("仮説と矛盾する点");
    expect(markdown).toContain("改善方法（原因仮説を確認するための実験）");
    expect(markdown).toContain("成功判定");
    expect(markdown).toContain("原因を絞り込む追加質問");
    expect(markdown).toContain("ユーザー回答後の再診断");
    expect(markdown).toContain("着弾データだけから");
  });

  it("表面的な言い換えを禁じ、深掘りを必須にする指示を含む", () => {
    expect(markdown).toContain("深掘りの必須要件");
    // 表面的な指摘の例示(数値の言い換え)を禁止していること
    expect(markdown).toContain("そのまま言い換えただけの指摘");
    expect(markdown).toContain("2つ以上の指標・条件を掛け合わせて");
    // ハイライト章でも単一指標の表面的傾向を禁止していること
    expect(markdown).toContain("単一指標で分かる表面的傾向");
  });

  it("役割定義(ペルソナ)を分析指示の冒頭へ置く", () => {
    expect(markdown).toContain(ANALYSIS_PERSONA);
    expect(markdown).toContain("スポーツバイオメカニクス");
    // ペルソナは「## AIへの分析指示」直後、詳細ルールより前に出す
    const heading = markdown.indexOf("## AIへの分析指示");
    const persona = markdown.indexOf(ANALYSIS_PERSONA);
    const rules = markdown.indexOf("## リスクヘッジの置き方");
    expect(heading).toBeGreaterThan(-1);
    expect(persona).toBeGreaterThan(heading);
    expect(persona).toBeLessThan(rules);
  });

  it("思考プロセス(事実抽出→仮説→アクション)の3ステップを含む", () => {
    expect(markdown).toContain("## 思考プロセス(回答を書く前にこの手順で考える)");
    expect(markdown).toContain("**客観的事実の抽出**");
    expect(markdown).toContain("**要因の仮説提示**");
    expect(markdown).toContain("**改善アクション案**");
    // 各ステップが回答構成の章に対応することを明示している
    expect(markdown).toContain("第1章・第2章・第3章にそれぞれ対応");
  });

  it("回答構成を3章立てにし、既存の詳細項目を小見出しとして保持する", () => {
    for (const chapter of [
      "### 1. データの特徴(思考ステップ1: 客観的事実の抽出)",
      "### 2. 考えられる要因（仮説）(思考ステップ2: 要因の仮説提示)",
      "### 3. 次回へのアクション(思考ステップ3: 改善アクション案)",
    ]) {
      expect(markdown).toContain(chapter);
    }
    for (const sub of [
      "#### 1-1. 最重要結論",
      "#### 1-2. ユーザーの問題点",
      "#### 2-1. 原因候補・仮説",
      "#### 2-2. ユーザーが気付いていない可能性がある傾向",
      "#### 3-1. 優先して改善すべき項目",
      "#### 3-2. 改善方法（原因仮説を確認するための実験）",
      "#### 3-3. 原因を絞り込む追加質問",
      "#### 3-4. ユーザー回答後の再診断",
    ]) {
      expect(markdown).toContain(sub);
    }
    // 章の順序が指定どおりであること
    const order = [
      "### 1. データの特徴",
      "### 2. 考えられる要因（仮説）",
      "### 3. 次回へのアクション",
    ].map((h) => markdown.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("出力フォーマット・トーン指定を依頼文の末尾へ置く", () => {
    expect(markdown).toContain("## 回答のフォーマットとトーン");
    expect(markdown).toContain(
      "「1. データの特徴」「2. 考えられる要因（仮説）」「3. 次回へのアクション」の3章構成"
    );
    expect(markdown).toContain("文字数制限は設けず");
    expect(markdown).toContain("前向きで実践的なトーン");
    // 末尾に置く(以降にセクション見出しがない)
    const index = markdown.indexOf("## 回答のフォーマットとトーン");
    expect(index).toBeGreaterThan(markdown.indexOf("## データ利用上の注意"));
    expect(markdown.slice(index + 1).includes("\n## ")).toBe(false);
  });

  it("フォーマット指定でも医学的診断の禁止と分析不能の明示を維持する", () => {
    expect(OUTPUT_FORMAT_INSTRUCTIONS).toContain(
      "医学的診断・心理的診断・性格診断は行わないこと"
    );
    expect(OUTPUT_FORMAT_INSTRUCTIONS).toContain("「分析不能」と明記");
    // 前向きなトーン指定が、課題の曖昧化や確からしさの水増しへ繋がらないこと
    expect(OUTPUT_FORMAT_INSTRUCTIONS).toContain(
      "確からしさを実際より高く述べたり"
    );
  });

  it("全投擲データの表を含む", () => {
    expect(markdown).toContain("| No. | セット | 投順 |");
    expect(markdown).toContain("| T20 |");
    expect(markdown).toContain("evaluation_kind");
    expect(markdown).toContain("same_set_as_previous");
  });

  it("リスクヘッジは冒頭・末尾のみで、本文は踏み込む指示を含む", () => {
    expect(markdown).toContain("回答の冒頭に");
    expect(markdown).toContain("回答の末尾にも");
    expect(markdown).toContain("気付いていないクセ・傾向・改善点");
    expect(markdown).toContain("ぼかし表現を使わず");
  });

  it("矢速の表列を含み、記録ありは値・未記録はN/A", () => {
    const withSpeed = throws.map((record, i) =>
      i === 0 ? { ...record, speedKmh: 64.2 } : record
    );
    const md = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws: withSpeed,
      setNumberOf,
      comparisons: [],
      embedAllThrows: true,
    });
    expect(md).toContain("矢速(km/h)");
    expect(md).toContain("| 64.2 |");
    expect(md).toContain("speed_kmh");
  });

  it("グルーピング統計(径・前後半・投順間距離)と定義をAI出力へ含める", () => {
    const groupingTarget = buildSkillCheckPlan(SOFT_BOARD, 20)[0]![0]!;
    const groupingThrows = buildThrows(
      [
        [0, 0],
        [0.3, 0],
        [0, 0.4],
      ].map(([x, y]) => ({
        target: groupingTarget,
        setId: "grouping-set",
        landing: landingFromCoordinate(x!, y!, SOFT_BOARD),
      })),
      3
    );
    const groupingStats = calculateStatistics("grouping-md", 3, groupingThrows, "skill_check");
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ trainingMode: "skill_check", plannedThrowCount: 3, setCount: 1 }),
      player: undefined,
      equipment: undefined,
      stats: groupingStats,
      throws: groupingThrows,
      setNumberOf: () => 1,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("平均グルーピング径");
    expect(md).toContain("中央値グルーピング径");
    expect(md).toContain("投順間平均距離");
    expect(md).toContain("| セット(実施順) | 3投間最大距離 | 3投間平均距離 |");
    expect(md).toContain("グルーピング径=セット内3投の全ペア距離の最大値");
  });

  it("3投命中セット率のラベルは練習方式で切り替わる", () => {
    const bullTarget = { ...T20 };
    const throws3 = buildThrows(
      [0, 1, 2].map(() => ({
        target: bullTarget,
        setId: "set-1",
        landing: landingFromCoordinate(
          bullTarget.representativePoint.x,
          bullTarget.representativePoint.y,
          STEEL_BOARD
        ),
      })),
      3
    );
    const st = calculateStatistics("zeroone", 3, throws3, "zero_one");
    const build = (arrangement: string) =>
      buildAnalysisMarkdown({
        session: fixtureSession({
          trainingMode: "zero_one",
          arrangement,
          plannedThrowCount: 3,
          setCount: 1,
        }),
        player: undefined,
        equipment: undefined,
        stats: st,
        throws: throws3,
        setNumberOf: () => 1,
        comparisons: [],
        embedAllThrows: false,
      });
    // 同一ターゲット反復ではフィニッシュ成立率と呼ばない
    const repeat = build("same_per_set");
    expect(repeat).toContain("3投すべてターゲットに命中したセット率");
    expect(repeat).not.toContain("フィニッシュ成立率");
    // フィニッシュ3投指定ではフィニッシュ成立率と呼ぶ
    expect(build("fixed_three")).toContain("フィニッシュ成立率");
  });

  it("中断セッションは予定投擲数と完了投擲数を概要の最初に明示する", () => {
    const aborted = fixtureSession({
      status: "aborted",
      plannedThrowCount: 60,
      setCount: 20,
    });
    const md = buildAnalysisMarkdown({
      session: aborted,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("セッション状態: 中断(予定60投中6投で中断)");
    const completedMd = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(completedMd).toContain("セッション状態: 完了");
  });

  it("依頼文は少数標本・フォーム情報なし・公式レーティング算出禁止の指示を含む", () => {
    expect(markdown).toContain("確からしさを「高」にしないでください");
    expect(markdown).toContain("フォーム情報が記録されていない場合は、身体・動作要因を断定的な最有力候補にせず");
    expect(markdown).toContain("公式のPPD・MPR・レーティング");
  });

  it("grouping_onlyは命中数・命中率・投擲命中をN/A表示にする", () => {
    const groupingTarget = buildSkillCheckPlan(SOFT_BOARD, 20)[0]![0]!;
    const groupingThrows = buildThrows(
      [0, 0.01, -0.01].map((x) => ({
        target: groupingTarget,
        setId: "grouping-set",
        landing: landingFromCoordinate(x, 0, SOFT_BOARD),
      })),
      3
    );
    const groupingStats = calculateStatistics("grouping", 3, groupingThrows, "skill_check");
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ trainingMode: "skill_check", plannedThrowCount: 3, setCount: 1 }),
      player: undefined,
      equipment: undefined,
      stats: groupingStats,
      throws: groupingThrows,
      setNumberOf: () => 1,
      comparisons: [],
      embedAllThrows: true,
    });
    expect(md).toContain("| 1投目の着弾点 | 3 | 0 | N/A | N/A |");
    expect(md).toContain("| 1投目の着弾点 |");
    expect(md).not.toContain("| 1投目の着弾点 | 3 | 0 | 0.0% |");
    const csv = buildSessionCsv(session, groupingThrows, () => 1);
    const exactHit = (csv.trim().split("\r\n")[1] ?? "").split(",")[
      CSV_COLUMNS.indexOf("exact_hit")
    ];
    expect(exactHit).toBe("");
  });

  it("R1の前投命中はセット全投でN/A(CSV空欄・Markdown N/A・×を出さない)", () => {
    const groupingTarget = buildSkillCheckPlan(SOFT_BOARD, 20, "fat_bull")[0]![0]!;
    // 2セット(6投)のR1グルーピング。2・3投目は同一セット内の後続投擲。
    const groupingThrows = buildThrows(
      [0, 0.01, -0.01, 0.2, 0.21, 0.19].map((x, i) => ({
        target: groupingTarget,
        setId: `r1-set-${Math.floor(i / 3) + 1}`,
        landing: landingFromCoordinate(x, 0, SOFT_BOARD),
      })),
      6
    );
    const r1Session = fixtureSession({
      trainingMode: "skill_check",
      scoringStyle: "fat_bull",
      plannedThrowCount: 6,
      setCount: 2,
    });
    const setOf = (setId: string) => Number(setId.replace("r1-set-", ""));

    // CSV: exact_hit / previous_throw_was_hit / previous_throw_was_hit_in_same_set は全行空欄。
    const csv = buildSessionCsv(r1Session, groupingThrows, setOf);
    const rows = csv.trim().split("\r\n").slice(1);
    const iExact = CSV_COLUMNS.indexOf("exact_hit");
    const iPrev = CSV_COLUMNS.indexOf("previous_throw_was_hit");
    const iPrevSame = CSV_COLUMNS.indexOf("previous_throw_was_hit_in_same_set");
    const iSameSet = CSV_COLUMNS.indexOf("same_set_as_previous");
    for (const row of rows) {
      const cols = row.split(",");
      expect(cols[iExact]).toBe("");
      expect(cols[iPrev]).toBe("");
      expect(cols[iPrevSame]).toBe("");
    }
    // same_set_as_previous は実関係を保持(2・3投目は true)。
    expect(rows[1]!.split(",")[iSameSet]).toBe("true");
    expect(rows[2]!.split(",")[iSameSet]).toBe("true");

    // Markdown 投擲一覧: previous_throw_was_hit_in_same_set 列に「×」を出さない。
    const md = buildAnalysisMarkdown({
      session: r1Session,
      player: undefined,
      equipment: undefined,
      stats: calculateStatistics("r1", 6, groupingThrows, "skill_check"),
      throws: groupingThrows,
      setNumberOf: setOf,
      comparisons: [],
      embedAllThrows: true,
    });
    // 投擲一覧の行だけを抽出する(精度ラベル「座標」を含むのは投擲一覧行のみ)。
    const throwRows = md
      .split("\n")
      .filter((line) => line.includes("1投目の着弾点") && line.includes("座標"));
    expect(throwRows.length).toBe(6);
    for (const row of throwRows) {
      // 命中列・前投命中列はN/A。× は現れない。
      expect(row).not.toContain(" × ");
    }
  });

  it("R2など通常ラウンドの前投命中は従来どおりtrue/falseを保持する", () => {
    // T20を同一セットで3投(1投目命中→2投目の前投命中=true)。
    const rep = T20.representativePoint;
    const scoringThrows = buildThrows(
      [
        { target: T20, landing: landingFromCoordinate(rep.x, rep.y, STEEL_BOARD), setId: "r2-set-1" },
        { target: T20, landing: landingFromCoordinate(rep.x + 0.5, rep.y, STEEL_BOARD), setId: "r2-set-1" },
        { target: T20, landing: landingFromCoordinate(rep.x, rep.y, STEEL_BOARD), setId: "r2-set-1" },
      ],
      3
    );
    const csv = buildSessionCsv(
      fixtureSession({ trainingMode: "skill_check", scoringStyle: "fat_bull", plannedThrowCount: 3, setCount: 1 }),
      scoringThrows,
      () => 1
    );
    const rows = csv.trim().split("\r\n").slice(1);
    const iPrevSame = CSV_COLUMNS.indexOf("previous_throw_was_hit_in_same_set");
    // 2投目: 前投(1投目)は命中 → true。3投目: 前投(2投目)は外れ → false。
    expect(rows[1]!.split(",")[iPrevSame]).toBe("true");
    expect(rows[2]!.split(",")[iPrevSame]).toBe("false");
  });

  it("投順別表は総投擲数と命中率の分母を分けて表示する", () => {
    const plan = buildSkillCheckPlan(SOFT_BOARD, 20, "fat_bull");
    const skillThrows = buildThrows(
      plan.flatMap((targets, setIndex) =>
        targets.map((target) => ({
          target,
          setId: `skill-set-${setIndex + 1}`,
          landing: landingFromCoordinate(
            target.representativePoint.x,
            target.representativePoint.y,
            SOFT_BOARD
          ),
        }))
      ),
      60
    );
    const skillStats = calculateStatistics("skill-denominator", 60, skillThrows, "skill_check");
    const md = buildAnalysisMarkdown({
      session: fixtureSession({
        id: "skill-denominator",
        trainingMode: "skill_check",
        scoringStyle: "fat_bull",
        plannedThrowCount: 60,
        setCount: 20,
      }),
      player: undefined,
      equipment: undefined,
      stats: skillStats,
      throws: skillThrows,
      setNumberOf: (setId) => Number(setId.replace("skill-set-", "")),
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("| 投順 | 総投擲数 | 命中判定対象数(命中率の分母) |");
    expect(md).toContain("| 1投目 | 20 | 15 | 15 | 100.0% |");
  });

  it("旧R4は観測ターゲット列から安全に補完し未測定パターンを明示する", () => {
    const current = buildSkillCheckPlan(SOFT_BOARD, 20, "fat_bull")[15]!;
    const legacyTargets = current.map((target) => ({
      ...target,
      patternId: undefined,
      patternKind: undefined,
      analysisCategory: undefined,
    }));
    const legacyThrows = buildThrows(
      legacyTargets.map((target) => ({
        target,
        setId: "legacy-r4-set",
        landing: landingFromCoordinate(
          target.representativePoint.x,
          target.representativePoint.y,
          SOFT_BOARD
        ),
      })),
      3
    );
    const legacySession = fixtureSession({
      id: "legacy-r4",
      trainingMode: "skill_check",
      plannedThrowCount: 3,
      setCount: 1,
    });
    const legacyStats = calculateStatistics("legacy-r4", 3, legacyThrows, "skill_check");
    const md = buildAnalysisMarkdown({
      session: legacySession,
      player: undefined,
      equipment: undefined,
      stats: legacyStats,
      throws: legacyThrows,
      setNumberOf: () => 1,
      comparisons: [],
      embedAllThrows: true,
    });
    expect(md).toContain("legacy-observed-fixed-d20-d20-d20");
    expect(md).toContain("inferred_from_observed_targets");
    expect(md).toContain("switchパターン: 未測定（分析不能）");
    const csv = buildSessionCsv(legacySession, legacyThrows, () => 1);
    const first = (csv.trim().split("\r\n")[1] ?? "").split(",");
    expect(first[CSV_COLUMNS.indexOf("pattern_kind")]).toBe("fixed");
    expect(first[CSV_COLUMNS.indexOf("analysis_category")]).toBe("d20_fixed");
    expect(first[CSV_COLUMNS.indexOf("pattern_metadata_source")]).toBe(
      "inferred_from_observed_targets"
    );
  });

  it("座標なしはN/A、バウンスアウトを明示", () => {
    expect(markdown).toContain("N/A");
    expect(markdown).toContain("バウンスアウト");
  });

  it("統計値がアプリ計算と一致する", () => {
    expect(markdown).toContain("完全命中率: 16.7%");
    expect(markdown).toContain("平均誤差距離: 0.150");
  });

  it("モード別の分析焦点セクションを含む (同一ターゲット系)", () => {
    // fixtureSession は same_target → 反復練習の焦点
    expect(markdown).toContain("このセッションの分析焦点(同一ターゲット反復練習)");
    expect(markdown).toContain("該当なし");
  });

  it("モードごとに分析焦点が切り替わる", () => {
    const build = (overrides: Parameters<typeof fixtureSession>[0]) =>
      buildAnalysisMarkdown({
        session: fixtureSession(overrides),
        player: undefined,
        equipment: undefined,
        stats,
        throws,
        setNumberOf,
        comparisons: [],
        embedAllThrows: false,
      });
    expect(build({ trainingMode: "bull" })).toContain(
      "分析焦点(ブル反復練習)"
    );
    expect(build({ trainingMode: "cricket" })).toContain(
      "分析焦点(クリケット練習)"
    );
    expect(build({ trainingMode: "cricket" })).toContain("平均マーク数");
    expect(build({ trainingMode: "random" })).toContain(
      "分析焦点(全体診断)"
    );
    const skillMd = build({
      trainingMode: "skill_check",
      arrangement: "blocks",
    });
    expect(skillMd).toContain("分析焦点(スキル診断)");
    expect(skillMd).toContain("R1 グルーピング(grouping_only)");
    expect(skillMd).toContain("R2 スコアリング(scoring)");
    expect(skillMd).toContain("R3 ナンバー(number)");
    expect(skillMd).toContain("R4 チェックアウト(checkout)");
    expect(skillMd).toContain("100点満点評価や採点基準の創作は禁止");
    expect(
      build({ trainingMode: "zero_one", arrangement: "fixed_three" })
    ).toContain("分析焦点(フィニッシュ3投指定)");
    expect(
      build({ trainingMode: "zero_one", arrangement: "same_per_set" })
    ).toContain("分析焦点(同一ターゲット反復練習)");
  });

  it("スキル診断の分析焦点はスコアリング形式で主役・副が切り替わる", () => {
    const build = (overrides: Parameters<typeof fixtureSession>[0]) =>
      buildAnalysisMarkdown({
        session: fixtureSession(overrides),
        player: undefined,
        equipment: undefined,
        stats,
        throws,
        setNumberOf,
        comparisons: [],
        embedAllThrows: false,
      });
    const fitBull = build({
      trainingMode: "skill_check",
      scoringStyle: "fat_bull",
    });
    expect(fitBull).toContain("ファットブル");
    expect(fitBull).toContain("01の削りの主役ターゲットはBull");
    expect(fitBull).toContain("R3 ナンバー(number): 副ターゲットT20");
    expect(fitBull).toContain("- スコアリング形式: ファットブル");
    const steel = build({
      trainingMode: "skill_check",
      scoringStyle: "steel",
    });
    expect(steel).toContain("ハード(スティール");
    expect(steel).toContain("01の削りの主役ターゲットはT20");
    expect(steel).toContain("R3 ナンバー(number): 副ターゲットBull");
    // 旧データ(形式未記録)はファットブル相当として扱い、その旨を明記する
    const legacy = build({ trainingMode: "skill_check" });
    expect(legacy).toContain("スコアリング形式は記録されていません");
    expect(legacy).toContain("01の削りの主役ターゲットはBull");
    expect(legacy).not.toContain("- スコアリング形式:");
  });

  it("CSV別添方式では表を含めない", () => {
    const summary = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(summary).not.toContain("| No. | セット | 投順 |");
    expect(summary).toContain("CSVファイルを参照");
  });

  it("比較セッションのセクションを出力する", () => {
    const other = fixtureSession({ id: "session-2", startedAt: "2025-12-01T10:00:00.000Z" });
    const otherStats = calculateStatistics("session-2", 6, throws);
    const withCompare = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [{ session: other, stats: otherStats }],
      embedAllThrows: false,
    });
    expect(withCompare).toContain("### 比較対象:");
    expect(withCompare).toContain("差 0.0pt");
  });
});

describe("ZIP出力", () => {
  it("Markdown・CSV・metadata.jsonを正しい内部名で含む", async () => {
    const csv = buildSessionCsv(session, throws, setNumberOf);
    const blob = await buildAnalysisZip("# analysis", csv, session);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      "analysis-request.md",
      "metadata.json",
      "throws.csv",
    ]);
    expect(await zip.file("analysis-request.md")?.async("string")).toBe(
      "# analysis"
    );
    // ZIP内CSVは単独ダウンロード(csvToBlob)と同一バイト列＝BOM付きであること。
    // BOMがないとZIPを展開したCSVだけが日本語版Excelで文字化けする。
    expect(await zip.file("throws.csv")?.async("string")).toBe(csvWithBom(csv));
    const metadata = JSON.parse(
      (await zip.file("metadata.json")?.async("string")) ?? "{}"
    ) as Record<string, unknown>;
    expect(metadata["sessionId"]).toBe(session.id);
    expect(metadata["assessments"]).toEqual(session.assessments);
  });

  it("ZIP内CSVと単独ダウンロードCSVがバイト単位で一致する(BOM込み)", async () => {
    const csv = buildSessionCsv(session, throws, setNumberOf);
    const blob = await buildAnalysisZip("# analysis", csv, session);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = await JSZip.loadAsync(bytes);
    // 実バイト列で比較する(readAsTextはBOMをデコード時に食べてしまうため使わない)
    const inZipBytes = (await zip.file("throws.csv")?.async("uint8array")) ??
      new Uint8Array();
    const standaloneBuffer = await new Promise<ArrayBuffer>(
      (resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(csvToBlob(csv));
      }
    );
    const standaloneBytes = new Uint8Array(standaloneBuffer);
    expect([...inZipBytes]).toEqual([...standaloneBytes]);
    // 先頭3バイトがUTF-8 BOM (EF BB BF) であること
    expect([...inZipBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const inZipText = (await zip.file("throws.csv")?.async("string")) ?? "";
    expect(inZipText.startsWith(UTF8_BOM)).toBe(true);
    // 本文(BOMを除いた部分)も当然一致する
    expect(inZipText.slice(UTF8_BOM.length)).toBe(csv);
  });

  it("csvWithBomはBOMを二重に付けない", () => {
    const once = csvWithBom("a,b\r\n");
    expect(csvWithBom(once)).toBe(once);
    expect(once.startsWith(UTF8_BOM)).toBe(true);
  });

  it("Markdown・CSVのセッションIDが一致し、CSVにspeed_kmhが含まれる", async () => {
    const md = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws: throws.map((record, i) =>
        i === 0 ? { ...record, speedKmh: 64.2 } : record
      ),
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    const csv = buildSessionCsv(
      session,
      throws.map((record, i) =>
        i === 0 ? { ...record, speedKmh: 64.2 } : record
      ),
      setNumberOf
    );
    const blob = await buildAnalysisZip(md, csv, session);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = await JSZip.loadAsync(bytes);
    // ファイル名が重複しない
    const names = Object.keys(zip.files);
    expect(new Set(names).size).toBe(names.length);
    // 展開して両ファイルを読み戻し、セッションIDが一致する
    const mdBack = await zip.file("analysis-request.md")?.async("string");
    const csvBack = await zip.file("throws.csv")?.async("string");
    expect(mdBack).toContain(`セッションID: ${session.id}`);
    expect(csvBack).toContain(session.id);
    expect(csvBack).toContain("speed_kmh");
    expect(csvBack).toContain("64.2");
  });
});

describe("R1グルーピングの前半・後半は結果画面とAI Markdownで同じ共通値を使う", () => {
  const groupingTarget = buildSkillCheckPlan(SOFT_BOARD, 20, "fat_bull")[0]![0]!;
  // 有効セット3件(径 0.2 / 0.4 / 0.6)+ 途中に対象外1件。
  const sets: (number | "excluded")[] = [0.2, "excluded", 0.4, 0.6];
  const specs = sets.flatMap((set, i) => {
    const setId = `g-${i + 1}`;
    if (set === "excluded") {
      return [
        { target: groupingTarget, setId, landing: landingFromCoordinate(0, 0, SOFT_BOARD) },
        { target: groupingTarget, setId, landing: landingBounceOut() },
        { target: groupingTarget, setId, landing: landingFromCoordinate(0, 0, SOFT_BOARD) },
      ];
    }
    return [
      { target: groupingTarget, setId, landing: landingFromCoordinate(0, 0, SOFT_BOARD) },
      { target: groupingTarget, setId, landing: landingFromCoordinate(set, 0, SOFT_BOARD) },
      { target: groupingTarget, setId, landing: landingFromCoordinate(0, 0, SOFT_BOARD) },
    ];
  });
  const gThrows = buildThrows(specs, specs.length);
  const gStats = calculateStatistics("g-md", specs.length, gThrows, "skill_check");

  it("Markdownの前半・後半値は stats.grouping の共通フィールドを3桁丸めで表示する", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ trainingMode: "skill_check", scoringStyle: "fat_bull", plannedThrowCount: specs.length, setCount: sets.length }),
      player: undefined,
      equipment: undefined,
      stats: gStats,
      throws: gThrows,
      setNumberOf: (setId) => Number(setId.replace("g-", "")),
      comparisons: [],
      embedAllThrows: true,
    });
    // 有効セット3件 → 前半[0.2,0.4]=0.3 / 後半[0.6]
    expect(gStats.grouping?.validSetCount).toBe(3);
    const first = fmtNum(gStats.grouping?.firstHalfAverageDiameter);
    const second = fmtNum(gStats.grouping?.secondHalfAverageDiameter);
    // StatsView(結果画面)も同じ stats.grouping.*AverageDiameter を fmtNum で表示する。
    expect(md).toContain(`前半の平均グルーピング径: ${first} / 後半: ${second}`);
    expect(first).toBe("0.300");
  });
});

describe("スコアリング形式の機械可読値 fat_bull への統一と後方互換", () => {
  const readZipMetadata = async (blob: Blob): Promise<Record<string, unknown>> => {
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = await JSZip.loadAsync(bytes);
    return JSON.parse(
      (await zip.file("metadata.json")?.async("string")) ?? "{}"
    ) as Record<string, unknown>;
  };

  it("新規ファットブルセッションのCSV scoring_style は fat_bull", () => {
    const styled = fixtureSession({
      trainingMode: "skill_check",
      scoringStyle: "fat_bull",
    });
    const csv = buildSessionCsv(styled, throws, setNumberOf);
    const col = CSV_COLUMNS.indexOf("scoring_style");
    const value = (csv.trim().split("\r\n")[1] ?? "").split(",")[col];
    expect(value).toBe("fat_bull");
  });

  it("ZIP内 metadata.json の scoringStyle は fat_bull", async () => {
    const styled = fixtureSession({
      trainingMode: "skill_check",
      scoringStyle: "fat_bull",
    });
    const csv = buildSessionCsv(styled, throws, setNumberOf);
    const metadata = await readZipMetadata(
      await buildAnalysisZip("# analysis", csv, styled)
    );
    expect(metadata["scoringStyle"]).toBe("fat_bull");
  });

  it("AI Markdown はファットブル(日本語表示)", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ trainingMode: "skill_check", scoringStyle: "fat_bull" }),
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("- スコアリング形式: ファットブル");
    expect(md).not.toContain("フィットブル");
  });

  it("旧値 fit_bull のセッションは出力時に fat_bull(ファットブル)へ正規化される", () => {
    // 旧データはDB移行・読込正規化で fat_bull になるが、万一残っていても
    // 出力境界(CSV・ZIP・Markdown)で正規化される(後方互換)。
    const legacy = fixtureSession({ trainingMode: "skill_check" });
    // 型に存在しない旧値を後方互換テストとして注入する。
    (legacy as { scoringStyle: string }).scoringStyle = "fit_bull";
    const csv = buildSessionCsv(legacy, throws, setNumberOf);
    const col = CSV_COLUMNS.indexOf("scoring_style");
    expect((csv.trim().split("\r\n")[1] ?? "").split(",")[col]).toBe("fat_bull");
    const md = buildAnalysisMarkdown({
      session: legacy,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("- スコアリング形式: ファットブル");
    expect(md).not.toContain("フィットブル");
  });

  it("セパレートブル・ハードは影響を受けない", () => {
    for (const style of ["separate_bull", "steel"] as const) {
      const styled = fixtureSession({ trainingMode: "skill_check", scoringStyle: style });
      const csv = buildSessionCsv(styled, throws, setNumberOf);
      const col = CSV_COLUMNS.indexOf("scoring_style");
      expect((csv.trim().split("\r\n")[1] ?? "").split(",")[col]).toBe(style);
    }
  });
});

describe("セッティング(装備)の全項目がAI依頼文に含まれる", () => {
  const equipment = {
    schemaVersion: 1,
    id: "equip-1",
    name: "マイダーツ",
    barrel: { maker: "TRiNiDAD", model: "GOMEZ", weightG: 18.5, lengthMm: 45, maxDiameterMm: 6.8 },
    shaft: { maker: "L-style", model: "L-Shaft", lengthMm: 26 },
    flight: { maker: "L-style", model: "L1", shape: "Standard" },
    point: { maker: "CONDOR", model: "Tip", lengthMm: 25 },
    notes: "先端やや長め。冬場は指先が乾く",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("バレル(重量・全長・最大径)・シャフト全長・フライト・ポイント・メモをすべて出力する", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("マイダーツ");
    expect(md).toContain("バレル: TRiNiDAD GOMEZ 18.5g 全長45mm 最大径6.8mm");
    expect(md).toContain("シャフト: L-style L-Shaft 全長26mm");
    expect(md).toContain("フライト: L-style L1 Standard");
    expect(md).toContain("ポイント: CONDOR Tip 全長25mm");
    expect(md).toContain("メモ: 先端やや長め。冬場は指先が乾く");
  });

  it("最小構成(名前のみ)でも壊れない", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: { ...equipment, barrel: undefined, shaft: undefined, flight: undefined, point: undefined, notes: undefined },
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("- セッティング: マイダーツ");
  });
});

describe("目的プロファイル・メンタル評価・長期トレンドの出力", () => {
  const player = {
    schemaVersion: 1,
    id: "player-1",
    displayName: "テスト",
    dominantHand: "right" as const,
    goal: "recovery" as const,
    currentLevel: "レーティング8相当",
    targetLevel: "レーティング12",
    concern: "3投目で失速する",
    defaultBoardType: "soft" as const,
    dartColors: ["#111", "#222", "#333"] as [string, string, string],
    defaultInputMethod: "simple" as const,
    vibrationEnabled: false,
    soundEnabled: false,
    autoAdvanceEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("ユーザーの目的・背景セクションを出力する", () => {
    const md = buildAnalysisMarkdown({
      session,
      player,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("## ユーザーの目的・背景");
    expect(md).toContain("復調・イップス(以前の実力に戻る)");
    expect(md).toContain("レーティング8相当");
    expect(md).toContain("3投目で失速する");
    expect(md).toContain("この目的と悩みに直接応える形で");
    expect(md).toContain("目的別の注意（復調・イップス）");
    expect(md).toContain("医学的・心理的診断はしない");
  });

  it("levelNote があれば実力・目標メモとして出力し、旧レベル欄は出さない", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: {
        ...player,
        levelNote: "安定して80点/R。ダブルが内側に外れやすい",
      },
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("- 実力・目標メモ: 安定して80点/R。ダブルが内側に外れやすい");
    // levelNote 優先時は旧ラベルを出力しない
    expect(md).not.toContain("現在のレベル(自己申告)");
    expect(md).not.toContain("目標レベル:");
  });

  it("levelNote が無い旧データは currentLevel / targetLevel を後方互換で出力する", () => {
    const md = buildAnalysisMarkdown({
      session,
      player, // levelNote 未設定・旧フィールドのみ
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("- 現在のレベル(自己申告): レーティング8相当");
    expect(md).toContain("- 目標レベル: レーティング12");
  });

  it("実力・レーティング向上の目的セクションを出力する", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: { ...player, goal: "rating" as const },
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("- 目的: 実力・レーティング向上");
    expect(md).toContain("目的別の注意（実力・レーティング向上）");
  });

  it("自己申告レーティングをPPD/MPRの目安と目標ギャップつきで出力する", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: {
        ...player,
        goal: "rating" as const,
        currentRating: { system: "darts_live" as const, value: 10 },
        targetRating: { system: "darts_live" as const, value: 12 },
      },
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("現在レーティング: DARTSLIVE Rt10");
    expect(md).toContain("目標レーティング: DARTSLIVE Rt12");
    // Rt10 PPD25.00→Rt12 PPD28.34 (+3.34) / MPR2.65→3.05 (+0.40)
    expect(md).toContain("01のPPDを約+3.34、クリケットのMPRを約+0.40");
    expect(md).toContain("非公式の対応表による参考値");
  });

  it("レーティング未設定なら参照ブロックを出力しない", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: { ...player, currentRating: undefined, targetRating: undefined },
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).not.toContain("現在レーティング:");
    expect(md).not.toContain("非公式の対応表");
  });

  it("プロ志望でもベンチマーク未記録なら合否を断定させない", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ contextSnapshot: {
        capturedAt: "2026-01-01T09:59:00.000Z",
        displayName: "プロ志望",
        dominantHand: "right",
        goal: "pro",
        dartColors: ["#111", "#222", "#333"],
        boardType: "steel",
        inputMethod: "coordinate",
      } }),
      player,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("プロテストの合否を断定しない");
    expect(md).toContain("JAPANプロテスト基準を推測・創作しない");
  });

  it("開始時スナップショットは現在の人物・用品変更に影響されない", () => {
    const snapshotted = fixtureSession({ contextSnapshot: {
      capturedAt: "2026-01-01T09:59:00.000Z",
      displayName: "開始時の復調ユーザー",
      dominantHand: "left",
      goal: "recovery",
      currentLevel: "Rt8",
      targetLevel: "Rt16",
      concern: "リリースの怖さ",
      form: {
        gripFingerCount: "3",
        gripPosition: "center",
        takeback: "standard",
        throwingTempo: "slow",
        concern: "開始時は3投目で腕が止まる",
      },
      dartColors: ["#111", "#222", "#333"],
      boardType: "steel",
      inputMethod: "coordinate",
      equipmentSnapshot: { name: "開始時セッティング", barrel: { model: "OLD" } },
    } });
    const currentEquipment = {
      schemaVersion: 2,
      id: "equipment-current",
      name: "変更後セッティング",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const md = buildAnalysisMarkdown({
      session: snapshotted,
      player: {
        ...player,
        displayName: "変更後ユーザー",
        goal: "pro",
        form: { gripFingerCount: "4", concern: "変更後フォーム" },
      },
      equipment: currentEquipment,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("開始時の復調ユーザー");
    expect(md).toContain("開始時セッティング");
    expect(md).toContain("3フィンガー");
    expect(md).toContain("開始時は3投目で腕が止まる");
    expect(md).not.toContain("変更後ユーザー");
    expect(md).not.toContain("変更後セッティング");
    expect(md).not.toContain("変更後フォーム");
  });

  it("開始時に用品未選択なら現在用品へフォールバックしない", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ contextSnapshot: {
        capturedAt: "2026-01-01T09:59:00.000Z",
        displayName: "用品なし",
        dominantHand: "right",
        dartColors: ["#111", "#222", "#333"],
        boardType: "steel",
        inputMethod: "coordinate",
      } }),
      player,
      equipment: {
        schemaVersion: 2, id: "later", name: "後日追加用品",
        createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      },
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("セッティング: N/A");
    expect(md).not.toContain("後日追加用品");
  });

  it("目的未設定なら目的セクションを出力しない", () => {
    const md = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).not.toContain("## ユーザーの目的・背景");
  });

  it("メンタル評価があると自己評価表に列が追加される", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({
        assessments: [
          {
            timing: "before",
            recordedAt: "2026-01-01T09:59:00.000Z",
            fatigue: 3,
            concentration: 7,
            pain: 0,
            confidence: 6,
            anxiety: 8,
            releaseFear: 6,
            routineAdherence: 4,
          },
        ],
      }),
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      embedAllThrows: false,
    });
    expect(md).toContain("投げる前の不安");
    expect(md).toContain("リリースの怖さ");
    expect(md).toContain("| 8 | 6 | 4 |");
    expect(md).toContain("心理的・医学的診断ではない");
  });

  it("30%→50%→70%の時間変化と旧データN/Aを表で出力する", () => {
    const md = buildAnalysisMarkdown({
      session: fixtureSession({ assessments: [
        { timing: "before", recordedAt: "2026-01-01T09:00:00Z", fatigue: 1, concentration: 5, pain: 0, confidence: 4, uninterruptedThrowRate: 30, releaseStopTiming: "during_setup" },
        { timing: "middle", recordedAt: "2026-01-01T09:30:00Z", fatigue: 2, concentration: 6, pain: 0, confidence: 5, uninterruptedThrowRate: 50, releaseStopTiming: "before_takeback" },
        { timing: "after", recordedAt: "2026-01-01T10:00:00Z", fatigue: 3, concentration: 7, pain: 0, confidence: 6, uninterruptedThrowRate: 70, releaseStopTiming: "none" },
      ] }),
      player: undefined, equipment: undefined, stats, throws, setNumberOf,
      comparisons: [], embedAllThrows: false,
    });
    expect(md).toContain("| 開始前 | 1 | 5 | 0 | 4 | N/A | N/A | N/A | 30% | セットアップ中 |");
    expect(md).toContain("| 中間 | 2 | 6 | 0 | 5 | N/A | N/A | N/A | 50% | テイクバック開始前 |");
    expect(md).toContain("| 終了後 | 3 | 7 | 0 | 6 | N/A | N/A | N/A | 70% | なし |");
  });

  it("長期トレンドセクションを出力する", () => {
    const past = fixtureSession({
      id: "session-past",
      startedAt: "2025-12-01T10:00:00.000Z",
    });
    const pastStats = calculateStatistics("session-past", 6, throws);
    const md = buildAnalysisMarkdown({
      session,
      player: undefined,
      equipment: undefined,
      stats,
      throws,
      setNumberOf,
      comparisons: [],
      recentSessions: [{ session: past, stats: pastStats }],
      embedAllThrows: false,
    });
    expect(md).toContain("## 長期トレンド");
    expect(md).toContain("2025/12/01");
    expect(md).toContain("| 今回");
    expect(md).toContain("改善中/停滞/悪化");
  });
});

describe("60投セッションの通し検証 (統計→Markdown→CSV)", () => {
  // 20セット×3投=60投。T20狙いで規則的な着弾を生成
  const specs = Array.from({ length: 60 }, (_, i) => {
    const rep = T20.representativePoint;
    const dx = ((i % 5) - 2) * 0.03;
    const dy = ((i % 7) - 3) * 0.02;
    return {
      target: T20,
      landing: landingFromCoordinate(rep.x + dx, rep.y + dy, STEEL_BOARD),
    };
  });
  const throws60 = buildThrows(specs, 60);
  const session60 = fixtureSession({
    setCount: 20,
    plannedThrowCount: 60,
  });
  const stats60 = calculateStatistics(session60.id, 60, throws60);

  it("60投すべてが統計に反映される", () => {
    expect(stats60.completedThrows).toBe(60);
    expect(
      stats60.byDartInSet["1"].throwCount +
        stats60.byDartInSet["2"].throwCount +
        stats60.byDartInSet["3"].throwCount
    ).toBe(60);
    expect(stats60.firstHalf.throwCount + stats60.secondHalf.throwCount).toBe(60);
    expect(stats60.combinedError.sampleCount).toBe(60);
  });

  it("Markdownに60投分の行が含まれる", () => {
    const md = buildAnalysisMarkdown({
      session: session60,
      player: undefined,
      equipment: undefined,
      stats: stats60,
      throws: throws60,
      setNumberOf,
      comparisons: [],
      embedAllThrows: true,
    });
    const rows = md
      .split("\n")
      .filter((line) => /^ \| \d+ \| \d+ \|/.test(line) || /^\| \d+ \|/.test(line.trim()));
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(md).toContain("- 完了投擲数: 60");
  });

  it("CSVに60行のデータが含まれる", () => {
    const csv = buildSessionCsv(session60, throws60, setNumberOf);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(1 + 60);
  });
});

describe("JSONバックアップ検証", () => {
  const backup = buildBackup({
    settings: [],
    players: [],
    equipmentProfiles: [],
    trainingPlans: [],
    sessions: [session],
    throwSets: [],
    throws,
    sessionStatistics: [stats],
  });

  it("バックアップのメタ情報", () => {
    expect(backup.format).toBe("darts-training-analyzer-backup");
    expect(backup.backupVersion).toBe(BACKUP_VERSION);
    expect(backup.counts["sessions"]).toBe(1);
    expect(backup.counts["throws"]).toBe(6);
  });

  it("正常なバックアップは検証を通過する", () => {
    const result = parseBackup(serializeBackup(backup));
    expect(result.ok).toBe(true);
    expect(result.counts?.["throws"]).toBe(6);
  });

  it("投擲プロセス評価をJSONバックアップ・復元で維持する", () => {
    const assessed = fixtureSession({ assessments: [{
      timing: "after", recordedAt: "2026-01-01T10:00:00Z",
      fatigue: 3, concentration: 7, pain: 0, confidence: 6,
      uninterruptedThrowRate: 70, releaseStopTiming: "before_release",
    }] });
    const value = buildBackup({
      settings: [], players: [], equipmentProfiles: [], trainingPlans: [],
      sessions: [assessed], throwSets: [], throws: [], sessionStatistics: [],
    });
    const restored = parseBackup(serializeBackup(value)).backup;
    expect(restored?.data.sessions[0]?.assessments[0]).toMatchObject({
      uninterruptedThrowRate: 70,
      releaseStopTiming: "before_release",
    });
  });

  it("旧バックアップv1/v2も引き続き読み込める", () => {
    expect(validateBackup({ ...backup, backupVersion: 1 }).ok).toBe(true);
    expect(validateBackup({ ...backup, backupVersion: 2 }).ok).toBe(true);
  });

  it("不正なJSONは拒否する", () => {
    expect(parseBackup("not json").ok).toBe(false);
    expect(parseBackup("{}").ok).toBe(false);
  });

  it("formatが違うファイルは拒否する", () => {
    expect(validateBackup({ format: "other", backupVersion: 1, data: {} }).ok).toBe(false);
  });

  it("新しすぎるバージョンは拒否する", () => {
    const result = validateBackup({
      ...backup,
      backupVersion: BACKUP_VERSION + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("version_too_new");
  });

  it("ストア欠落は拒否する", () => {
    const broken = JSON.parse(serializeBackup(backup)) as {
      data: Record<string, unknown>;
    };
    delete broken.data["throws"];
    expect(validateBackup(broken).ok).toBe(false);
  });

  it("idを持たないレコードは拒否する", () => {
    const broken = JSON.parse(serializeBackup(backup)) as {
      data: { sessions: Record<string, unknown>[] };
    };
    broken.data.sessions = [{ notId: true }];
    expect(validateBackup(broken).ok).toBe(false);
  });
});

describe("入力精度に応じた分析指示の切替", () => {
  const build = (
    records: readonly ThrowRecord[],
    overrides?: Partial<TrainingSession>
  ) => {
    const s = fixtureSession(overrides);
    return buildAnalysisMarkdown({
      session: s,
      player: undefined,
      equipment: undefined,
      stats: calculateStatistics(s.id, records.length, records),
      throws: records,
      setNumberOf,
      comparisons: [],
      embedAllThrows: true,
    });
  };
  const segmentThrows = buildThrows(
    [
      { target: T20, landing: landingFromSegment("triple", STEEL_BOARD, 20) },
      { target: T20, landing: landingFromSegment("outer_single", STEEL_BOARD, 5) },
      { target: T20, landing: landingFromSegment("outer_single", STEEL_BOARD, 1) },
    ],
    3
  );

  it("記録済み着弾の精度から区分を判定する", () => {
    const coordinateSession = fixtureSession();
    expect(
      inputPrecisionModeOf(
        calculateStatistics("s", 6, throws),
        coordinateSession
      )
    ).toBe("coordinate");
    expect(
      inputPrecisionModeOf(
        calculateStatistics("s", 3, segmentThrows),
        fixtureSession({ inputMethod: "simple" })
      )
    ).toBe("simple");
    expect(
      inputPrecisionModeOf(
        calculateStatistics("s", 3, mixedPrecisionThrows()),
        coordinateSession
      )
    ).toBe("mixed");
  });

  it("精度付きの着弾が1件もなければセッション設定へフォールバックする", () => {
    const bounceOnly = buildThrows(
      [{ target: T20, landing: landingBounceOut() }],
      1
    );
    const stats1 = calculateStatistics("s", 1, bounceOnly);
    expect(stats1.coordinateInputCount).toBe(0);
    expect(stats1.approximateInputCount).toBe(0);
    expect(inputPrecisionModeOf(stats1, fixtureSession())).toBe("coordinate");
    expect(
      inputPrecisionModeOf(stats1, fixtureSession({ inputMethod: "simple" }))
    ).toBe("simple");
    // スナップショットの入力方式を優先する
    expect(
      inputPrecisionModeOf(
        stats1,
        fixtureSession({
          inputMethod: "coordinate",
          contextSnapshot: {
            capturedAt: "2026-01-01T10:00:00.000Z",
            displayName: "P",
            dominantHand: "right",
            dartColors: ["#000", "#111", "#222"],
            boardType: "steel",
            inputMethod: "simple",
          },
        })
      )
    ).toBe("simple");
  });

  it("詳細座標入力では左右・上下の偏差を個別に分析させる", () => {
    const md = build(throws);
    expect(md).toContain("### 入力精度に応じた分析指示");
    expect(md).toContain("本データは詳細なX/Y座標");
    expect(md).toContain("左右の偏差(テイクバック・リリースラインに関わる軸)");
    expect(md).toContain("上下の偏差(リリースポイント・高低差に関わる軸)");
    expect(md).toContain("分けて集計・評価");
    // 簡易入力向けの指示は出さない
    expect(md).not.toContain("本データはセグメント単位の簡易入力です");
  });

  it("簡易入力では命中率と確率推移を中心に分析させる", () => {
    const md = build(segmentThrows, { inputMethod: "simple" });
    expect(md).toContain("本データはセグメント単位の簡易入力です");
    expect(md).toContain("ミリ単位の誤差ではなく");
    expect(md).toContain("投順・セット間での確率推移");
    expect(md).toContain("グルーピング径の絶対値");
    expect(md).not.toContain("本データは詳細なX/Y座標");
  });

  it("混在セッションでは精度ごとに扱いを分けさせる", () => {
    const md = build(mixedPrecisionThrows());
    expect(md).toContain("詳細座標入力と簡易入力が混在しています");
    expect(md).toContain("同じ測定値として合算した結論を出さないでください");
    expect(md).toContain("- 着弾記録の内訳: 詳細座標入力 1投 / 簡易入力(セグメント単位) 2投");
  });

  it("正規化座標のmm換算係数をボード種別に応じて示す", () => {
    expect(build(throws)).toContain(
      "ボード半径 170mm を掛けてください(誤差距離0.10 ≒ 17mm)"
    );
    const soft = build(throws, {
      boardType: "soft",
      boardProfileId: "soft_155",
    });
    expect(soft).toContain(
      "ボード半径 196mm を掛けてください(誤差距離0.10 ≒ 20mm)"
    );
  });
});
