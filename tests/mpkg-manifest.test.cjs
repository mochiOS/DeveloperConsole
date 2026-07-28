"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { extractManifest, parsePublicKey } = require("../public/assets/mpkg-manifest.js");

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  assert.ok(bytes.length <= length);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeString(buffer, offset, length, `${encoded}\0`);
}

function tarEntry(name, content, type = "0") {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, type === "5" ? 0 : data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([header, data, padding]);
}

function mpkg(entries) {
  const tar = Buffer.concat([...entries, Buffer.alloc(1024)]);
  const header = Buffer.alloc(32);
  writeString(header, 0, 4, "MPKG");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(32, 8);
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeBigUInt64LE(BigInt(tar.length), 12);
  return Buffer.concat([header, tar]);
}

const manifest = `format = 1

[package]
id = "org.mochios.example"
name = "Example"
version = "0.1.0"
kind = "application"

[[file]]
id = "main"
path = "$/entry.elf"
digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
size = 1
mode = "0755"

[[binary]]
path = "/applications/Example.app/entry.elf"
kind = "application"
requires = [
  "window.create",
  "fs.read.all",
]

[[binary]]
path = "/applications/Example.app/helper.elf"
requires = ["ipc.client", "window.create"]
`;

{
  const result = extractManifest(mpkg([tarEntry("manifest.toml", manifest)]));
  assert.equal(result.packageId, "org.mochios.example");
  assert.deepEqual(result.capabilities, ["fs.read.all", "ipc.client", "window.create"]);
}

assert.throws(() => extractManifest(Buffer.from([0x1f, 0x8b, 0x08])), /legacy \.pkg/);
assert.throws(() => extractManifest(mpkg([tarEntry("about.toml", "name='legacy'")])), /top-level/);
assert.throws(
  () => extractManifest(mpkg([tarEntry("manifest.toml", manifest), tarEntry("signatures/developer.cert", "signed")])),
  /unsigned \.mpkg/
);
assert.throws(
  () => extractManifest(mpkg([tarEntry("manifest.toml", manifest), tarEntry("payload/../escape", "bad")])),
  /不正なpath/
);

{
  const key = Buffer.alloc(32, 7);
  assert.equal(parsePublicKey(key.toString("base64")).subjectPublicKey, key.toString("base64"));
  assert.equal(parsePublicKey(key.toString("hex")).subjectPublicKey, key.toString("base64"));
  assert.throws(() => parsePublicKey(Buffer.alloc(64, 7).toString("base64")), /32-byte/);
  assert.throws(() => parsePublicKey("not-a-key"), /32-byte/);
}

{
  const app = fs.readFileSync(path.join(__dirname, "../public/assets/app.js"), "utf8");
  assert.match(app, /name="package_id" readonly/);
  assert.match(app, /name="subject_key_id" readonly/);
  assert.match(app, /name="capabilities" readonly/);
  assert.match(app, /certificateIssuePayload\(draft\)/);
  assert.doesNotMatch(app, /certificate_file/);
  const payloadFunction = app.slice(app.indexOf("function certificateIssuePayload"), app.indexOf("function downloadCertificate"));
  assert.doesNotMatch(payloadFunction, /mpkg|manifestText|private/i);
  assert.match(app, /idempotencyKey: `cert-\$\{crypto\.randomUUID\(\)\}`/);
}

console.log("MPKG manifest and public-key tests passed");
