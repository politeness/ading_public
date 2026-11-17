// zh/en dictionaries: no duplicate keys, matching placeholders, no Chinese left in English
import { createRequire } from "node:module";
import { htmlMessages } from "../dist/ui/locales/html.js";
import { rendererMessages } from "../dist/ui/locales/renderer.js";
import { moduleMessages } from "../dist/ui/locales/modules.js";

const require = createRequire(import.meta.url);
const { mainMessages } = require("../dist/locales/main.js");
const { servicesMessages } = require("../dist/locales/services.js");
const { orchestrationMessages } = require("../dist/locales/orchestration.js");
const i18n = require("../dist/i18n.js");

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const groups = {
  renderer: [htmlMessages, rendererMessages, moduleMessages],
  main: [mainMessages, servicesMessages, orchestrationMessages]
};
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const [side, catalogs] of Object.entries(groups)) {
  const seen = new Set();
  for (const catalog of catalogs) {
    for (const [key, entry] of Object.entries(catalog)) {
      check(`${side} key not duplicated ${key}`, !seen.has(key), key);
      seen.add(key);
      check(`Both zh and en present ${key}`, typeof entry.zh === "string" && entry.zh.length > 0 && typeof entry.en === "string" && entry.en.length > 0, entry);
      check(`Placeholders match ${key}`, placeholders(entry.zh) === placeholders(entry.en), entry);
      check(`English has no Chinese ${key}`, !/[一-鿿]/.test(entry.en), entry.en);
    }
  }
  check(`${side} entry count is reasonable`, seen.size > 50, seen.size);
}

// Main process tm: Chinese by default, English after switching, parameter substitution, unknown languages fall back to Chinese
check("Chinese by default", i18n.mainLanguage() === "zh-CN");
const key = Object.keys(mainMessages).find((k) => /\{\w+\}/.test(mainMessages[k].zh));
const params = Object.fromEntries(placeholders(mainMessages[key].zh).split(",").map((name) => [name, "X"]));
check("Chinese parameter substitution", !/\{\w+\}/.test(i18n.tm(key, params)) && /[一-鿿]/.test(i18n.tm(key, params)), i18n.tm(key, params));
i18n.setMainLanguage("en");
check("Switched to English", i18n.mainLanguage() === "en" && !/[一-鿿]/.test(i18n.tm(key, params)), i18n.tm(key, params));
i18n.setMainLanguage("fr");
check("Unknown language falls back to Chinese", i18n.mainLanguage() === "zh-CN");

console.log(`i18n: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
