import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { SessionsRouteData } from "./sessions-page.ts";

function routeOptions(location: RouteLocation) {
  const search = new URLSearchParams(location.search);
  const expandedSessionKey = search.get("session")?.trim() || null;
  // The operator list is deliberately an unarchived-session surface. BRD-01
  // archives stay hidden and there is no archive-browser route.
  const showArchived = false;
  return { expandedSessionKey, showArchived };
}

export async function loadSessionsRoute(
  context: ApplicationContext,
  location: RouteLocation,
): Promise<SessionsRouteData> {
  const options = routeOptions(location);
  const checkpointAgentId = parseAgentSessionKey(options.expandedSessionKey)?.agentId;
  const sessionRequest = options.expandedSessionKey
    ? context.sessions.list({
        activeMinutes: 0,
        limit: 50,
        search: options.expandedSessionKey,
        includeGlobal: true,
        includeUnknown: true,
        showArchived: false,
        ...(checkpointAgentId ? { agentId: checkpointAgentId } : {}),
      })
    : context.sessions.listAllUnarchived();
  const [sessions] = await Promise.all([
    sessionRequest.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error: String(error) }),
    ),
    context.runtimeConfig.ensureLoaded().catch(() => undefined),
  ]);
  const gateway = context.gateway.snapshot;
  return {
    client: gateway.client,
    connected: gateway.connected,
    result: sessions.result,
    error: sessions.error,
    ...options,
  };
}

export const page = definePage({
  id: "sessions",
  path: "/sessions",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => {
    const options = routeOptions(location);
    return `${options.expandedSessionKey ?? ""}\u0000${options.showArchived ? "1" : "0"}`;
  },
  loader: (context: ApplicationContext, { location }) => loadSessionsRoute(context, location),
  component: () =>
    import("./sessions-page.ts").then(() => ({
      header: true,
      render: (data: SessionsRouteData | undefined) =>
        html`<openclaw-sessions-page .routeData=${data}></openclaw-sessions-page>`,
    })),
});
