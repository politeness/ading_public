import { p } from "../prompt-language";
import { parseDocument } from "yaml";

export function parseSkillDocument(text: string): { name: string; description: string; content: string } {
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if(!match) throw new Error(p("SKILL.md 必须包含 name 和 description 元数据", "SKILL.md must include name and description metadata"));
  const document=parseDocument(match[1],{uniqueKeys:true});
  const name=document.get("name"),description=document.get("description");
  if(document.errors.length || typeof name!=="string" || !name.trim() || typeof description!=="string" || !description.trim()) throw new Error(p("技能元数据无效，name 和 description 必须是非空文本", "The skill metadata is invalid; name and description must be nonempty text"));
  return {name,description,content:match[2].replace(/^\r?\n/,"")};
}
export function renderSkillDocument(skill: Pick<Skill,"name"|"description"|"content">, previous?: string): string {
  const embedded=skill.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  const match=(previous ?? (embedded ? skill.content : undefined))?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const document=parseDocument(match?.[1] ?? "",{uniqueKeys:true});
  if(document.errors.length) throw new Error(p("技能元数据无效", "The skill metadata is invalid"));
  document.set("name",skill.name); document.set("description",skill.description || skill.name);
  return ["---",document.toString().trimEnd(),"---","",embedded ? parseSkillDocument(skill.content).content : skill.content].join("\n");
}
