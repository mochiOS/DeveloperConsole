# 一般開発者のApp公開フロー

1. mochiOS IDでConsoleへログインし、Developerを作成する
2. 管理者がDeveloperをverifiedにする（Certificate自体の審査はない）
3. 初回だけ`kome login`でブラウザ承認し、`kome keygen`で`.key`と`.pub`を生成する
4. `kome sign`でmanifestを読み、Developer Certificateを取得してMPKGへ署名する
5. 署名済みMPKGを固定tagのGitHub Release assetへ公開する
6. AppStoreへrepository、tag、asset名、Certificate IDを登録する

```powershell
kome login
kome keygen
kome sign
```

`.cert`は鍵生成時には作られません。DeveloperCAへ送るのはDeveloper ID、公開鍵、Package ID、全`binary.requires`の和集合だけです。`.key`、MPKG、payload、ローカルpathは送信しません。

ReviewerはGitHubから一時取得し、MCER署名、Issuer trust、serial、Subject Key ID、UUID Developer ID、Package scope、Capability、manifest署名、payload、SHA-256、path制約を検証します。
