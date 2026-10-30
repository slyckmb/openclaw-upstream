import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertProtectedFloorActive,
  isProtectedFloorPresent,
  readProtectedFloor,
} from "./protected-floor.js";

const VALID_RECORD = JSON.stringify({
  schema: "openclaw-protected-floor/v1",
  floor: "operator-only",
});

describe("protected floor (B1)", () => {
  let root: string;
  let floorDir: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr25-floor-")));
    floorDir = path.join(root, "openclaw-protected");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFloor(record: string | null, dirMode = 0o700, fileMode = 0o600): void {
    fs.mkdirSync(floorDir, { mode: dirMode });
    fs.chmodSync(floorDir, dirMode);
    if (record !== null) {
      const file = path.join(floorDir, "floor.json");
      fs.writeFileSync(file, record, { mode: fileMode });
      fs.chmodSync(file, fileMode);
    }
  }

  it("reports absent and denies protected provisioning when no floor directory exists", () => {
    expect(readProtectedFloor(floorDir)).toEqual({ status: "absent" });
    expect(isProtectedFloorPresent(floorDir)).toBe(false);
    expect(() => assertProtectedFloorActive(floorDir)).toThrow(
      /Protected execution denied: no operator floor is configured/,
    );
  });

  it("accepts a service-owned 0700 directory with a valid 0600 record", () => {
    writeFloor(VALID_RECORD);
    expect(readProtectedFloor(floorDir)).toEqual({ status: "active" });
    expect(isProtectedFloorPresent(floorDir)).toBe(true);
    expect(() => assertProtectedFloorActive(floorDir)).not.toThrow();
  });

  it("fails closed on a group- or other-accessible directory", () => {
    writeFloor(VALID_RECORD, 0o755);
    expect(readProtectedFloor(floorDir)).toMatchObject({
      status: "invalid",
      reason: "floor directory mode must be 0700",
    });
    expect(() => assertProtectedFloorActive(floorDir)).toThrow(/mode must be 0700/);
  });

  it("fails closed when the record is group-writable", () => {
    writeFloor(VALID_RECORD, 0o700, 0o664);
    expect(readProtectedFloor(floorDir)).toMatchObject({ status: "invalid" });
  });

  it("fails closed when the record is missing", () => {
    writeFloor(null);
    expect(readProtectedFloor(floorDir)).toMatchObject({
      status: "invalid",
      reason: "floor record is missing",
    });
  });

  it("fails closed on malformed JSON or a wrong schema or marker", () => {
    writeFloor("{not json");
    expect(readProtectedFloor(floorDir)).toMatchObject({
      status: "invalid",
      reason: "floor record is not valid JSON",
    });
    fs.writeFileSync(
      path.join(floorDir, "floor.json"),
      JSON.stringify({ schema: "openclaw-protected-floor/v1", floor: "agent-writable" }),
    );
    expect(readProtectedFloor(floorDir)).toMatchObject({
      status: "invalid",
      reason: "floor record has an unexpected schema or marker",
    });
  });

  it("does not follow a symlinked floor directory", () => {
    writeFloor(VALID_RECORD);
    const link = path.join(root, "linked-floor");
    fs.symlinkSync(floorDir, link);
    expect(readProtectedFloor(link)).toMatchObject({
      status: "invalid",
      reason: "floor path is not a real directory",
    });
  });
});
