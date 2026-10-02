const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.env.NODEBLASTER_HOST_ROOT || "/proc/1/root";
const ASSETS = process.env.NODEBLASTER_BOOTSTRAP_DIR || "/bootstrap";
const DATA_DIR = process.env.NODEBLASTER_DATA_DIR || "/data";
const STATUS = process.env.NODEBLASTER_BOOTSTRAP_STATUS || "/data/bootstrap-status.json";
const SKIP_SYSTEMD = process.env.NODEBLASTER_BOOTSTRAP_SKIP_SYSTEMD === "1";

const TARGETS = {
  "nodeblaster-updater/update.py": ["/home/umbrel/umbrel/nodeblaster-updater/update.py", 0o755],
  "systemd/nodeblaster-updater.service": ["/etc/systemd/system/nodeblaster-updater.service", 0o644],
  "systemd/nodeblaster-updater.timer": ["/etc/systemd/system/nodeblaster-updater.timer", 0o644],
  "nodeblaster-branding/apply.py": ["/home/umbrel/umbrel/nodeblaster-branding/apply.py", 0o755],
  "nodeblaster-branding/pre-start": ["/home/umbrel/umbrel/nodeblaster-branding/pre-start", 0o755],
  "custom-hooks/pre-start": ["/home/umbrel/umbrel/custom-hooks/pre-start", 0o755],
  "systemd/nodeblaster-branding.service": ["/etc/systemd/system/nodeblaster-branding.service", 0o644],
  "systemd/nodeblaster-branding.timer": ["/etc/systemd/system/nodeblaster-branding.timer", 0o644],
  "custom-wallpapers/replace-existing-wallpapers.py": ["/home/umbrel/umbrel/custom-wallpapers/replace-existing-wallpapers.py", 0o755],
  "nodeblaster-status/status_server.py": ["/home/umbrel/umbrel/nodeblaster-status/status_server.py", 0o755],
  "systemd/nodeblaster-status.service": ["/etc/systemd/system/nodeblaster-status.service", 0o644],
  "nodeblaster-support/support_access.py": ["/home/umbrel/umbrel/nodeblaster-support/support_access.py", 0o755],
  "systemd/nodeblaster-support-expire.service": ["/etc/systemd/system/nodeblaster-support-expire.service", 0o644],
  "systemd/nodeblaster-support-expire.timer": ["/etc/systemd/system/nodeblaster-support-expire.timer", 0o644],
  "nodeblaster-display/display.py": ["/home/umbrel/umbrel/nodeblaster-display/display.py", 0o755],
  "nodeblaster-display/assets/logo-badge-v2.png": ["/home/umbrel/umbrel/nodeblaster-display/assets/logo-badge-v2.png", 0o644],
  "nodeblaster-display/assets/block-found-notification.png": ["/home/umbrel/umbrel/nodeblaster-display/assets/block-found-notification.png", 0o644],
  "nodeblaster-display/assets/block-found-alert.wav": ["/home/umbrel/umbrel/nodeblaster-display/assets/block-found-alert.wav", 0o644],
  "systemd/nodeblaster-display.service": ["/etc/systemd/system/nodeblaster-display.service", 0o644],
  "nodeblaster-security/apply-hashwatcher-firewall.sh": ["/home/umbrel/umbrel/nodeblaster-security/apply-hashwatcher-firewall.sh", 0o755],
  "systemd/nodeblaster-hashwatcher-firewall.service": ["/etc/systemd/system/nodeblaster-hashwatcher-firewall.service", 0o644],
  "systemd/nodeblaster-hashwatcher-firewall.timer": ["/etc/systemd/system/nodeblaster-hashwatcher-firewall.timer", 0o644],
  "nodeblaster-control-bridge/bridge.py": ["/home/umbrel/umbrel/nodeblaster-control-bridge/bridge.py", 0o755],
  "systemd/nodeblaster-control-bridge.service": ["/etc/systemd/system/nodeblaster-control-bridge.service", 0o644],
};
for (let slot = 1; slot <= 12; slot += 1) {
  const name = `custom-wallpapers/source/slot-${String(slot).padStart(2, "0")}.jpg`;
  TARGETS[name] = [`/home/umbrel/umbrel/${name}`, 0o644];
}

const ARTIFACTS = [
  { name: "base", manifest: "base-manifest.json", signature: "base-manifest.json.sig", package: "base-package.tar.gz", version: "2026.09.26-stable133-display-polish-leaderboard-hold" },
  { name: "bridge", manifest: "bridge-manifest.json", signature: "bridge-manifest.json.sig", package: "bridge-package.tar.gz", version: "2026.09.29-stable135-control-bridge-payload-candidate" },
];

