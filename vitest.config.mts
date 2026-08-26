import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worktrees created under .claude/worktrees/ live nested inside this
    // folder on disk, and vitest's default file glob has no directory
    // anchor — without this it would also pick up (and re-run) those
    // worktrees' own copies of every test file.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
