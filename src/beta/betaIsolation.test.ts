// @ts-expect-error The browser app intentionally excludes Node types; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_CHANNEL,
  APP_DISPLAY_NAME,
  APP_VERSION,
  BETA_NOTICE,
} from "../config/constants";
import { VERSION_HISTORY } from "../config/versionHistory";

/**
 * ベータ版と本番版の保存領域が分離されていることの回帰テスト。
 *
 * GitHub Pages では以下の2つは「パスが違うだけの同一オリジン」であり、
 *   https://chihirohashimotoac-coder.github.io/chtrainer/
 *   https://chihirohashimotoac-coder.github.io/chtrainer-beta/
 * IndexedDB・Cache Storage・localStorage は自動的には分離されない。
 * 識別子をベータ専用にしていることをコードから直接検証する。
 */

/** 本番版が使用している識別子。ベータ版のコードに出現してはならない。 */
const PRODUCTION_DB_NAME = "darts-training-analyzer";
const PRODUCTION_CACHE_PREFIX = "dta-v";
const PRODUCTION_THEME_KEY = "chtrainer-theme";

const BETA_DB_NAME = "darts-training-analyzer-beta";

const dbSource = readFileSync("src/db/db.ts", "utf8") as string;
const dbTestSource = readFileSync("src/db/db.test.ts", "utf8") as string;
const swSource = readFileSync("public/sw.js", "utf8") as string;
const themeSource = readFileSync("src/theme/theme.ts", "utf8") as string;
const indexHtml = readFileSync("index.html", "utf8") as string;
const manifest = JSON.parse(
  readFileSync("public/manifest.webmanifest", "utf8") as string
) as Record<string, string>;
const pkg = JSON.parse(readFileSync("package.json", "utf8") as string) as {
  name: string;
  version: string;
};
const visualQaSource = readFileSync("scripts/visual_qa.py", "utf8") as string;

describe("ベータ版の保存領域分離", () => {
  it("IndexedDBのDB名が darts-training-analyzer-beta である", () => {
    expect(dbSource).toContain(`const DB_NAME = "${BETA_DB_NAME}"`);
  });

  it("本番用DB名を開くコードが存在しない", () => {
    // "darts-training-analyzer" 単体（-beta が続かないもの）の出現を禁止する
    const productionOnly = new RegExp(`"${PRODUCTION_DB_NAME}"(?!-)`, "g");
    for (const [label, source] of [
      ["src/db/db.ts", dbSource],
      ["src/db/db.test.ts", dbTestSource],
      ["scripts/visual_qa.py", visualQaSource],
    ] as const) {
      expect(source.match(productionOnly), label).toBeNull();
    }
    // 開発・QA用スクリプトもベータ専用DBを操作する
    expect(visualQaSource).toContain(`indexedDB.open("${BETA_DB_NAME}")`);
  });

  it("ベータ版のデータ削除操作がベータ用DBだけを対象にする", () => {
    // 削除・オープンの対象がすべてベータ専用名であること
    const names = [...dbSource.matchAll(/deleteDatabase\("([^"]+)"\)/g)].map(
      (m) => m[1]
    );
    const testNames = [
      ...dbTestSource.matchAll(/deleteDatabase\("([^"]+)"\)/g),
    ].map((m) => m[1]);
    for (const name of [...names, ...testNames]) {
      expect(name).toBe(BETA_DB_NAME);
    }
  });

  it("Service Workerのキャッシュ名がベータ専用である", () => {
    expect(swSource).toContain('const CACHE_VERSION = "dta-beta-v__APP_VERSION__"');
    // 本番と同じ "dta-v..." 形式へ戻っていないこと
    expect(swSource).not.toMatch(
      new RegExp(`CACHE_VERSION\\s*=\\s*"${PRODUCTION_CACHE_PREFIX}`)
    );
  });

  it("localStorageのキーがベータ専用で、HTMLの先行適用スクリプトと一致する", () => {
    expect(themeSource).toContain('const STORAGE_KEY = "chtrainer-beta-theme"');
    expect(indexHtml).toContain('localStorage.getItem("chtrainer-beta-theme")');
    // 本番キーを読み書きしない
    expect(themeSource).not.toContain(`"${PRODUCTION_THEME_KEY}"`);
    expect(indexHtml).not.toContain(`"${PRODUCTION_THEME_KEY}"`);
  });

  it("manifestの名称にβが含まれ、scopeが相対パスである", () => {
    expect(manifest.name).toBe("CH Darts Training Analyzer β");
    expect(manifest.short_name).toBe("CH DartsTA β");
    expect(manifest.id).toBe("./");
    expect(manifest.start_url).toBe("./");
    // scope を "./" にすることで Service Worker が chtrainer-beta 配下だけを制御する
    expect(manifest.scope).toBe("./");
    expect(manifest.description).toContain("ベータ版");
  });

  it("本番URLへのパスがソースへ混入していない", () => {
    const sources = [dbSource, swSource, themeSource, indexHtml, JSON.stringify(manifest)];
    for (const source of sources) {
      expect(source).not.toContain("github.io/chtrainer/");
      expect(source).not.toContain("chihirohashimotoac-coder.github.io/chtrainer/");
    }
    // 相対 base を維持していること（リポジトリ名をパスへ埋め込まない）
    const viteConfig = readFileSync("vite.config.ts", "utf8") as string;
    expect(viteConfig).toContain('base: "./"');
  });
});

describe("ベータ版のバージョンと識別表示", () => {
  it("バージョンが 2.7.0-beta.1 で、package.json と一致する", () => {
    expect(APP_VERSION).toBe("2.7.0-beta.1");
    expect(pkg.version).toBe(APP_VERSION);
    expect(pkg.name).toBe("darts-training-analyzer-beta");
  });

  it("バージョン履歴の先頭が APP_VERSION と一致する", () => {
    expect(VERSION_HISTORY[0]?.version).toBe(APP_VERSION);
  });

  it("バージョン履歴にベータ版の要点が記載されている", () => {
    const summary = VERSION_HISTORY[0]?.summary ?? "";
    for (const phrase of [
      "ローカルコーチ事前分析",
      "ルールベース",
      "生成AIや機械学習モデルは一切使用せず",
      "別の保存領域",
      "自動同期",
    ]) {
      expect(summary, phrase).toContain(phrase);
    }
  });

  it("配布チャネルがベータで、表示名にβが付く", () => {
    expect(APP_CHANNEL).toBe("beta");
    expect(APP_DISPLAY_NAME).toContain("β");
  });

  it("ベータ版の注意書きが所定の3文である", () => {
    expect(BETA_NOTICE).toBe(
      [
        "このアプリはベータ版です。",
        "本番版とは別の保存領域を使用しており、記録データは自動同期されません。",
        "重要な記録は定期的にJSONバックアップしてください。",
      ].join("\n")
    );
  });

  it("HTMLのタイトルがベータ版として識別できる", () => {
    expect(indexHtml).toContain("<title>CH Darts Training Analyzer β</title>");
  });
});
