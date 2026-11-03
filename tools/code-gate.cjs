#!/usr/bin/env node
// The portable code gate -- WP-D6-06, OKF-TOGAF#160, on "Build WP-D6-06's remaining half as 462-CC
// plans it with 229-DT2's answers and additions -- David Facer 10/18/2026". SOURCE OF RECORD: each
// repository the plan gates carries a byte-for-byte copy as tools/code-gate.cjs, run by its workflow
// (tools/code-gate/code-gate.yml) on every push, and tools/code-gate/copies.js holds each copy to this
// file. It is the sites' gate (aimaturitymodels' scripts/code-gate.js, 371-CC), made to run anywhere:
//
//   SECRETS, by the sites' patterns: file, line and kind, never the value. In a code file an unquoted
//     name, property read or call is not a value (418-DT2); a line the repository marks known safe is
//     reported as such, by its reason (MARKS_FILE).
//   THE CODE CHECK: where a lint config runs, the linter's counts; otherwise, or where the linter cannot
//     run, a parse of every .js, .cjs and .mjs file by Node and of every .py file by Python where
//     Python is found. A file it cannot parse -- .ts, .tsx, .jsx, JSX inside a .js file, or .py without
//     Python -- is named as skipped, never passed (229-DT2 section 1.3).
//   THE DEPENDENCY AUDIT, for every package-lock.json outside installed packages.
//
// IT REPORTS. Nothing refuses unless --refuse-secrets is given, and then only a found secret; outside
// the two sites nothing is given it (462-CC section 3.3). The exit is otherwise 0, so a run fails only if
// the gate itself cannot run. The counts go to the summary file named by --summary, so a finding shows on
// the run's page without opening its log (229-DT2 section 2.2). The gate reads no environment variable:
// the workflow passes that path as an argument.
//
// HOW IT CAN BE CROSSED (RULE-10, declared): a secret in a shape no pattern knows passes; a secret split
// across lines passes; a file skipped is not checked, though it is named; anyone who can push can edit a
// repository's copy, which copies.js then names as differing. A marked line is reported as known safe,
// not as a secret, and would pass if --refuse-secrets were given; anyone who can push can add a mark.
// GitHub's own secret scanning is a second, separate stop in the public repositories (WP-D6-06
// activity 2).
//
// Usage: node tools/code-gate.cjs <root> [--report] [--refuse-secrets] [--summary <file>]
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SHAPES = [
  { kind: "privatekey", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: "github", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { kind: "apikey", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "aws", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
];
const SEP = String.raw`\s*["']?\s*[:=]\s*["']?`;
const VAL = String.raw`([^\s"'\x60,;)}\]]{8,})`;
const ASSIGNS = [
  { kind: "vercel", re: new RegExp(String.raw`(\b(?:VERCEL|VC)_[A-Z0-9_]*TOKEN)(` + SEP + ")" + VAL, "gi") },
  { kind: "assign", re: new RegExp(String.raw`(?<![<A-Za-z0-9_])([A-Za-z0-9_]*(?:password|passwd|secret|api_key|apikey|token))(` + SEP + ")" + VAL, "gi") },
];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "out", "dist", "build", "coverage", ".venv", "venv", "__pycache__"]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|xlsx?|zip|gz|mp3|mp4|webm|svg|tar|tgz|jsonl)$/i;
const rel = (root, full) => path.relative(root, full).replace(/\\/g, "/");

function walk(root, onFile) {
  const go = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) go(full); continue; }
      if (e.isFile()) onFile(full, e.name);
    }
  };
  go(root);
}

