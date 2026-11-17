// Agent output varies wildly and the parsing layer is the most fragile part, so test it separately
import path from "node:path";
const m = await import(path.resolve("dist/skills/capture.js"));

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

// ---- parseJson ----
check("Pure JSON", m.parseJson('{"problems":[]}')?.problems.length === 0);
check("```json fence", m.parseJson('```json\n{"problems":["a"]}\n```')?.problems[0] === "a");
check("``` fence without language", m.parseJson('```\n{"problems":["b"]}\n```')?.problems[0] === "b");
check("Explanatory text before", m.parseJson('我看了一下，觉得没问题。\n{"problems":[]}')?.problems.length === 0);
check("Text before and after", m.parseJson('看法如下\n{"problems":["c"]}\n以上。')?.problems[0] === "c");
check("NONE returns null", m.parseJson("NONE") === null);
check("lowercase none also counts", m.parseJson("none") === null);
check("NONE with explanation", m.parseJson("NONE，这一轮没什么可沉淀的") === null);
check("Empty string", m.parseJson("") === null);
check("Plain prose without JSON", m.parseJson("我觉得挺好的，没什么问题") === null);
check("Bad JSON does not throw", m.parseJson('{"problems":[缺引号]}') === null);
check("Nested object", m.parseJson('{"name":"x","content":"a{b}c"}')?.content === "a{b}c");

// ---- stripTrailingJson ----
const withTail = '这条规则有点太绝对了，同步回调其实不需要幂等。\n{"problems":["过度泛化"],"suggestion":"限定为 MQ 回调"}';
const stripped = m.stripTrailingJson(withTail);
check("Strips trailing JSON", !stripped.includes("problems"), stripped);
check("Keeps human text", stripped.includes("同步回调其实不需要幂等"), stripped);

const fencedTail = '看起来没问题。\n```json\n{"problems":[]}\n```';
const strippedFenced = m.stripTrailingJson(fencedTail);
check("Strips fenced JSON", !strippedFenced.includes("problems"), strippedFenced);
check("Fenced version keeps human text", strippedFenced.includes("看起来没问题"), strippedFenced);

check("Returned as-is when there is no JSON", m.stripTrailingJson("就是一段普通的话") === "就是一段普通的话");
// With only JSON and no human text, must not return an empty string (otherwise an empty message appears in the group)
check("Pure JSON is not emptied", m.stripTrailingJson('{"problems":[]}').length > 0);

console.log(`\nParsing layer tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
