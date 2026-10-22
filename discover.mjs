const A = '0xF3841e27b27B6bC78Ea4ad2dC9a1882D04F39f93';
const out = [];
try {
  const b = await (await fetch(`https://base.blockscout.com/api/v2/addresses/${A}/token-balances`)).json();
  out.push('== token balances ==');
  for (const x of b) out.push(`${x.token?.symbol} ${x.token?.address_hash ?? x.token?.address} ${x.value} dec=${x.token?.decimals}`);
} catch (e) { out.push('balances error ' + e.message); }
try {
  const t = await (await fetch(`https://base.blockscout.com/api/v2/addresses/${A}/token-transfers`)).json();
  out.push('== token transfers ==');
  for (const x of (t.items ?? []).slice(0, 25)) out.push(`${x.timestamp} ${x.token?.symbol} from ${x.from?.hash} to ${x.to?.hash} ${x.total?.value} ${x.method ?? ''}`);
} catch (e) { out.push('transfers error ' + e.message); }
console.log(out.join('\n'));