function writeStatus(state, detail) {
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });
  const temp = `${STATUS}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schema: 1, state, detail, updated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temp, STATUS);
}

function prepareAppData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.chmodSync(DATA_DIR, 0o770);
  try { fs.chownSync(DATA_DIR, 1000, 1000); } catch (error) { if (process.platform !== "win32") throw error; }
}

function prepareIdentityDirectory() {
  const identity = hostPath("/home/umbrel/umbrel/nodeblaster-identity");
  fs.mkdirSync(identity, { recursive: true, mode: 0o700 });
  fs.chmodSync(identity, 0o700);
  try { fs.chownSync(identity, 0, 0); } catch (error) { if (process.platform !== "win32") throw error; }
}

function hostPath(target) {
  return path.join(ROOT, target.replace(/^\/+/, ""));
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout;
}

function verifyAndInstall(artifact, trustedKey) {
  const manifestPath = path.join(ASSETS, artifact.manifest);
  const signaturePath = path.join(ASSETS, artifact.signature);
  const packagePath = path.join(ASSETS, artifact.package);
  const manifestBytes = fs.readFileSync(manifestPath);
  if (!crypto.verify("sha256", manifestBytes, trustedKey, fs.readFileSync(signaturePath))) {
    throw new Error(`${artifact.name} manifest signature is invalid`);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== artifact.version || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${artifact.name} manifest identity is invalid`);
  }
  const packageBytes = fs.readFileSync(packagePath);
  const digest = crypto.createHash("sha256").update(packageBytes).digest("hex");
  if (digest !== manifest.sha256 || packageBytes.length !== manifest.size) throw new Error(`${artifact.name} package integrity check failed`);
  const listed = run("tar", ["-tzf", packagePath]).split(/\r?\n/).filter(Boolean);
  if (listed.length !== manifest.files.length || listed.some((name, index) => name !== manifest.files[index])) {
    throw new Error(`${artifact.name} package file list does not match its signed manifest`);
  }
  for (const name of listed) if (!TARGETS[name]) throw new Error(`unsupported signed payload path: ${name}`);
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), `nodeblaster-${artifact.name}-`));
  try {
    run("tar", ["-xzf", packagePath, "-C", extracted]);
    for (const name of listed) {
      const [target, mode] = TARGETS[name];
      const destination = hostPath(target);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temp = `${destination}.nodeblaster-suite.tmp`;
      fs.copyFileSync(path.join(extracted, ...name.split("/")), temp);
      fs.chmodSync(temp, mode);
      fs.renameSync(temp, destination);
    }
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

function installActivationUnits() {
  const service = `[Unit]\nDescription=Activate licensed NodeBlaster Suite services\nAfter=nodeblaster-control-bridge.service umbrel.service\nConditionPathExists=/home/umbrel/umbrel/nodeblaster-identity/control-entitlement-v2.json\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /home/umbrel/umbrel/nodeblaster-branding/apply.py --mode full --wallpaper-selection preserve --display-policy apply\nExecStartPost=/usr/bin/systemctl enable --now nodeblaster-branding.timer nodeblaster-updater.timer nodeblaster-status.service nodeblaster-support-expire.timer\n\n[Install]\nWantedBy=multi-user.target\n`;
  const pathUnit = `[Unit]\nDescription=Watch for NodeBlaster Suite activation\n\n[Path]\nPathExists=/home/umbrel/umbrel/nodeblaster-identity/control-entitlement-v2.json\nUnit=nodeblaster-suite-activate.service\n\n[Install]\nWantedBy=multi-user.target\n`;
  for (const [name, content] of [["nodeblaster-suite-activate.service", service], ["nodeblaster-suite-activate.path", pathUnit]]) {
    const destination = hostPath(`/etc/systemd/system/${name}`);
    fs.writeFileSync(`${destination}.tmp`, content, { mode: 0o644 });
    fs.renameSync(`${destination}.tmp`, destination);
  }
}

function systemctl(...args) {
  if (!SKIP_SYSTEMD) run("chroot", [ROOT, "/usr/bin/systemctl", ...args]);
}

function main() {
  prepareAppData();
  writeStatus("installing", "Verifying signed appliance packages");
  if (!fs.statSync(ROOT).isDirectory()) throw new Error("host root is unavailable");
  const trustedKeyPath = path.join(ASSETS, "trusted-release-key.pub");
  const trustedKey = fs.readFileSync(trustedKeyPath);
  for (const artifact of ARTIFACTS) verifyAndInstall(artifact, trustedKey);
  const hostTrustedKey = hostPath("/home/umbrel/umbrel/nodeblaster-updater/trusted-release-key.pem");
  fs.mkdirSync(path.dirname(hostTrustedKey), { recursive: true });
  fs.copyFileSync(trustedKeyPath, hostTrustedKey);
  fs.chmodSync(hostTrustedKey, 0o644);
  const runtime = hostPath("/home/umbrel/umbrel/app-data/nodeblaster-control/data/host-bridge");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o770 });
  fs.chmodSync(runtime, 0o770);
  try { fs.chownSync(runtime, 1000, 1000); } catch (error) { if (process.platform !== "win32") throw error; }
  prepareIdentityDirectory();
  installActivationUnits();
  systemctl("daemon-reload");
  systemctl("enable", "nodeblaster-control-bridge.service", "nodeblaster-suite-activate.path");
  systemctl("restart", "nodeblaster-control-bridge.service");
  systemctl("start", "nodeblaster-suite-activate.path");
  writeStatus("ready", "Signed host agent installed; ready for license activation");
}

try {
  main();
} catch (error) {
  writeStatus("failed", String(error.message || error));
  process.exitCode = 1;
}
