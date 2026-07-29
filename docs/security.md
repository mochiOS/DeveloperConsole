# セキュリティ

- Web sessionとOAuth stateはSecure／HttpOnly／SameSite=Laxの`__Host-` Cookie
- Accounts Cookieを親domainへ共有しない
- 変更APIの`Origin`を`CONSOLE_BASE_URL`へ完全一致
- Accounts、DeveloperCA、AppStoreはService Bindingで接続
- 管理delegation tokenは60秒、固定issuer／audience／role／actor、操作ごとに一意jti
- 一般Certificate発行endpointをBFFから公開しない
- 公開鍵、秘密鍵、MPKGを選択・解析・送信する発行UIを持たない
- DeveloperCA管理操作は追加作成申請、Developer／Certificateの停止・再開、Certificate失効だけ
- App Store管理操作はRelease審査とパッケージの停止・再開だけ
- AppStoreの`ADMIN_TOKEN`をブラウザへ返さない

Kome CLI credentialはAccountsが管理します。Consoleはaccess token、refresh token、device codeを受け取りません。
