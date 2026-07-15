// Identity bootstrap hook tests cover priority order, boundary guards, and opt-in.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createIdentityBootstrapConfig(params?: {
  enabled?: boolean;
  order?: string[];
}): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "identity-bootstrap": {
            enabled: params?.enabled ?? true,
            ...(params?.order ? { order: params.order } : {}),
          },
        },
      },
    },
  };
}

async function writeRootMarkdownFiles(
  workspaceDir: string,
  files: Array<{ name: string; content: string }>,
): Promise<void> {
  await Promise.all(
    files.map((file) =>
      writeWorkspaceFile({
        dir: workspaceDir,
        name: file.name,
        content: file.content,
      }),
    ),
  );
}

function createBootstrapContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  initialFiles: Array<{ name: string; content: string }>;
}): AgentBootstrapHookContext {
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: params.initialFiles.map((file) => ({
      name: file.name,
      path: path.join(params.workspaceDir, file.name),
      content: file.content,
      missing: false,
    })),
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  };
}

describe("identity-bootstrap hook", () => {
  it("loads root markdown and applies soul-first priority order after subagent filters", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-identity-bootstrap-");
    await writeRootMarkdownFiles(workspaceDir, [
      { name: "AGENTS.md", content: "project rules" },
      { name: "SOUL.md", content: "persona" },
      { name: "IDENTITY.md", content: "identity" },
      { name: "USER.md", content: "user" },
      { name: "MEMORY.md", content: "memory" },
      { name: "TOOLS.md", content: "tools" },
      { name: "STYLE.md", content: "style" },
      { name: "PRIVACY.md", content: "privacy" },
      { name: "EXTRA.md", content: "extra" },
      { name: "PERSONA.md", content: "persona extra" },
      { name: "BOOTSTRAP.md", content: "stale setup" },
      { name: "HEARTBEAT.md", content: "heartbeat only" },
    ]);
    await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "nested", "IGNORED.md"), "nested", "utf8");
    await fs.writeFile(path.join(workspaceDir, "notes.txt"), "not markdown", "utf8");

    const sessionKey = "agent:main:subagent:worker";
    const context = createBootstrapContext({
      workspaceDir,
      cfg: createIdentityBootstrapConfig(),
      sessionKey,
      initialFiles: [
        { name: "AGENTS.md", content: "filtered agents" },
        { name: "TOOLS.md", content: "filtered tools" },
      ],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.name)).toEqual([
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "MEMORY.md",
      "AGENTS.md",
      "TOOLS.md",
      "STYLE.md",
      "PRIVACY.md",
      "EXTRA.md",
      "PERSONA.md",
    ]);
    expect(context.bootstrapFiles.find((file) => file.name === "SOUL.md")?.content).toBe("persona");
    expect(context.bootstrapFiles.find((file) => file.name === "AGENTS.md")?.content).toBe(
      "project rules",
    );
    expect(
      context.bootstrapFiles.map((file) => path.relative(workspaceDir, file.path)),
    ).not.toContain(path.join("nested", "IGNORED.md"));
  });

  it("applies a configured priority order instead of the soul-first default", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-identity-bootstrap-order-");
    await writeRootMarkdownFiles(workspaceDir, [
      { name: "AGENTS.md", content: "project rules" },
      { name: "SOUL.md", content: "persona" },
      { name: "USER.md", content: "user" },
    ]);

    const sessionKey = "agent:main:main";
    const context = createBootstrapContext({
      workspaceDir,
      cfg: createIdentityBootstrapConfig({ order: ["USER.md", "AGENTS.md"] }),
      sessionKey,
      initialFiles: [],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.name)).toEqual([
      "USER.md",
      "AGENTS.md",
      "SOUL.md",
    ]);
  });

  it("passes malformed pathless entries through so bootstrap sanitization can warn on them", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-identity-bootstrap-pathless-");
    await writeRootMarkdownFiles(workspaceDir, [{ name: "SOUL.md", content: "persona" }]);

    const sessionKey = "agent:main:main";
    const context = createBootstrapContext({
      workspaceDir,
      cfg: createIdentityBootstrapConfig(),
      sessionKey,
      initialFiles: [],
    });
    const pathlessEntry = { name: "BROKEN.md", path: "", content: "broken", missing: false };
    context.bootstrapFiles = [pathlessEntry];

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.name)).toEqual(["SOUL.md", "BROKEN.md"]);
    expect(context.bootstrapFiles).toContain(pathlessEntry);
  });

  it("skips root markdown symlinks that escape the workspace and oversized files", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-identity-bootstrap-guarded-");
    const outsideDir = await makeTempWorkspace("openclaw-identity-bootstrap-outside-");
    await writeRootMarkdownFiles(workspaceDir, [{ name: "AGENTS.md", content: "project rules" }]);
    await fs.writeFile(path.join(outsideDir, "ESCAPE.md"), "outside secret", "utf8");
    await fs.symlink(path.join(outsideDir, "ESCAPE.md"), path.join(workspaceDir, "ESCAPE.md"));
    await fs.writeFile(path.join(workspaceDir, "HUGE.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));

    const sessionKey = "agent:main:subagent:worker";
    const context = createBootstrapContext({
      workspaceDir,
      cfg: createIdentityBootstrapConfig(),
      sessionKey,
      initialFiles: [{ name: "AGENTS.md", content: "filtered agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.name)).toEqual(["AGENTS.md"]);
    expect(context.bootstrapFiles[0]?.content).toBe("project rules");
  });

  it("does not mutate bootstrap files unless explicitly enabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-identity-bootstrap-disabled-");
    await writeRootMarkdownFiles(workspaceDir, [
      { name: "AGENTS.md", content: "project rules" },
      { name: "EXTRA.md", content: "extra" },
    ]);

    const sessionKey = "agent:main:main";
    const context = createBootstrapContext({
      workspaceDir,
      cfg: createIdentityBootstrapConfig({ enabled: false }),
      sessionKey,
      initialFiles: [{ name: "AGENTS.md", content: "filtered agents" }],
    });

    const event = createHookEvent("agent", "bootstrap", sessionKey, context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.name)).toEqual(["AGENTS.md"]);
    expect(context.bootstrapFiles[0]?.content).toBe("filtered agents");
  });
});
