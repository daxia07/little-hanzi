import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function port(name,fallback){const value=Number(process.env[name]??fallback);if(!Number.isInteger(value)||value<1||value>65535)throw new Error(`Invalid ${name}`);return value;}
const listenPort=port('HANZI_PORT',4173);
const backendPort=port('HANZI_BACKEND_PORT',4175);
if(listenPort===backendPort)throw new Error('LAN and backend ports must differ');
const backend=spawn(path.join(project,'node_modules/.bin/wrangler'),['dev','--config','dist/server/wrangler.json','--ip','127.0.0.1','--port',String(backendPort),'--persist-to','.wrangler/state'],{cwd:project,stdio:['ignore','inherit','inherit']});
const server=http.createServer((req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Retry-After':'2'});res.end('小课堂正在启动，请稍后刷新。');});
  req.on('aborted',()=>upstream.destroy());
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
  req.pipe(upstream);
});
server.listen(listenPort,'0.0.0.0',()=>{
  console.log(`Little Hanzi: http://localhost:${listenPort}`);
  for(const entries of Object.values(os.networkInterfaces()))for(const entry of entries??[])if(entry.family==='IPv4'&&!entry.internal)console.log(`LAN: http://${entry.address}:${listenPort}`);
});
server.on('error',error=>{console.error(error);backend.kill('SIGTERM');process.exitCode=1;});
function stop(){server.close();backend.kill('SIGTERM');setTimeout(()=>process.exit(0),1000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
backend.on('error',error=>{console.error(error);server.close();process.exitCode=1;});
backend.on('exit',code=>{server.close();process.exitCode=code??1;});
