import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-response]")) {
    button.addEventListener("click", () => ipcRenderer.send("permission:respond", Number(button.dataset.response)));
  }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") ipcRenderer.send("permission:respond", 0);
  });
  document.querySelector<HTMLButtonElement>('button[data-response="0"]')?.focus();
});
