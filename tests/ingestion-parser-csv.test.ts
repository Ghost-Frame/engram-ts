import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { csvParser } from "../src/ingestion/parsers/csv.ts";

describe("csvParser.detect", () => {
  it("returns true for meta.extension = .csv", () => {
    assert.equal(csvParser.detect("a,b,c", { extension: ".csv" }), true);
  });

  it("returns false for meta.extension = .json", () => {
    assert.equal(csvParser.detect("a,b,c", { extension: ".json" }), false);
  });

  it("returns false with no meta", () => {
    assert.equal(csvParser.detect("a,b,c"), false);
  });
});

describe("csvParser.parse", () => {
  it("yields one ParsedDocument per data row", async () => {
    const input = "id,content\n1,hello\n2,world";
    const docs: unknown[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc);
    }
    assert.equal(docs.length, 2);
  });

  it("auto-detects column named 'content' as text column", async () => {
    const input = "id,content\n1,hello world\n2,foo bar";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "hello world");
    assert.equal(docs[1].text, "foo bar");
  });

  it("auto-detects column named 'text' as text column", async () => {
    const input = "id,text\n1,first message\n2,second message";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "first message");
    assert.equal(docs[1].text, "second message");
  });

  it("falls back to longest average string length column when no named column", async () => {
    const input = "id,description\n1,this is a very long description field\n2,another lengthy description here";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "this is a very long description field");
    assert.equal(docs[1].text, "another lengthy description here");
  });

  it("uses row number as title when no title/name column", async () => {
    const input = "id,content\n1,hello\n2,world";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "Row 1");
    assert.equal(docs[1].title, "Row 2");
  });

  it("uses 'title' column as title when present", async () => {
    const input = "title,content\nMy Title,some text here\nAnother,more text";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "My Title");
    assert.equal(docs[1].title, "Another");
  });

  it("uses 'name' column as title when present", async () => {
    const input = "name,content\nItem One,some text here\nItem Two,more text";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].title, "Item One");
    assert.equal(docs[1].title, "Item Two");
  });

  it("metadata includes all non-content columns", async () => {
    const input = "id,author,content\n1,Alice,hello world";
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].metadata.id, "1");
    assert.equal(docs[0].metadata.author, "Alice");
    assert.equal(docs[0].metadata.content, undefined);
  });

  it("handles quoted fields with commas", async () => {
    const input = `id,content\n1,"hello, world"\n2,simple`;
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, "hello, world");
    assert.equal(docs[1].text, "simple");
  });

  it("handles quoted fields with escaped double quotes", async () => {
    const input = `id,content\n1,"say ""hello"""\n2,simple`;
    const docs: { title: string; text: string; source: string; metadata: Record<string, unknown> }[] = [];
    for await (const doc of csvParser.parse(input)) {
      docs.push(doc as typeof docs[0]);
    }
    assert.equal(docs[0].text, 'say "hello"');
  });
});
