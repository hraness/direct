// src/core/result.ts
function ok(value) {
  return { ok: true, value };
}
function err(error) {
  return { ok: false, error };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { ok, err, isRecord };
