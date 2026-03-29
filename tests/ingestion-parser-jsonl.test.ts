import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonlParser } from "../src/ingestion/parsers/jsonl.ts";

describe("jsonlParser.detect", () => {
  it("returns true for meta.extension = .jsonl", () => {
    assert.equal(jsonlParser.detect('{"text":"hi"}', { extension: ".jsonl" }), true);
  });

  it("returns false for meta.extension = .json", () => {
    assert.equal(jsonlParser.detect('{"text":"hi"}', { extension: ".json" }), false);
  });

  it("returns false with no meta", () => {
    assert.equal(jsonlParser.detect('{"text":"hi"}'), false);
  });
});

describe("jsonlParser.parse", () => {
  it("yields one ParsedDocument per line", async () => {
    const input = '{"content":"hello"}\n{"content":"world"}';
    const docs: unknown[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc);
    }
    assert.equal(docs.length, 2);
  });

  it("finds content in 'content' field", async () => {
    const input = '{"content":"hello world","id":1}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "hello world");
  });

  it("finds content in 'text' field", async () => {
    const input = '{"text":"some text content","id":2}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "some text content");
  });

  it("finds content in 'body' field", async () => {
    const input = '{"body":"body content here","id":3}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "body content here");
  });

  it("skips blank lines", async () => {
    const input = '{"content":"hello"}\n\n{"content":"world"}\n';
    const docs: unknown[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc);
    }
    assert.equal(docs.length, 2);
  });

  it("skips unparseable lines", async () => {
    const input = '{"content":"hello"}\nnot valid json\n{"content":"world"}';
    const docs: unknown[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc);
    }
    assert.equal(docs.length, 2);
  });

  it("skips lines with no recognized content field", async () => {
    const input = '{"content":"hello"}\n{"other_field":"no content here"}\n{"content":"world"}';
    const docs: unknown[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc);
    }
    assert.equal(docs.length, 2);
  });

  it("metadata contains remaining fields not used as content", async () => {
    const input = '{"content":"hello world","id":42,"author":"Alice","tags":["a","b"]}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].metadata.id, 42);
    assert.equal(docs[0].metadata.author, "Alice");
    assert.deepEqual(docs[0].metadata.tags, ["a", "b"]);
    assert.equal(docs[0].metadata.content, undefined);
  });

  it("finds content in 'message' field", async () => {
    const input = '{"message":"msg content","id":5}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "msg content");
  });

  it("uses 'title' field for document title when present", async () => {
    const input = '{"content":"hello","title":"My Doc"}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "My Doc");
  });

  it("falls back to first 60 chars of text as title", async () => {
    const input = '{"content":"short text"}';
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of jsonlParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "short text");
  });
});
