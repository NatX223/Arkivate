import type { RequestHandler } from "express";

/**
 * Exact-match CORS: an allowed `Origin` is echoed back; anything else gets no CORS headers, so the
 * browser blocks the response. Preflights from denied origins get 403.
 */
export function cors(allowed: readonly string[], methods: string): RequestHandler {
  return (req, res, next) => {
    res.setHeader("vary", "origin");
    const origin = req.headers.origin;
    const ok = origin !== undefined && allowed.includes(origin);
    if (ok) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", methods);
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") return void res.sendStatus(ok ? 204 : 403);
    next();
  };
}
