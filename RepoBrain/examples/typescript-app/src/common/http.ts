/**
 * HTTP helpers shared by route handlers: a typed error class and a small
 * wrapper that turns thrown errors into JSON responses.
 */

import type { Request, Response, NextFunction } from "express";

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, details);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, message);
}

export type AsyncHandler = (
  req: Request,
  res: Response,
) => Promise<unknown> | unknown;

/**
 * Wraps an async handler so rejected promises are forwarded to the error
 * middleware instead of crashing the process.
 */
export function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal error";
  res.status(500).json({ error: message });
}
