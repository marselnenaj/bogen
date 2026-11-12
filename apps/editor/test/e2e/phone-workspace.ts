/** Paired-phone view switching regression: real HTTPS pairing, one live document, Undo/Redo,
 * selection, unsent Ask text, remembered preference and host access guards at touch viewport sizes.
 * Build first, then: npx tsx apps/editor/test/e2e/phone-workspace.ts
 * Uses secure-chromium with its sandbox enabled; TLS trust is restricted to this fixture certificate.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { request } from 'node:http';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import type { ServeStatus, TailscaleCli } from '../../../../packages/server/src/tailnet.ts';
const OWNER='owner@example.com';
const work=mkdtempSync('/tmp/bogen-view-fixture-');
const shots=process.env.BOGEN_SHOTS??join(work,'shots');mkdirSync(shots,{recursive:true});
const checks: {name:string;ok:boolean;detail?:unknown}[]=[];
function check(name:string,ok:boolean,detail?:unknown){checks.push({name,ok,detail});console.log(ok?'PASS':'FAIL',name,detail??'');if(!ok)throw Error(name);}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean|Promise<boolean>){for(let i=0;i<100;i++){if(await f())return true;await sleep(100);}return false;}
function certificate(): { key: Buffer; cert: Buffer; spki: string } {
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

function fakeTailscale(name: string): TailscaleCli {
  const config: ServeStatus = { TCP: {}, Web: {} };
  return {
    self: async () => ({ dnsName: name, ownerLogin: OWNER, ips: ['100.64.0.10'], peers: [] }),
    serveStatus: async () => structuredClone(config),
    serve: async (port, target) => {
      config.TCP![port] = { HTTPS: true };
      config.Web![`${name}:${port}`] = { Handlers: { '/': { Proxy: target } } };
    },
    serveOff: async () => {},
    packetFilter: async () => [],
  };
}

/** `tailscale serve` in small: TLS here, the login header added, everything else passed through to the phone listener. */
class ServeStandIn {
  private server: HttpsServer | null = null;
  private sockets = new Set<Duplex>();
  port = 0;
  constructor(private readonly tls: { key: Buffer; cert: Buffer }, private readonly target: () => number) {}

