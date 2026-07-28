(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MochiMpkg = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const HEADER_SIZE = 32;
  const TAR_BLOCK_SIZE = 512;
  const MAX_MPKG_BYTES = 128 * 1024 * 1024;
  const MAX_MANIFEST_BYTES = 1024 * 1024;
  const MAX_TAR_ENTRIES = 10_000;
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  function fail(message) {
    throw new Error(message);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function parsePublicKey(value) {
    const text = String(value).trim();
    let bytes;
    if (/^[0-9a-f]{64}$/.test(text)) {
      bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
    } else {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) fail("application.pubは32-byte Ed25519公開鍵のBase64または64桁lowercase hexである必要があります。");
      const binary = atob(text);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (bytes.length !== 32 || bytesToBase64(bytes) !== text) fail("application.pubのBase64表現が不正です。");
    }
    return { bytes, subjectPublicKey: bytesToBase64(bytes) };
  }

  function bytesEqual(bytes, offset, expected) {
    if (offset + expected.length > bytes.length) return false;
    return expected.every((value, index) => bytes[offset + index] === value);
  }

  function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU64(bytes, offset) {
    let value = 0n;
    for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("MPKGのtar長が大きすぎます。");
    return Number(value);
  }

  function allZero(bytes, start, end) {
    for (let index = start; index < end; index += 1) if (bytes[index] !== 0) return false;
    return true;
  }

  function decodeField(bytes, start, length) {
    let end = start;
    while (end < start + length && bytes[end] !== 0) end += 1;
    try {
      return utf8.decode(bytes.subarray(start, end));
    } catch {
      fail("ustar pathがUTF-8ではありません。");
    }
  }

  function parseOctal(bytes, start, length, label) {
    if ((bytes[start] & 0x80) !== 0) fail(`${label}のbase-256表現には対応していません。`);
    const raw = decodeField(bytes, start, length).trim();
    if (!raw || !/^[0-7]+$/.test(raw)) fail(`${label}のoctal表現が不正です。`);
    const value = Number.parseInt(raw, 8);
    if (!Number.isSafeInteger(value)) fail(`${label}が大きすぎます。`);
    return value;
  }

  function verifyTarChecksum(block) {
    const expected = parseOctal(block, 148, 8, "ustar checksum");
    let actual = 0;
    for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
      actual += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    if (actual !== expected) fail("ustar checksumが一致しません。");
  }

  function validatePath(path) {
    if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("//") || path.includes("\0")) {
      fail("MPKG内に不正なpathがあります。");
    }
    const segments = path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) fail("MPKG内に不正なpathがあります。");
    const top = segments[0];
    if (top !== "manifest.toml" && top !== "signatures" && top !== "payload") fail("MPKG内に未知のtop-level entryがあります。");
    if (top === "manifest.toml" && segments.length !== 1) fail("manifest.toml pathが不正です。");
    if (top === "signatures" && segments.length > 1 && !["manifest.sig", "developer.cert"].includes(segments[1])) {
      fail("MPKG内に未知のsignature entryがあります。");
    }
  }

  function parseHeader(bytes) {
    if (bytesEqual(bytes, 0, [0x1f, 0x8b])) fail("legacy .pkg（gzip tar）は使用できません。unsigned .mpkgを選択してください。");
    if (bytes.length < HEADER_SIZE) fail("MPKG headerがありません。");
    if (!bytesEqual(bytes, 0, [0x4d, 0x50, 0x4b, 0x47])) {
      fail("MPKG magicが一致しません。");
    }
    if (readU16(bytes, 4) !== 1 || readU16(bytes, 6) !== 0 || readU16(bytes, 8) !== HEADER_SIZE) fail("対応していないMPKG versionです。");
    if (bytes[10] !== 0) fail("圧縮MPKGには対応していません。");
    if (bytes[11] !== 0 || !allZero(bytes, 20, 32)) fail("MPKG headerのflagsまたはreserved領域が不正です。");
    const tarLength = readU64(bytes, 12);
    if (tarLength < TAR_BLOCK_SIZE * 2 || tarLength % TAR_BLOCK_SIZE !== 0 || HEADER_SIZE + tarLength !== bytes.length) {
      fail("MPKG headerのtar長が実データと一致しません。");
    }
    return { tarOffset: HEADER_SIZE, tarLength };
  }

  function extractManifestBytes(bytes, tarOffset, tarLength) {
    const paths = new Set();
    let manifest = null;
    let offset = tarOffset;
    let entries = 0;
    const tarEnd = tarOffset + tarLength;
    while (offset + TAR_BLOCK_SIZE <= tarEnd) {
      const block = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
      if (allZero(block, 0, TAR_BLOCK_SIZE)) {
        if (offset + TAR_BLOCK_SIZE * 2 > tarEnd || !allZero(bytes, offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2)) {
          fail("ustar終端blockが不足しています。");
        }
        if (!allZero(bytes, offset, tarEnd)) fail("ustar終端後にデータがあります。");
        if (!manifest) fail("manifest.tomlがありません。");
        return manifest;
      }
      entries += 1;
      if (entries > MAX_TAR_ENTRIES) fail("MPKG内のentry数が上限を超えています。");
      verifyTarChecksum(block);
      if (!bytesEqual(block, 257, [0x75, 0x73, 0x74, 0x61, 0x72, 0x00]) || !bytesEqual(block, 263, [0x30, 0x30])) {
        fail("ustar headerではありません。");
      }
      const name = decodeField(block, 0, 100);
      const prefix = decodeField(block, 345, 155);
      const path = prefix ? `${prefix}/${name}` : name;
      validatePath(path);
      if (paths.has(path)) fail("MPKG内に重複したpathがあります。");
      paths.add(path);
      const type = block[156];
      if (![0, 0x30, 0x35].includes(type)) fail("MPKG内に未対応のustar entryがあります。");
      const size = parseOctal(block, 124, 12, "ustar size");
      if (type === 0x35 && size !== 0) fail("ustar directoryのsizeが0ではありません。");
      const dataOffset = offset + TAR_BLOCK_SIZE;
      const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
      if (dataOffset + paddedSize > tarEnd) fail("ustar entryが途中で切れています。");
      if (path === "manifest.toml") {
        if (type !== 0 && type !== 0x30) fail("manifest.tomlが通常ファイルではありません。");
        if (size === 0 || size > MAX_MANIFEST_BYTES) fail("manifest.tomlのsizeが不正です。");
        manifest = bytes.slice(dataOffset, dataOffset + size);
      }
      if (path === "signatures/manifest.sig" || path === "signatures/developer.cert") {
        fail("署名済みMPKGではなく、unsigned .mpkgを選択してください。");
      }
      offset = dataOffset + paddedSize;
    }
    fail("ustar終端がありません。");
  }

  function stripComment(line) {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (quote && char === quote) {
        quote = null;
      } else if (!quote && (char === '"' || char === "'")) {
        quote = char;
      } else if (!quote && char === "#") {
        return line.slice(0, index);
      }
    }
    return line;
  }

  function splitAssignment(line) {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (quote && char === quote) quote = null;
      else if (!quote && (char === '"' || char === "'")) quote = char;
      else if (!quote && char === "=") return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }
    return null;
  }

  function arrayComplete(value) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (const char of value) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (quote && char === quote) quote = null;
      else if (!quote && (char === '"' || char === "'")) quote = char;
      else if (!quote && char === "[") depth += 1;
      else if (!quote && char === "]") depth -= 1;
      if (depth < 0) return true;
    }
    return depth === 0 && !quote;
  }

  function parseTomlString(value, label) {
    const trimmed = value.trim();
    if (trimmed.length < 2) fail(`${label}が文字列ではありません。`);
    if (trimmed[0] === "'") {
      if (trimmed.at(-1) !== "'" || trimmed.slice(1, -1).includes("'")) fail(`${label}の文字列が不正です。`);
      return trimmed.slice(1, -1);
    }
    if (trimmed[0] !== '"' || trimmed.at(-1) !== '"') fail(`${label}が文字列ではありません。`);
    try {
      return JSON.parse(trimmed);
    } catch {
      fail(`${label}の文字列escapeが不正です。`);
    }
  }

  function parseStringArray(value, label) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) fail(`${label}が配列ではありません。`);
    const values = [];
    let token = "";
    let quote = null;
    let escaped = false;
    for (const char of trimmed.slice(1, -1)) {
      if (quote === '"' && escaped) {
        token += char;
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        token += char;
        escaped = true;
      } else if (quote && char === quote) {
        token += char;
        quote = null;
      } else if (!quote && (char === '"' || char === "'")) {
        token += char;
        quote = char;
      } else if (!quote && char === ",") {
        if (token.trim()) values.push(parseTomlString(token, label));
        token = "";
      } else {
        token += char;
      }
    }
    if (quote) fail(`${label}の文字列が閉じられていません。`);
    if (token.trim()) values.push(parseTomlString(token, label));
    return values;
  }

  function parseManifest(manifestBytes) {
    let text;
    try {
      text = utf8.decode(manifestBytes);
    } catch {
      fail("manifest.tomlがUTF-8ではありません。");
    }
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    let section = "";
    let format = null;
    let packageId = null;
    let packageName = null;
    let packageVersion = null;
    let fileCount = 0;
    const capabilities = new Set();
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripComment(lines[index]).trim();
      if (!line) continue;
      if (line.startsWith("[[") && line.endsWith("]]")) {
        const table = line.slice(2, -2).trim();
        section = table === "binary" ? "binary" : "other";
        if (table === "file") fileCount += 1;
        continue;
      }
      if (line.startsWith("[") && line.endsWith("]")) {
        section = line.slice(1, -1).trim() === "package" ? "package" : "other";
        continue;
      }
      const assignment = splitAssignment(line);
      if (!assignment) continue;
      const [key, firstValue] = assignment;
      if (!section && key === "format") {
        if (format !== null || firstValue !== "1") fail("manifest formatは1である必要があります。");
        format = 1;
      }
      if (section === "package" && key === "id") {
        if (packageId !== null) fail("package.idが重複しています。");
        packageId = parseTomlString(firstValue, "package.id");
      }
      if (section === "package" && key === "name") {
        if (packageName !== null) fail("package.nameが重複しています。");
        packageName = parseTomlString(firstValue, "package.name");
      }
      if (section === "package" && key === "version") {
        if (packageVersion !== null) fail("package.versionが重複しています。");
        packageVersion = parseTomlString(firstValue, "package.version");
      }
      if (section === "binary" && key === "requires") {
        let value = firstValue;
        while (!arrayComplete(value)) {
          index += 1;
          if (index >= lines.length) fail("binary.requires配列が閉じられていません。");
          value += `\n${stripComment(lines[index]).trim()}`;
        }
        for (const capability of parseStringArray(value, "binary.requires")) capabilities.add(capability);
      }
    }
    if (format !== 1) fail("manifest formatがないか、不正です。");
    if (!packageName || !packageVersion || packageName.length > 255 || packageVersion.length > 255) fail("package.nameまたはpackage.versionがありません。");
    if (fileCount < 1) fail("manifestに[[file]]がありません。");
    if (!packageId || packageId.length > 255 || !/^[a-z0-9.-]+$/.test(packageId) || packageId.startsWith(".") || packageId.endsWith(".") || packageId.includes("..")) {
      fail("package.idがないか、形式が不正です。");
    }
    const sortedCapabilities = [...capabilities].sort();
    for (const capability of sortedCapabilities) {
      if (!capability || capability.length > 255 || !/^[a-z0-9._-]+$/.test(capability)) fail("binary.requiresに不正なCapabilityがあります。");
    }
    if (sortedCapabilities.length > 512) fail("Capability数が上限を超えています。");
    return { packageId, capabilities: sortedCapabilities, manifestText: text };
  }

  function extractManifest(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length === 0 || bytes.length > MAX_MPKG_BYTES) fail("MPKGのsizeが不正です。");
    const header = parseHeader(bytes);
    return parseManifest(extractManifestBytes(bytes, header.tarOffset, header.tarLength));
  }

  return { extractManifest, parseManifest, parsePublicKey, limits: { MAX_MPKG_BYTES, MAX_MANIFEST_BYTES, MAX_TAR_ENTRIES } };
});
