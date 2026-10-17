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
//
// Given the tag being cut (--tag v1.5.0), it also runs the family standard's tests,
// STD-MODEL-PARTS v1.1 §7.1 items 1-7, through the family parser beside it: see
// checkRelease below.
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

// ---------------------------------------------------------------------------
// STD-MODEL-PARTS v1.1 §7.1, items 1-7 (OKF-TOGAF#205): the tests the family standard
// adds, run with the tag being cut. They read the matrix through the family parser,
// tools/model-parser.js, which sits beside this file in every model repository.
//
//   node tools/release-check.js --tag v1.5.0 [--against v1.4.1] [--home STD-ID=<address>]
//
// A PROBLEM refuses the tag. A PENDING item would refuse it once the model's text-neutral
// migration has landed -- the migration is the release whose changelog entry is labelled
// text-neutral under STD-MODEL-PARTS -- and is reported until then, because each model's
// wording release comes before its layout release (§8). A WARNING never refuses (§3.7).
//
// It reads two things it does not hold. The homes of shared text -- the family file, a
// rendered dimension's source, a threshold-state source -- by their public address at the
// cited tag; and the cited and earlier commits through git. Each read FAILS CLOSED: what
// it cannot read, it cannot prove, and it says so as a problem. --home supplies an address
// for a basis line that names none, for a run; the missing address is still reported.
const MARKERS = /^(### [A-E] — |\*\*Level [A-E]\b|\*\*Transition |### [A-E] → [A-E]|\*\*Verification:\*\*|\*\*Sustainment)/;
const FAMILY_REPO = /github\.com\/superdtf-0882\/(ai-native-[a-z0-9-]+-maturity-model)(?:\/([\w.-]+\.md))?/;
const POINTER = /^Names, descriptions and the general shape: family_maturity_levels\.md in github\.com\/superdtf-0882\/(ai-native-[a-z0-9-]+-maturity-model) at (v\d+\.\d+\.\d+)\.$/;
const TAG3 = /\bv\d+\.\d+\.\d+\b/;
const NUMBER = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)";
const COUNT = new RegExp("\\b[A-Z][\\w-]* has " + NUMBER + "\\b[^.]*,\\s*[A-Z][\\w-]*\\s+(?:has\\s+)?" + NUMBER + "\\b");
const rawUrl = (repo, tag, file) => "https://raw.githubusercontent.com/superdtf-0882/" + repo + "/" + tag + "/" + file;
const matrixFileOf = (repo) => repo.replace(/-/g, "_") + ".md";
const norm = (s) => String(s).replace(/\r\n/g, "\n");

