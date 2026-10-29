import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import {
  advanceProtectedCutoverInTransaction,
  assertProtectedRunState,
  bindProtectedRunInTransaction,
  retireProtectedRunInTransaction,
} from "./protected-execution-store.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const owner = { generation: 1, runtimeFingerprint: a, administratorRef: "admin-1", nowMs: 100 };
const run = {
  runId: "run-1",
  instanceId: "instance-1",
  agentId: "agent-1",
  generation: 1,
  runtimeFingerprint: a,
};
const allocated: Array<{ db: DatabaseSync; directory?: string }> = [];

function openFixture(persistent = false) {
  const directory = persistent
    ? fs.mkdtempSync(path.join(os.tmpdir(), "pr25-protected-"))
    : undefined;
  const db = new DatabaseSync(directory ? path.join(directory, "fixture.sqlite") : ":memory:");
  allocated.push({ db, directory });
  return db;
}

function transaction(db: DatabaseSync, action: () => void) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    action();
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

afterEach(() => {
  for (const record of allocated.splice(0)) {
    if (record.db.isOpen) {
      clearNodeSqliteKyselyCacheForDatabase(record.db);
      record.db.close();
    }
    if (record.directory) {
      fs.rmSync(record.directory, { recursive: true, force: true });
    }
  }
});

