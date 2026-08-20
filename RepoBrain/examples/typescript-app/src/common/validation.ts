/**
 * Reusable primitive validators. Route- and module-level validators build on
 * top of these so the rules stay consistent across the codebase.
 */

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isEmail(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isPhoneLike(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isPercentage(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 100;
}

export class ValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Validation failed: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/**
 * Collects issues while validating and throws once with all of them. This is a
 * tiny helper so module validators do not each reinvent it.
 */
export class IssueCollector {
  private readonly issues: string[] = [];

  require(condition: boolean, message: string): void {
    if (!condition) {
      this.issues.push(message);
    }
  }

  throwIfAny(): void {
    if (this.issues.length > 0) {
      throw new ValidationError(this.issues);
    }
  }
}
