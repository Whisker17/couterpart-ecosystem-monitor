# TODOS

## Post-dogfooding improvements

- [ ] **Competitor relevance model** — Add `focus_areas` field to `competitors.json` (e.g., "infra pricing", "devtools", "AI integrations") and include it in the LLM prompt context. Makes analyses more focused and actionable instead of generic summaries. Surfaced by Codex outside voice during eng review. Depends on: v1 dogfooding complete. Context: Without focus areas, the LLM produces summaries based only on competitor name/tags. After 2 weeks of reading reports, note which analyses feel too generic — those are the competitors that need focus_areas.

- [ ] **RSS feed health monitoring** — Alert when a tracked feed hasn't produced new items in 7+ days. Check `last_synced_at` against current time; send a health alert to Lark if gap exceeds threshold. Prevents silent loss of competitor coverage. Surfaced by Codex outside voice during eng review. Depends on: v1 pipeline running. Context: The dangerous failure mode isn't "pipeline crashed" but "feed stopped updating silently." The monitor will quietly stop including a competitor whose RSS feed goes stale. `last_synced_at` already exists in the schema — the health check is a ~20-line addition.
