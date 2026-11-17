// Workspace resolution. This decides whether "quick conversations bleed into each other"; it implements the isolation promise and must be pinned down
import path from "node:path";
const { resolveWorkspace, memoryScopesFor, resolveArtifactPath } = await import(
  path.resolve("dist/orchestration/workspace.js")
);

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  if (cond) pass++; else { fail++; console.log("FAIL:", name, got !== undefined ? `-> ${JSON.stringify(got)}` : ""); }
};

const folder = {
  workspaceId: "w_1", name: "ading", path: "/Users/me/ading", kind: "folder",
  createdAt: "", updatedAt: ""
};
const inbox = {
  workspaceId: "w_inbox", name: "随手", kind: "inbox", createdAt: "", updatedAt: ""
};
const scratch = "/Users/me/Documents/ADing/inbox";
const conv = (id, override) => ({ conversationId: id, workspacePath: override });

// ---- folder workspace ----
const a = resolveWorkspace(conv("c_1"), folder, scratch);
check("folder uses the workspace directory", a.workspacePath === "/Users/me/ading", a.workspacePath);
check("folder has shared knowledge", a.sharesKnowledge === true);
check("folder knowledge is attached to workspaceId", a.knowledgeOwnerId === "w_1");

const b = resolveWorkspace(conv("c_1", "/Users/me/ading/web"), folder, scratch);
check("conversation path is an override", b.workspacePath === "/Users/me/ading/web", b.workspacePath);
check("still the same workspace after overriding the directory", b.knowledgeOwnerId === "w_1");

// ---- quick (inbox) ----
const c = resolveWorkspace(conv("c_2"), inbox, scratch);
const d = resolveWorkspace(conv("c_3"), inbox, scratch);
check("each quick conversation gets its own directory", c.workspacePath !== d.workspacePath, [c.workspacePath, d.workspacePath]);
check("quick directory is under scratch", c.workspacePath === path.join(scratch, "c_2"), c.workspacePath);
check("quick has no shared knowledge", c.sharesKnowledge === false);
check("quick has no knowledge anchor", c.knowledgeOwnerId === undefined);

// A missing workspace record (data corruption, mid-migration) must fall back to quick, not crash
const e = resolveWorkspace(conv("c_4"), null, scratch);
check("missing workspace falls back to scratch", e.workspacePath === path.join(scratch, "c_4"), e.workspacePath);
check("missing workspace shares no knowledge", e.sharesKnowledge === false);

// A folder with empty path is dirty data; it must also fall back, never pass undefined as cwd to codex
const f = resolveWorkspace(conv("c_5"), { ...folder, path: undefined }, scratch);
check("folder without directory falls back", f.workspacePath === path.join(scratch, "c_5"), f.workspacePath);
check("folder without directory shares no knowledge", f.sharesKnowledge === false);

// ---- memory layers ----
const full = memoryScopesFor(a, "u_1", "c_1");
check("folder injects three layers", full.length === 3, full.map((s) => s.scope));
check("order is person -> project -> conversation",
  full.map((s) => s.scope).join(",") === "user,workspace,conversation",
  full.map((s) => s.scope));
check("project layer attached to workspaceId", full[1].ownerId === "w_1");
check("conversation layer attached to conversationId", full[2].ownerId === "c_1");

const light = memoryScopesFor(c, "u_1", "c_2");
check("quick injects only two layers", light.length === 2, light.map((s) => s.scope));
check("quick has no workspace layer",
  light.every((s) => s.scope !== "workspace"), light.map((s) => s.scope));
check("quick still has personal memory", light[0].scope === "user" && light[0].ownerId === "u_1");
check("quick still has this conversation's memory", light[1].scope === "conversation" && light[1].ownerId === "c_2");

check("relative file resolves against the quick conversation directory", resolveArtifactPath("review-report.txt", c) === path.join(c.workspacePath,"review-report.txt"));
check("subdirectory with spaces", resolveArtifactPath("./reports/check report.txt", a) === path.join(a.workspacePath,"reports/check report.txt"));
check("absolute file needs no conversation", resolveArtifactPath("/tmp/report.txt") === "/tmp/report.txt");
check("relative file without a conversation must not land in app cwd", resolveArtifactPath("review-report.txt") === null);
for (const target of ["javascript:alert(1)","file:///tmp/a","//server/path", "a\0b"]) check("rejects invalid target " + target,resolveArtifactPath(target,a)===null);
console.log(`workspace: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
