import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Reference header builder for the brama gateway. createHeaders(config) returns
// a makeHeaders(body) => headers function producing the gateway's expected
// signed trio:
//   x-agent-id        : the agent id
//   x-agent-timestamp : unix seconds (read from the OS clock, not a constant)
//   x-agent-signature : HMAC-SHA256( `${agentId}:${ts}:${sha256hex(body)}` )
// The agent id and its already-resolved auth value come from the caller config;
// this module never reaches into any store, so the caller owns how the value is
// resolved (e.g. through the sanctioned entitlements path) before calling.

function unixSeconds() {
  return execFileSync('date', ['+%s']).toString().trim();
}

export function createHeaders(config = {}) {
  const agentId = config.agentId;
  const agentAuth = config.agentAuth;
  if (!agentId) throw new Error('createHeaders requires config.agentId');
  if (!agentAuth) throw new Error('createHeaders requires config.agentAuth (already-resolved value)');

  return function makeHeaders(body) {
    const timestamp = unixSeconds();
    const bodyHash = crypto.createHash('sha256').update(String(body)).digest('hex');
    const signature = crypto
      .createHmac('sha256', agentAuth)
      .update(`${agentId}:${timestamp}:${bodyHash}`)
      .digest('hex');
    return {
      'x-agent-id': agentId,
      'x-agent-timestamp': timestamp,
      'x-agent-signature': signature,
    };
  };
}
