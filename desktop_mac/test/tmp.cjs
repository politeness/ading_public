/** CommonJS version of `tmp.mjs`, for the `.cjs` UI tests. See tmp.mjs for details. */
const { mkdtemp: createAsync } = require("node:fs/promises");
const { mkdtempSync: createSync, rmSync } = require("node:fs");

const created = new Set();
let registered = false;

function remember(directory) {
  created.add(directory);
  if (!registered) {
    registered = true;
    process.on("exit", () => {
      for (const target of created) {
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // cleanup failure does not affect the test result
        }
      }
    });
  }
  return directory;
}

module.exports = {
  async mkdtemp(prefix) {
    return remember(await createAsync(prefix));
  },
  mkdtempSync(prefix) {
    return remember(createSync(prefix));
  }
};
