# セキュリティ

- Console sessionと認証stateはSecure、HttpOnly、SameSite=Laxの`__Host-` Cookieです。
- Accountsのsession Cookieを`.mochios.org`全体へ共有しません。
- 認可コードはハッシュ保存し、120秒で失効し、一回の交換で消費済みになります。
- 変更系BFF APIは`Origin`を`CONSOLE_BASE_URL`と照合します。
- JSONリクエストは64 KiBへ制限します。
- AccountsとDeveloperCAの呼び出しにはService Bindingを使用します。
- `CONSOLE_SERVICE_TOKEN`、session token、認可コードをログへ出力しません。
- DeveloperCAの`ADMIN_TOKEN`とIntermediate秘密鍵をConsoleへ設定しません。
- Content Security Policyで実行元、接続先、フレーム埋め込みを制限します。
