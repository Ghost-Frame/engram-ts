export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") throw new ValidationError(`${fieldName} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`${fieldName} is required`);
  return trimmed;
}

export function optionalString(value: unknown, fallback: string = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim() || fallback;
}

export function optionalInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function requireBody(body: unknown, requiredFields: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body is required");
  }
  const obj = body as Record<string, unknown>;
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new ValidationError(`${field} is required`);
    }
  }
  return obj;
}

export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string").map(t => t.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map(t => t.trim()).filter(Boolean);
  return [];
}

export function parseIdFromPath(pathname: string, position: number): number | null {
  const segments = pathname.split("/").filter(Boolean);
  const raw = segments[position];
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return Number.isInteger(id) ? id : null;
}
