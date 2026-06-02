import { test, expect } from "bun:test";
import { normalizeUrl } from "./url-normalize.js";

test("forces http to https", () => {
  expect(normalizeUrl("http://example.com/blog/")).toBe(
    "https://example.com/blog"
  );
});

test("keeps https unchanged", () => {
  expect(normalizeUrl("https://example.com/blog")).toBe(
    "https://example.com/blog"
  );
});

test("strips trailing slash from pathname", () => {
  expect(normalizeUrl("https://example.com/blog/")).toBe(
    "https://example.com/blog"
  );
});

test("does not strip root path slash", () => {
  const result = normalizeUrl("https://example.com/");
  expect(result).toBe("https://example.com/");
});

test("removes utm_ prefixed params", () => {
  expect(normalizeUrl("https://example.com/?utm_source=rss&id=1")).toBe(
    "https://example.com/?id=1"
  );
});

test("removes multiple utm_ params", () => {
  expect(
    normalizeUrl("https://example.com/?utm_source=rss&utm_medium=email&id=1")
  ).toBe("https://example.com/?id=1");
});

test("removes ref param", () => {
  expect(normalizeUrl("https://example.com/?ref=twitter")).toBe(
    "https://example.com/"
  );
});

test("removes source param", () => {
  expect(normalizeUrl("https://example.com/?source=rss")).toBe(
    "https://example.com/"
  );
});

test("removes fbclid param", () => {
  expect(normalizeUrl("https://example.com/?fbclid=abc123")).toBe(
    "https://example.com/"
  );
});

test("removes gclid param", () => {
  expect(normalizeUrl("https://example.com/?gclid=xyz789")).toBe(
    "https://example.com/"
  );
});

test("removes ref and source together", () => {
  expect(normalizeUrl("https://example.com/?ref=twitter&source=rss")).toBe(
    "https://example.com/"
  );
});

test("preserves referralCode — no false positive on prefix match", () => {
  expect(normalizeUrl("https://example.com/?referralCode=abc")).toBe(
    "https://example.com/?referralCode=abc"
  );
});

test("removes hash fragment", () => {
  expect(normalizeUrl("https://example.com/blog#section")).toBe(
    "https://example.com/blog"
  );
});

test("sorts remaining query params alphabetically", () => {
  expect(normalizeUrl("https://example.com/?z=last&a=first&m=mid")).toBe(
    "https://example.com/?a=first&m=mid&z=last"
  );
});

test("returns original string for invalid URL", () => {
  expect(normalizeUrl("not-a-url")).toBe("not-a-url");
});

test("returns original string for empty string", () => {
  expect(normalizeUrl("")).toBe("");
});

test("returns original string for relative path", () => {
  expect(normalizeUrl("/relative/path")).toBe("/relative/path");
});

test("different URL variants of same article normalize to same string", () => {
  const v1 = normalizeUrl(
    "http://example.com/blog/?utm_source=rss&utm_medium=feed&id=42#comments"
  );
  const v2 = normalizeUrl(
    "https://example.com/blog/?id=42&utm_medium=email&ref=newsletter"
  );
  expect(v1).toBe(v2);
});

test("combined: http, trailing slash, tracking params, hash all normalized", () => {
  expect(
    normalizeUrl(
      "http://example.com/blog/?utm_source=rss&id=1&fbclid=x#top"
    )
  ).toBe("https://example.com/blog?id=1");
});
