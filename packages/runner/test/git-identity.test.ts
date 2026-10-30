import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)), "../../");
const guard = resolve(root, "scripts/verify-git-identity.mjs");
function withTemporaryGitRepo(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(resolve(tmpdir(), "browserproof-git-identity-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["config", "--local", "user.name", "Krishna Balaji"], { cwd });
    execFileSync("git", ["config", "--local", "user.email", "145410244+krishna31102004@users.noreply.github.com"], { cwd });
    run(cwd);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

describe("local publication identity guard", () => {
  it("accepts the configured identity that Git will use", () => {
    withTemporaryGitRepo((cwd) => {
      const result = spawnSync(process.execPath, [guard], { cwd, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Git identity preflight PASS");
    });
  });

  it("rejects an environment override without changing repository config", () => {
    withTemporaryGitRepo((cwd) => {
      const before = execFileSync("git", ["config", "--local", "--list"], { cwd, encoding: "utf8" });
      const result = spawnSync(process.execPath, [guard], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "--get", GIT_AUTHOR_EMAIL: "wrong@example.invalid" },
      });
      const after = execFileSync("git", ["config", "--local", "--list"], { cwd, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("identity override present");
      expect(after).toBe(before);
    });
  });
});
