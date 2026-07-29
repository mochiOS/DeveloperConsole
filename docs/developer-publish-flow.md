# 一般開発者のApp公開フロー

1. mochiOS IDでConsoleへログインし、Developerを作成する
2. Developerは作成時に自動でverifiedになる（問題発生時は管理者が停止できる）
3. 初回だけ`kome login`でブラウザ承認し、`kome keygen`で`.key`と`.pub`を生成する
4. `kome sign`でmanifestを読み、Developer Certificateを取得してMPKGへ署名する
5. 署名済みMPKGを固定tagのGitHub Release assetへ公開する
6. ConsoleのDeveloper詳細でPackage ID、表示情報、repository、tag、asset名、Certificate IDを登録する
7. MPKG Reviewerの検証後、Console審査を通過したReleaseだけがStoreへ公開される

```powershell
kome login
kome keygen
kome sign
```

`.cert`は鍵生成時には作られません。DeveloperCAへ送るのはDeveloper ID、公開鍵、Package ID、全`binary.requires`の和集合だけです。`.key`、MPKG、payload、ローカルpathは送信しません。

ReviewerはGitHubから一時取得し、MCER署名、Issuer trust、serial、Subject Key ID、UUID Developer ID、Package scope、Capability、manifest署名、payload、SHA-256、path制約を検証します。

GitHub OAuth token、Developer秘密鍵、MPKG本体はConsoleやAppStoreへ保存しません。Accountsが登録Accountの保存済みgrantで公開repository、権限、Release ID、Asset IDを確認し、クライアントはGitHub Releasesから直接取得します。
