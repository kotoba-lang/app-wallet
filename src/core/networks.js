// Where balances, prices and broadcasts come from. App data, not library
// data: wallet.chains says what a chain IS; this says which public endpoint
// the app asks about it. Every endpoint is keyless and public, and each one
// only ever learns addresses — never a key, never the mnemonic.
//
// Requests go through kotoba-shell's `http/fetch` provider when the native
// host is attached (no CORS, the policy audits every call) and fall back to
// the WebView's fetch in a plain browser.

export const evm = {
  eth:       { decimals: 18, rpc: 'https://ethereum-rpc.publicnode.com',          explorer: 'https://etherscan.io' },
  bnb:       { decimals: 18, rpc: 'https://bsc-rpc.publicnode.com',               explorer: 'https://bscscan.com' },
  polygon:   { decimals: 18, rpc: 'https://polygon-bor-rpc.publicnode.com',       explorer: 'https://polygonscan.com' },
  avalanche: { decimals: 18, rpc: 'https://avalanche-c-chain-rpc.publicnode.com', explorer: 'https://snowtrace.io' },
  arbitrum:  { decimals: 18, rpc: 'https://arbitrum-one-rpc.publicnode.com',      explorer: 'https://arbiscan.io' },
  optimism:  { decimals: 18, rpc: 'https://optimism-rpc.publicnode.com',          explorer: 'https://optimistic.etherscan.io' },
  base:      { decimals: 18, rpc: 'https://base-rpc.publicnode.com',              explorer: 'https://basescan.org' },
};

export const utxo = {
  btc:  { decimals: 8, kind: 'esplora',     api: 'https://mempool.space/api',     explorer: 'https://mempool.space/address/' },
  ltc:  { decimals: 8, kind: 'esplora',     api: 'https://litecoinspace.org/api', explorer: 'https://litecoinspace.org/address/' },
  doge: { decimals: 8, kind: 'blockcypher', api: 'https://api.blockcypher.com/v1/doge/main', explorer: 'https://blockchair.com/dogecoin/address/' },
  // blockchair answers keyless clients with 430 (IP blacklisted) — haskoin does not.
  bch:  { decimals: 8, kind: 'haskoin',     api: 'https://api.haskoin.com/bch', explorer: 'https://blockchair.com/bitcoin-cash/address/' },
};

export const tron = {
  trx: { decimals: 6, api: 'https://api.trongrid.io', explorer: 'https://tronscan.org/#/address/' },
};

// CoinGecko ids per ticker symbol from wallet.chains (several chains share ETH).
export const priceIds = {
  ETH: 'ethereum', BNB: 'binancecoin', POL: 'polygon-ecosystem-token', AVAX: 'avalanche-2',
  BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', BCH: 'bitcoin-cash', TRX: 'tron',
};

export const fiats = ['jpy', 'usd', 'eur', 'gbp', 'cny', 'krw'];

export function decimalsOf(chain) {
  return (evm[chain] || utxo[chain] || tron[chain])?.decimals ?? 18;
}

// ── transport ────────────────────────────────────────────────────────────
async function request(url, { method = 'GET', body, headers = {}, text = false } = {}) {
  const shell = globalThis.kotobaShell;
  let status, payload;
  if (shell?.available) {
    const r = await shell.invoke('http/fetch', { url, method, headers, ...(body != null ? { body } : {}) });
    if (!r.ok) throw new Error(`${r.error}${r.detail ? ': ' + r.detail : ''}`);
    ({ status, body: payload } = r.value);
  } else {
    const res = await fetch(url, { method, headers, body });
    status = res.status; payload = await res.text();
  }
  // node errors (e.g. "sendrawtransaction RPC error: …") are the useful part of a failed broadcast
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} from ${new URL(url).host}${payload ? ': ' + String(payload).slice(0, 300) : ''}`);
  return text ? String(payload).trim() : JSON.parse(payload);
}

let rpcId = 0;
export async function rpc(chain, method, params = []) {
  const j = await request(evm[chain].rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// ── balances (smallest unit, BigInt) ─────────────────────────────────────
export async function balance(acct) {
  const { chain } = acct;
  if (evm[chain]) return BigInt(await rpc(chain, 'eth_getBalance', [acct.address, 'latest']));
  if (tron[chain]) {
    const j = await request(`${tron[chain].api}/v1/accounts/${acct.address}`);
    return BigInt(j.data?.[0]?.balance ?? 0);
  }
  const u = utxo[chain];
  const addrs = [acct.p2wpkh, acct.p2pkh, acct.cashaddr].filter(Boolean);
  let total = 0n;
  for (const a of addrs) {
    if (u.kind === 'esplora') {
      const j = await request(`${u.api}/address/${a}`);
      const s = (x) => BigInt(x.funded_txo_sum) - BigInt(x.spent_txo_sum);
      total += s(j.chain_stats) + s(j.mempool_stats);
    } else if (u.kind === 'blockcypher') {
      const j = await request(`${u.api}/addrs/${a}/balance`);
      total += BigInt(j.final_balance ?? 0);
    } else if (u.kind === 'haskoin') {
      const j = await request(`${u.api}/address/${a}/balance`);
      total += BigInt(j.confirmed ?? 0) + BigInt(j.unconfirmed ?? 0);
    }
  }
  return total;
}

export async function prices(fiat) {
  const ids = [...new Set(Object.values(priceIds))].join(',');
  const j = await request(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${fiat}`);
  const out = {};
  for (const [sym, id] of Object.entries(priceIds)) if (j[id]?.[fiat] != null) out[sym] = j[id][fiat];
  return out;
}

