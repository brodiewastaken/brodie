// Verifies manifest reuse is scoped, bounded, and owned by the plugin lifecycle.
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import { getPluginManifestMetadataSnapshot } from "./manifest-metadata-cache.js";
import { resolveOpenClawPluginManifestMetadataSnapshot } from "./manifest-metadata-scan.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const fixture = vi.hoisted(() => ({ key: "first" }));

vi.mock("./bundled-dir.js", () => ({
  resolveBundledPluginsDir: (env: NodeJS.ProcessEnv) => env.OPENCLAW_BUNDLED_PLUGINS_DIR,
}));
vi.mock("./manifest-metadata-scan.js", () => ({
  resolveOpenClawPluginManifestMetadataSnapshot: vi.fn(() => ({
    key: fixture.key,
    records: [{ pluginDir: "/fixture", manifest: { id: fixture.key } }],
  })),
}));

const scan = vi.mocked(resolveOpenClawPluginManifestMetadataSnapshot);

function activateSnapshot(): void {
  setCurrentPluginMetadataSnapshotState({ generation: "fixture" }, "fixture");
}

describe("getPluginManifestMetadataSnapshot", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    fixture.key = "first";
    scan.mockClear();
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
  });

  it("keeps standalone reads fresh and does not seed the lifecycle memo", () => {
    expect(getPluginManifestMetadataSnapshot({}).key).toBe("first");
    fixture.key = "second";
    expect(getPluginManifestMetadataSnapshot({}).key).toBe("second");
    activateSnapshot();
    expect(getPluginManifestMetadataSnapshot({}).key).toBe("second");
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("reuses prepared metadata and returns independently mutable record arrays", () => {
    activateSnapshot();
    const first = getPluginManifestMetadataSnapshot({});
    first.records.length = 0;
    fixture.key = "changed-on-disk";

    const second = getPluginManifestMetadataSnapshot({});
    expect(second.key).toBe("first");
    expect(second.records).toHaveLength(1);
    expect(scan).toHaveBeenCalledTimes(1);

    clearPluginMetadataLifecycleCaches();
    activateSnapshot();
    expect(getPluginManifestMetadataSnapshot({}).key).toBe("changed-on-disk");
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it.each([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_HOME",
    "HOME",
    "USERPROFILE",
    "PREFIX",
    "ANDROID_DATA",
    "OPENCLAW_TEST_FAST",
    "VITEST",
    "NODE_ENV",
    "VITEST_WORKER_ID",
    "VITEST_POOL_ID",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
  ])("separates the %s discovery scope", (key) => {
    activateSnapshot();
    getPluginManifestMetadataSnapshot({ [key]: "one" });
    getPluginManifestMetadataSnapshot({ [key]: "two" });
    getPluginManifestMetadataSnapshot({ [key]: "one" });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("separates working directories, entrypoints, OS homes, and temporary roots", () => {
    activateSnapshot();
    getPluginManifestMetadataSnapshot({});
    vi.spyOn(process, "cwd").mockReturnValue("/another-workspace");
    getPluginManifestMetadataSnapshot({});
    vi.spyOn(os, "homedir").mockReturnValue("/another-home");
    getPluginManifestMetadataSnapshot({});
    vi.spyOn(os, "tmpdir").mockReturnValue("/another-tmp");
    getPluginManifestMetadataSnapshot({});
    const previousArgv = process.argv;
    try {
      process.argv = [previousArgv[0], "/another-entrypoint"];
      getPluginManifestMetadataSnapshot({});
      getPluginManifestMetadataSnapshot({});
    } finally {
      process.argv = previousArgv;
    }
    expect(scan).toHaveBeenCalledTimes(5);
  });

  it("evicts the least recently used scope after eight entries", () => {
    activateSnapshot();
    const readScope = (index: number) =>
      getPluginManifestMetadataSnapshot({ OPENCLAW_STATE_DIR: `/state/${index}` });
    for (let index = 0; index < 8; index += 1) {
      readScope(index);
    }
    readScope(0);
    readScope(8);
    readScope(0);
    expect(scan).toHaveBeenCalledTimes(9);
    readScope(1);
    expect(scan).toHaveBeenCalledTimes(10);
  });
});
