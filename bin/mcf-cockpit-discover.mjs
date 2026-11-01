#!/usr/bin/env node
// Atomic, read-only inspection of the local Cockpit. Never prints the bearer token.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildControlCatalog } from '../src/main/control-catalog.mjs';

const args=process.argv.slice(2);
if(args.includes('--help')) {
  process.stdout.write('Usage: node bin/mcf-cockpit-discover.mjs [--instance=notebook] [--offline] [--summary]\n');
  process.exit(0);
}
if(args.some(v=>!['--offline','--summary'].includes(v)&&!v.startsWith('--instance='))) {
  process.stderr.write('invalid_argument\n');process.exit(2);
}
const instanceFlag=args.find(v=>v.startsWith('--instance='));
const instance=instanceFlag ? instanceFlag.slice('--instance='.length):'notebook';
if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(instance)){
  process.stderr.write('invalid_instance\n');process.exit(2);
}
const render=(catalog)=>{
  if(args.includes('--summary')) {
    process.stdout.write(JSON.stringify({schema:catalog.schema,instance,
      counts:catalog.counts,runtime:catalog.runtime,
      contract:catalog.contract,limitations:catalog.limitations},null,2)+'\n');
  } else process.stdout.write(JSON.stringify(catalog,null,2)+'\n');
};
if(args.includes('--offline')){render(buildControlCatalog());process.exit(0);}
const descriptorFile=path.join(os.homedir(),'.config','mcf-dual-browser-cockpit','instances',instance,'agent-bridge.json');
try {
  const descriptor=JSON.parse(readFileSync(descriptorFile,'utf8'));
  if(descriptor.instanceId!==instance || descriptor.host!=='127.0.0.1'
    || !Number.isInteger(descriptor.port) || descriptor.port<1 || descriptor.port>65535
    || typeof descriptor.token!=='string'||!descriptor.token) throw Error('descriptor_invalid');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);
  let response;
  try {
    response=await fetch(`http://127.0.0.1:${descriptor.port}/v1/control-catalog`,{
      headers:{Authorization:`Bearer ${descriptor.token}`,'X-MCF-Instance':instance},
      signal:controller.signal,
    });
  } finally {clearTimeout(timeout);}
  if(!response.ok) throw Error(`catalog_http_${response.status}`);
  const result=await response.json();
  if(result.ok!==true || result.catalog?.schema!=='mcf-dual-browser-control-catalog/v1')
    throw Error('catalog_response_invalid');
  render(result.catalog);
} catch(error) {
  // Redact unknown error details: exceptions could contain bearer material.
  process.stderr.write('live_catalog_unavailable; use --offline for static contract\n');
  process.exitCode=3;
}
