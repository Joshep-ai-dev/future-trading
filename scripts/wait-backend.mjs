import {createConnection} from 'node:net';

// Hold Vite until the API accepts connections so the first /api proxy requests do not fail.
const deadline = Date.now() + 120_000;
const attempt = () => {
  const socket = createConnection({host:'127.0.0.1',port:3001});
  socket.once('connect',() => {socket.end();process.exit(0);});
  socket.once('error',() => {
    socket.destroy();
    if (Date.now() > deadline) {console.error('Backend did not open port 3001 within 120s.');process.exit(1);}
    setTimeout(attempt,300);
  });
};
attempt();
