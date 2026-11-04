#!/usr/bin/env node
// Release command for a maturity model repository. It is the one way a release is
// meant to come into being: it runs the release check, and only on a pass makes the
// tag and pushes main and the tag together.
//
//   node tools/release.js v1.5.1
//
// ONE LIST OF REFUSALS, each with its reason, for the command and the hook alike: a tag
// not shaped vX.Y.Z; a shallow clone; a branch other than main; uncommitted or untracked
// files, because the check reads the working folder; a remote it can't read; a clone
// behind the remote. A git read that fails is never taken as a pass. The earlier tag
// comes from one function over the clone's tags and the remote's together, so a text-
// neutral release is always compared with the one before it.
//
// THE COMMAND adds: core.hooksPath not set to tools/hooks, and a tag that already exists
// here or on the remote. It sets no git setting.
//
// THE HOOK. tools/hooks/pre-push hands every push to this file as --hook, so the rules
// live in one place. A push with no tag in it passes. For each tag the hook first refuses
// a published tag deleted or moved, then runs the one list, then adds: a tag off the
// current commit; a tag that isn't annotated, as every model's is; and a commit that
// neither is the remote's main nor reaches it in this push.
//
// EXIT. 0 a pass. 1 a refusal or a fault in the release. 2 the check could not read
// what it needs: it hasn't passed, and it hasn't found a fault. A fault's exit wins
// when both appear. Exit 2 here is not the usage exit it is in other tools.
//
// AFTER A FAILED PUSH it reads the remote before removing the tag it made, since a
// push that timed out may have landed. It keeps a tag that landed, and keeps one it
// can't read back, and says so. It doesn't retry.
//
// HOW IT CAN BE CROSSED (RULE-10). git push --no-verify skips the hook; that's the
// declared way past a false refusal, and nothing forces the release brief to record
// it. A clone without core.hooksPath has no hook, so a tag made and pushed by hand
// there meets no check. A tag made on GitHub's site or through its interface meets
// none of this. And this file, the hook and the check live in the repository they
// guard, so a commit that weakens them passes its own release; comparing them with
// their sources in the practice lifts that for a release cut through tools/cut-release.js.
// A repository rule on GitHub could narrow the first three, and what it would lift isn't
// tested: --no-verify and an unhooked clone can use the same credential this command does.
// Such a rule is the owner's to set.
//
// Needs nothing installed but git and node. OKF-TOGAF#209.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const ZERO = /^0+$/;
const parts = (t) => { const m = TAG.exec(t); return m ? m.slice(1).map(Number) : null; };
const below = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

// The highest version tag below the one being cut, or null for a first release.
function earlierTag(tag, tags) {
  const cut = parts(tag);
  let best = null, bestParts = null;
  for (const t of tags) {
    const p = parts(t);
    if (p && below(p, cut) && (!bestParts || below(bestParts, p))) { best = t; bestParts = p; }
  }
  return best;
}

