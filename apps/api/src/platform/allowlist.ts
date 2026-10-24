import { BlockList, isIP } from 'node:net';

/** True when an address may reach the operator API. */
export type IpAllowlist = (ip: string) => boolean;

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** An IPv4 client seen through an IPv6 socket (`::ffff:10.0.0.1`) is matched as IPv4. */
function plain(ip: string): string {
  return MAPPED.exec(ip)?.[1] ?? ip;
}

/**
 * `PLATFORM_IP_ALLOWLIST` (ADR M15-0001 decision 9): a comma-separated list of addresses or CIDRs, IPv4 or IPv6.
 * Unset or empty: every address may reach the operator API, which still needs a password, a TOTP code and its own
 * session. Throws on an entry that is not an address or a CIDR, so a typo fails the boot rather than letting
 * everyone in or locking everyone out unnoticed.
 */
export function ipAllowlistFromEnv(value: string | undefined): IpAllowlist | null {
  if (value === undefined || value.trim() === '') return null;
  const list = new BlockList();
  for (const entry of value.split(',').map((e) => e.trim())) {
    const [address = '', prefix, ...rest] = entry.split('/');
    const version = isIP(plain(address));
    const max = version === 4 ? 32 : 128;
    const valid =
      version !== 0 &&
      rest.length === 0 &&
      (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= max));
    if (!valid) {
      throw new Error(
        `PLATFORM_IP_ALLOWLIST must list addresses or CIDRs (for example 203.0.113.7 or 10.20.0.0/16), not ${JSON.stringify(entry)}`,
      );
    }
    const type = version === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(plain(address), type);
    else list.addSubnet(plain(address), Number(prefix), type);
  }
  return (ip) => {
    const address = plain(ip);
    const version = isIP(address);
    return version !== 0 && list.check(address, version === 4 ? 'ipv4' : 'ipv6');
  };
}
