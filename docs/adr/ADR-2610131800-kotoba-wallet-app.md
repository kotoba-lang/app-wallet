# ADR-2610131800: Kotoba Wallet — kotoba-shell 上の non-custodial マルチチェーン・ウォレットアプリ

- 状態: 採用 (v0.1.0)
- 日付: 2026-10-13
- 関連: kotoba-lang/wallet (ADR-2607012200, ADR-2608241100 signer seam), kotoba-lang/saifu (ADR-2608039900), kotoba-lang/shell

## 文脈

`kotoba-lang/wallet` はチェーン表 (`wallet.chains`) と family driver (`:evm` / `:utxo` / `:tron`) を持つ
ライブラリで、UI もアプリも無かった。`kotoba-lang/shell` は web bundle を WKWebView / android.webkit.WebView
に載せて iOS / Android / macOS アプリを scaffold・build でき、bridge で keychain・clipboard・http を
policy 越しに提供する。この 2 つを繋いで、iOS / Android で動くウォレットを出す。

## 決定

### 1. UI と鍵処理は web bundle 内 (JS)、正しさはライブラリが決める

wallet ライブラリは `.cljk` で、kbb (SCI on Node) では現状ロードできず (`wallet` の nbb.edn に
btc-crypto/eth-crypto が無い)、WebView に載せる JS への compile 経路も無い。そこでアプリ内の導出・署名は
監査済みの `@noble/*` / `@scure/*` で行い、**正しさの基準はライブラリ自身に置く**:

- `scripts/oracle.sh` が wallet と pin された依存を clone し、JVM 上で `wallet.chain/account` と `sign-tx`
  を実行して `test/fixtures/oracle.json` を書く。
- `test/core.test.js` は全実装チェーンのアドレスと、EVM 5 チェーン × (EIP-1559, legacy) の raw tx が
  oracle と **バイト一致**することを検査する (30 tests)。
- チェーン表 (`src/core/chains.json`) も oracle 出力から抽出する。手でコピーしない。staged / external の
  チェーンはライブラリと同じく **導出を拒否し、待っている機構を表示** する。

アプリが自前で実装したのは暗号ではなく符号化だけ (RLP、cashaddr checksum、EIP-55)。いずれも oracle で検査済み。

### 2. 秘密はニーモニック 1 つ、保存は暗号文だけ

- ニーモニックは AES-256-GCM で暗号化し、鍵は PBKDF2-HMAC-SHA256 (210,000 回) でパスコードから導出する
  (wallet.keystore と同じ構成)。KDF パラメータは vault に入れ、後から回数を上げられる。
- 純 JS (@noble/ciphers) を使う。iOS は `kotoba-webbundle:` カスタムスキームで配信されるため
  `crypto.subtle` の存在が保証されない。
- vault は bridge の `keychain/*` 経由で OS キーチェーン (iOS Keychain / Android Keystore 鍵で暗号化した
  SharedPreferences) に置く。
- ロック解除中、メモリに持つのは **公開アカウントだけ** (`wallet.chain/account-with` と同じ分離)。
  ニーモニックは unlock / 表示 / 署名の間だけ復号して捨てる。署名のたびにパスコードを再入力させる。
- 5 分間操作が無い場合と、バックグラウンドに 60 秒以上いた場合は自動でロックする。

### 3. bridge policy は最小権限

`shell-policy.edn`: allow = keychain read/write/delete、`clipboard/write-text`、`http/fetch`。
deny = `clipboard/read-text` (アドレスすり替えマルウェアの足掛かりになる)、`fs/*`。
CSP は `script-src 'self'`、`object-src 'none'`、`connect-src https:`。

### 4. 「複数通貨」= マルチチェーン + 法定通貨表示

- チェーン: wallet.chains の実装済み 12 (ETH, BNB, Polygon, Avalanche, Arbitrum, Optimism, Base, BTC,
  LTC, DOGE, BCH(受取専用), TRX)。準備中 10 は理由付きで一覧表示する。
- 残高: EVM は publicnode JSON-RPC、BTC/LTC は esplora (mempool.space / litecoinspace)、DOGE は
  blockcypher、BCH は haskoin (blockchair はキー無しクライアントに 430 を返した)、TRX は trongrid。
- 法定通貨: CoinGecko simple price。JPY / USD / EUR / GBP / CNY / KRW。
- 外部 API に渡るのはアドレスだけ。鍵もニーモニックも渡らない。

### 5. 送金は EVM のみ (v0.1)

EIP-1559。nonce は `pending`、`maxFee = 2·baseFee + tip`、gas は `eth_estimateGas` で決める。確認画面に
最大手数料と最大合計を出す。chain-id はレジストリから注入し、不一致なら拒否する。宛先は EIP-55
チェックサムで検証する。UTXO と TRON の送金は **理由を表示して非対応にした**
(UTXO 選択と broadcast が未実装、TRON raw-data protobuf が未実装)。

## 検証 (2026-10-13)

- `npm test`: 30/30 pass (oracle パリティ、拒否、EIP-55、単位、vault)。
- ブラウザ (localhost): 復元 → 残高 / 価格 → 受取 QR → 送金フォームの検証まで。
- iOS 26.5 Simulator: `scripts/build-app.sh ios` → 復元 → 残高 / 価格 (bridge http/fetch) → BTC の受取アドレスが
  oracle と一致 (`bc1qmxrw6…kmp8m` / `1LqBGS…WeabA`)。
- Android (API 34 image emulator): `scripts/build-app.sh android` (JDK 21) → 復元 → 残高 → Settings に
  「OS keychain」と表示。

**未検証**: 実資金での EVM 送金と broadcast (署名バイトは oracle で一致を確認済み)。App Store / Play への提出
(署名 identity と store アカウントが必要)。

## 発見した shell 側の制約 (アプリ側で回避済み)

1. `app build` は web bundle を再コピーしない。コピーするのは `app scaffold` だけなので、
   `scripts/build-app.sh` は毎回 scaffold してから build する。
2. iOS シミュレータ build は `CODE_SIGNING_ALLOWED=NO` で、keychain が `-34018` (errSecMissingEntitlement)
   を返す。アプリはこの場合だけアプリ内 localStorage (暗号化済み vault) に退避し、Settings にそう表示する。
   署名済み build ではキーチェーンを使う。
3. Android host は policy が `notify/show` を許可していなくても、起動時に通知権限を要求する
   (iOS host は policy を確認してから要求する)。
4. CSP の `'self'` は WKWebView のカスタムスキームに一致しないため、`kotoba-webbundle:` を明示する必要がある。

## 今後

UTXO 送金 (btc-crypto の BIP-143 経路に合わせる)、kagi signer seam (本番 custody)、saifu 経由の Cosmos、
ed25519 系 (SOL ほか) の SLIP-0010、生体認証での unlock、WalletConnect / SIWE 署名 UI。
