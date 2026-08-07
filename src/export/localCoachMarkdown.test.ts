import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { STEEL_BOARD } from "../config/boardProfiles";
import { MAX_EMBEDDED_MARKDOWN_CHARS } from "../config/constants";
import { landingFromCoordinate } from "../domain/landing";
import { calculateStatistics } from "../domain/stats";
import {
  ENGINE_VERSION,
  MAX_INSUFFICIENT_SECTION_CHARS,
  MAX_LOCAL_COACH_SECTION_CHARS,
} from "../domain/localCoach/config";
import { buildThrows, fixtureSession, T20 } from "../test/fixtures";
import type { FixtureThrowSpec } from "../test/fixtures";
import type { SessionStatistics, TrainingSession } from "../types/models";
import { analyzeLocalCoach } from "../domain/localCoach/analyzeLocalCoach";
import { buildSessionCsv } from "./csv";
import {
  ANALYSIS_INSTRUCTIONS,
  OUTPUT_FORMAT_INSTRUCTIONS,
  buildAnalysisMarkdown,
  inputPrecisionSection,
  inputPrecisionModeOf,
} from "./markdown";
import {
  LOCAL_COACH_HANDLING_HEADING,
  LOCAL_COACH_HANDLING_INSTRUCTIONS,
  LOCAL_COACH_SECTION_HEADING,
  buildLocalCoachMarkdown,
  fmtRelativeDiff,
} from "./localCoachMarkdown";
import { buildAnalysisZip } from "./zip";

const REP = T20.representativePoint;
const CALCULATED_AT = "2026-01-01T11:00:00.000Z";

function scenario(setCount: number) {
  const specs: FixtureThrowSpec[] = [];
  for (let set = 0; set < setCount; set += 1) {
    for (const dart of [1, 2, 3] as const) {
      const spread = dart === 3 ? 0.18 : 0.02;
      const sign = set % 2 === 0 ? 1 : -1;
      const jitter = ((set % 5) - 2) / 10;
      specs.push({
        target: T20,
        landing: landingFromCoordinate(
          REP.x + sign * spread * (1 + jitter),
          REP.y + jitter * 0.02,
          STEEL_BOARD
        ),
        setId: `set-${set + 1}`,
      });
    }
  }
  const session: TrainingSession = fixtureSession({
    setCount,
    plannedThrowCount: setCount * 3,
    plannedTargets: Array.from({ length: setCount }, () => [T20, T20, T20]),
    status: setCount >= 20 ? "completed" : "aborted",
  });
  const throws = buildThrows(specs, setCount * 3);
  const stats: SessionStatistics = calculateStatistics(
    session.id,
    session.plannedThrowCount,
    throws,
    session.trainingMode,
    CALCULATED_AT
  );
  return { session, throws, stats };
}

const setNumberOf = (setId: string) => Number(setId.replace("set-", ""));

function markdownOf(
  data: ReturnType<typeof scenario>,
  embedAllThrows: boolean
): string {
  return buildAnalysisMarkdown({
    session: data.session,
    player: undefined,
    equipment: undefined,
    stats: data.stats,
    throws: data.throws,
    setNumberOf,
    comparisons: [],
    embedAllThrows,
  });
}

/** ローカルコーチ節（見出しから次の "## " まで）を切り出す。 */
function localCoachSection(markdown: string): string {
  const start = markdown.indexOf(LOCAL_COACH_SECTION_HEADING);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + LOCAL_COACH_SECTION_HEADING.length);
  const end = rest.indexOf("\n## ");
  return LOCAL_COACH_SECTION_HEADING + (end === -1 ? rest : rest.slice(0, end));
}

