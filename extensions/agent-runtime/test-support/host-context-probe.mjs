// §9 host-context probe. Characterizes the HOST execution context that the ACP/Codex app-server
// inherits (it is spawned via plain spawn on the host — extensions/codex/.../transport-stdio.ts).
// NEVER prints secret VALUES — only names, counts, and booleans. The codex binary is NOT launched
// (no provider creds; experimental policy). Run: node host-context-probe.mjs
import { existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

const SECRET_NAME =
  /(_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET|KEY))$|^(OV_|TELEGRAM_|SLACK_|GITHUB_|GH_|AWS_|GOOGLE_|AZURE_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|SSH_|DOCKER_)/i;

function canWrite(dir) {
  try {
    const probe = join(dir, `.oc-runtime-probe-${process.pid}`);
    writeFileSync(probe, "x");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function inContainer() {
  if (existsSync("/.dockerenv")) {
    return true;
  }
  try {
    const cg = readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods/.test(cg);
  } catch {
    return false; // /proc absent (e.g. macOS) → not in a Linux container
  }
}

const envNames = Object.keys(process.env);
const secretNamesPresent = envNames.filter((n) => SECRET_NAME.test(n));
const home = homedir();

const evidence = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : null,
  gid: typeof process.getgid === "function" ? process.getgid() : null,
  isRoot: typeof process.getuid === "function" ? process.getuid() === 0 : null,
  inContainer: inContainer(),
  dockerSocketVisible: existsSync("/var/run/docker.sock"),
  homeDir: home === process.env.HOME ? "<host HOME>" : "<other>",
  hostHomeWritable: canWrite(home),
  repoParentWritable: canWrite(dirname(process.cwd())),
  tmpWritable: canWrite(tmpdir()),
  sshDirVisible: existsSync(join(home, ".ssh")),
  awsDirVisible: existsSync(join(home, ".aws")),
  ghConfigVisible: existsSync(join(home, ".config", "gh")),
  npmrcVisible: existsSync(join(home, ".npmrc")),
  totalEnvVars: envNames.length,
  // names only — NO values
  secretPatternEnvNamesInherited: secretNamesPresent.length,
  sampleSecretNamesInherited: secretNamesPresent.slice(0, 8),
  // resource limits: not in a container ⇒ no enforced cgroup limits
  enforcedContainerResourceLimits: inContainer(),
};

console.log(JSON.stringify(evidence, null, 2));
