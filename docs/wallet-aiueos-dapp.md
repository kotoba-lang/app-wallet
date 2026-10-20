# Kotoba Wallet — itonami（dapp）上の分散型設計

状態: 第 1 スライス実装（2026-10-20）。正本はこの文書。
追跡: Linear JUN-128 + JUN-126（親 JUN-116）。

## 位置づけ

Kotoba Wallet は non-custodial マルチチェーン・ウォレット（12 チェーン送受 +
準備中 10、Kotoba L1/inga の ref 書き込み）。itonami（dapp）の app bundle で、
接続面（L4）の wallet 側を担う。鍵導出・署名は kotoba-lang/wallet とバイト一致
（既存の npm test 55 件が検査）。

## このスライス: 「どのチェーンに何ができるか」の判定コア

正本は `src/core/chains.json`（チェーン表）と `src/ui/app.js` の送金述語
（canSend = family が evm、または utxo で receive-only でない）。

| 層 | 実体 | 状態 |
|---|---|---|
| 判定コア guest | `aiueos/wallet_judgment.cljk` — chain-status（送受可 / 受取専用 / 準備中 / unknown）/ can-send（app.js 述語そのもの）/ can-derive（準備中は拒否）/ transfer-judgment（拒否理由を排他ビットで: unknown / preparing / send-refused / bad-amount） | **実装済み・実測** |
| 記述子 | `aiueos/wallet.edn` | **実装済み** |
| parity | `test/judgment-parity.test.js`（node:test、既存 suite と同形式）— **chains.json の全 20 チェーン**で app.js 述語と guest が一致、derive の 12/10 分岐も一致 | **実装済み・実測** |

実測: `amu test aiueos/wallet_judgment.cljk` → **27/27**（jvm-kir / js / wasm）。
`node --test test/judgment-parity.test.js` → **pass 3 / fail 0**。

## 実測で分かった chains.json の正確な分類（guest はこれに追従）

- family は 8 種: **evm(7) / utxo(4) / tron(1) = supported 12**、
  **cardano / cosmos / monero / substrate / xrp / ed25519(5) = 準備中 10**
  （SOL / TON / SUI / NEAR / APT は ed25519 family）。
- 受取専用は 2 形: `receive-only?` フラグ（BCH）と **family で送金述語に載らない**
  （tron など）。guest の send-refused はこの 2 形を同じビットに落とす。
- transfer-judgment のビットは**排他**（拒否理由は unknown / preparing /
  receive-only のどれか 1 つ）+ 金額ビット。

## 未実装境界

- 鍵導出・署名・ネットワーク（kotoba-lang/wallet との parity は既存 npm test
  の領域）。inga ref 書き込み（`inga.ref-record/v2`）の判定も含め次スライス。
- L4 の wallet 接続面そのもの（SIWE 判定は app-credits 側で実装済み —
  JUN-126。browser UI は両 app 共通の残課題）。
- mon（DNA）化は kaikei.ledger / aozora.boundary のレシピ適用が次のスライス。
