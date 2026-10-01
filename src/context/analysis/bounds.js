// Caller-supplied bounds shared by catalog construction and analysis. A bound
// the caller does not give is no bound: the whole input is used. A bound that
// is given but is not a positive number is refused by name.

export function optionalPositiveNumber(options, name, context) {
  const given = options?.[name];
  if (given === undefined || given === null) return Infinity;
  const value = Number(given);
  if (Number.isNaN(value) || value < Number.EPSILON) {
    throw new Error(`${context}: ${name} must be a positive number, got ${given}`);
  }
  return value;
}

export function optionalPositiveInteger(options, name, context) {
  const given = options?.[name];
  if (given === undefined || given === null) return Infinity;
  const value = Number(given);
  if (!Number.isInteger(value) || value < Number.EPSILON) {
    throw new Error(`${context}: ${name} must be a positive integer, got ${given}`);
  }
  return value;
}

