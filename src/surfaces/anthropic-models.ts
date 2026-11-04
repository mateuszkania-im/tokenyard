/**
 * Body of tokenyard's own `GET /v1/models` answer, in the Anthropic list shape.
 * Only ids containing `claude` are listed, because Claude Code keeps only those.
 */
export function modelsListBody(ids: readonly string[]): Buffer {
  const kept = [...new Set(ids.filter((id) => id.includes('claude')))];
  const data = kept.map((id) => ({ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' }));
  return Buffer.from(
    JSON.stringify({ data, has_more: false, first_id: kept[0] ?? null, last_id: kept[kept.length - 1] ?? null }),
  );
}
