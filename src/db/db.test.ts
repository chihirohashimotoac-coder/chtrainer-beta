import { openDB } from "idb";
// @ts-expect-error The browser app intentionally excludes Node types; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDb, getSession, getSessions, importAllData } from "./db";
import { parseBackup } from "../export/backup";
import { SCHEMA_VERSION } from "../types/models";
import { fixtureSession } from "../test/fixtures";

describe("IndexedDB schema upgrades", () => {
  it("v1から現行DBへの更新で派生統計を無効化する", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("darts-training-analyzer-beta");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const legacy = await openDB("darts-training-analyzer-beta", 1, {
      upgrade(db) {
        db.createObjectStore("settings", { keyPath: "id" });
        db.createObjectStore("players", { keyPath: "id" });
        db.createObjectStore("equipmentProfiles", { keyPath: "id" });
        db.createObjectStore("trainingPlans", { keyPath: "id" });
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("byStatus", "status");
        sessions.createIndex("byStartedAt", "startedAt");
        const sets = db.createObjectStore("throwSets", { keyPath: "id" });
        sets.createIndex("bySession", "sessionId");
        const throws = db.createObjectStore("throws", { keyPath: "id" });
        throws.createIndex("bySession", "sessionId");
        db.createObjectStore("sessionStatistics", { keyPath: "sessionId" });
        db.createObjectStore("appMetadata", { keyPath: "key" });
      },
    });
    await legacy.put("sessionStatistics", {
      sessionId: "legacy-session",
      exactHitRate: 1,
    });
    legacy.close();

    const upgraded = await getDb();
    expect(await upgraded.getAll("sessionStatistics")).toEqual([]);

    const sample = parseBackup(
      readFileSync("samples/sample-backup.json", "utf8")
    );
    expect(sample.ok).toBe(true);
    await importAllData(sample.backup!.data, "replace");
    expect((await getSession("session-1"))?.schemaVersion).toBe(SCHEMA_VERSION);

    // 旧値 fit_bull のセッションを取り込み時・読込時に fat_bull へ正規化する
    // (後方互換)。同一の接続ライフサイクルで検証する。
    const legacySession = fixtureSession({ id: "legacy-fit-bull", trainingMode: "skill_check" });
    // 型に存在しない旧値を後方互換テストとして注入する。
    (legacySession as { scoringStyle: string }).scoringStyle = "fit_bull";
    await importAllData(
      {
        settings: [],
        players: [],
        equipmentProfiles: [],
        trainingPlans: [],
        sessions: [legacySession],
        throwSets: [],
        throws: [],
        sessionStatistics: [],
      },
      "merge"
    );
    expect((await getSession("legacy-fit-bull"))?.scoringStyle).toBe("fat_bull");
    const listed = (await getSessions()).find((s) => s.id === "legacy-fit-bull");
    expect(listed?.scoringStyle).toBe("fat_bull");

    upgraded.close();
  });
});
