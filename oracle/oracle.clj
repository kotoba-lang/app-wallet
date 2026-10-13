(ns oracle
  "Parity oracle: runs the REAL kotoba-lang/wallet library (JVM) and prints
  the addresses and signed transactions the app's JS core must reproduce
  byte-for-byte. Output is committed as test/fixtures/oracle.json via
  scripts/oracle.sh."
  (:require [btc-crypto.bip32 :as bip32]
            [btc-crypto.bip39 :as bip39]
            [clojure.data.json :as json]
            [wallet.chain :as w]
            [wallet.chains :as chains]))

(def mnemonic "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")

(def to "0x3535353535353535353535353535353535353535")

(def eip1559-tx {:nonce 7 :max-priority-fee-per-gas 1000000000
                 :max-fee-per-gas 30000000000 :gas 21000
                 :to to :value 1000000000000000 :data "0x"})

(def legacy-tx {:nonce 9 :gas-price 20000000000 :gas 21000
                :to to :value 1000000000000000000 :data "0x"})

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
                              :signed signed}
                             :key-fn (fn [k] (if (keyword? k) (name k) (str k)))
                             :value-fn (fn [_ v] (if (keyword? v) (name v) v))))))
