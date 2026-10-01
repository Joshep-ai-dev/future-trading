import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
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
const heartbeat = `.runtime/backend-${randomUUID()}`;
const pulse = () => writeFileSync(heartbeat,String(Date.now()));
pulse();
const timer = setInterval(pulse,1000);
const cleanup = () => {clearInterval(timer);rmSync(heartbeat,{force:true});};
process.on('exit',cleanup);
const child = spawn(python,['-m','server.dev',heartbeat],{stdio:'inherit'});
let stopping = false;
child.on('error',error=>{console.error(error.message);process.exit(1);});
child.on('exit',code=>process.exit(stopping ? 0 : (code??1)));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  stopping = true;
  cleanup();
});