async function defaultFetch(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}
function defaultGit(root) {
  const { execFileSync } = require("child_process");
  return (ref, file) => {
    try { return execFileSync("git", ["-C", root, "show", ref + ":" + file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  };
}
function thisRepository(root) {
  const t = readIf(path.join(root, ".work-item-surfaces"));
  const line = t && t.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  return line ? line.split("\t")[0] : null;
}
// The changelog's entries, top first: { tag, body }.
function entries(log) {
  const out = [];
  const re = /^## (v\d+\.\d+\.\d+)\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(log || ""))) out.push({ tag: m[1], body: m[2] });
  return out;
}
const textNeutral = (e) => /text-neutral/i.test(e.body) && /STD-MODEL-PARTS/.test(e.body);
function shortFormFlags(text) {
  const flags = {};
  let cur = null, inDims = false;
  for (const line of (text || "").split("\n")) {
    if (/^dimensions:\s*$/.test(line)) { inDims = true; continue; }
    if (inDims && /^\S/.test(line) && !/^#/.test(line)) inDims = false;
    if (!inDims) continue;
    const d = /^  (D\d+):\s*$/.exec(line);
    if (d) { cur = d[1]; continue; }
    const f = /^ {4}flag:\s*"(.*)"\s*$/.exec(line);
    if (f && cur) flags[cur] = f[1];
  }
  return flags;
}
const inScope = (scope, id) => {
  const n = +id.slice(1);
  const r = /^D(\d+)[–-]D(\d+)$/.exec(scope);
  return r ? n >= +r[1] && n <= +r[2] : scope === id;
};
function walk(root, rel, out) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || (rel === "" && e.name === "tools")) continue;
    const p = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(root, p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
// A paragraph's continuation line is a hard wrap unless it starts a new marker, list item,
// table row, heading, quote or rule, or is a flag, names or pointer line.
function hardWraps(md) {
  const lines = md.split("\n");
  const out = [];
  let fence = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^```/.test(lines[i - 1])) fence = !fence;
    if (fence) continue;
    const a = lines[i - 1], b = lines[i];
    if (!a.trim() || !b.trim()) continue;
    if (/^(#|\||>|-{3,}|```)/.test(a.trim())) continue;
    // The names section is the names line and the pointer, each a line; what else it holds is M3's problem.
    if (POINTER.test(a.trim()) || /^A — \S+ · B — /.test(a.trim())) continue;
    if (/^(\*\*|\*\s|-\s|\d+\.\s|#|\||>|```|-{3,})/.test(b.trim())) continue;
    if (/^(Model|D\d+(?:[–-]D\d+)?): /.test(b.trim()) || POINTER.test(b.trim()) || /^A — \S+ · B — /.test(b.trim())) continue;
    out.push(i + 1);
  }
  return out;
}

async function checkRelease(root, opts) {
  opts = opts || {};
  const base = check(root, opts);
  const problems = base.problems.slice(), pending = [], warnings = [], notes = [];
  const out = { problems, pending, warnings, notes, version: base.version, matrix: base.matrix, migrated: false, dialect: null };
  let MP;
  try { MP = require("./model-parser.js"); } catch (e) { problems.push("tools/model-parser.js, the family parser, did not load beside this check: " + e.message.split("\n")[0]); return out; }
  if (!base.matrix) return out;
  const fetchText = opts.fetch || defaultFetch;
  const git = opts.git || defaultGit(root);
  const homes = opts.homes || {};
  const self = thisRepository(root);
  const md = readIf(path.join(root, base.matrix));
  const m = MP.parseModel(md);
  out.dialect = m.dialect;
  const log = readIf(path.join(root, "CHANGELOG.md")) || "";
  const logEntries = entries(log);
  const migrated = out.migrated = logEntries.some(textNeutral);
  const later = (msg) => (migrated ? problems : pending).push(msg);
  const readAt = async (repo, tag, file) => (repo === self && opts.tag && tag === opts.tag ? readIf(path.join(root, file)) : fetchText(rawUrl(repo, tag, file)));
  const declared = new Set(m.dimensions.map((d) => d.id));

  // Item 4 (§4C): the version line names the tag; the changelog's top entry names it; the
  // short form cites the version line and a commit where the matrix and its layers are the tag's.
  if (opts.tag) {
    if (!base.version || "v" + base.version !== opts.tag) problems.push("the version line says " + (base.version ? "v" + base.version : "nothing") + ", but the tag being cut is " + opts.tag + "; the version line names the tag (§4C)");
    const top = logEntries[0] ? logEntries[0].tag : null;
    if (top !== opts.tag) problems.push("CHANGELOG.md's top entry is " + (top || "absent") + ", not " + opts.tag + ", the tag being cut (§4C)");
  }
  const sfText = readIf(path.join(root, "short_form.yml"));
  const sf = sfText ? shortForm(sfText) : null;
  if (sf && sf.version && base.version && sf.version !== base.version) problems.push("short_form.yml's source_matrix_version is " + sf.version + ", not the version line's " + base.version + " (§4C)");

  // The layers: files a range heading names as the home of the dimensions it declares, each
  // with a version line of its own (§3.5). A file named there without one -- SDLC's range
  // section also names the superseded D1-D3 text it keeps as history -- is not a layer.
  const layers = [];
  const lines = md.split("\n");
  lines.forEach((l, i) => {
    if (!/^#{2,4} D\d+[–-]D\d+\. /.test(l)) return;
    for (let j = i + 1; j < lines.length && !/^#{1,4} /.test(lines[j]); j++) {
      for (const f of lines[j].match(/[\w.-]+\.md/g) || []) {
        if (f === base.matrix || layers.includes(f) || !fs.existsSync(path.join(root, f))) continue;
        if (MP.parseModel(readIf(path.join(root, f))).id) layers.push(f);
      }
    }
  });
  if (sf && /^[0-9a-f]{40}$/.test(sf.commit || "")) {
    for (const f of [base.matrix].concat(layers)) {
      const at = git(sf.commit, f);
      if (at === null) problems.push("could not read " + f + " at the short form's cited commit " + sf.commit.slice(0, 7) + ", so the citation cannot be proved (§4C; fails closed)");
      else if (norm(at) !== norm(readIf(path.join(root, f)))) problems.push(f + " at the short form's cited commit " + sf.commit.slice(0, 7) + " differs from the tag's; cite a commit where it is byte-identical (§4C)");
    }
  }
  for (const f of layers) {
    const L = MP.parseModel(readIf(path.join(root, f)));
    for (const p of L.problems) problems.push(f + " (a layer, read as a second matrix): " + p);
    if (!L.id) problems.push(f + ": a layer with no version line of its own, \"**STD-… · vX.Y · date**\" (§3.5)");
    else if (!log.includes(L.id + " v" + L.version)) problems.push("CHANGELOG.md has no entry naming " + L.id + " v" + L.version + ", the layer's version (§3.5, §7.1 item 4)");
    if (migrated && L.dialect && L.dialect !== "common") problems.push(f + ": a layer outside the common dialect (" + L.dialect + ") (§3.5, §5.2)");
  }

  // Item 1, model parts.
  const ns = m.namesSection;
  if (!ns) problems.push("no names section, \"## Family maturity names\" (M3)");
  else {
    if (ns.heading !== "Family maturity names") problems.push("the names section is headed \"" + ns.heading + "\", not \"Family maturity names\" (M3)");
    const body = ns.lines.map((l) => l.trim());
    const pointer = body.map((l) => POINTER.exec(l)).find(Boolean);
    if (!m.namesLine) problems.push("the names section has no names line, \"A — Nascent · B — Modeled · …\" (M3)");
    if (!pointer) problems.push("the names section has no pointer line to the family file, \"Names, descriptions and the general shape: family_maturity_levels.md in <address> at <tag>.\" (M3)");
    const extra = body.filter((l) => l !== m.namesLine && !POINTER.test(l));
    if (extra.length) problems.push("the names section holds more than the names line and the pointer: \"" + extra[0].slice(0, 70) + "\"" + (extra.length > 1 ? " and " + (extra.length - 1) + " more line(s)" : "") + " (M3)");
    if (pointer && m.namesLine) {
      const fam = await readAt(pointer[1], pointer[2], "family_maturity_levels.md");
      if (fam === null) problems.push("could not read family_maturity_levels.md in " + pointer[1] + " at " + pointer[2] + ", so the names line cannot be compared (M3; fails closed)");
      else if (MP.parseFamily(fam).namesLine !== m.namesLine) problems.push("the names line differs from the family file's at " + pointer[2] + " (M3, §3.6)");
    }
  }
  if (!m.readingRules) problems.push("no reading-rules section, \"## How to read this model\" (M4)");
  else if (migrated && m.readingRules.heading !== "How to read this model") problems.push("the reading rules are headed \"" + m.readingRules.heading + "\", not \"How to read this model\" (M4, §5.2)");
  const ts = m.thresholdStates;
  if (ts.preAI && ts.preAI.source) {
    const s = ts.preAI.source;
    const src = await fetchText(rawUrl(s.repository, s.tag, matrixFileOf(s.repository)));
    if (src === null) problems.push("could not read the Pre-AI and Exempt source, " + s.repository + " at " + s.tag + ", so the two texts cannot be resolved (§4A; fails closed)");
    else {
      const S = MP.parseModel(src);
      if (!(S.thresholdStates.preAI && S.thresholdStates.preAI.text && S.thresholdStates.exempt && S.thresholdStates.exempt.text)) problems.push("the Pre-AI and Exempt source, " + s.repository + " at " + s.tag + ", has no Pre-AI and Exempt sections of its own (§4A)");
    }
  } else if (!(ts.preAI && ts.exempt)) problems.push("Pre-AI and Exempt: neither the model's own two sections, nor a source line, nor the line saying it scores A to E only (M5, §4A)");
  for (const f of [["README.md", "README.md"], ["tools/release-check.js", "the release check"], ["tools/model-parser.js", "the family parser, tools/model-parser.js"], ["tools/hooks/commit-msg", "the Work Item hook, tools/hooks/commit-msg"]]) {
    if (!fs.existsSync(path.join(root, f[0]))) problems.push("missing: " + f[1] + " (M10)");
  }

  // Items 1-2, dimension parts, through the parser. A table dimension waits for its migration.
  const dimOf = (p) => m.dimensions.find((d) => p.startsWith(d.id + ":"));
  for (const p of m.problems) {
    const d = dimOf(p);
    if (d && d.dialect === "table") pending.push(p);
    else problems.push(p);
  }
  const ranges = new Set();
  for (const d of m.dimensions) {
    if (d.range && !d.basis && !ranges.has(d.range)) { ranges.add(d.range); later(d.range + ": a range heading with no basis line under it (§4B)"); }
    if (d.status === "inherited" && d.rendered && !d.basis) problems.push(d.id + ": inherited and rendered here, with no basis line naming its home (§4B)");
  }

  // Item 3: one home per part. A second file; the flags; each rendered copy against its home.
  for (const f of walk(root, "", [])) {
    if (f === base.matrix || layers.includes(f) || /^(README|CHANGELOG|LICENSE)\.md$/.test(f)) continue;
    const t = norm(readIf(path.join(root, f)));
    const marks = t.split("\n").filter((l) => MARKERS.test(l)).length;
    const ids = [...new Set((t.match(/^#{2,4} D(\d+)\b/gm) || []).map((h) => "D" + /D(\d+)/.exec(h)[1]))].filter((id) => declared.has(id));
    if (marks && ids.length) later(f + ": a second file carries " + marks + " level, transition, verification or sustainment marker(s) for " + ids.join(", ") + ", which the matrix carries (§3.1, §7.1 item 3)");
  }
  const sfFlags = shortFormFlags(sfText);
  if (!m.flags.length) {
    if (Object.keys(sfFlags).length) later("short_form.yml carries flags for " + Object.keys(sfFlags).join(", ") + ", and the matrix has no Flags section to be their home (§3.3)");
  } else {
    for (const [id, text] of Object.entries(sfFlags)) {
      const mf = m.flags.find((f) => inScope(f.scope, id));
      if (!mf) problems.push(id + ": short_form.yml carries a flag the matrix's Flags section does not (§3.3)");
      else if (mf.text !== text) problems.push(id + ": short_form.yml's flag differs from the matrix's, word for word (§3.3)");
    }
    for (const f of m.flags) {
      if (f.scope === "Model") continue;
      for (const d of m.dimensions) if (inScope(f.scope, d.id) && !sfFlags[d.id]) problems.push(d.id + ": the matrix's flag (" + f.scope + ") has no copy in short_form.yml (§3.3)");
    }
  }
  for (const d of m.dimensions) {
    if (!(d.status === "inherited" && d.rendered && d.basis)) continue;
    const b = d.basis.text;
    const std = (/(STD-[A-Z0-9-]+)/.exec(b) || [])[1];
    let addr = FAMILY_REPO.exec(b);
    if (!addr) {
      problems.push(d.id + ": the basis line names no address for its home, so the rendered copy cannot be checked against it (§4B, §10)");
      if (std && homes[std]) addr = FAMILY_REPO.exec(homes[std]);
      if (!addr) continue;
    }
    const tag = (TAG3.exec(b) || [])[0];
    if (!tag) { problems.push(d.id + ": the basis line names no release tag for its home (§4B)"); continue; }
    const file = addr[2] || matrixFileOf(addr[1]);
    const text = await readAt(addr[1], tag, file);
    if (text === null) { problems.push(d.id + ": could not read its home, " + addr[1] + "/" + file + " at " + tag + ", so the copy cannot be checked (§10; fails closed)"); continue; }
    const h = MP.parseModel(text).dimensions.find((x) => x.id === d.id);
    if (!h || !h.levels) { problems.push(d.id + ": its home, " + addr[1] + "/" + file + " at " + tag + ", has no " + d.id + " to compare with (§10)"); continue; }
    const fields = [["definition", (x) => x.definition], ["sustainment", (x) => x.sustainment]];
    for (const L of MP.LEVELS) fields.push(["levels." + L, (x) => x.levels[L]]);
    for (const [a, z] of MP.STEPS) { const k = a + "-" + z; fields.push(["transitions." + k + ".text", (x) => (x.transitions[k] || {}).text], ["transitions." + k + ".verification", (x) => (x.transitions[k] || {}).verification]); }
    if (h.vantage) fields.push(["vantage", (x) => x.vantage]);
    for (const [name, get] of fields) if (get(d) !== get(h)) problems.push(d.id + ": the rendered " + name + " differs from its home's at " + tag + " (§10)");
  }

  // Item 5 (§5): the common form, once migrated; before, the dialect is reported.
  if (migrated) {
    for (const d of m.dimensions) if (d.dialect && d.dialect !== "common" && d.dialect !== "table") problems.push(d.id + ": not in the common dialect (" + d.dialect + ") (§5.2)");
    const w = hardWraps(md);
    if (w.length) problems.push("hard-wrapped paragraph(s) in the matrix, at L" + w.slice(0, 5).join(", L") + (w.length > 5 ? " and " + (w.length - 5) + " more" : "") + "; a paragraph is a line (§5.2)");
  } else notes.push("dialect found: " + (m.dialect || "none") + "; the common-form test turns on with the model's text-neutral migration (§7.1 item 5)");

  // Item 6 (§6): text-neutral, against the earlier tag.
  if (opts.against) {
    const prior = git(opts.against, base.matrix);
    if (prior === null) problems.push("could not read " + base.matrix + " at " + opts.against + ", so the text-neutral comparison cannot run (§6; fails closed)");
    else {
      const B = MP.parseModel(prior);
      const diffs = [];
      if (B.dimensions.some((d) => d.dialect === "table")) problems.push(opts.against + " is a table model; the family parser cannot read it yet, so text-neutral cannot be proved against it (§6)");
      else {
        const ids = (x) => x.dimensions.map((d) => d.id).join(",");
        if (ids(B) !== ids(m)) diffs.push("the dimension set or order");
        const J = (v) => JSON.stringify(v === undefined ? null : v);
        for (const d of m.dimensions) {
          const p = B.dimensions.find((x) => x.id === d.id);
          if (!p) continue;
          for (const k of ["definition", "sustainment", "vantage", "indicativeEvidence", "readingNotes"]) if (J(d[k]) !== J(p[k])) diffs.push(d.id + " " + k);
          for (const L of MP.LEVELS) if (J((d.levels || {})[L]) !== J((p.levels || {})[L])) diffs.push(d.id + " levels." + L);
          for (const [a, z] of MP.STEPS) {
            const k = a + "-" + z, x = (d.transitions || {})[k] || {}, y = (p.transitions || {})[k] || {};
            for (const f of ["title", "text", "verification"]) if (J(x[f]) !== J(y[f])) diffs.push(d.id + " transitions." + k + "." + f);
          }
        }
        if (J(m.namesLine) !== J(B.namesLine)) diffs.push("levelNames");
        if (J((m.readingRules || {}).text) !== J((B.readingRules || {}).text)) diffs.push("readingRules");
        const tsText = (x) => J([x.thresholdStates.preAI, x.thresholdStates.exempt]);
        if (tsText(m) !== tsText(B)) diffs.push("thresholdStates");
        const priorSf = git(opts.against, "short_form.yml");
        const flagSet = (x, sfT) => J(x.flags.length ? x.flags.map((f) => f.scope + ": " + f.text).sort() : Object.entries(shortFormFlags(sfT)).map(([k, v]) => k + ": " + v).sort());
        if (priorSf !== null && flagSet(m, sfText) !== flagSet(B, priorSf)) diffs.push("flags");
        if (priorSf !== null && J(shortForm(sfText || "").dims) !== J(shortForm(priorSf).dims)) diffs.push("short-form cells");
        if (priorSf === null) notes.push("could not read short_form.yml at " + opts.against + "; its cells and flags were not compared");
        const labelled = logEntries[0] && textNeutral(logEntries[0]);
        if (diffs.length && labelled) problems.push("the release is labelled text-neutral, but " + diffs.length + " content field(s) differ from " + opts.against + ": " + diffs.join("; ") + " (§6)");
        else if (diffs.length) notes.push(diffs.length + " content field(s) differ from " + opts.against + ", so this is a content release: " + diffs.join("; "));
        else notes.push("text-neutral against " + opts.against + ": no content field differs (not compared yet: boundaries and provenance)");
      }
    }
  }

  // Item 7 (§3.7): siblings, warned about and never refused.
  const readme = readIf(path.join(root, "README.md"));
  (readme || "").split("\n").forEach((l, i) => {
    const sib = [...l.matchAll(new RegExp(FAMILY_REPO.source, "g"))].map((x) => x[1]).filter((r) => r !== self);
    if (sib.length) warnings.push("README.md L" + (i + 1) + " names a sibling model (" + [...new Set(sib)].join(", ") + "); for the family, a README links to the models page (§3.7)");
    else if (/same family as/i.test(l)) warnings.push("README.md L" + (i + 1) + " says \"same family as\"; for the family, a README links to the models page (§3.7)");
  });
  const firstH2 = lines.findIndex((l) => /^## /.test(l));
  lines.forEach((l, i) => {
    if (i < firstH2 || /^\*\*Basis:\*\*/.test(l)) return;
    const ids = [...new Set(l.match(/\bSTD-[A-Z0-9-]+-MM\b/g) || [])];
    if (ids.length >= 2) warnings.push(base.matrix + " L" + (i + 1) + " lists " + ids.length + " standards (" + ids.join(", ") + "); a model does not list its siblings (§3.7)");
    if (COUNT.test(l)) warnings.push(base.matrix + " L" + (i + 1) + " counts the family's models or dimensions; a model does not count its siblings (§3.7)");
  });
  return out;
}

module.exports = { check, checkRelease, dimensions, shortForm };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const homes = {};
  args.forEach((a, i) => { if (a === "--home" && args[i + 1]) { const [k, v] = args[i + 1].split("="); homes[k] = v; } });
  const root = args.find((a, i) => !a.startsWith("--") && !["--tag", "--against", "--home"].includes(args[i - 1])) || process.cwd();
  const tag = opt("--tag");
  if (!tag) {
    const r = check(root);
    console.log("RELEASE CHECK -- " + (r.matrix || "no matrix") + (r.version ? " at v" + r.version : ""));
    console.log("  (the present tests only; give --tag <the tag being cut> for STD-MODEL-PARTS v1.1's)");
    if (r.problems.length) { r.problems.forEach((p) => console.log("  PROBLEM  " + p)); console.log(r.problems.length + " problem(s). Fix them before tagging."); }
    else console.log("  Nothing found by the present tests.");
    process.exitCode = r.problems.length ? 1 : 0;
  } else {
    checkRelease(root, { tag, against: opt("--against"), homes }).then((r) => {
      console.log("RELEASE CHECK -- " + (r.matrix || "no matrix") + (r.version ? " at v" + r.version : "") + ", for " + tag + "; " + (r.migrated ? "migrated" : "not yet migrated") + " to STD-MODEL-PARTS");
      r.problems.forEach((p) => console.log("  PROBLEM  " + p));
      r.pending.forEach((p) => console.log("  PENDING  " + p));
      r.warnings.forEach((p) => console.log("  WARNING  " + p));
      r.notes.forEach((p) => console.log("  NOTE     " + p));
      console.log(r.problems.length ? r.problems.length + " problem(s). Fix them before tagging " + tag + "." : "No problem. Ready to tag " + tag + (r.pending.length ? "; " + r.pending.length + " item(s) wait for the migration release." : "."));
      process.exitCode = r.problems.length ? 1 : 0;
    });
  }
}
