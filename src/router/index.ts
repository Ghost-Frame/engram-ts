import type { Handler, Middleware, Params, Route, Router } from "./types.ts";
export type { Handler, Middleware, Params, Router } from "./types.ts";

import { securityHeaders } from "../helpers/index.ts";

function compilePath(pattern: string): { segments: string[]; paramNames: string[] } {
  const segments = pattern.split("/").filter(Boolean);
  const paramNames: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith(":")) paramNames.push(seg.slice(1));
  }
  return { segments, paramNames };
}

function matchRoute(route: Route, method: string, pathSegments: string[]): Params | null {
  if (route.method !== method) return null;
  if (route.segments.length !== pathSegments.length) return null;
  const params: Params = {};
  for (let i = 0; i < route.segments.length; i++) {
    const routeSeg = route.segments[i];
    const pathSeg = pathSegments[i];
    if (routeSeg.startsWith(":")) {
      params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
    } else if (routeSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}

export function createRouter(): Router {
  const routes: Route[] = [];
  const middlewares: Middleware[] = [];

  function addRoute(method: string, pattern: string, handler: Handler, prefix = ""): void {
    const fullPattern = prefix + pattern;
    const { segments, paramNames } = compilePath(fullPattern);
    routes.push({ method, pattern: fullPattern, segments, paramNames, handler });
  }

  const router: Router = {
    get: (path, handler) => addRoute("GET", path, handler),
    post: (path, handler) => addRoute("POST", path, handler),
    put: (path, handler) => addRoute("PUT", path, handler),
    patch: (path, handler) => addRoute("PATCH", path, handler),
    delete: (path, handler) => addRoute("DELETE", path, handler),

    use: (mw) => { middlewares.push(mw); },

    group: (prefix, fn) => {
      const grouped: Router = {
        get: (path, handler) => addRoute("GET", path, handler, prefix),
        post: (path, handler) => addRoute("POST", path, handler, prefix),
        put: (path, handler) => addRoute("PUT", path, handler, prefix),
        patch: (path, handler) => addRoute("PATCH", path, handler, prefix),
        delete: (path, handler) => addRoute("DELETE", path, handler, prefix),
        use: router.use,
        group: (subPrefix, subFn) => router.group(prefix + subPrefix, subFn),
        handle: router.handle,
      };
      fn(grouped);
    },

    handle: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: securityHeaders() });
      }

      const pathSegments = url.pathname.split("/").filter(Boolean);

      let matched: { route: Route; params: Params } | null = null;
      for (const route of routes) {
        const params = matchRoute(route, method, pathSegments);
        if (params !== null) {
          matched = { route, params };
          break;
        }
      }

      if (!matched) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { route, params } = matched;

      let idx = 0;
      const next = async (): Promise<Response> => {
        if (idx < middlewares.length) {
          const mw = middlewares[idx++];
          return mw(req, params, next);
        }
        return route.handler(req, params);
      };

      return next();
    },
  };

  return router;
}