  async start(port = 0): Promise<void> {
    const server = createHttps(this.tls, (req, res) => {
      const headers = { ...req.headers, 'tailscale-user-login': OWNER };
      const out = request({ host: '127.0.0.1', port: this.target(), path: req.url, method: req.method, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on('error', () => res.destroy());
      req.pipe(out);
    });
    server.on('upgrade', (req, socket, head) => {
      const up = connect(this.target(), '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() !== 'tailscale-user-login') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        lines.push(`Tailscale-User-Login: ${OWNER}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      this.sockets.add(socket).add(up);
      const close = () => { socket.destroy(); up.destroy(); };
      up.on('error', close);
      socket.on('error', close);
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }

  /** The computer goes out of reach: every connection ends, nothing answers. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }
}


let pc:BogenServer|null=null;let browser:Awaited<ReturnType<typeof puppeteer.launch>>|null=null;
const tls=certificate();const serve=new ServeStandIn(tls,()=>pc!.phone.boundPort);
try {
 await serve.start();process.env.OMARCHY_PATH=join(work,'no-omarchy');
 pc=new BogenServer({home:join(work,'pc'),port:0,insecureAllowAnyHost:true,tailscale:fakeTailscale('localhost'),phonePort:0,phoneHttpsPort:serve.port,thumbnails:false});
 await pc.listen();
 const post=(path:string,body:unknown)=>fetch(pc!.localUrl()+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 check('fixture enables paired phone listener',(await post('/api/phone',{on:true})).ok);
 const {id}=await(await post('/api/files',{name:'Workspace continuity'})).json() as {id:string};
 await post('/api/files',{name:'Second fixture'});
 const room=await pc.rooms.get(id);const p=room.doc.getPages()[0]!.id;let textId='';
 room.doc.transact(()=>{const b=room.doc.insert(p,{type:'frame',name:'Phone screen',artboard:true,style:{position:'absolute',left:'0px',top:'0px',width:'393px',height:'852px',backgroundColor:'#f4f2ec'}});textId=room.doc.insert(b,{type:'text',name:'Headline',text:'Original heading',style:{position:'absolute',left:'28px',top:'60px',width:'330px',height:'100px',fontSize:'32px',color:'#172126'}});});
 browser=await puppeteer.launch({executablePath:'/home/designer/.local/bin/secure-chromium',pipe:true,headless:true,args:[`--secure-local-port=${serve.port}`,`--secure-local-port=${pc.port}`,`--ignore-certificate-errors-spki-list=${tls.spki}`]});
 const page=await browser.newPage();await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
 await page.evaluateOnNewDocument('window.__name=(f)=>f;localStorage.setItem("bogen-language","en");');
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));const ws:string[]=[];
 const cdp=await page.createCDPSession();await cdp.send('Network.enable');cdp.on('Network.webSocketCreated',e=>ws.push(e.url));
 const origin=`https://localhost:${serve.port}`;const {code}=await(await post('/api/phone/code',{})).json() as {code:string};
 await page.goto(`${origin}/#/pair/${code}`);await page.waitForSelector('.pair-secondary');await page.click('.pair-secondary');await page.waitForSelector('[data-testid="phone-inbox"]');
 check('real pairing opens touch inbox',true);
 await page.evaluate((id)=>{sessionStorage.setItem('bogen-phone-back','#/inbox');location.hash=`#/file/${id}`;},id);
 await page.waitForSelector('[data-testid="pf-tool-layers"]:not([disabled])');
 check('new Inbox route has correct back label',await page.$eval('[data-testid="phone-back"]',e=>e.textContent?.includes('Inbox'))===true);
 await page.click('[data-testid="pf-tool-layers"]');await page.waitForSelector(`[data-layer-id="${textId}"] .pf-layer-pick`);await page.click(`[data-layer-id="${textId}"] .pf-layer-pick`);
 await page.click('[data-testid="pf-layer-edit"]');await page.waitForSelector('[data-testid="pf-text-input"]');await page.$eval('[data-testid="pf-text-input"]',e=>(e as HTMLTextAreaElement).focus());
 await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type('Edited on the phone');
 await page.click('[data-testid="pf-done"]');check('touch edit synchronizes to document',await until(()=>room.doc.getNode(textId)?.text==='Edited on the phone'));
 await page.click('[data-testid="pf-tool-ask"]');await page.waitForSelector('[data-testid="pf-ask-input"]');await page.type('[data-testid="pf-ask-input"]','Keep my unsent instructions');
 const sockets=()=>ws.filter(u=>u.includes('/sync/')).length;const before=sockets();
 await page.select('[data-testid="phone-workspace-view"]','full');await page.waitForSelector('[data-testid="toolbar"]');
 check('full workspace uses same document connection',sockets()===before,{before,after:sockets()});
 await page.select('[data-testid="phone-workspace-view"]','touch');await page.waitForSelector('[data-testid="pf-ask-input"]',{visible:true});check('unsent Ask draft survives view round trip',await page.$eval('[data-testid="pf-ask-input"]',e=>(e as HTMLInputElement).value)==='Keep my unsent instructions');await page.select('[data-testid="phone-workspace-view"]','full');
 check('full view hides touch-only page sheet control',!await page.$('[data-testid="pf-page"]'));
 await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');
 check('Undo survives switching touch to full',await until(()=>room.doc.getNode(textId)?.text==='Original heading'));
 await page.keyboard.down('Control');await page.keyboard.down('Shift');await page.keyboard.press('KeyZ');await page.keyboard.up('Shift');await page.keyboard.up('Control');
 check('Redo survives switching touch to full',await until(()=>room.doc.getNode(textId)?.text==='Edited on the phone'));
 for(const [w,h]of [[390,844],[320,568],[844,390],[820,1180]] as const){
  await page.setViewport({width:w,height:h,deviceScaleFactor:1,isMobile:true,hasTouch:true});await sleep(200);
  const geometry=await page.$eval('[data-testid="phone-workspace-view"]',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,vw:innerWidth,vh:innerHeight,scroll:document.documentElement.scrollWidth};});
  check(`view selector reachable ${w}x${h}`,geometry.x>=0&&geometry.y>=0&&geometry.x+geometry.w<=geometry.vw&&geometry.y+geometry.h<=geometry.vh,geometry);
  await page.screenshot({path:`${shots}/full-${w}x${h}.png`});
  if(w===320){for(const side of ['left','right']){await page.click('[data-testid="toolbar-more"]');await page.waitForSelector(`[data-testid="more-panel-${side}"]`);await page.click(`[data-testid="more-panel-${side}"]`);await page.waitForSelector(`[data-testid="panel-drawer-${side}"]`,{visible:true});const box=await page.$eval(`[data-testid="panel-drawer-${side}"]`,e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,vw:innerWidth,vh:innerHeight};});check(`full ${side} panel reachable at 320px`,box.x>=0&&box.y>=0&&box.right<=box.vw&&box.bottom<=box.vh,box);await page.keyboard.press('Escape');}}

 }
 await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
 await page.select('[data-testid="phone-workspace-view"]','touch');await page.waitForSelector('[data-testid="pf-tool-layers"]:not([disabled])');await page.click('[data-testid="pf-tool-layers"]');
 check('selection survives switching back',await until(()=>page.$eval(`[data-layer-id="${textId}"] .pf-layer-pick`,e=>e.getAttribute('aria-pressed')==='true')));
 check('switching back keeps sync connection',sockets()===before);
 await page.select('[data-testid="phone-workspace-view"]','full');await page.reload();await page.waitForSelector('[data-testid="toolbar"]');
 check('device remembers full view on reload',await page.$eval('[data-testid="phone-workspace-view"]',e=>(e as HTMLSelectElement).value)==='full');
 await page.evaluate(()=>location.hash='#/files');await page.waitForSelector('[data-testid="phone-full-home"]');
 await page.screenshot({path:`${shots}/full-home-390.png`});check('full file browser visible',!!await page.$('.home'));
 const statuses=await page.evaluate(async()=>{const paths=['/api/phone','/mcp'];return Promise.all(paths.map(async p=>({path:p,status:(await fetch(p)).status})));});check('view choice does not grant host administration',statuses.every(s=>s.status===403),statuses);
 await page.evaluate((id)=>location.hash=`#/file/${id}/edit`,id);await page.waitForSelector('[data-testid="toolbar"]');await page.select('[data-testid="phone-workspace-view"]','touch');await page.waitForSelector('[data-testid="pf-tool-layers"]:not([disabled])');
 check('legacy full-editor link can return to touch',await page.evaluate(()=>!location.hash.endsWith('/edit')));
 check('no browser runtime errors',!errors.length,errors);
} finally {writeFileSync(join(shots,'browser-checks.json'),JSON.stringify(checks,null,2));await browser?.close();await serve.stop();await pc?.close();}
