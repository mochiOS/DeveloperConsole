# mochiOS Console

`console.mochios.org`で提供する開発者向けポータルです。Rustと`workers-rs`で
実装したBFF、Cloudflare Workers Static Assets、D1セッションで構成します。

ConsoleはDeveloper、Developer Member、追加Developer申請、Developer
Certificate申請を操作します。証明書申請時は`.mpkg`を端末内で展開し、
`manifest.toml`の`package.id`と全`binary.requires`からscopeとCapabilityを
自動入力できます。パッケージ本体はConsoleへ送信しません。

allowlistへ登録された審査担当者は、Developer確認、追加作成申請、証明書発行申請、
検証済みApp Store Releaseをブラウザーから審査できます。DeveloperCAの秘密鍵、
管理token、Accountsのセッショントークンをブラウザーへ渡しません。
証明書審査では、manifest由来scopeとCapabilityに対するDeveloper grantとglobal許可を
個別に確認・追加し、すべて揃うまで発行ボタンを無効にします。

## 構成

```text
ブラウザー
  ├─ AccountsでGitHub OAuth
  └─ Console Worker（HttpOnlyセッション）
        ├─ Accounts Service Binding
        ├─ DeveloperCA Service Binding
        ├─ DeveloperCA管理BFF（審査担当者のみ）
        ├─ AppStore Service Binding（審査担当者のみ）
        ├─ D1（Consoleセッション）
        └─ Static Assets（日本語UI）
```

AccountsからConsoleへのログイン引き渡しには、120秒で失効し一度だけ交換できる
認可コードを使用します。AccountsのCookieへ親ドメインは設定しません。

## ローカル検証

```powershell
cargo test --offline
cargo clippy --offline --all-targets -- -D warnings
npx wrangler d1 migrations apply mochios-console --local
npx wrangler deploy --dry-run
```

`.dev.vars`へ次のSecretを設定します。

```text
CONSOLE_SERVICE_TOKEN=<Accountsとの内部API用ランダム値>
DEVELOPER_CA_TOKEN_SIGNING_KEY=<DeveloperCA短期token用base64 Ed25519 32-byte seed>
APPSTORE_ADMIN_TOKEN=<AppStore APIのADMIN_TOKENと同じ値>
```

署名鍵と管理tokenはConsole Worker内だけで使用します。HTML、JavaScript、APIレスポンス
には含めません。DeveloperCA tokenは60秒で失効し、操作ごとに新しい`jti`を持ちます。
審査担当者はConsole D1の`developer_ca_reviewers`と
`app_store_reviewers`で責務ごとに明示的に許可します。

本番設定と手順は[docs/deployment.md](docs/deployment.md)を参照してください。
