const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const zlib = require("node:zlib");

const source = fs.readFileSync(path.join(__dirname, "../public/assets/mpkg-manifest.js"), "utf8");
vm.runInThisContext(source, { filename: "mpkg-manifest.js" });

const example = `format = 1

[package]
id = "org.mochios.binder"
name = "Binder"
version = "0.1.0"

[[binary]]
path = "/applications/Binder.app/entry.elf"
kind = "application"
requires = [
  "fs.read.all",
  "ipc.client",
  "ipc.server",
  "process.spawn",
  "window.create",
  "window.overlay",
]
`;

function tarFile(name, body) {
  const content = Buffer.from(body);
  const blocks = Math.ceil(content.length / 512);
  const archive = Buffer.alloc(512 + blocks * 512 + 1024);
  archive.write(name, 0, 100, "utf8");
  archive.write("0000644\0", 100, 8, "ascii");
  archive.write("0000000\0", 108, 8, "ascii");
  archive.write("0000000\0", 116, 8, "ascii");
  archive.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  archive.write("00000000000\0", 136, 12, "ascii");
  archive.fill(32, 148, 156);
  archive[156] = 48;
  archive.write("ustar\0", 257, 6, "ascii");
  const checksum = archive.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  archive.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  content.copy(archive, 512);
  return archive;
}

test("extracts package scope and unique capabilities from the manifest", () => {
  const result = globalThis.MochiMpkgManifest.parseManifestToml(example);
  assert.equal(result.packageId, "org.mochios.binder");
  assert.equal(result.binaryCount, 1);
  assert.deepEqual(result.capabilities, [
    "fs.read.all", "ipc.client", "ipc.server", "process.spawn", "window.create", "window.overlay",
  ]);
});

test("reads a root manifest from a gzip tar mpkg", async () => {
  const file = new Blob([zlib.gzipSync(tarFile("manifest.toml", example))]);
  const result = await globalThis.MochiMpkgManifest.inspectMpkg(file);
  assert.equal(result.packageId, "org.mochios.binder");
});

test("rejects invalid capabilities", () => {
  assert.throws(
    () => globalThis.MochiMpkgManifest.parseManifestToml(example.replace("fs.read.all", "fs read all")),
    /Capability/,
  );
});
