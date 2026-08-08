// @ts-expect-error The browser app intentionally excludes Node types; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AboutPage from "./AboutPage";
import HomePage from "./HomePage";
import { AppProvider } from "../state/AppContext";
import { SetupProvider } from "../state/SetupContext";
import {
  APP_VERSION,
  BETA_BADGE_LABEL,
  BETA_NOTICE,
} from "../config/constants";
import { VERSION_HISTORY } from "../config/versionHistory";

const css: string = readFileSync("src/styles.css", "utf8");

/**
 * バージョン履歴のサマリには previous_throw_was_hit_in_same_set や fat_bull などの
 * 折り返し位置を持たない長い識別子が含まれる。折り返し指定がないと flex 行の
 * min-width:auto と相まって狭幅画面で横スクロールが発生するため、
 * サマリ要素に overflow-wrap と min-width:0 が設定されていることを保証する。
 */
describe("AboutPage (バージョン履歴の折り返し)", () => {
  it("長い識別子を含むサマリが横はみ出ししないよう折り返し指定を持つ", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );

    // 長い英数字トークンを含む代表的なサマリのテキストノードを探す
    const longEntry = VERSION_HISTORY.find((e) =>
      e.summary.includes("previous_throw_was_hit_in_same_set")
    );
    expect(longEntry).toBeDefined();

    const summarySpans = Array.from(
      container.querySelectorAll<HTMLElement>("span.small")
    ).filter((el) => el.textContent === longEntry!.summary);
    expect(summarySpans.length).toBe(1);

    const style = summarySpans[0]!.style;
    // 長いトークンを分割可能にし、flex 収縮を許可する
    expect(style.overflowWrap).toBe("anywhere");
    expect(["0", "0px"]).toContain(style.minWidth);
  });
});

/**
 * スマホ幅での可読性に対する回帰テスト。
 *
 * 版数(「v2.7.0-beta.3 (2026-08-07)」)は折り返させたくないため nowrap で描画するが、
 * これを本文と横並びにすると版数側が約200pxを占有し、幅390pxの端末では
 * 本文が1行あたり数文字の細長い列になる。版数行と本文を縦に積み、
 * 本文が行の全幅を使える構造であることを固定する。
 */
describe("AboutPage (バージョン履歴の縦積みレイアウト)", () => {
  it("版数行と本文は横並びではなく、本文が独立した行を占める", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );

    const entries = container.querySelectorAll<HTMLElement>(".version-entry");
    expect(entries.length).toBe(VERSION_HISTORY.length);

    const first = entries[0]!;
    // 版数と日付は専用の行にまとまっている
    const head = first.querySelector<HTMLElement>(".version-entry-head");
    expect(head).not.toBeNull();
    expect(head!.textContent).toContain(`v${VERSION_HISTORY[0]!.version}`);
    expect(head!.textContent).toContain(VERSION_HISTORY[0]!.date);

    // 本文は版数行の外にあり、版数行の後続要素として独立している
    const summary = first.querySelector<HTMLElement>(".version-entry-summary");
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toBe(VERSION_HISTORY[0]!.summary);
    expect(head!.contains(summary!)).toBe(false);
    expect(summary!.previousElementSibling).toBe(head);

    // 横並びの .list-row は使わない(版数側の nowrap が本文幅を奪うため)
    expect(first.className).not.toContain("list-row");
  });

  it("styles.css で本文がブロック要素として全幅を使う", () => {
    const summaryRule = css.slice(
      css.indexOf(".version-entry-summary {"),
      css.indexOf("}", css.indexOf(".version-entry-summary {"))
    );
    expect(summaryRule).toMatch(/display:\s*block/);
    // 版数行のみ flex。エントリ自体を flex 行にはしない
    const entryRule = css.slice(
      css.indexOf(".version-entry {"),
      css.indexOf("}", css.indexOf(".version-entry {"))
    );
    expect(entryRule).not.toMatch(/display:\s*flex/);
  });
});

/**
 * ベータ版であることの識別表示。
 * 本番版と誤認されると、別々の保存領域に記録されたデータを同一のものと
 * 誤解するおそれがあるため、情報画面での明示は必須要件として固定する。
 */
describe("AboutPage (ベータ版の識別表示)", () => {
  it("βバッジ・ベータ版表記・バージョン・注意書きを表示する", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );
    const text = container.textContent ?? "";
    expect(text).toContain(BETA_BADGE_LABEL);
    expect(text).toContain("ベータ版");
    expect(text).toContain(APP_VERSION);
    expect(APP_VERSION).toMatch(/^2\.7\.0-beta\.\d+$/);
    // 注意書きは3文すべてが読める形で表示される
    for (const line of BETA_NOTICE.split("\n")) {
      expect(text, line).toContain(line);
    }
    // 注意書きは改行を保持したまま折り返す(狭幅で横スクロールしない)
    const notice = container.querySelector<HTMLElement>("p.beta-notice");
    expect(notice).not.toBeNull();
  });

  it("バッジは折り返し可能な行に置き、見出しを押し出さない", () => {
    const { container } = render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>
    );
    const badge = container.querySelector(".badge.beta");
    expect(badge).not.toBeNull();
    // 320px幅でも横スクロールしないよう、flex-wrap を持つ .title-row の中に置く
    expect(badge!.parentElement?.className).toContain("title-row");
    expect(badge!.textContent).toBe(BETA_BADGE_LABEL);
  });
});

describe("HomePage (ベータ版の識別表示)", () => {
  it("アプリ名の近くにβバッジを表示する", async () => {
    const { container, findByText } = render(
      <MemoryRouter>
        <AppProvider>
          <SetupProvider>
            <HomePage />
          </SetupProvider>
        </AppProvider>
      </MemoryRouter>
    );
    await findByText("CH Darts Training Analyzer");
    const hero = container.querySelector(".home-hero");
    expect(hero).not.toBeNull();
    const badge = hero!.querySelector(".badge.beta");
    expect(badge).not.toBeNull();
    expect(badge!.parentElement?.className).toContain("title-row");
  });
});
