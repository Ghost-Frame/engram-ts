import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlParser } from "../src/ingestion/parsers/html.ts";

describe("htmlParser.detect", () => {
  it("returns true for meta.extension = .html", () => {
    assert.equal(htmlParser.detect("<p>hi</p>", { extension: ".html" }), true);
  });

  it("returns true for meta.extension = .htm", () => {
    assert.equal(htmlParser.detect("<p>hi</p>", { extension: ".htm" }), true);
  });

  it("returns true for content starting with <!DOCTYPE", () => {
    assert.equal(htmlParser.detect("<!DOCTYPE html><html></html>"), true);
  });

  it("returns true for content starting with <html", () => {
    assert.equal(htmlParser.detect("<html><body></body></html>"), true);
  });
});

describe("htmlParser.parse", () => {
  it("strips script and style tags", async () => {
    const input = `<html><head><script>alert('xss')</script><style>body { color: red; }</style></head><body><p>Real content</p></body></html>`;
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of htmlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.ok(!docs[0].text.includes("alert"), "script content should be stripped");
    assert.ok(!docs[0].text.includes("color: red"), "style content should be stripped");
  });

  it("strips nav/footer/header/aside elements", async () => {
    const input = `<html><body><header>Site Header</header><nav>Navigation</nav><main><p>Main content</p></main><aside>Sidebar</aside><footer>Footer text</footer></body></html>`;
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of htmlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.ok(!docs[0].text.includes("Site Header"), "header should be stripped");
    assert.ok(!docs[0].text.includes("Navigation"), "nav should be stripped");
    assert.ok(!docs[0].text.includes("Sidebar"), "aside should be stripped");
    assert.ok(!docs[0].text.includes("Footer text"), "footer should be stripped");
  });

  it("extracts title from <title> tag", async () => {
    const input = `<html><head><title>Page Title Here</title></head><body><p>Content</p></body></html>`;
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of htmlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "Page Title Here");
  });

  it("normalizes excessive whitespace (triple+ newlines to double)", async () => {
    const input = `<html><body><p>First paragraph</p><p>Second paragraph</p><p>Third paragraph</p></body></html>`;
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of htmlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.ok(!docs[0].text.includes("\n\n\n"), "should not contain triple newlines");
  });
});
