(ns oracle
  "Parity oracle: runs the REAL kotoba-lang/wallet library (JVM) and prints
  the addresses and signed transactions the app's JS core must reproduce
  byte-for-byte. Output is committed as test/fixtures/oracle.json via
  scripts/oracle.sh."
  (:require [btc-crypto.bip32 :as bip32]
            [btc-crypto.bip39 :as bip39]
            [clojure.data.json :as json]
            [btc-crypto.core :as btc]
            [btc-crypto.tx :as btc-tx]
            [wallet.chain :as w]
            [wallet.chains :as chains]))

(def mnemonic "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")

(def to "0x3535353535353535353535353535353535353535")

(def eip1559-tx {:nonce 7 :max-priority-fee-per-gas 1000000000
                 :max-fee-per-gas 30000000000 :gas 21000
                 :to to :value 1000000000000000 :data "0x"})

(def legacy-tx {:nonce 9 :gas-price 20000000000 :gas 21000
                :to to :value 1000000000000000000 :data "0x"})

;; ── UTXO: one fixed 2-in/2-out tx; every input signed by wallet.chain/sign-tx
;;    (btc-crypto's legacy / BIP-143 SIGHASH_ALL + RFC-6979). The app must
;;    reproduce each input's signature and witness/scriptSig byte-for-byte.
(defn- hex [^bytes b] (apply str (map #(format "%02x" (bit-and % 0xff)) b)))
(defn- unhex ^bytes [s] (byte-array (map #(unchecked-byte (Integer/parseInt (apply str %) 16)) (partition 2 s))))

(def utxo-tx-template
  {:version 2 :locktime 0
   :inputs [{:txid "4e3b2f6e8a1d0c9b7a5f3e2d1c0b9a8f7e6d5c4b3a291807f6e5d4c3b2a19080" :vout 1 :sequence 0xfffffffd}
            {:txid "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00" :vout 0 :sequence 0xfffffffd}]
   :outputs [{:value 150000 :script-pubkey "0014751e76e8199196d454941c45d1b3a323f1433bd6"}
             {:value 48000 :script-pubkey "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac"}]
   :amounts [120000 90000]})

(defn- utxo-vectors [master]
  (for [[chain script-types] [[:btc [:p2wpkh :p2pkh]] [:ltc [:p2wpkh :p2wpkh]] [:doge [:p2pkh :p2pkh]]]]
    (let [acct (w/account master chain)
          t utxo-tx-template
          tx {:version (:version t) :locktime (:locktime t)
              :inputs (mapv #(update % :txid unhex) (:inputs t))
              :outputs (mapv #(update % :script-pubkey unhex) (:outputs t))}]
      {:chain chain
       :tx t
       :inputs (vec (for [i (range 2)]
                      (let [st (nth script-types i)
                            r (w/sign-tx acct {:tx tx :input-index i :amount (nth (:amounts t) i) :script-type st})]
                        (cond-> {:script-type st}
                          (:witness r) (assoc :witness (mapv hex (:witness r)))
                          (:der-sig-with-type r) (assoc :der-sig-with-type (hex (:der-sig-with-type r))
                                                        :pubkey (hex (:pubkey r)))))))})))

(defn -main [& _]
  (let [master (bip32/seed->master (bip39/mnemonic->seed mnemonic ""))
        accts (into (sorted-map)
                    (for [c (chains/implemented)]
                      [c (dissoc (w/account master c) :private-key)]))
        signed (for [c [:eth :bnb :polygon :base :arbitrum]
                     [kind tx] [[:eip1559 eip1559-tx] [:legacy legacy-tx]]]
                 (let [entry (chains/entry c)
                       tx (assoc tx :chain-id (:chain-id entry))]
                   {:chain c :kind kind
                    :tx (update-vals tx str)
                    :raw (w/sign-tx (w/account master c) tx)}))]
    (println (json/write-str {:source "kotoba-lang/wallet (JVM, wallet.chain/account + sign-tx)"
                              :mnemonic mnemonic
                              :chains (into (sorted-map)
                                            (for [[k e] chains/chains] [k e]))
                              :accounts accts
                              :signed signed
                              :utxo-signed (utxo-vectors master)}
                             :key-fn (fn [k] (if (keyword? k) (name k) (str k)))
                             :value-fn (fn [_ v] (if (keyword? v) (name v) v))))))
