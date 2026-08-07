/**
 * A/B評価用のPromptと採点テンプレートを生成する。
 * 実行: npm run ab:prompts
 *
 * 出力先: ab-eval/
 *   <key>/production.md  本番版(2.6.0)相当の依頼文
 *   <key>/beta.md        ベータ版の依頼文（ローカルコーチ節を含む）
 *   ground-truth.json    期待するローカル所見・出してはいけない断定（採点用）
 *   sizes.csv            文字数・概算トークン数・増加率の実測
 *   scoring-template.md  採点テンプレート
 *
 * 重要: production.md / beta.md には Dataset名・Ground Truth を含めない。
 * 期待値は ground-truth.json 側にのみ置く。
 */
// @ts-expect-error The browser app intentionally excludes Node types; this script runs in Node.
import { mkdirSync, writeFileSync } from "node:fs";
// @ts-expect-error Node types are intentionally excluded from the browser app.
import { join } from "node:path";
import { ALL_FIXTURES, PRIMARY_FIXTURE_KEYS } from "../src/domain/localCoach/fixtures";
import type { LocalCoachFixture } from "../src/domain/localCoach/fixtures";
import { buildPromptPair } from "../src/export/abEvaluation";
import { ENGINE_VERSION } from "../src/domain/localCoach/config";
import { APP_VERSION } from "../src/config/constants";

// @ts-expect-error Node globals are intentionally excluded from the browser app.
const outDir = join(process.cwd(), "ab-eval");
mkdirSync(outDir, { recursive: true });

const setNumberOf = (setId: string) => {
  const match = /-set-(\d+)$/.exec(setId);
  return match ? Number(match[1]) : undefined;
};

function promptsFor(fixture: LocalCoachFixture) {
  return buildPromptPair({
    session: fixture.current.session,
    player: undefined,
    equipment: undefined,
    stats: fixture.current.stats,
    throws: fixture.current.throws,
    setNumberOf,
    comparisons: fixture.history.map((h) => ({
      session: h.session,
      stats: h.stats,
    })),
    recentSessions: fixture.history.map((h) => ({
      session: h.session,
      stats: h.stats,
    })),
    embedAllThrows: false,
  });
}

const rows: string[] = [
  "key,production_chars,beta_chars,local_coach_chars,production_tokens,beta_tokens,char_increase_pct,token_increase_pct",
];
const groundTruth: Record<string, unknown> = {
  appVersion: APP_VERSION,
  engineVersion: ENGINE_VERSION,
  primaryFixtureKeys: PRIMARY_FIXTURE_KEYS,
  fixtures: {} as Record<string, unknown>,
};

for (const factory of ALL_FIXTURES) {
  const fixture = factory();
  const pair = promptsFor(fixture);
  const dir = join(outDir, fixture.key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "production.md"), pair.production.markdown);
  writeFileSync(join(dir, "beta.md"), pair.beta.markdown);
  rows.push(
    [
      fixture.key,
      pair.production.chars,
      pair.beta.chars,
      pair.localCoachChars,
      pair.production.estimatedTokens,
      pair.beta.estimatedTokens,
      (pair.charIncreaseRatio * 100).toFixed(2),
      (pair.tokenIncreaseRatio * 100).toFixed(2),
    ].join(",")
  );
  (groundTruth.fixtures as Record<string, unknown>)[fixture.key] = {
    description: fixture.description,
    ...fixture.expectation,
    localCoachChars: pair.localCoachChars,
    tokenIncreasePct: Number((pair.tokenIncreaseRatio * 100).toFixed(2)),
  };
}

writeFileSync(join(outDir, "sizes.csv"), rows.join("\n") + "\n");
writeFileSync(
  join(outDir, "ground-truth.json"),
  JSON.stringify(groundTruth, null, 2) + "\n"
);

const primaryRows = rows
  .slice(1)
  .filter((row) => PRIMARY_FIXTURE_KEYS.includes(row.split(",")[0] as string));
const primaryTokenIncrease =
  primaryRows.reduce((sum, row) => sum + Number(row.split(",")[7]), 0) /
  Math.max(1, primaryRows.length);

writeFileSync(
  join(outDir, "scoring-template.md"),
  `# ローカルコーチ A/B 採点テンプレート

- アプリVersion: ${APP_VERSION}
- 分析エンジン: ${ENGINE_VERSION}
- 主要6 Dataset: ${PRIMARY_FIXTURE_KEYS.join(", ")}
- 主要6 Dataset平均の概算token増加率(production比): ${primaryTokenIncrease.toFixed(2)}%

## 手順

1. 回答生成モデルを1つ固定する（モデルIDと設定を記録する）。
2. 各Datasetについて \`production.md\` と \`beta.md\` をそれぞれ別セッションへ貼り付ける。
3. 提示順をDatasetごとにランダム化する（A=production/B=beta の割り当てを記録し、採点者へは伏せる）。
4. 各条件3〜5回生成する。
5. 可能なら採点は生成担当と別のモデル・別の担当者が行う。完全Blindでない場合は「疑似Blind」と明記する。
6. 採点後に \`ground-truth.json\` と突き合わせる。**採点前にGround Truthを参照しない。**

## 記録するモデル情報

| 項目 | 値 |
|---|---|
| 生成モデルID | |
| 採点モデルID / 採点者 | |
| temperature 等の設定 | |
| Blind条件 | 完全Blind / 疑似Blind |
| 実施日 | |

## 評価項目（各10点・合計100点）

| # | 項目 | 観点 |
|---|---|---|
| 1 | データ理解 | 分母・入力精度・N/Aを正しく読めているか |
| 2 | 問題発見 | Ground Truthの期待所見を検出できているか |
| 3 | 優先順位 | 効果量と確からしさに整合した順位か |
| 4 | 根拠 | 依頼文の数値に紐づいているか |
| 5 | 過剰推論の少なさ | データにない断定をしていないか |
| 6 | 原因仮説 | 反証可能な形式で、支持・矛盾・不足を伴うか |
| 7 | 改善提案 | 一般論でなく仮説を区別する実験になっているか |
| 8 | 検証可能性 | 成功基準・否定基準が数値化されているか |
| 9 | 個人最適化 | 本人の履歴・条件に即しているか |
| 10 | 実用性 | 次回そのまま実施できるか |

## 別記録（件数でカウント）

| 項目 | production | beta |
|---|---:|---:|
| Hallucination（依頼文にない数値・事実） | | |
| False Positive（安定Datasetで課題を作る） | | |
| False Negative（期待所見の見落とし） | | |
| Anchoring（ローカル順位をそのまま採用） | | |
| Echoing（ローカル文章の言い換えのみ） | | |
| Generic Advice（データに依存しない一般論） | | |

## 品質目標

- 主要6 Dataset平均で production 比 +5点以上
- 主要6 Dataset中5件以上で同等以上
- 問題発見・False Positive・False Negative・過剰推論を悪化させない
- 複合Datasetで重大なAnchoringを起こさない
- 安定Datasetで課題を作らない
- 9投Datasetで断定しない

**+5点を達成するために、回答・Ground Truth・採点結果を作為的に変更しないこと。**
未実施の試験をPass扱いにしないこと。
`
);

console.log(`ab-eval generated: ${ALL_FIXTURES.length} datasets`);
console.log(`主要6 Dataset平均の概算token増加率: ${primaryTokenIncrease.toFixed(2)}%`);
