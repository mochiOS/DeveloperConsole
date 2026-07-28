# mochiOS Developer Console

`console.mochios.org`でDeveloper、Member、Developer Certificate、App Store審査を管理するRust／`workers-rs`製BFFと日本語フロントエンドです。Cloudflare Workers Static AssetsとD1のHttpOnly sessionを使用します。

## Developer Certificate

devkitが生成するのは次の2ファイルです。

```text
application.key  # Base64 Ed25519 32-byte seed。端末外へ送らない
application.pub  # Base64 Ed25519 32-byte公開鍵
```

Consoleでは`application.pub`とunsigned `.mpkg`を選びます。ブラウザがMPKG v1の32-byte headerと無圧縮ustarを検証し、`manifest.toml`からPackage IDと全`[[binary]].requires`の和集合を抽出します。Package ID、Capability、Subject Key IDは読み取り専用です。

Workerへ送るのは公開鍵と抽出済みmetadataだけです。`.key`とMPKG bytesは送信しません。Developer CAがOnline Intermediateで発行したraw MCERを`developer.cert`としてダウンロードします。Certificateの人手審査はなく、管理者は失効だけを行います。

## ローカル検証

```powershell
node --check public/assets/mpkg-manifest.js
node --check public/assets/app.js
node tests/mpkg-manifest.test.cjs
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
npx wrangler d1 migrations apply mochios-console --local
npx wrangler deploy --dry-run
```

`.dev.vars`:

```text
CONSOLE_SERVICE_TOKEN=<Accounts内部API token>
DEVELOPER_CA_TOKEN_SIGNING_KEY=<Base64 Ed25519 32-byte seed>
APPSTORE_ADMIN_TOKEN=<AppStore API ADMIN_TOKENと同じ値>
```

構成は[docs/architecture.md](docs/architecture.md)、セキュリティ境界は[docs/security.md](docs/security.md)、一般開発者の公開手順は[docs/developer-publish-flow.md](docs/developer-publish-flow.md)を参照してください。