describe("AI依頼文へのローカルコーチ分析の埋め込み", () => {
  const rich = scenario(20);

  it("ローカルコーチの見出しが1回だけ出力される", () => {
    for (const embed of [true, false]) {
      const md = markdownOf(rich, embed);
      const occurrences = md.split(LOCAL_COACH_SECTION_HEADING).length - 1;
      expect(occurrences, `embedAllThrows=${embed}`).toBe(1);
      const handling = md.split(LOCAL_COACH_HANDLING_HEADING).length - 1;
      expect(handling, `embedAllThrows=${embed}`).toBe(1);
    }
  });

  it("生成AIではない旨とエンジンバージョンが表示される", () => {
    const section = localCoachSection(markdownOf(rich, true));
    expect(section).toContain(
      "アプリ内の決定ルールと統計計算による事前評価です。生成AIの回答でも最終結論でもありません。"
    );
    expect(section).toContain(`エンジン: ${ENGINE_VERSION}`);
    expect(ENGINE_VERSION).toBe("local-coach-v3.0");
  });

  it("外部AIへ独立検証を要求する指示が含まれる", () => {
    const md = markdownOf(rich, true);
    expect(md).toContain(LOCAL_COACH_HANDLING_INSTRUCTIONS);
    // 統計値・全投擲データはローカルコーチ節より「前」に出力されるため、
    // 「後続の」ではなく「この依頼文に含まれる」と表現していること
    expect(md).toContain("ローカル所見を最終結論として採用しない");
    expect(md).toContain(
      "この依頼文に含まれる統計値と全投擲データ(または添付CSV)から、あなた自身で上位の傾向を独立に作る。"
    );
    // 統計値はローカルコーチ節より「前」に出力されるため「後続の」とは書かない
    expect(md).not.toContain("後続の統計値");
    expect(md).toContain(
      "一致した候補・一致しなかった候補・ローカルが検出していない候補を明示する。"
    );
    expect(md).toContain("観測事実と原因仮説を分けて書く。");
    expect(md).toContain("ローカルの順位に引きずられない");
  });

  it("embedAllThrows=true と false の両方で同じローカルコーチ分析が出力される", () => {
    const embedded = localCoachSection(markdownOf(rich, true));
    const attached = localCoachSection(markdownOf(rich, false));
    expect(attached).toBe(embedded);
    expect(embedded.length).toBeGreaterThan(0);
  });

  it("ZIP内のanalysis-request.mdと単独生成Markdownが一致する", async () => {
    const md = markdownOf(rich, false);
    const csv = buildSessionCsv(rich.session, rich.throws, setNumberOf);
    const blob = await buildAnalysisZip(md, csv, rich.session);
    // jsdom の Blob には arrayBuffer() がないため FileReader を使う（既存テストと同じ方式）
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const zip = await JSZip.loadAsync(bytes);
    const inZip = await zip.file("analysis-request.md")!.async("string");
    expect(inZip).toBe(md);
    expect(localCoachSection(inZip)).toBe(localCoachSection(md));
  });

  it("文字数プレビューに使う生成結果へも反映される（生成が純粋関数で一致する）", () => {
    const a = markdownOf(rich, true);
    const b = markdownOf(rich, true);
    expect(b).toBe(a);
    expect(a.length).toBeGreaterThan(MAX_EMBEDDED_MARKDOWN_CHARS);
  });

  it("ローカルコーチ節は1,800文字を超えない", () => {
    for (const data of [rich, scenario(3), scenario(40)]) {
      for (const embed of [true, false]) {
        const section = localCoachSection(markdownOf(data, embed));
        expect(section.length).toBeLessThanOrEqual(MAX_LOCAL_COACH_SECTION_CHARS);
      }
    }
  });

  it("配置がセッション概要・統計・比較のあと、データ利用上の注意と出力フォーマット指定の前になる", () => {
    const md = markdownOf(rich, true);
    const order = [
      "## セッション概要",
      "## アプリ算出の基本統計",
      "## 過去セッションとの比較",
      LOCAL_COACH_SECTION_HEADING,
      LOCAL_COACH_HANDLING_HEADING,
      "## データ利用上の注意",
      "## 回答のフォーマットとトーン",
    ].map((heading) => md.indexOf(heading));
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i], `${i}番目の見出しの順序`).toBeGreaterThan(order[i - 1]!);
    }
  });

  it("既存のAI分析指示・入力精度別指示・診断禁止ルールを削除していない", () => {
    const md = markdownOf(rich, true);
    expect(md).toContain(ANALYSIS_INSTRUCTIONS);
    expect(md).toContain(OUTPUT_FORMAT_INSTRUCTIONS);
    expect(md).toContain(
      inputPrecisionSection(inputPrecisionModeOf(rich.stats), rich.stats, rich.session)
    );
    expect(md).toContain("### 入力精度に応じた分析指示");
    expect(md).toContain("医学的診断、心理的診断、性格診断は禁止です。");
    expect(md).toContain(
      "このデータは個人のトレーニング記録です。分析は運動学習の参考情報であり、医学的診断を行わないでください。"
    );
  });

  it("数値の丸め規則が既存フォーマットと一致する", () => {
    const section = localCoachSection(markdownOf(rich, true));
    // 正規化座標は小数3桁 (fmtNum)
    expect(section).toMatch(/ばらつき\(標準偏差\): \d+\.\d{3} /);
    // 率は小数1桁の% (fmtRate)、相対差は "pt" ではなく "%"
    expect(fmtRelativeDiff(0.1234)).toBe("+12.3%");
    expect(fmtRelativeDiff(-0.1234)).toBe("-12.3%");
    expect(fmtRelativeDiff(undefined)).toBe("N/A");
    // 分母が必ず併記される
    expect(section).toMatch(/分母\d+/);
  });

  it("身体動作・医学・心理の断定を含む見出しを出力しない", () => {
    const section = localCoachSection(markdownOf(rich, true));
    // 「判断できないこと」として列挙するのは可。断定形の文言がないことを確認する。
    for (const phrase of [
      "肘が下がっています",
      "肩が開いています",
      "手首を使いすぎています",
      "グリップが強くなっています",
      "リリースが早い",
      "メンタルが弱い",
      "集中力がない",
      "イップス",
    ]) {
      expect(section, phrase).not.toContain(phrase);
    }
  });
});

