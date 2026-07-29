# アーキテクチャ

```text
ブラウザ -> Console Worker -> Accounts（Web login）
                         +-> DeveloperCA（Developer/Member/Certificate表示、失効）
                         +-> AppStore（Release審査）

Kome CLI -> Accounts Device Login -> DeveloperCA Certificate発行
```

Consoleは一般Certificate発行経路に入りません。Developer公開鍵、秘密鍵、MPKG、CLI credentialを受け取らず、Developer詳細にはKome CLIの手順とmochiOS IDのCLI session管理導線だけを表示します。

DeveloperCA管理delegationは固定path、60秒token、管理者roleに限定します。一般Developer向けの発行tokenはAccountsからKome CLIへ直接渡されます。
