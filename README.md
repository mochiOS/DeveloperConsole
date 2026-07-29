# mochiOS Developer Console

`console.mochios.org`でDeveloper、Member、Certificate一覧、セキュリティ停止、App Store審査を扱うRust／`workers-rs`製BFFと日本語フロントエンドです。

一般Developer Certificate発行はKome CLIが担当します。Consoleは公開鍵、秘密鍵、MPKGを選択・アップロードする発行UIを持ちません。

```text
初回: kome login -> kome keygen -> kome sign
以降: kome sign
```

CLI sessionの一覧・個別失効は[mochiOS ID](https://accounts.mochios.org/#sessions)へ移動して管理します。DeveloperとCertificateの事前審査はなく、管理者は問題発生時にDeveloper、Certificate、パッケージを停止または失効します。

```powershell
node --check public/assets/app.js
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
npx wrangler d1 migrations apply mochios-console --local
npx wrangler deploy --dry-run
```
