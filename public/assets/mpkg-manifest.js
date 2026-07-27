(function (root) {
  "use strict";

  const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
  const MAX_ENTRIES = 10_000;
  const MAX_MANIFEST_BYTES = 1024 * 1024;
  const MANIFEST_PATHS = new Set(["manifest.toml", "META/manifest.toml"]);

  function fail(message) {
    throw new Error(message);
  }

  function stripTomlComments(source) {
    return source.split(/\r?\n/).map((line) => {
      let quoted = false;
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "#") return line.slice(0, index);
      }
      return line;
    }).join("\n");
  }

  function tomlString(value, label) {
    try {
      return JSON.parse(value);
    } catch (_) {
      fail(`${label} が有効な文字列ではありません。`);
    }
  }

  function stringArray(body, label) {
    const values = [];
    const stringPattern = /"(?:[^"\\]|\\.)*"/g;
    let remainder = body;
    for (const match of body.matchAll(stringPattern)) {
      values.push(tomlString(match[0], label));
      remainder = remainder.replace(match[0], "");
    }
    if (remainder.replace(/[\s,]/g, "") !== "") fail(`${label} は文字列配列で指定してください。`);
    return values;
  }

  function sectionBody(source, header) {
    const start = header.index + header[0].length;
    const remaining = source.slice(start);
    const nextHeader = remaining.search(/^\s*\[/m);
    return nextHeader < 0 ? remaining : remaining.slice(0, nextHeader);
  }

  function parseManifestToml(source) {
    if (typeof source !== "string" || source.length > MAX_MANIFEST_BYTES) fail("manifest.toml が大きすぎます。");
    const clean = stripTomlComments(source);
    const format = clean.match(/^\s*format\s*=\s*(\d+)\s*$/m);
    if (!format || Number(format[1]) !== 1) fail("対応していないmanifest形式です。");
    const packageHeader = /^\s*\[package\]\s*$/m.exec(clean);
    if (!packageHeader) fail("manifestに[package]がありません。");
    const packageIdMatch = sectionBody(clean, packageHeader).match(/^\s*id\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m);
    if (!packageIdMatch) fail("manifestにpackage.idがありません。");
    const packageId = tomlString(packageIdMatch[1], "package.id");
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(packageId) || packageId.length > 255) {
      fail("package.idの形式が無効です。");
    }
    const capabilities = [];
    const binaryPattern = /^\s*\[\[binary\]\]\s*$/gm;
    let binaryCount = 0;
    for (const binary of clean.matchAll(binaryPattern)) {
      binaryCount += 1;
      const requires = sectionBody(clean, binary).match(/\brequires\s*=\s*\[([\s\S]*?)\]/m);
      if (!requires) continue;
      for (const capability of stringArray(requires[1], "binary.requires")) {
        if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(capability) || capability.length > 128) {
          fail(`Capabilityの形式が無効です: ${capability}`);
        }
        if (!capabilities.includes(capability)) capabilities.push(capability);
      }
    }
    if (binaryCount === 0) fail("manifestに[[binary]]がありません。");
    return { format: 1, packageId, capabilities, binaryCount };
  }

  function tarString(bytes) {
    const end = bytes.indexOf(0);
    return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
  }

  function tarNumber(bytes) {
    const value = tarString(bytes).trim().replace(/\0/g, "");
    if (!/^[0-7]+$/.test(value)) fail("tarヘッダーのサイズが無効です。");
    return Number.parseInt(value, 8);
  }

  function safeTarPath(name) {
    const normalized = name.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      fail(".mpkgに安全でないパスが含まれています。");
    }
    return normalized;
  }

  function findManifest(expanded) {
    const paths = new Set();
    let manifest = null;
    let offset = 0;
    let entries = 0;
    while (offset + 512 <= expanded.length) {
      const header = expanded.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      entries += 1;
      if (entries > MAX_ENTRIES) fail(".mpkgのentry数が多すぎます。");
      const name = tarString(header.subarray(0, 100));
      const prefix = tarString(header.subarray(345, 500));
      const path = safeTarPath(prefix ? `${prefix}/${name}` : name);
      if (paths.has(path)) fail(`.mpkgに重複パスがあります: ${path}`);
      paths.add(path);
      const size = tarNumber(header.subarray(124, 136));
      const type = header[156];
      const dataStart = offset + 512;
      const dataEnd = dataStart + size;
      if (!Number.isSafeInteger(size) || dataEnd > expanded.length) fail(".mpkgが途中で切れています。");
      if (MANIFEST_PATHS.has(path)) {
        if (type !== 0 && type !== 48) fail("manifest.tomlが通常ファイルではありません。");
        if (manifest) fail(".mpkgにmanifest.tomlが複数あります。");
        if (size > MAX_MANIFEST_BYTES) fail("manifest.tomlが大きすぎます。");
        manifest = new TextDecoder("utf-8", { fatal: true }).decode(expanded.subarray(dataStart, dataEnd));
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
    }
    if (!manifest) fail(".mpkgにmanifest.tomlがありません。");
    return manifest;
  }

  async function inspectMpkg(file) {
    if (!(file instanceof Blob) || file.size === 0) fail(".mpkgを選択してください。");
    if (file.size > MAX_PACKAGE_BYTES) fail(".mpkgは128 MiB以下にしてください。");
    if (typeof DecompressionStream !== "function") fail("このブラウザーはgzip展開に対応していません。");
    const reader = file.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXPANDED_BYTES) {
        await reader.cancel();
        fail(".mpkgの展開後サイズが512 MiBを超えています。");
      }
      chunks.push(value);
    }
    const expanded = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      expanded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseManifestToml(findManifest(expanded));
  }

  root.MochiMpkgManifest = { inspectMpkg, parseManifestToml };
})(globalThis);