// In a code file an unquoted value after an assignment is an expression: a name, a property read or a
// call holds nothing of its own, as an environment-variable read doesn't (418-DT2 section 2). Only in these files,
// and only for the assign kind; an unquoted value in .env, YAML, TOML, INI, shell or Markdown is a literal.
// The scan cannot see a string or a comment, so a bare name stays a flag (a key can be shaped like one),
// and so does a name right after ? & # or /, as in a URL's query (419-DT2).
const CODE_FILE = /\.(js|cjs|mjs|jsx|ts|tsx)$/i;
const EXPRESSION = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*(?:\??\.[A-Za-z_$][\w$]*|[[(].*)$/;
const IN_URL = /[?&#/]$/;

function kindsIn(line, file) {
  const kinds = [];
  for (const { kind, re } of SHAPES) if (re.test(line)) kinds.push(kind);
  for (const { kind, re } of ASSIGNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (/^process\.env\b/.test(m[3])) continue; // names a variable, holds nothing
      if (kind === "assign" && file && CODE_FILE.test(file) && !/["']\s*$/.test(m[2]) && EXPRESSION.test(m[3]) && !IN_URL.test(line.slice(0, m.index))) continue; // an expression, holds nothing
      kinds.push(kind);
      break;
    }
    re.lastIndex = 0;
  }
  return kinds;
}

// Every text file under root, less installed packages, build output, environments and binaries.
function scanSecrets(root) {
  const hits = [];
  walk(root, (full, name) => {
    if (BINARY.test(name)) return;
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { return; }
    if (text.includes("\u0000")) return;
    text.split(/\r?\n/).forEach((line, i) => { for (const kind of kindsIn(line, name)) hits.push({ file: rel(root, full), line: i + 1, kind }); });
  });
  return hits;
}

// THE KNOWN-SAFE MARK (418-DT2 section 1). A repository's own list, at MARKS_FILE under its root: each
// entry names a path, the kind, a hash of the line's whole text, a reason citing the brief that
// classified the line, and who marked it. A flag on a line whose path, kind and hash match is reported
// as known safe, not as a secret. A changed line stops matching and flags again; an entry whose line is
// gone is reported as stale. A list that cannot be read, or has an entry missing a field, marks nothing.
const MARKS_FILE = "tools/code-gate.known-safe.json";
const lineHash = (text) => require("crypto").createHash("sha256").update(text, "utf8").digest("hex");

function readMarks(root) {
  const full = path.join(root, MARKS_FILE);
  if (!fs.existsSync(full)) return { marks: [] };
  try {
    const marks = JSON.parse(fs.readFileSync(full, "utf8")).marks;
    if (!Array.isArray(marks)) throw new Error("no marks list");
    for (const e of marks) for (const f of ["path", "kind", "line_sha256", "reason", "by"]) if (!e || typeof e[f] !== "string" || !e[f]) throw new Error("an entry has no " + f);
    return { marks };
  } catch (e) {
    return { marks: [], error: String(e.message || e).split("\n")[0] };
  }
}

function applyMarks(root, hits, marks) {
  const linesOf = {};
  const lines = (p) => {
    if (!(p in linesOf)) { try { linesOf[p] = fs.readFileSync(path.join(root, p), "utf8").split(/\r?\n/); } catch { linesOf[p] = null; } }
    return linesOf[p];
  };
  const safe = [], open = [];
  for (const h of hits) {
    const p = h.file.replace(/\\/g, "/");
    const text = (lines(h.file) || [])[h.line - 1];
    const e = text === undefined ? null : marks.find((x) => x.path === p && x.kind === h.kind && x.line_sha256 === lineHash(text));
    if (e) safe.push(Object.assign({}, h, { reason: e.reason, by: e.by })); else open.push(h);
  }
  const stale = marks.filter((e) => !(lines(e.path) || []).some((t) => lineHash(t) === e.line_sha256));
  return { hits: open, safe, stale };
}

const formatSecrets = (hits) => hits.map((h) => "  " + h.file + ":" + h.line + "  " + h.kind).join("\n");
const exitFor = (hits, opts) => ((opts && opts.refuseSecrets) && hits.length ? 1 : 0);

// A command of this file's own, never input, run with its arguments as a list. On Windows npm and npx
// are .cmd files, which Node starts only through a shell; their arguments here are this file's own
// constants, so the shell is given nothing from outside.
const runList = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, shell: /\.cmd$/.test(cmd) });

function findPython() {
  for (const cmd of ["python3", "python"]) {
    const r = runList(cmd, ["-c", "import ast; print(1)"]);
    if (!r.error && r.status === 0 && /1/.test(r.stdout || "")) return cmd;
  }
  return null;
}

const PY_PARSE = "import ast,sys\nsrc=open(sys.argv[1],encoding='utf-8').read()\nast.parse(src, sys.argv[1])";
const JSX_HINT = /Unexpected token '<'|JSX|Unexpected token '\/'/;

// Parse every script file: Node for .js, .cjs, .mjs; Python for .py where found. Name what is skipped.
function parseCheck(root, opts) {
  const python = opts && "python" in opts ? opts.python : findPython();
  const out = { mode: "parse", checked: 0, problems: [], skipped: [], python };
  walk(root, (full, name) => {
    const r = rel(root, full);
    if (/\.(js|cjs|mjs)$/.test(name)) {
      const res = runList(process.execPath, ["--check", full]);
      if (res.error) { out.skipped.push({ file: r, why: "node could not run" }); return; }
      if (res.status === 0) { out.checked++; return; }
      const err = String(res.stderr || "");
      if (JSX_HINT.test(err) && /<[A-Za-z/>]/.test(fs.readFileSync(full, "utf8"))) { out.skipped.push({ file: r, why: "JSX, which Node does not parse" }); return; }
      out.checked++;
      out.problems.push({ file: r, line: (err.match(/:(\d+)\s*\n/) || [])[1] ? +err.match(/:(\d+)\s*\n/)[1] : null });
      return;
    }
    if (/\.py$/.test(name)) {
      if (!python) { out.skipped.push({ file: r, why: "no Python found" }); return; }
      const res = runList(python, ["-c", PY_PARSE, full]);
      if (res.error) { out.skipped.push({ file: r, why: "Python could not run" }); return; }
      out.checked++;
      if (res.status !== 0) out.problems.push({ file: r, line: (String(res.stderr).match(/line (\d+)/) || [])[1] ? +String(res.stderr).match(/line (\d+)/)[1] : null });
      return;
    }
    if (/\.(ts|tsx|jsx)$/.test(name)) out.skipped.push({ file: r, why: "TypeScript or JSX, which this check does not parse" });
  });
  return out;
}

const LINT_CONFIG = /^(eslint\.config\.(js|cjs|mjs)|\.eslintrc(\.(js|cjs|json|yml|yaml))?)$/;
const hasLintConfig = (root) => { try { return fs.readdirSync(root).some((f) => LINT_CONFIG.test(f)); } catch { return false; } };
const defaultLint = (root) => {
  const r = runList(process.platform === "win32" ? "npx.cmd" : "npx", ["--no-install", "eslint", ".", "-f", "json"], root);
  if (r.error) throw r.error;
  if (!r.stdout || !r.stdout.trim()) throw new Error("no output" + (r.stderr ? ": " + String(r.stderr).split("\n")[0] : ""));
  return r.stdout;
};

// The linter where a lint config runs; otherwise, or where it cannot run, the parse check, saying so.
function codeCheck(root, opts) {
  opts = opts || {};
  if (hasLintConfig(root)) {
    try {
      const files = JSON.parse((opts.lint || defaultLint)(root));
      const withProblems = files.filter((f) => f.errorCount || f.warningCount);
      return { mode: "lint", files: withProblems.length, errors: files.reduce((p, f) => p + f.errorCount, 0), warnings: files.reduce((p, f) => p + f.warningCount, 0) };
    } catch (e) {
      return Object.assign(parseCheck(root, opts), { lintNote: "lint not run -- " + String(e.message || e).split("\n")[0] });
    }
  }
  return parseCheck(root, opts);
}

const defaultAudit = (dir) => {
  const r = runList(process.platform === "win32" ? "npm.cmd" : "npm", ["audit", "--json"], dir);
  if (r.error) throw r.error;
  if (!r.stdout || !r.stdout.trim()) throw new Error("no output");
  return r.stdout;
};

// Every package-lock.json outside installed packages, audited where it stands.
function auditAll(root, runner) {
  const dirs = [];
  walk(root, (full, name) => { if (name === "package-lock.json") dirs.push(path.dirname(full)); });
  return dirs.sort().map((d) => {
    const dir = rel(root, d) || ".";
    try {
      const v = (JSON.parse((runner || defaultAudit)(d)).metadata || {}).vulnerabilities;
      if (!v) throw new Error("no vulnerability counts in the audit's answer");
      return { dir, state: "read", info: v.info || 0, low: v.low || 0, moderate: v.moderate || 0, high: v.high || 0, critical: v.critical || 0, total: v.total || 0 };
    } catch (e) {
      return { dir, state: "not read", why: String(e.message || e).split("\n")[0] };
    }
  });
}

function runGate(root, opts) {
  opts = opts || {};
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };
  say("CODE GATE (WP-D6-06, OKF-TOGAF#160) -- " + (opts.refuseSecrets ? "a found secret refuses" : "report only, nothing refuses"));
  const M = readMarks(root);
  if (M.error) say("MARKS: not read -- " + M.error + "; nothing is marked.");
  const { hits, safe, stale } = applyMarks(root, scanSecrets(root), M.marks);
  if (hits.length) { say("SECRETS: " + hits.length + " found. File, line and kind; the value is never printed:"); say(formatSecrets(hits)); }
  else say("SECRETS: none found.");
  if (safe.length) { say("KNOWN SAFE: " + safe.length + " marked line(s), by " + MARKS_FILE + ":"); say(safe.map((h) => "  " + h.file + ":" + h.line + "  " + h.kind + "  " + h.reason).join("\n")); }
  if (stale.length) { say("STALE MARKS: " + stale.length + ", whose line is gone:"); say(stale.map((e) => "  " + e.path + "  " + e.kind + "  " + e.reason).join("\n")); }
  const C = codeCheck(root, opts);
  if (C.mode === "lint") say("CODE CHECK (lint): " + C.errors + " error(s), " + C.warnings + " warning(s) in " + C.files + " file(s).");
  else {
    say("CODE CHECK (parse" + (C.lintNote ? "; " + C.lintNote : "") + "): " + C.checked + " file(s) parsed, " + C.problems.length + " that do not parse" + (C.problems.length ? ": " + C.problems.map((p) => p.file + (p.line ? ":" + p.line : "")).join(", ") : "") + "; " + C.skipped.length + " skipped.");
    if (C.skipped.length) say("  skipped: " + C.skipped.map((s) => s.file + " (" + s.why + ")").join("; "));
  }
  const A = auditAll(root, opts.audit);
  if (!A.length) say("DEPENDENCY AUDIT: no package-lock.json, nothing to audit.");
  for (const a of A) say("DEPENDENCY AUDIT (" + a.dir + "): " + (a.state === "read" ? a.total + " known vulnerability(ies): critical " + a.critical + ", high " + a.high + ", moderate " + a.moderate + ", low " + a.low + "." : "not read -- " + a.why));
  if (opts.summary) {
    const md = ["### Code gate (WP-D6-06, OKF-TOGAF#160)", "", "| Check | Result |", "|---|---|",
      "| Secrets | " + (hits.length ? hits.length + " found: " + hits.map((h) => "`" + h.file + ":" + h.line + "` " + h.kind).join(", ") : "none found") + " |",
      ...(safe.length ? ["| Known safe | " + safe.length + " marked: " + safe.map((h) => "`" + h.file + ":" + h.line + "` " + h.kind).join(", ") + " |"] : []),
      ...(stale.length ? ["| Stale marks | " + stale.length + ": " + stale.map((e) => "`" + e.path + "` " + e.kind).join(", ") + " |"] : []),
      ...(M.error ? ["| Marks | not read: " + M.error + " |"] : []),
      "| Code check (" + C.mode + ") | " + (C.mode === "lint" ? C.errors + " error(s), " + C.warnings + " warning(s) in " + C.files + " file(s)" : C.checked + " parsed, " + C.problems.length + " do not parse, " + C.skipped.length + " skipped" + (C.lintNote ? "; " + C.lintNote : "")) + " |",
      ...(A.length ? A.map((a) => "| Dependency audit (" + a.dir + ") | " + (a.state === "read" ? a.total + ": critical " + a.critical + ", high " + a.high + ", moderate " + a.moderate + ", low " + a.low : "not read") + " |") : ["| Dependency audit | no lockfile |"]),
      "", "Report only: " + (opts.refuseSecrets ? "a found secret refuses." : "nothing refuses.") + " A secret is named by file, line and kind, never its value.", ""];
    fs.appendFileSync(opts.summary, md.join("\n"));
  }
  return { exit: exitFor(hits, opts), hits, safe, stale, code: C, audit: A, lines };
}

module.exports = { scanSecrets, formatSecrets, exitFor, kindsIn, findPython, parseCheck, codeCheck, auditAll, runGate, SKIP_DIRS, MARKS_FILE, lineHash, readMarks, applyMarks };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const root = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--summary") || ".");
  process.exitCode = runGate(root, { refuseSecrets: args.includes("--refuse-secrets"), summary: at("--summary") }).exit;
}
