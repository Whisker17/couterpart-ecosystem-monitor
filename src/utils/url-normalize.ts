// URL normalization for dedup
const EXACT_REMOVE = new Set(["ref", "source", "fbclid", "gclid"]);

export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.protocol = "https:";

  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
  }

  const toDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (key.startsWith("utm_") || EXACT_REMOVE.has(key)) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    parsed.searchParams.delete(key);
  }

  parsed.searchParams.sort();

  parsed.hash = "";

  return parsed.toString();
}
