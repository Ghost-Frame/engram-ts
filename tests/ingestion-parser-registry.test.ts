import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getParser, listParsers } from "../src/ingestion/parsers/index.ts";

describe("Parser registry", () => {
  it("getParser('markdown') returns a parser with name 'markdown'", () => {
    const parser = getParser("markdown");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "markdown");
  });

  it("getParser('plaintext') returns the same parser as markdown", () => {
    const md = getParser("markdown");
    const pt = getParser("plaintext");
    assert.ok(pt, "plaintext parser should be defined");
    assert.equal(pt, md);
  });

  it("getParser('html') returns a parser with name 'html'", () => {
    const parser = getParser("html");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "html");
  });

  it("getParser('pdf') returns a parser with name 'pdf'", () => {
    const parser = getParser("pdf");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "pdf");
  });

  it("getParser('docx') returns a parser with name 'docx'", () => {
    const parser = getParser("docx");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "docx");
  });

  it("getParser('csv') returns a parser with name 'csv'", () => {
    const parser = getParser("csv");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "csv");
  });

  it("getParser('jsonl') returns a parser with name 'jsonl'", () => {
    const parser = getParser("jsonl");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "jsonl");
  });

  it("getParser('claude-export') returns a parser with name 'claude'", () => {
    const parser = getParser("claude-export");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "claude");
  });

  it("getParser('chatgpt-export') returns a parser with name 'chatgpt'", () => {
    const parser = getParser("chatgpt-export");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "chatgpt");
  });

  it("getParser('messages') returns a parser with name 'messages'", () => {
    const parser = getParser("messages");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "messages");
  });

  it("getParser('zip') returns a parser with name 'zip'", () => {
    const parser = getParser("zip");
    assert.ok(parser, "parser should be defined");
    assert.equal(parser.name, "zip");
  });

  it("getParser('unknown-format' as any) returns undefined", () => {
    const parser = getParser("unknown-format" as any);
    assert.equal(parser, undefined);
  });

  it("listParsers() returns array with >= 10 entries", () => {
    const parsers = listParsers();
    assert.ok(Array.isArray(parsers), "should be an array");
    assert.ok(parsers.length >= 10, `expected >= 10 parsers, got ${parsers.length}`);
  });
});
