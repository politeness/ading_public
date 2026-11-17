import type { Catalog } from "../i18n.js";

export const moduleMessages = {
  "ui.queue.processing": { zh: "正在并行处理新消息，原工作继续", en: "Handling the new message in parallel; current work continues" },
  "ui.queue.waiting": { zh: "新消息将接续当前消息处理，原工作继续", en: "The new message will be handled after the current one; current work continues" },
  "ui.queue.handled": { zh: "新消息已处理，原工作继续", en: "New message handled; current work continues" }
} as const satisfies Catalog;