describe("v3 Markdown 要件", () => {
  it("未掲載の検出候補を短い補助情報として出す（存在を隠さない）", () => {
    // 複合的な問題があるセッションでは検出候補が3件以上になる
    const data = scenario(20);
    const report = analyzeLocalCoach({
      session: data.session,
      stats: data.stats,
      throws: data.throws,
    });
    if (report.allCandidates.length <= 1) return; // 候補が1件なら対象外
    const section = localCoachSection(markdownOf(data, true));
    expect(section).toContain("未掲載の検出候補");
    // 未掲載候補は1行の短い形式（優先度と確からしさのみ）
    const lines = section
      .split("\n")
      .filter((line) => /^- .+（優先度\d+位・確からしさ[高中低]）$/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // 詳細（根拠の数値・仮説・実験）は含めない
      expect(line).not.toContain("分母");
      expect(line).not.toContain("仮説");
      expect(line.length).toBeLessThan(120);
    }
  });

  it("強い断定表現を使わない（候補・可能性として提示する）", () => {
    const section = localCoachSection(markdownOf(scenario(20), true));
    // 断定的な見出し・言い回しを使わない
    for (const phrase of [
      "最優先の課題",
      "原因は",
      "が原因です",
      "断定できます",
      "確実に",
      "必ず改善します",
    ]) {
      expect(section, phrase).not.toContain(phrase);
    }
    // 順位がローカルルール上のものであることを明示する
    expect(section).toContain("ローカルルール上の優先候補");
    // 原因候補は未検証であることを明示する
    expect(section).toContain("原因候補(未検証。次回の実験で確認する)");
  });

  it("undefined・NaN・Infinity を出力しない", () => {
    for (const setCount of [2, 3, 20, 40]) {
      const section = localCoachSection(markdownOf(scenario(setCount), true));
      expect(section, `setCount=${setCount}`).not.toContain("undefined");
      expect(section, `setCount=${setCount}`).not.toContain("NaN");
      expect(section, `setCount=${setCount}`).not.toContain("Infinity");
    }
  });
});

describe("データ不足時のローカルコーチ表示", () => {
  const scarce = scenario(2); // 6投

  it("架空の分析を生成せず、分析不能として理由を示す", () => {
    const section = localCoachSection(markdownOf(scarce, true));
    expect(section).toContain("分析可能性: 不足");
    expect(section).toContain("判定できない項目と理由:");
    expect(section).toContain("完了投擲数が最低分析数10投を下回っています");
    // 次回に必要な投擲数と入力精度を示す
    expect(section).toContain("次回の必要条件");
    expect(section).toContain("最低30投");
    expect(section).toContain("詳細座標入力が必要");
    // 分析不能時は仮説・実験・定型の身体原因リストを出さない
    expect(section).toContain("今回は原因仮説・練習メニューを生成しません");
    expect(section).not.toContain("優先候補");
    expect(section).not.toContain("1変数実験");
    expect(section).not.toContain("仮説1");
    expect(section).not.toContain("グリップ圧の変化");
    // 通常ケースより短いこと
    expect(section.length).toBeLessThanOrEqual(MAX_INSUFFICIENT_SECTION_CHARS);
  });

  it("分析不能でも外部AIへの独立検証指示は維持される", () => {
    const md = markdownOf(scarce, true);
    expect(md).toContain(LOCAL_COACH_HANDLING_INSTRUCTIONS);
  });
});

