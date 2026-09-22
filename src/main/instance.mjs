import path from 'node:path';
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function instanceConfig(argv, base) {
  const flags = argv.filter(value => value.startsWith('--instance='));
  const id = flags.length ? flags[0].slice(11) : 'principal';
  if (flags.length > 1 || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) throw new Error('invalid_instance_id');
  return { id, userData: path.join(base, 'instances', id) };
}

export function atomicJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}
