import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const RULES = [
  { id: "P1", severity: "HIGH", pattern: /ignore (all|any|the)?\s*(previous|system)|忽略.{0,8}(系统|之前|以上).{0,8}(指令|规则)/i, message: "疑似覆盖系统指令" },
  { id: "E2", severity: "HIGH", pattern: /process\.env|os\.environ|Get-ChildItem\s+Env:|读取.{0,8}(密钥|令牌|环境变量)/i, message: "疑似读取环境变量或密钥" },
  { id: "SC2", severity: "HIGH", pattern: /curl\s+[^\n|]+\|\s*(bash|sh)|iwr.{0,80}\|\s*(iex|Invoke-Expression)/i, message: "疑似下载并直接执行远程脚本" },
  { id: "SC3", severity: "HIGH", pattern: /fromBase64String|base64\s+(-d|--decode).{0,80}(bash|sh)|eval\s*\(/i, message: "疑似混淆或动态执行" },
  { id: "PE2", severity: "MEDIUM", pattern: /\bsudo\b|runas\s+\/user:administrator|Start-Process.{0,80}-Verb\s+RunAs/i, message: "请求提升系统权限" },
  { id: "PE3", severity: "HIGH", pattern: /\.ssh[\\/]|id_rsa|credentials\.json|keyring|读取.{0,8}(密码|凭据)/i, message: "疑似访问用户凭据" },
  { id: "EA2", severity: "HIGH", pattern: /(无需|不需要).{0,8}(确认|批准).{0,16}(删除|停止|购买|付费|发布)|without.{0,8}(confirmation|approval).{0,24}(delete|stop|purchase|publish)/i, message: "疑似绕过高影响操作确认" },
  { id: "RA1", severity: "CRITICAL", pattern: /(修改|重写).{0,8}(系统提示|自身代码|安全规则)|modify.{0,8}(system prompt|own code|safety rules)/i, message: "疑似要求智能体修改自身或安全规则" },
];

const WEIGHTS = { LOW: 5, MEDIUM: 10, HIGH: 25, CRITICAL: 50 };

export function basicScan(files) {
  const findings = [];
  for (const file of files) {
    const text = Buffer.isBuffer(file.content) ? file.content.toString("utf8") : String(file.content || "");
    for (const rule of RULES) {
      if (rule.pattern.test(text)) findings.push({ rule: rule.id, severity: rule.severity, file: file.name, message: rule.message });
    }
  }
  const score = Math.min(100, findings.reduce((total, item) => total + WEIGHTS[item.severity], 0));
  return { engine: "ropiq-basic", score, severity: score >= 80 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 20 ? "MEDIUM" : "LOW", safe: score < 50, findings };
}

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ available: false, error: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ available: true, code, stdout, stderr }); });
  });
}

function findCommand(name) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${name}${suffix}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return "";
}

export async function skillSpectorStatus() {
  const command = findCommand("skillspector");
  return { installed: Boolean(command), source: "NVIDIA/SkillSpector" };
}

export async function scanDirectory(directory) {
  const command = findCommand("skillspector");
  if (!command) return { available: false };
  const result = await run(command, ["scan", directory, "--format", "json", "--no-llm"]);
  if (!result.available) return { available: false };
  let report;
  try { report = JSON.parse(result.stdout); } catch {
    return { available: true, safe: false, score: 100, severity: "CRITICAL", findings: [{ rule: "SCANNER", severity: "CRITICAL", file: path.basename(directory), message: result.stderr || "SkillSpector 未返回有效 JSON" }] };
  }
  const score = Number(report.risk_assessment?.score ?? report.risk_score ?? report.score ?? 100);
  return {
    available: true,
    engine: "nvidia-skillspector",
    safe: score < 51,
    score,
    severity: report.risk_assessment?.severity || report.risk_severity || report.severity || (score >= 51 ? "HIGH" : "LOW"),
    findings: report.issues || report.filtered_findings || report.findings || [],
  };
}

export function writeScanReport(dataRoot, extensionId, report) {
  const directory = path.join(dataRoot, "security-reports");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${extensionId}.json`), `${JSON.stringify({ scannedAt: new Date().toISOString(), ...report }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