describe("ローカルコーチMarkdownの整形（単体）", () => {
  it("分母0はN/Aとして表示し、0%として扱わない", () => {
    const section = buildLocalCoachMarkdown({
      engineVersion: ENGINE_VERSION,
      generatedFrom: {
        completedThrows: 30,
        plannedThrowCount: 30,
        completionRatio: 1,
        coordinateInputCount: 30,
        approximateInputCount: 0,
        comparisonSessionCount: 0,
        comparisonSources: [],
        scopes: [],
      },
      analyzable: true,
      allCandidates: [],
      unrankedCandidates: [],
      issueFindings: [
        {
          id: "x",
          kind: "statistical_trend",
          priority: 1,
          effect: 0.5,
          severity: 0.35,
          title: "t",
          summary: "s",
          confidence: "medium",
          evidence: [{ metric: "未測定の指標", sampleSize: 0, unit: "rate" }],
          limitations: [],
        },
      ],
      unavailableReasons: [],
    });
    expect(section).toContain("- 未測定の指標: N/A / 分母0(N/A)");
    expect(section).not.toContain("0.0%");
  });

  it("良かった点・課題・推奨メニューの見出しが上限件数どおりに並ぶ", () => {
    const section = localCoachSection(markdownOf(scenario(20), true));
    expect(section.split("### ローカルルール上の優先候補1").length - 1).toBe(1);
    expect(section.split("### ローカルルール上の優先候補2").length - 1).toBeLessThanOrEqual(1);
    expect(section.split("### 次回の1変数実験").length - 1).toBeLessThanOrEqual(1);
    // 強い断定に見える旧見出しは使わない
    expect(section).not.toContain("### 最優先の課題");
    expect(section).not.toContain("### 次に優先する課題");
  });

  it("相対差の根拠行は、指標名の直後に実測値を置く（%を指標値と読み違えない）", () => {
    const section = buildLocalCoachMarkdown({
      engineVersion: ENGINE_VERSION,
      generatedFrom: {
        completedThrows: 60,
        plannedThrowCount: 60,
        completionRatio: 1,
        coordinateInputCount: 60,
        approximateInputCount: 0,
        comparisonSessionCount: 0,
        comparisonSources: [],
        scopes: [],
      },
      analyzable: true,
      allCandidates: [],
      unrankedCandidates: [],
      issueFindings: [
        {
          id: "x",
          kind: "statistical_trend",
          priority: 1,
          effect: 0.5,
          severity: 0.35,
          title: "t",
          summary: "s",
          confidence: "medium",
          evidence: [
            {
              metric: "後半の平均誤差距離",
              current: 0.182,
              baseline: 0.083,
              difference: 1.2,
              sampleSize: 40,
              unit: "ratio",
            },
          ],
          limitations: [],
        },
      ],
      unavailableReasons: [],
    });
    expect(section).toContain(
      "- 後半の平均誤差距離: 0.182 / 基準比 +120.0% (基準 0.083) / 分母40"
    );
  });

  it("率の根拠には95%区間を併記し、有意性の主張はしない", () => {
    const section = buildLocalCoachMarkdown({
      engineVersion: ENGINE_VERSION,
      generatedFrom: {
        completedThrows: 60,
        plannedThrowCount: 60,
        completionRatio: 1,
        coordinateInputCount: 60,
        approximateInputCount: 0,
        comparisonSessionCount: 0,
        comparisonSources: [],
        scopes: [],
      },
      analyzable: true,
      allCandidates: [],
      unrankedCandidates: [],
      issueFindings: [
        {
          id: "x",
          kind: "statistical_trend",
          priority: 1,
          effect: 0.5,
          severity: 0.35,
          title: "t",
          summary: "s",
          confidence: "medium",
          evidence: [
            {
              metric: "3投目の命中率",
              current: 0.5,
              sampleSize: 100,
              unit: "rate",
              interval: { low: 0.4038, high: 0.5962 },
            },
          ],
          limitations: [],
        },
      ],
      unavailableReasons: [],
    });
    expect(section).toContain(
      "- 3投目の命中率: 50.0% / 分母100 / 95%区間 40.4%〜59.6%"
    );
    // 区間の読み方を1行で説明し、「有意」とは述べない
    expect(section).toContain("95%区間はぶれ幅の目安です");
    expect(section).not.toContain("有意差");
    expect(section).not.toContain("統計的に有意");
  });

  it("推奨メニューに目的・実施方法・投擲数・意識すること・記録項目・成功判定が含まれる", () => {
    const section = localCoachSection(markdownOf(scenario(20), true));
    // v3: 1変数実験としての必須要素
    for (const label of [
      "### 次回の1変数実験",
      "目的:",
      "変える要因(これ以外は変えない):",
      "実施順:",
      "主要指標:",
      "記録:",
      "悪化させない指標:",
      "成功:",
      "仮説の否定:",
      "中止・変更:",
      "次の分岐:",
    ]) {
      expect(section, label).toContain(label);
    }
    // 対照条件と介入条件がそれぞれ投擲数付きで示される
    expect(section).toMatch(/A: .+\(\d+投\)/);
    expect(section).toMatch(/B: .+\(\d+投\)/);
  });
});
