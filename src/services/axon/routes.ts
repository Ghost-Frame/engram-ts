// ============================================================================
// Axon routes - event bus, pub/sub, SSE streaming, webhooks
// Prefix: /axon/*
// ============================================================================

import { json, errorResponse } from "../../helpers/index.ts";
import { getContext } from "../../middleware/auth.ts";
import { bounded } from "../types.ts";
import {
  publish, getEvents, getEvent,
  listChannels, createChannel,
  subscribe, unsubscribe, getSubscriptions,
  poll, startSSE,
  getStats,
} from "./bus.ts";

export async function handleAxonRoutes(
  method: string,
  url: URL,
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const path = url.pathname;

  if (!path.startsWith("/axon/") && path !== "/axon") return null;

  const sub = path.slice("/axon".length); // e.g. "/publish" or "/events/5"

  // - Publish --

  if (sub === "/publish" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { channel, source, type, payload } = body;
    if (!channel || typeof channel !== "string") return errorResponse("channel required", 400, requestId);
    if (!source || typeof source !== "string") return errorResponse("source required", 400, requestId);
    if (!type || typeof type !== "string") return errorResponse("type required", 400, requestId);
    if (type.includes("\n")) return errorResponse("type must not contain newline characters", 400, requestId);
    publish(auth.user_id, channel, source, type, payload ?? {});
    return json({ ok: true }, 201);
  }

  // - Events --

  if (sub === "/events" && method === "GET") {
    const { auth } = getContext(req);
    const since_id = url.searchParams.has("since_id") ? parseInt(url.searchParams.get("since_id")!, 10) : undefined;
    return json(getEvents(auth.user_id, {
      channel: url.searchParams.get("channel") ?? undefined,
      type: url.searchParams.get("type") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
      since_id: since_id !== undefined && Number.isFinite(since_id) ? since_id : undefined,
      limit: bounded(url.searchParams.get("limit"), 1, 1000, 100),
    }));
  }

  const eventMatch = sub.match(/^\/events\/(\d+)$/);
  if (eventMatch && method === "GET") {
    const { auth } = getContext(req);
    const event = getEvent(parseInt(eventMatch[1], 10), auth.user_id);
    if (!event) return errorResponse("Event not found", 404, requestId);
    return json(event);
  }

  // - Channels --

  if (sub === "/channels" && method === "GET") {
    const { auth } = getContext(req);
    return json(listChannels(auth.user_id));
  }

  if (sub === "/channels" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { name, description, retain_hours } = body;
    if (!name || typeof name !== "string") return errorResponse("name required", 400, requestId);
    try {
      return json(createChannel(auth.user_id, name, description, retain_hours), 201);
    } catch (e: any) {
      if (e.message?.includes("UNIQUE")) return errorResponse("Channel already exists", 409, requestId);
      throw e;
    }
  }

  // - Subscriptions --

  if (sub === "/subscribe" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { agent, channel, filter_type, webhook_url } = body;
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!channel || typeof channel !== "string") return errorResponse("channel required", 400, requestId);
    try {
      const result = await subscribe(auth.user_id, agent, channel, filter_type, webhook_url);
      return json(result, 201);
    } catch (e: any) {
      return errorResponse(e.message ?? "Subscription failed", 400, requestId);
    }
  }

  if (sub === "/unsubscribe" && method === "POST") {
    const { body: rawBody, auth } = getContext(req);
    const body = (rawBody || {}) as any;
    const { agent, channel } = body;
    if (!agent || typeof agent !== "string") return errorResponse("agent required", 400, requestId);
    if (!channel || typeof channel !== "string") return errorResponse("channel required", 400, requestId);
    const ok = unsubscribe(auth.user_id, agent, channel);
    if (!ok) return errorResponse("Subscription not found", 404, requestId);
    return json({ ok: true });
  }

  if (sub === "/subscriptions" && method === "GET") {
    const { auth } = getContext(req);
    return json(getSubscriptions(auth.user_id, url.searchParams.get("agent") ?? undefined));
  }

  // - Poll --

  if (sub === "/poll" && method === "GET") {
    const { auth } = getContext(req);
    const agent = url.searchParams.get("agent");
    const channel = url.searchParams.get("channel");
    if (!agent) return errorResponse("agent query param required", 400, requestId);
    if (!channel) return errorResponse("channel query param required", 400, requestId);
    const limit = bounded(url.searchParams.get("limit"), 1, 1000, 100);
    return json(poll(auth.user_id, agent, channel, limit));
  }

  // - SSE Stream --

  if (sub === "/stream" && method === "GET") {
    const { auth } = getContext(req);
    const agent = url.searchParams.get("agent");
    const channelsParam = url.searchParams.get("channels");
    if (!agent) return errorResponse("agent query param required", 400, requestId);
    if (!channelsParam) return errorResponse("channels query param required", 400, requestId);
    const channels = channelsParam.split(",").map(s => s.trim()).filter(Boolean);
    if (channels.length === 0) return errorResponse("at least one channel required", 400, requestId);
    const filterType = url.searchParams.get("filter_type") ?? undefined;
    const lastEventId = url.searchParams.has("last_event_id") ? parseInt(url.searchParams.get("last_event_id")!, 10) : undefined;
    return startSSE(auth.user_id, agent, channels, filterType, lastEventId !== undefined && Number.isFinite(lastEventId) ? lastEventId : undefined);
  }

  // - Stats --

  if (sub === "/stats" && method === "GET") {
    const { auth } = getContext(req);
    return json(getStats(auth.is_admin ? undefined : auth.user_id));
  }

  return null; // Not an axon route match
}
