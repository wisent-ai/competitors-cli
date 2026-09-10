// Required caller-supplied bounds shared by catalog construction and analysis.

export function requirePositiveNumber(options, name, context) {
  const value = Number(options?.[name]);
  if (!Number.isFinite(value) || value < Number.EPSILON) {
    throw new Error(`${context} requires a finite positive ${name} option`);
  }
  return value;
}

export function requirePositiveInteger(options, name, context) {
  const value = Number(options?.[name]);
  if (!Number.isInteger(value) || value < Number.EPSILON) {
    throw new Error(`${context} requires a positive integer ${name} option`);
  }
  return value;
}

