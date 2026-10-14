import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createConnection} from 'node:net';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const python = process.platform === 'win32' || (!existsSync('.venv/bin/python') && existsSync('.venv/Scripts/python.exe'))
  ? '.venv/Scripts/python.exe' : '.venv/bin/python';
// Fail before launching a second server, including Windows listeners from WSL.
const occupied = await new Promise(resolve => {
  const socket = createConnection({host:'127.0.0.1',port:3001});
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('error',()=>resolve(false));
  socket.setTimeout(2000,()=>{socket.destroy();resolve(true);});
});
if (occupied) {
  console.error('Port 3001 is already in use. Close the previous project terminal before restarting the app.');
  process.exit(1);
}
// A shared-file heartbeat works across WSL/Windows, including abrupt exits.
mkdirSync('.runtime',{recursive:true});
// Remove markers left behind if a terminal or Node process was killed abruptly.
for (const name of readdirSync('.runtime')) {
  if (!/^backend-[0-9a-f-]+$/i.test(name)) continue;
  const path = `.runtime/${name}`;
  try {
    if (Date.now() - statSync(path).mtimeMs > 10000) rmSync(path,{force:true});
  } catch {}
}
const heartbeat = `.runtime/backend-${randomUUID()}`;
const pulse = () => writeFileSync(heartbeat,String(Date.now()));
pulse();
const timer = setInterval(pulse,1000);
const cleanup = () => {clearInterval(timer);rmSync(heartbeat,{force:true});};
process.on('exit',cleanup);
const child = spawn(python,['-m','server.dev',heartbeat],{stdio:'inherit'});
let stopping = false;
let finished = false;
const finish = code => {
  if (finished) return;
  finished = true;
  cleanup();
  process.exitCode = code;
};
child.on('error',error=>{console.error(error.message);finish(1);});
child.on('exit',(code,signal)=>finish(stopping ? 0 : (code??(signal ? 1 : 0))));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  if (stopping) return;
  stopping = true;
  cleanup();
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
});
