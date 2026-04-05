// Smoke test for eval harness modules
import { isLocalModelAvailable } from "../../src/llm/local.ts";
import { repairAndParseJSON } from "../../src/llm/index.ts";
import { jsonStructuralMatch, keywordRecall } from "./scoring.ts";
import { wrapWithCollector, ENABLED } from "./collect.ts";

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

console.log("--- Eval Harness Smoke Test ---\n");

// Module imports
assert("local.ts loads", typeof isLocalModelAvailable === "function");
assert("repairAndParseJSON loads", typeof repairAndParseJSON === "function");
assert("jsonStructuralMatch loads", typeof jsonStructuralMatch === "function");
assert("keywordRecall loads", typeof keywordRecall === "function");
assert("wrapWithCollector loads", typeof wrapWithCollector === "function");

// JSON structural match
assert("identical structure = 1.0", jsonStructuralMatch('{"a":1}', '{"a":2}') === 1.0);
assert("different structure < 1.0", jsonStructuralMatch('{"a":1}', '{"b":2}') < 1.0);
assert("both non-JSON = 1.0", jsonStructuralMatch("hello", "world") === 1);
assert("one JSON one not = 0", jsonStructuralMatch('{"a":1}', "hello") === 0);

// Keyword recall
assert("full recall = 1.0", keywordRecall("192.168.1.1 port 8080", "server at 192.168.1.1 on port 8080") === 1.0);
assert("partial recall < 1.0", keywordRecall("192.168.1.1 port 8080 v2.3", "192.168.1.1") < 1.0);
assert("no keywords = 1.0", keywordRecall("hello world", "anything") === 1);

// Collector no-op when disabled
assert("collector disabled", !ENABLED);
const mock = async (s: string, u: string) => "mock";
assert("collector returns same fn when disabled", wrapWithCollector(mock as any) === mock);

console.log(`\n--- Results: ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);
