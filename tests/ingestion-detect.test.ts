import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectFormat } from "../src/ingestion/detect.ts";
import { SupportedFormat } from "../src/ingestion/types.ts";

describe("detectFormat", () => {
  // Extension-based detection
  it("detects markdown from .md extension", () => {
    assert.equal(detectFormat("# Hello", { extension: ".md" }), SupportedFormat.Markdown);
  });

  it("detects plaintext from .txt extension", () => {
    assert.equal(detectFormat("hello world", { extension: ".txt" }), SupportedFormat.PlainText);
  });

  it("detects html from .html extension", () => {
    assert.equal(detectFormat("<p>hi</p>", { extension: ".html" }), SupportedFormat.HTML);
  });

  it("detects pdf from .pdf extension", () => {
    assert.equal(detectFormat(Buffer.from([0x25, 0x50, 0x44, 0x46]), { extension: ".pdf" }), SupportedFormat.PDF);
  });

  it("detects docx from .docx extension", () => {
    assert.equal(detectFormat(Buffer.alloc(10), { extension: ".docx" }), SupportedFormat.DOCX);
  });

  it("detects csv from .csv extension", () => {
    assert.equal(detectFormat("a,b,c\n1,2,3", { extension: ".csv" }), SupportedFormat.CSV);
  });

  it("detects jsonl from .jsonl extension", () => {
    assert.equal(detectFormat('{"a":1}\n{"b":2}', { extension: ".jsonl" }), SupportedFormat.JSONL);
  });

  it("detects zip from .zip extension", () => {
    assert.equal(detectFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04]), { extension: ".zip" }), SupportedFormat.ZIP);
  });

  // Magic bytes detection
  it("detects pdf from %PDF magic bytes", () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    assert.equal(detectFormat(buf), SupportedFormat.PDF);
  });

  it("detects zip from PK magic bytes", () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]); // PK..
    assert.equal(detectFormat(buf), SupportedFormat.ZIP);
  });

  // MIME-based detection
  it("detects html from text/html MIME type", () => {
    assert.equal(detectFormat("<p>hi</p>", { mime: "text/html" }), SupportedFormat.HTML);
  });

  it("detects pdf from application/pdf MIME type", () => {
    assert.equal(detectFormat(Buffer.alloc(10), { mime: "application/pdf" }), SupportedFormat.PDF);
  });

  // Content sniffing
  it("detects html from DOCTYPE content", () => {
    assert.equal(detectFormat("<!DOCTYPE html><html><body></body></html>"), SupportedFormat.HTML);
  });

  it("detects claude-export from JSON array with uuid+chat_messages fields", () => {
    const data = JSON.stringify([{ uuid: "abc-123", chat_messages: [], name: "Test" }]);
    assert.equal(detectFormat(data), SupportedFormat.ClaudeExport);
  });

  it("detects chatgpt-export from JSON array with title+mapping fields", () => {
    const data = JSON.stringify([{ title: "Conversation", mapping: {}, create_time: 1234 }]);
    assert.equal(detectFormat(data), SupportedFormat.ChatGPTExport);
  });

  it("detects messages from JSON array with role+content fields", () => {
    const data = JSON.stringify([{ role: "user", content: "Hello" }]);
    assert.equal(detectFormat(data), SupportedFormat.Messages);
  });

  // Fallback
  it("falls back to plaintext for unknown input", () => {
    assert.equal(detectFormat("some random text that matches nothing"), SupportedFormat.PlainText);
  });
});
