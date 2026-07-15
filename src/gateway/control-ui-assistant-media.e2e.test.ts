// Control UI assistant media e2e tests verify scoped media-ticket access through gateway HTTP routes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_E2E_TOKEN = "test-gateway-token-1234567890";

describe("Control UI assistant media e2e", () => {
  test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, "测试 ticketed (final).txt");
    await fs.writeFile(filePath, "ticketed control ui media\n", "utf8");

    await withGatewayServer(
      async ({ port }) => {
        const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
        const sourceParam = encodeURIComponent(filePath);

        const metadata = await fetch(`${route}?meta=1&source=${sourceParam}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(metadata.status).toBe(200);
        const payload = (await metadata.json()) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
        };
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);
        expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();

        const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
        expect(withoutTicket.status).toBe(401);

        const ticketed = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(ticketed.status).toBe(200);
        expect(ticketed.headers.get("content-disposition")).toBe(
          `attachment; filename="__ ticketed (final).txt"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20ticketed%20%28final%29.txt`,
        );
        expect(await ticketed.text()).toBe("ticketed control ui media\n");

        const otherFilePath = path.join(mediaDir, "other-preview.txt");
        await fs.writeFile(otherFilePath, "other media\n", "utf8");
        const wrongSource = await fetch(
          `${route}?source=${encodeURIComponent(otherFilePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(wrongSource.status).toBe(401);
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });

  test("assistantMediaAnyLocalPath independently gates files outside allowed roots", async () => {
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-outside-"));
    const outsidePath = path.join(outsideDir, "outside-roots.txt");
    await fs.writeFile(outsidePath, "outside the roots\n", "utf8");

    const fetchMeta = async (port: number) => {
      const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
      return await fetch(`${route}?meta=1&source=${encodeURIComponent(outsidePath)}`, {
        headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
      });
    };

    try {
      await withGatewayServer(
        async ({ port }) => {
          const response = await fetchMeta(port);
          expect(response.status).toBe(200);
          expect((await response.json()) as { available?: boolean }).toMatchObject({
            available: false,
          });
        },
        { serverOptions: { controlUiEnabled: true } },
      );

      testState.gatewayControlUi = { security: { assistantMediaAnyLocalPath: true } };
      await withGatewayServer(
        async ({ port }) => {
          const response = await fetchMeta(port);
          expect(response.status).toBe(200);
          expect((await response.json()) as { available?: boolean }).toMatchObject({
            available: true,
          });
          const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
          const served = await fetch(`${route}?source=${encodeURIComponent(outsidePath)}`, {
            headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
          });
          expect(served.status).toBe(200);
          expect(await served.text()).toBe("outside the roots\n");
          expect((await fetch(`${route}?source=${encodeURIComponent(outsidePath)}`)).status).toBe(
            401,
          );
        },
        { serverOptions: { controlUiEnabled: true } },
      );
    } finally {
      testState.gatewayControlUi = undefined;
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