// ── EVM send ─────────────────────────────────────────────────────────────
/** Fee quote for an EIP-1559 transfer: maxFee = 2·baseFee + tip. */
export async function quoteEvmTransfer(chain, from, to, value) {
  const [nonce, block, tipHex, gasHex] = await Promise.all([
    rpc(chain, 'eth_getTransactionCount', [from, 'pending']),
    rpc(chain, 'eth_getBlockByNumber', ['latest', false]),
    rpc(chain, 'eth_maxPriorityFeePerGas', []).catch(() => '0x59682f00'), // 1.5 gwei
    rpc(chain, 'eth_estimateGas', [{ from, to, value: '0x' + value.toString(16) }]),
  ]);
  const base = BigInt(block.baseFeePerGas ?? '0x0');
  const tip = BigInt(tipHex);
  const gas = BigInt(gasHex);
  const maxFeePerGas = base * 2n + tip;
  return { nonce: BigInt(nonce), gas, maxPriorityFeePerGas: tip, maxFeePerGas, maxCost: gas * maxFeePerGas };
}

export const broadcastEvm = (chain, raw) => rpc(chain, 'eth_sendRawTransaction', [raw]);

// ── UTXO send ────────────────────────────────────────────────────────────
/** Spendable outputs of every address of `acct`, tagged with the input type. */
export async function listUtxos(acct) {
  const u = utxo[acct.chain];
  const owned = [['p2wpkh', acct.p2wpkh], ['p2pkh', acct.p2pkh]].filter(([, a]) => a);
  const out = [];
  for (const [type, addr] of owned) {
    if (u.kind === 'esplora') {
      for (const x of await request(`${u.api}/address/${addr}/utxo`))
        out.push({ txid: x.txid, vout: x.vout, value: BigInt(x.value), type, confirmed: !!x.status?.confirmed });
    } else if (u.kind === 'blockcypher') {
      const j = await request(`${u.api}/addrs/${addr}?unspentOnly=true&limit=200`);
      for (const [x, confirmed] of [...(j.txrefs ?? []).map((x) => [x, true]), ...(j.unconfirmed_txrefs ?? []).map((x) => [x, false])])
        out.push({ txid: x.tx_hash, vout: x.tx_output_n, value: BigInt(x.value), type, confirmed });
    } else throw new Error(`no UTXO source for ${acct.chain}`);
  }
  return out;
}

/** Fee tiers in sat/vB: {fast, normal, slow}. */
export async function feeRates(chain) {
  const u = utxo[chain];
  if (u.kind === 'esplora') {
    const j = await request(`${u.api}/v1/fees/recommended`);
    return { fast: j.fastestFee, normal: j.halfHourFee, slow: Math.max(j.hourFee, j.minimumFee) };
  }
  if (u.kind === 'blockcypher') {
    const j = await request(u.api);
    const vb = (k) => Math.ceil(j[k] / 1000);
    return { fast: vb('high_fee_per_kb'), normal: vb('medium_fee_per_kb'), slow: vb('low_fee_per_kb') };
  }
  throw new Error(`no fee source for ${chain}`);
}

/** Broadcast a raw hex tx; returns the txid the node reports. */
export async function broadcastUtxo(chain, rawHex) {
  const u = utxo[chain];
  if (u.kind === 'esplora')
    return request(`${u.api}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: rawHex, text: true });
  if (u.kind === 'blockcypher') {
    const j = await request(`${u.api}/txs/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: rawHex }) });
    return j.tx?.hash;
  }
  throw new Error(`no broadcast endpoint for ${chain}`);
}

export const txExplorerUrl = (chain, txid) =>
  evm[chain] ? `${evm[chain].explorer}/tx/${txid}`
    : chain === 'btc' ? `https://mempool.space/tx/${txid}`
    : chain === 'ltc' ? `https://litecoinspace.org/tx/${txid}`
    : chain === 'doge' ? `https://blockchair.com/dogecoin/transaction/${txid}` : '#';
