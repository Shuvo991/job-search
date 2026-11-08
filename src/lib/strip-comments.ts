/** Hand-edited JSON config files may carry "_readme"-style comment keys; remove them before validating. */
export function stripCommentKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCommentKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, inner]) => [key, stripCommentKeys(inner)]),
    );
  }
  return value;
}