// What to do after a push that failed: read the remote first.
function afterFailedPush({ read, landed }) {
  if (!read) return { removeTag: false, say: "could not read the remote after the failed push, so the local tag stays. Read the remote before doing anything else." };
  if (landed) return { removeTag: false, say: "the push reported a failure, but the tag is on the remote, so the local tag stays. Read what landed before doing anything else." };
  return { removeTag: true, say: "the tag isn't on the remote, so the local tag is removed. Nothing landed." };
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const headOf = (root) => git(root, ["rev-parse", "HEAD"]).out;
const localTags = (root) => git(root, ["tag", "--list"]).out.split("\n").filter(Boolean);

// The remote's refs: { ok, refs: name -> id, peeled: tag -> commit }.
function remoteRefs(root, remote, read) {
  const r = (read || git)(root, ["ls-remote", remote || "origin"]);
  if (!r.ok) return { ok: false, refs: {}, peeled: {} };
  const refs = {}, peeled = {};
  for (const line of r.out.split("\n").filter(Boolean)) {
    const [id, name] = line.split("\t");
    if (name.endsWith("^{}")) peeled[name.slice("refs/tags/".length, -3)] = id;
    else refs[name] = id;
  }
  return { ok: true, refs, peeled };
}

const remoteTags = (refs) => Object.keys(refs).filter((n) => n.startsWith("refs/tags/")).map((n) => n.slice("refs/tags/".length));

// The one list. { code: 0, refs, peeled, tags } or { code: 1 or 2, why }. A read that
// fails is code 2: it hasn't passed, and it hasn't found a fault.
function commonRefusal({ git: read, root, tag, remote }) {
  const no = (code, why) => ({ code, why });
  if (!parts(tag)) return no(1, tag + " isn't shaped vX.Y.Z, and every release tag is.");
  const sh = read(root, ["rev-parse", "--is-shallow-repository"]);
  if (!sh.ok || (sh.out !== "true" && sh.out !== "false")) return no(2, "could not read whether this is a full clone. That isn't a pass.");
  if (sh.out === "true") return no(1, "this is a shallow clone, so the earlier tag can't be read. Use a full clone.");
  const branch = read(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return no(2, "could not read which branch this clone is on. That isn't a pass.");
  if (branch.out !== "main") return no(1, "a release is cut on main, and this clone isn't on it.");
  const status = read(root, ["status", "--porcelain"]);
  if (!status.ok) return no(2, "could not read whether this clone is clean. That isn't a pass.");
  if (status.out !== "") return no(1, "there are uncommitted or untracked files, and the check reads the working folder, so it wouldn't be reading what the tag holds.");
  const r = remoteRefs(root, remote, read);
  if (!r.ok) return no(2, "could not read the remote, so nothing is known about what's published. That isn't a pass.");
  const main = r.refs["refs/heads/main"];
  if (main && !read(root, ["merge-base", "--is-ancestor", main, "HEAD"]).ok) return no(1, "this clone is behind the remote's main. Fetch and pull first.");
  const local = read(root, ["tag", "--list"]);
  if (!local.ok) return no(2, "could not read this clone's tags. That isn't a pass.");
  const tags = [...new Set(local.out.split("\n").filter(Boolean).concat(remoteTags(r.refs)))];
  return { code: 0, refs: r.refs, peeled: r.peeled, tags };
}

async function runCheck(root, tag, tags, say) {
  const { checkRelease, exitFor } = require("./release-check.js");
  const against = earlierTag(tag, tags);
  say(against ? "Compared with " + against + ", the tag before." : "No earlier tag: this is a first release, so there's nothing to compare it with.");
  const r = await checkRelease(root, { tag, against: against || undefined });
  (r.problems || []).forEach((p) => say("  PROBLEM  " + p));
  (r.unread || []).forEach((p) => say("  UNREAD   " + p));
  (r.pending || []).forEach((p) => say("  PENDING  " + p));
  (r.warnings || []).forEach((p) => say("  WARNING  " + p));
  (r.notes || []).forEach((p) => say("  NOTE     " + p));
  return exitFor(r);
}

async function cut(root, tag) {
  const say = (m) => console.log(m);
  const refuse = (m, code) => { say("RELEASE REFUSED -- " + m); return code === undefined ? 1 : code; };
  const common = commonRefusal({ git, root, tag, remote: "origin" });
  if (common.code) return refuse(common.why, common.code);
  if (git(root, ["config", "--get", "core.hooksPath"]).out !== "tools/hooks") return refuse("core.hooksPath isn't tools/hooks in this clone. Run: git config core.hooksPath tools/hooks");
  if (localTags(root).includes(tag)) return refuse(tag + " already exists in this clone.");
  if (common.refs["refs/tags/" + tag]) return refuse(tag + " already exists on the remote.");
  const code = await runCheck(root, tag, common.tags, say);
  if (code === 1) return refuse("the release check found a fault above. No tag was made.", 1);
  if (code !== 0) return refuse("the release check could not read what it needs, above. That isn't a pass. No tag was made.", code);

  const head = headOf(root);
  const made = git(root, ["tag", "-a", tag, "-m", "Release " + tag]);
  if (!made.ok) return refuse("the tag could not be made: " + made.err);
  const push = spawnSync("git", ["-C", root, "push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/" + tag], { encoding: "utf8" });
  const output = (push.stdout || "") + (push.stderr || "");
  process.stdout.write(output);
  if (push.status !== 0) {
    const after = remoteRefs(root);
    const next = afterFailedPush({ read: after.ok, landed: after.ok && !!after.refs["refs/tags/" + tag] });
    if (next.removeTag) git(root, ["tag", "-d", tag]);
    return refuse("the push failed: " + next.say, after.ok ? 1 : 2);
  }
  const landed = remoteRefs(root);
  if (!landed.ok) return refuse("the push reported success, but the remote couldn't be read back. Read it before doing anything else.", 2);
  if (landed.refs["refs/heads/main"] !== head || landed.peeled[tag] !== head) return refuse("the push reported success, but the remote doesn't show main and " + tag + " at " + head.slice(0, 8) + ". Read it before doing anything else.");
  const hookLine = output.split("\n").find((l) => l.includes("RELEASE HOOK: ran"));
  say("Released: " + tag + " at " + head);
  say("  The check: passed.");
  say("  The hook: " + (hookLine ? "ran." : "did not report."));
  return 0;
}

async function hook(root, input, remote) {
  const say = (m) => console.error(m);
  const lines = input.split("\n").map((l) => l.trim().split(/\s+/)).filter((l) => l.length === 4);
  const tags = lines.filter((l) => l[2].startsWith("refs/tags/"));
  const mainPush = lines.find((l) => l[2] === "refs/heads/main");
  let worst = 0;
  const note = (code) => { if (code === 1 || (code === 2 && worst === 0)) worst = code; };
  const refuse = (tag, m, code) => { say("RELEASE HOOK: refused, " + tag + ": " + m); note(code === undefined ? 1 : code); };
  for (const [, localId, remoteRef, remoteId] of tags) {
    const tag = remoteRef.slice("refs/tags/".length);
    if (ZERO.test(localId)) { refuse(tag, "a published tag is a promise, and it isn't deleted."); continue; }
    if (!ZERO.test(remoteId)) {
      if (remoteId !== localId) refuse(tag, "it's already published, and a published tag doesn't move.");
      continue;
    }
    const common = commonRefusal({ git, root, tag, remote: remote || "origin" });
    if (common.code) { refuse(tag, common.why, common.code); continue; }
    const commit = git(root, ["rev-parse", localId + "^{commit}"]);
    if (!commit.ok || commit.out !== headOf(root)) { refuse(tag, "the tag isn't on the current commit, and the check reads the working folder, so it wouldn't be reading what the tag holds."); continue; }
    if (git(root, ["cat-file", "-t", localId]).out !== "tag") { refuse(tag, "it isn't an annotated tag, and every model's release tag is."); continue; }
    const reaching = common.refs["refs/heads/main"] === commit.out || (mainPush && git(root, ["rev-parse", mainPush[1] + "^{commit}"]).out === commit.out);
    if (!reaching) { refuse(tag, "its commit isn't the remote's main, and this push doesn't take it there, so the release would hold text main doesn't."); continue; }
    const code = await runCheck(root, tag, common.tags, say);
    if (code === 0) say("RELEASE HOOK: ran, " + tag + " at " + commit.out.slice(0, 8) + ", passed.");
    else refuse(tag, code === 1 ? "the release check found a fault above." : "the release check could not read what it needs, above. That isn't a pass.", code);
  }
  if (worst) say("The declared way past a false refusal is git push --no-verify, recorded in the release brief.");
  return worst;
}

module.exports = { earlierTag, afterFailedPush, commonRefusal };

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const finish = (code) => { process.exitCode = code; };
  const fail = (e) => { console.error("RELEASE REFUSED -- it stopped on an error: " + (e && e.message || e)); process.exitCode = 1; };
  if (args[0] === "--hook") hook(root, fs.readFileSync(0, "utf8"), args[1]).then(finish, fail);
  else if (args.length === 1 && !args[0].startsWith("--")) cut(root, args[0]).then(finish, fail);
  else { console.log("Usage: node tools/release.js vX.Y.Z"); process.exitCode = 1; }
}
