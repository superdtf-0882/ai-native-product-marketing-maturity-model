#!/usr/bin/env node
// Release check for a maturity model repository. Run it in the repository
// before tagging a release:   node tools/release-check.js
//
// It checks what a reader of the published model relies on and a person
// forgets at the moment of release:
//   - the matrix calls itself by its version, and not a draft, a strawman or
//     a prototype (the family learned this at a lock that shipped both wrong);
//   - that version, and the one the short form cites, each have a changelog
//     entry, and the short form cites a full commit, not a branch;
//   - every dimension the model writes itself has all five short-form cells,
//     and the short form has no dimension the matrix does not declare; a
//     dimension inherited by reference takes its cells from its source;
//   - the licence and the Work Item surfaces line are present.
//
// It needs nothing installed. Exit 1 on any problem, each one named.
"use strict";
const fs = require("fs");
const path = require("path");

const LEVELS = ["A", "B", "C", "D", "E"];
const DRAFT = /\b(draft|strawman|unratified|prototype|proposed|pending)\b/i;

function readIf(file) { try { return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"); } catch { return null; } }

// The matrix: the one ai_native_*_maturity_model.md at the root.
function findMatrix(root) {
  const names = fs.readdirSync(root).filter((f) => /^ai_native_.*maturity_model\.md$/.test(f));
  return names.length === 1 ? names[0] : null;
}

// Dimensions the matrix declares, each with whether it is inherited by reference.
function dimensions(md) {
  const out = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // A range heading ("## D1–D3.") declares each dimension in it, inherited by reference.
    const r = /^#{2,4} D(\d+)[–-]D(\d+)\. /.exec(lines[i]);
    if (r) { for (let n = +r[1]; n <= +r[2]; n++) out.push({ id: "D" + n, inherited: true }); continue; }
    const m = /^#{2,4} D(\d+)\. /.exec(lines[i]);
    if (!m) continue;
    let inherited = false;
    for (let j = i + 1; j < lines.length && !/^#{2,4} D\d+\. /.test(lines[j]); j++) {
      if (/^\*\*Status:\*\*/.test(lines[j])) { inherited = /inherited/i.test(lines[j]) && /by reference/i.test(lines[j]); break; }
    }
    out.push({ id: "D" + m[1], inherited });
  }
  return out;
}

// The short form, read without a YAML library: the two citation fields and,
// under `dimensions:`, each `  D<n>:` with its `      <Level>: "<cell>"` lines.
function shortForm(text) {
  const field = (k) => { const m = new RegExp("^" + k + ':\\s*"?([^"\\n]*)"?\\s*$', "m").exec(text); return m ? m[1].trim() : null; };
  const dims = {};
  let cur = null, inDims = false;
  for (const line of text.split("\n")) {
    if (/^dimensions:\s*$/.test(line)) { inDims = true; continue; }
    if (inDims && /^\S/.test(line) && !/^#/.test(line)) inDims = false;
    if (!inDims) continue;
    const d = /^  (D\d+):\s*$/.exec(line);
    if (d) { cur = dims[d[1]] = {}; continue; }
    const l = /^ {6}([A-E]):\s*"(.*)"\s*$/.exec(line);
    if (l && cur) cur[l[1]] = l[2];
  }
  return { version: field("source_matrix_version"), commit: field("source_matrix_commit"), dims };
}

function check(root, opts) {
  opts = opts || {};
  const problems = [];
  const matrix = findMatrix(root);
  if (!matrix) return { problems: ["no single ai_native_*_maturity_model.md at the root"], version: null };
  const md = readIf(path.join(root, matrix));
  const head = md.split("\n").slice(0, 6).join("\n");
  const title = (md.match(/^# .*$/m) || [""])[0];
  if (DRAFT.test(title)) problems.push(matrix + ": the title makes a draft's claim about itself: " + title);
  const vm = /^\*\*Version (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\b/m.exec(head);
  if (!vm) problems.push(matrix + ": no version line (\"**Version X.Y.Z — YYYY-MM-DD\") near the top");
  else if (DRAFT.test(head.slice(head.indexOf(vm[0]), head.indexOf(vm[0]) + 160).split(".")[0])) problems.push(matrix + ": the version line makes a draft's claim about itself");
  const version = vm ? vm[1] : null;

  const log = readIf(path.join(root, "CHANGELOG.md"));
  const released = new Set(log ? [...log.matchAll(/^## v(\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]) : []);
  if (!log) problems.push("no CHANGELOG.md");
  else if (version && !released.has(version)) problems.push("CHANGELOG.md has no entry for v" + version + ", the version the matrix states");

  const sfText = readIf(path.join(root, "short_form.yml"));
  if (!sfText) problems.push("no short_form.yml");
  else {
    const sf = shortForm(sfText);
    if (!sf.version) problems.push("short_form.yml: no source_matrix_version");
    else if (log && !released.has(sf.version)) problems.push("short_form.yml cites matrix v" + sf.version + ", which CHANGELOG.md never released");
    if (!/^[0-9a-f]{40}$/.test(sf.commit || "")) problems.push("short_form.yml: source_matrix_commit is not a full commit: " + (sf.commit || "absent"));
    const declared = dimensions(md);
    const ids = new Set(declared.map((d) => d.id));
    for (const d of declared) {
      if (d.inherited) continue;
      const cells = sf.dims[d.id];
      if (!cells) { problems.push("short_form.yml has no cells for " + d.id + ", which the model writes itself"); continue; }
      const missing = LEVELS.filter((l) => !(cells[l] || "").trim());
      if (missing.length) problems.push("short_form.yml: " + d.id + " is missing level(s) " + missing.join(", "));
    }
    for (const id of Object.keys(sf.dims)) if (!ids.has(id)) problems.push("short_form.yml has " + id + ", which the matrix does not declare");
  }

  if (!fs.existsSync(path.join(root, "LICENSE.md"))) problems.push("no LICENSE.md, the family's licence");
  if (!fs.existsSync(path.join(root, ".work-item-surfaces"))) problems.push("no .work-item-surfaces, the Work Item surfaces line");
  return { problems, version, matrix };
}

module.exports = { check, dimensions, shortForm };

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  const r = check(root);
  console.log("RELEASE CHECK -- " + (r.matrix || "no matrix") + (r.version ? " at v" + r.version : ""));
  if (r.problems.length) { r.problems.forEach((p) => console.log("  PROBLEM  " + p)); console.log(r.problems.length + " problem(s). Fix them before tagging."); }
  else console.log("  Nothing found. Ready to tag v" + r.version + ".");
  process.exitCode = r.problems.length ? 1 : 0;
}
