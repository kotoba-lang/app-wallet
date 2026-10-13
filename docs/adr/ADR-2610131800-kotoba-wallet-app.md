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

### 5. 送金: EVM (v0.1) と UTXO (v0.2)

**EVM**: EIP-1559。nonce は `pending`、`maxFee = 2·baseFee + tip`、gas は `eth_estimateGas` で決める。
chain-id はレジストリから注入し、不一致なら拒否する。宛先は EIP-55 で検証する。

**UTXO (BTC / LTC / DOGE)** — `src/core/utxo.js`。ライブラリと同じ範囲に限定する:
- 使える入力は自分の P2WPKH (BIP-143 SIGHASH_ALL) と P2PKH (legacy SIGHASH_ALL) だけ。
  署名は RFC-6979 で、low-S の DER に 0x01 を付ける。
- 送金先: P2PKH / P2SH / P2WPKH / P2WSH / P2TR (bech32m)。別ネットワークのアドレスは拒否する。
- コイン選択は大きい順。おつりがダスト未満になる場合はおつり出力を作らず、手数料に回す。
  全額送金 (fee を差し引く) にも対応。
- DOGE はダスト制限と最低手数料がどちらも 0.01 DOGE (手数料は /kB あたり、Dogecoin Core 1.14.6+) なので、手数料率に下限を設ける。
- sequence = 0xfffffffd (RBF 有効)、version 2、locktime 0。
- 未承認の入力を使うときは警告する。
- データ源: esplora (`/address/:a/utxo`, `/v1/fees/recommended`, `POST /tx`) と blockcypher (DOGE)。
- レビュー時のコイン選択には公開データしか使わない。署名時は同じ UTXO 集合で選択をやり直し、
  手数料か金額がレビューと違っていたら送信しない。
- **BCH は送金不可のまま**。SIGHASH_FORKID が未実装で、ライブラリも拒否している。

検証は 2 系統で行う: 入力ごとの署名は wallet ライブラリ (oracle) と**バイト一致**し、組み立てた tx 全体
(raw / txid / vsize) は独立実装の `@scure/btc-signer` と一致する。

TRON の送金は非対応のまま (raw-data protobuf が未実装)。

### 6. Kotoba L1 (inga) ドライバ (v0.3)

inga は残高を持つチェーンではない。順序付けるのは head record (「ref R の sequence S は CID C を指す」) で、
2f+1 quorum が compare-and-set になる (`inga.ref/project`: 各 [ref seq] で最初に確定した記録が勝つ)。
ネイティブ資産は無い (ENGI/EN を inga 上で動かすのは engi の README で future work とされている)。
したがってウォレットが inga 上で持つのは **残高ではなく writer の ID** になる。`src/core/inga.js`:

- **ID**: 同じ BIP-39 seed から SLIP-0010 (ed25519、全階層 hardened) で Ed25519 鍵を導出し、did:key
  (multicodec 0xed01 + base58btc。kagi / kotoba-lang/ed25519 と同じ形) で表す。
  パスは `m/7040884'/0'/0'` (0x6b6f74 = "kot")。Kotoba には SLIP-44 の coin type が登録されておらず、
  他のチェーンの番号を借りると衝突するため、独自の purpose 階層にした。**暫定**:
  ID そのものを決める値なので、変えるなら vault の移行とセットで行う。
- **記録**: `inga.head/v1` のフィールドに `writer` と `sig` を加える。`sig` は `inga.writer/signing-text`
  (`inga.ref-record/v2`: chain id と全フィールド) に対する Ed25519 署名を base64 にしたもの。
  inga 自体は署名のエンコードを決めていない (verify-fn を注入する方式) ため、inga-node の witness
  署名と同じ base64 を採った。ref / cid / chain id に改行が入った場合は拒否する。署名対象の text は
  改行区切りなので、改行を許すと別の記録の text に見せかけられるため。
- **通信**: inga-node HTTP (`GET /health`, `GET /committed?ref=`, `POST /submit`)。ノード URL はユーザーが
  設定する (公開ノードは無い)。提出後は head を最大 30 秒ポーリングし、結果を
  committed / lost (同じ seq を他の記録に取られた) / superseded / pending のどれかで表示する。
- **ライブラリ表 (wallet.chains) には入れない**。inga は EVM でも UTXO でもなく、アドレスと残高の
  モデルに当てはまらないため、アプリ側の別の画面として扱う。

検証:
- `inga.writer` 自身を oracle にした (`scripts/inga-oracle.mjs`: kbb 上で real な signing-text と refusal を、
  node:crypto の Ed25519 で実行)。正常な記録は受理され、改ざん (cid / seq)、別の writer、別の chain、
  余分なフィールドは、それぞれ inga と同じ理由で拒否される。
- SLIP-0010 は公式テストベクタ 1 と micro-key-producer (独立実装) で照合した。
- E2E: ローカルに inga-node を 4 プロセス起動 (quorum 3/4、chain `inga-wallet-e2e`) し、iOS
  シミュレータのアプリから bridge http/fetch 経由で ref を書き込んだ → 4 witness すべてで確定 (proof 付き)。
  確定した記録を real `inga.writer` に渡すと受理され、cid を変えたコピーは `bad-signature` になった。

既知の制約 (inga 側):
- inga-node は `inga.writer` のポリシーをまだ適用していない (`/submit` が要求するのは ref と cid だけ)。
  署名はポリシーを適用する読み手が検証できるが、ノード自身は未署名の記録も受け付ける。
- inga-node は CORS ヘッダを返さない。ネイティブアプリ (bridge) からは届くが、ブラウザ版からは届かない。

## 検証 (2026-10-13)

- `npm test`: 42/42 pass (EVM / UTXO の oracle パリティ、btc-signer との一致、アドレスのネットワーク判定、コイン選択、拒否、vault)。
- UTXO の UI 経路 (ブラウザ): UTXO 応答だけをダミーに差し替え、レビュー → 署名まで実行した。送信内容は手元で横取りし、外部には出していない。
  横取りした tx を btc-signer で decode し、BIP-143 署名が独立に検証できることを確認した。
- ブラウザ (localhost): 復元 → 残高 / 価格 → 受取 QR → 送金フォームの検証まで。
- iOS 26.5 Simulator: `scripts/build-app.sh ios` → 復元 → 残高 / 価格 (bridge http/fetch) → BTC の受取アドレスが
  oracle と一致 (`bc1qmxrw6…kmp8m` / `1LqBGS…WeabA`)。
- Android (API 34 image emulator): `scripts/build-app.sh android` (JDK 21) → 復元 → 残高 → Settings に
  「OS keychain」と表示。

**未検証**: 実資金での EVM / UTXO 送金と broadcast、iOS / Android 実機上での UTXO 送金 (署名バイトは oracle で一致を確認済み)。App Store / Play への提出
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