describe("trusted protected-execution durable storage primitive", () => {
  it("denies absent state and does not create any schema during validation", () => {
    const db = openFixture();
    expect(() => assertProtectedRunState(db, run)).toThrow(/missing/);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()).toEqual({ n: 0 });
  });

  it("lazily installs approved STRICT tables without increasing database schema version", () => {
    const db = openFixture();
    db.exec("PRAGMA user_version = 11");
    transaction(db, () => advanceProtectedCutoverInTransaction(db, owner));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 11 });
    expect(
      db
        .prepare(
          "SELECT generation, required, runtime_fingerprint FROM protected_execution_cutovers",
        )
        .get(),
    ).toEqual({ generation: 1, required: 1, runtime_fingerprint: a });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'protected_execution_runs_guard_delete'",
        )
        .get(),
    ).toEqual({ name: "protected_execution_runs_guard_delete" });
  });

  it("binds exact immutable run authority, then invalidates it permanently at retirement", () => {
    const db = openFixture();
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    expect(() => assertProtectedRunState(db, run)).not.toThrow();
    expect(() => assertProtectedRunState(db, { ...run, instanceId: "copy" })).toThrow(/authority/);
    expect(() => assertProtectedRunState(db, { ...run, agentId: "other" })).toThrow(/authority/);
    expect(() => assertProtectedRunState(db, { ...run, runtimeFingerprint: b })).toThrow(/cutover/);
    expect(() =>
      transaction(db, () =>
        bindProtectedRunInTransaction(db, { ...run, instanceId: "copy", nowMs: 106 }),
      ),
    ).toThrow(/already bound/);
    transaction(db, () => retireProtectedRunInTransaction(db, run, 115));
    expect(() => assertProtectedRunState(db, run)).toThrow(/authority/);
    expect(() =>
      transaction(db, () => bindProtectedRunInTransaction(db, { ...run, nowMs: 120 })),
    ).toThrow(/already bound/);
  });

  it("does not permit weaker floors or generation changes with active runs", () => {
    const db = openFixture();
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    transaction(db, () => advanceProtectedCutoverInTransaction(db, owner)); // exact retry only
    expect(() =>
      transaction(db, () => advanceProtectedCutoverInTransaction(db, { ...owner, generation: 0 })),
    ).toThrow(/generation/);
    expect(() =>
      transaction(db, () =>
        advanceProtectedCutoverInTransaction(db, { ...owner, runtimeFingerprint: b }),
      ),
    ).toThrow(/advance/);
    expect(() =>
      transaction(db, () =>
        advanceProtectedCutoverInTransaction(db, {
          ...owner,
          generation: 2,
          runtimeFingerprint: b,
        }),
      ),
    ).toThrow(/active runs/);
    transaction(db, () => retireProtectedRunInTransaction(db, run, 120));
    transaction(db, () =>
      advanceProtectedCutoverInTransaction(db, {
        ...owner,
        generation: 2,
        runtimeFingerprint: b,
        nowMs: 121,
      }),
    );
    expect(() => assertProtectedRunState(db, run)).toThrow(/cutover/);
  });

  it("rejects unknown parents and cannot retire a parent with active children", () => {
    const db = openFixture();
    const child = {
      ...run,
      runId: "child-1",
      instanceId: "child-instance",
      parentRunId: run.runId,
    };
    transaction(db, () => advanceProtectedCutoverInTransaction(db, owner));
    expect(() =>
      transaction(db, () => bindProtectedRunInTransaction(db, { ...child, nowMs: 105 })),
    ).toThrow(/parent run/);
    transaction(db, () => {
      bindProtectedRunInTransaction(db, { ...run, nowMs: 110 });
      bindProtectedRunInTransaction(db, { ...child, nowMs: 115 });
    });
    expect(() => transaction(db, () => retireProtectedRunInTransaction(db, run, 120))).toThrow(
      /child runs remain active/,
    );
    transaction(db, () => retireProtectedRunInTransaction(db, child, 125));
    transaction(db, () => retireProtectedRunInTransaction(db, run, 130));
  });

  it("protects against direct SQL deletes and identity rewrites", () => {
    const db = openFixture();
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    expect(() => db.exec("DELETE FROM protected_execution_cutovers")).toThrow(/cannot be deleted/);
    expect(() => db.exec("DELETE FROM protected_execution_runs")).toThrow(/cannot be deleted/);
    expect(() => db.exec("UPDATE protected_execution_runs SET agent_id = 'attacker'")).toThrow(
      /immutable/,
    );
    expect(() => db.exec("UPDATE protected_execution_cutovers SET generation = 0")).toThrow();
    expect(() => assertProtectedRunState(db, run)).not.toThrow();
  });

  it("denies execution on damaged schema, removed protections, and unknown fingerprints", () => {
    const db = openFixture();
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    db.exec("DROP TRIGGER protected_execution_runs_guard_delete;");
    expect(() => assertProtectedRunState(db, run)).toThrow(/guard.*missing/);
    db.exec("DROP TABLE protected_execution_runs;");
    expect(() => assertProtectedRunState(db, run)).toThrow(/missing/);
  });

  it("rejects a replacement no-op guard with the same name", () => {
    const db = openFixture();
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    db.exec("DROP TRIGGER protected_execution_runs_guard_update;");
    db.exec(`
      CREATE TRIGGER protected_execution_runs_guard_update
      BEFORE UPDATE ON protected_execution_runs
      BEGIN SELECT 1; END;
    `);
    expect(() => assertProtectedRunState(db, run)).toThrow(/weakened or changed/);
    expect(() =>
      transaction(db, () =>
        bindProtectedRunInTransaction(db, {
          ...run,
          runId: "second-run",
          instanceId: "second-instance",
          nowMs: 115,
        }),
      ),
    ).toThrow(/weakened or changed/);
  });

  it("rejects weaker schema when a required index disappears", () => {
    const db = openFixture();
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    db.exec("DROP INDEX idx_protected_execution_runs_active_parent;");
    expect(() => assertProtectedRunState(db, run)).toThrow(/index.*missing/);
  });

  it("preserves exact policy and run identity across a closed-and-reopened SQLite connection", () => {
    const db = openFixture(true);
    transaction(db, () => {
      advanceProtectedCutoverInTransaction(db, owner);
      bindProtectedRunInTransaction(db, { ...run, nowMs: 105 });
    });
    const file = db
      .prepare("PRAGMA database_list")
      .all()
      .find((entry) => entry.name === "main")?.file;
    expect(file).toBeTruthy();
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    const reopened = new DatabaseSync(String(file));
    allocated.push({ db: reopened });
    expect(() => assertProtectedRunState(reopened, run)).not.toThrow();
    expect(
      reopened
        .prepare("SELECT parent_run_id FROM protected_execution_runs WHERE run_id = ?")
        .get("run-1"),
    ).toEqual({ parent_run_id: null });
  });

  it("rejects malformed input before mutating stored state", () => {
    const db = openFixture();
    expect(() =>
      transaction(db, () =>
        advanceProtectedCutoverInTransaction(db, { ...owner, runtimeFingerprint: "fake" }),
      ),
    ).toThrow(/SHA-256/);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'protected_execution_cutovers'")
        .get(),
    ).toBeUndefined();
  });
});
