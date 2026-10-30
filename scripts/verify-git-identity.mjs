import { execFileSync } from "node:child_process";

const expected = {
  name: "Krishna Balaji",
  email: "145410244+krishna31102004@users.noreply.github.com",
};

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

try {
  const configuredName = git(["config", "--local", "--get", "user.name"]);
  const configuredEmail = git(["config", "--local", "--get", "user.email"]);
  const author = git(["var", "GIT_AUTHOR_IDENT"]);
  const committer = git(["var", "GIT_COMMITTER_IDENT"]);
  const identity = `${expected.name} <${expected.email}>`;
  const badOverride = Object.keys(process.env).find((key) =>
    /^(GIT_AUTHOR_|GIT_COMMITTER_)/.test(key),
  );
  const validIdent = new RegExp(`^${expected.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} <${expected.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}> \\d+ [+-]\\d{4}$`);
  if (configuredName !== expected.name || configuredEmail !== expected.email || !validIdent.test(author) || !validIdent.test(committer) || badOverride) {
    console.error("Git identity preflight FAILED");
    console.error(`configured: ${configuredName} <${configuredEmail}>`);
    console.error(`author: ${author}`);
    console.error(`committer: ${committer}`);
    if (badOverride) console.error(`identity override present: ${badOverride}`);
    process.exit(1);
  }
  if (!author.startsWith(identity) || !committer.startsWith(identity)) throw new Error("git var identities do not match expected identity");
  console.log(`Git identity preflight PASS: ${identity} for author and committer`);
} catch (error) {
  console.error(`Git identity preflight FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
