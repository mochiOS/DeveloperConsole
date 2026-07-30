# セキュリティ

- Web sessionとOAuth stateはSecure／HttpOnly／SameSite=Laxの`__Host-` Cookie
- Accounts Cookieを親domainへ共有しない
- 変更APIの`Origin`を`CONSOLE_BASE_URL`へ完全一致
- Accounts、DeveloperCA、AppStoreはService Bindingで接続
- 管理delegation tokenは60秒、固定issuer／audience／role／actor、操作ごとに一意jti
- 一般Certificate発行endpointをBFFから公開しない
- 公開鍵、秘密鍵、MPKGを選択・解析・送信する発行UIを持たない
- DeveloperCA管理操作は追加作成申請、Developer／Certificateの停止・再開、Certificate失効だけ
- App Store一般操作は署名済みdelegation tokenからAccountを決定し、owner／admin／developer Memberだけに許可
- App Store管理操作はRelease審査とパッケージの停止・再開だけ
- AppStoreの`ADMIN_TOKEN`をブラウザへ返さない
- Reviewer専用tokenをConsoleへ設定せず、Consoleからvalidation resultを送信できない
- 成功した管理操作だけをD1のappend-only監査ログへ記録
- 監査ログは操作者、操作種別、対象ID、日時、接続元IP、User-Agent、Cloudflare Ray IDを保持
- 接続元IPはCloudflareが付与する`CF-Connecting-IPv6`を優先し、次に`CF-Connecting-IP`を構文検証して使用する
- `X-Forwarded-For`やブラウザから送信されたJSONのIP値を監査情報として信用しない
- 監査ログAPIはApp Store／Developer CA管理権限を検査し、付与されたサービスの操作だけを返す
- IPとUser-Agentは一般Developer画面や公開APIへ返さない

Kome CLI credentialはAccountsが管理します。Consoleはaccess token、refresh token、device codeを受け取りません。
