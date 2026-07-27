# セキュリティ

- Console sessionと認証stateはSecure、HttpOnly、SameSite=Laxの`__Host-` Cookieです。
- Accountsのsession Cookieを`.mochios.org`全体へ共有しません。
- 認可コードはハッシュ保存し、120秒で失効し、一回の交換で消費済みになります。
- 変更系BFF APIは`Origin`を`CONSOLE_BASE_URL`と照合します。
- JSONリクエストは64 KiBへ制限します。
- AccountsとDeveloperCAの呼び出しにはService Bindingを使用します。
- `CONSOLE_SERVICE_TOKEN`、署名鍵、session token、認可コードをログへ出力しません。
- DeveloperCAのIntermediate秘密鍵をConsoleへ設定しません。ConsoleはDeveloperCA専用Ed25519鍵で最大60秒のtokenだけを署名します。
- DeveloperCA管理APIはConsole session、active Account、D1 reviewer allowlist、同一Originをすべて確認します。
- `.mpkg`のmanifest抽出はブラウザー内だけで行い、パッケージ本体をConsole APIへ送信しません。
- MPKG選択を必須とし、manifestのscope・Capability欄は読み取り専用にします。DeveloperCAは形式、Developer状態、member role、Issuer trustを再検証します。
- Certificate管理BFFはissue/rejectや任意pathを公開せず、固定reason code付きrevokeだけを転送します。
- AppStoreの`ADMIN_TOKEN`はConsole Worker Secretとしてのみ保持し、ブラウザーへ返しません。
- App Store審査APIはConsole session、active Account、D1 reviewer allowlist、同一Originをすべて確認します。
- ブラウザーから任意のvalidation reportは受理せず、Rust reviewerの検証結果だけを審査対象にします。
- Content Security Policyで実行元、接続先、フレーム埋め込みを制限します。
