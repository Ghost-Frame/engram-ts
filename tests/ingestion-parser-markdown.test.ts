import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownParser } from "../src/ingestion/parsers/markdown.ts";

describe("markdownParser.detect", () => {
  it("returns true for meta.extension = .md", () => {
    assert.equal(markdownParser.detect("# Hello", { extension: ".md" }), true);
  });

  it("returns true for meta.extension = .txt", () => {
    assert.equal(markdownParser.detect("hello world", { extension: ".txt" }), true);
  });

  it("returns false for meta.extension = .html", () => {
    assert.equal(markdownParser.detect("<p>hi</p>", { extension: ".html" }), false);
  });
});

describe("markdownParser.parse", () => {
  it("yields one ParsedDocument", async () => {
    const docs: unknown[] = [];
    for await (const doc of markdownParser.parse("# Title\n\nSome text.")) {
      docs.push(doc);
    }
    assert.equal(docs.length, 1);
  });

  it("extracts title from first markdown heading", async () => {
    const input = "# My Heading\n\nSome content here.";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of markdownParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "My Heading");
  });

  it("uses first 60 chars as title when no heading present", async () => {
    const input = "This is a document without any heading at all, just plain text here.";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of markdownParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, input.slice(0, 60));
  });

  it("sets text to full input content", async () => {
    const input = "# Title\n\nSome text content.";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of markdownParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, input);
  });
});
