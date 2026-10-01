const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const root = __dirname;
const parentSource = fs.readFileSync(root + '/apps-script/ApplicantSignature.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const childSource = fs.readFileSync(root + '/signature/capture-webhid.js', 'utf8');
const serverSource = fs.readFileSync(root + '/apps-script/SignatureDevice.gs', 'utf8');
for (const [name, source] of [['dialog', parentSource], ['device page', childSource], ['server', serverSource]]) new vm.Script(source, {filename:name});
const png = Buffer.alloc(34); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(840,16); png.writeUInt32BE(480,20);
const dataUrl = 'data:image/png;base64,' + png.toString('base64');
let count = 0;
function check(name, fn) {fn(); count++; console.log('PASS ' + name);}
function canvas() {
  const ops = [];
  const ctx = new Proxy({}, {get:(o,k) => k in o ? o[k] : (...args) => ops.push({k,args}), set:(o,k,v) => {o[k]=v;return true;}});
  return {width:840,height:480,ops,ctx,events:{},getContext:()=>ctx,toDataURL:()=>dataUrl,getBoundingClientRect:()=>({left:0,top:0,width:420,height:240}),setPointerCapture(){},addEventListener(n,fn){this.events[n]=fn;}};
}
function env() {
  const elements = {};
  for (const id of ['applicant','wacom','clear','save','cancel','status','connect','connection']) elements[id] = {events:{},textContent:id==='applicant'?'Test Applicant':'',disabled:false,addEventListener(n,fn){this.events[n]=fn;}};
  elements.signaturePad = canvas(); elements.preview = canvas();
  const messages = [], timers = [], calls = [], listeners = {};
  const popup = {closed:false,postMessage(message,origin){messages.push({message,origin});},focus(){},close(){this.closed=true;}};
  let success, failure, hostClosed = 0;
  const run = {withSuccessHandler(fn){success=fn; return this;},withFailureHandler(fn){failure=fn; return this;},saveApplicantSignatureFromDevice(...args){calls.push(args);}};
  const context = {console,URL,URLSearchParams,crypto:webcrypto,Uint8Array,Promise,Date,Math,Number,String,Array,Set,Error,location:{origin:'https://test-script.googleusercontent.com'},google:{script:{run,host:{close(){hostClosed++;}}}},document:{getElementById:id=>elements[id],createElement:tag=>tag==='canvas'?canvas():{remove(){}},head:{appendChild(script){queueMicrotask(()=>script.onload());}}},Image:class {naturalWidth=840;naturalHeight=480;set src(value){this.onload();}},setTimeout(fn,ms){const t={fn,ms,active:true};timers.push(t);return t;},clearTimeout(t){if(t)t.active=false;},setInterval(fn,ms){return {fn,ms};},clearInterval(){}};
  context.TiponStu540 = {supported:()=>true};
  context.window = {open:()=>popup,opener:popup,addEventListener:(type,fn)=>listeners[type]=fn,close(){popup.closed=true;}};
  vm.createContext(context);
  return {context,elements,popup,messages,timers,calls,listeners,get hostClosed(){return hostClosed;},success:r=>success(r),failure:e=>failure(e)};
}
function parent() {
  const e=env(); vm.runInContext(parentSource,e.context);
  e.elements.wacom.events.click();
  e.session = vm.runInContext('undefined',e.context);
  // Read the nonce from the popup URL, independently of the production state.
  return e;
}
function openParent() {
  const e=env(); let opened;
  e.context.window.open = url => {opened=new URL(url); return e.popup;};
  vm.runInContext(parentSource,e.context); e.elements.wacom.events.click();
  e.session = new URLSearchParams(opened.hash.slice(1)).get('session');
  e.deliver=(extra, origin='https://lesterkleinandres.github.io', source=e.popup)=>e.listeners.message({origin,source,data:{requestId:e.session,...extra}});
  return e;
}
check('wrong origin, popup or nonce cannot save a signature',()=>{
  const e=openParent();
  e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl},'https://attacker.example');
  e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl},undefined,{});
  e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl,requestId:'0'.repeat(32)});
  assert.equal(e.calls.length,0);
});
check('handshake sends the applicant only to the expected capture origin',()=>{
  const e=openParent(); e.deliver({type:'TIPON_STU_READY'});
  assert.equal(e.messages[0].origin,'https://lesterkleinandres.github.io'); assert.equal(e.messages[0].message.applicantName,'Test Applicant');
});
check('valid device image saves once; duplicate delivery is ignored',()=>{
  const e=openParent(); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl}); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl});
  assert.equal(e.calls.length,1); assert.equal(e.calls[0][1],'Test Applicant'); assert.equal(e.calls[0][2],e.session);
  assert.equal(e.elements.cancel.disabled,true);
});
check('malformed or oversized data never reaches Apps Script',()=>{
  const e=openParent(); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl:'data:image/svg+xml;base64,AAAA'}); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl:'A'.repeat(1600001)});
  assert.equal(e.calls.length,0);
});
check('wrong decoded dimensions cannot save',()=>{
  const e=openParent(); e.context.Image=class {naturalWidth=800;naturalHeight=480;set src(v){this.onload();}};
  e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl}); assert.equal(e.calls.length,0);
});
check('timeout is a warning and never confirms success or closes',()=>{
  const e=openParent(); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl}); e.timers.find(t=>t.ms===20000).fn();
  assert.equal(e.hostClosed,0); assert.equal(e.messages.length,0); assert.equal(e.elements.cancel.disabled,true);
});
check('only a confirmed save permits closing',()=>{
  const e=openParent(); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl}); e.success({success:true});
  assert.equal(e.messages.at(-1).message.success,true); assert.equal(e.hostClosed,0);
  e.deliver({type:'TIPON_STU_ACK'}); assert.equal(e.hostClosed,1);
});
check('failed or unconfirmed saves do not close and cannot repeat',()=>{
  for(const result of ['error','false']) {const e=openParent(); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl}); if(result==='error')e.failure(new Error('Failed')); else e.success({success:false});
    assert.equal(e.hostClosed,0); assert.equal(e.messages.at(-1).message.success,false); e.deliver({type:'TIPON_STU_SIGNATURE',dataUrl}); assert.equal(e.calls.length,1);}
});
check('manual pen/mouse capture uses the same guarded save',()=>{
  const e=env();vm.runInContext(parentSource,e.context);e.elements.signaturePad.events.pointerdown({button:0,pointerId:1,clientX:100,clientY:100,preventDefault(){}});e.elements.signaturePad.events.pointerup();e.elements.save.events.click();assert.equal(e.calls.length,1);assert.equal(e.calls[0][1],'Test Applicant');
});
function server() {
  const saved=[], cache=new Map(); let name='Test Applicant', releases=0, fail=false;
  const s={Utilities:{base64Decode:s=>Array.from(Buffer.from(s,'base64'))},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){releases++;}})},CacheService:{getUserCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v)})},SpreadsheetApp:{openById:()=>({getSheetByName:()=>({})})},APPLICANT_CAPTURE_CONFIG:{spreadsheetId:'exact-test-id',sheetName:'exact-test-sheet'},getApplicantCaptureName_:()=>name,saveApplicantSignatureCapture:data=>{saved.push(data);if(fail)throw new Error('Sync failed');return {success:true};}};
  vm.createContext(s);vm.runInContext(serverSource,s);
  return {s,saved,set name(v){name=v;},set fail(v){fail=v;},get releases(){return releases;},call:(data=dataUrl,id='a'.repeat(32))=>s.saveApplicantSignatureFromDevice(data,'Test Applicant',id)};
}
check('server rejects a changed applicant before writing',()=>{const e=server();e.name='Another Applicant';assert.throws(()=>e.call(),/selected applicant changed/);assert.equal(e.saved.length,0);assert.equal(e.releases,1);});
check('server returns an idempotent result after successful save',()=>{const e=server();assert.equal(e.call().success,true);assert.equal(e.call().duplicate,true);assert.equal(e.saved.length,1);});
check('server blocks repeating a partial/failed attempt',()=>{const e=server();e.fail=true;assert.throws(()=>e.call(),/not fully confirmed/);assert.throws(()=>e.call(),/already submitted/);assert.equal(e.saved.length,1);assert.equal(e.releases,2);});
check('server rejects wrong PNG headers, dimensions and session IDs',()=>{const e=server();assert.throws(()=>e.call('data:image/png;base64,AAAA'),/valid PNG/);const bad=Buffer.from(png);bad.writeUInt32BE(900,16);assert.throws(()=>e.call('data:image/png;base64,'+bad.toString('base64')),/Unexpected signature size/);assert.throws(()=>e.call(dataUrl,'bad'),/Invalid signature session/);assert.equal(e.saved.length,0);});
const c=env(); c.context.location.hash='#'+new URLSearchParams({session:'b'.repeat(32),parentOrigin:'https://test-script.googleusercontent.com'});
// Export private pen processing for a narrow hardware-event simulation; production files remain untouched.
const instrumented=childSource.replace(/\}\)\(\);\s*$/, 'window.test={onPen,prepareCanvas,signaturePng,get hasInk(){return hasInk;},setup(){capability={screenWidth:800,screenHeight:480,tabletMaxX:800,tabletMaxY:480};threshold={onPressureMark:5,offPressureMark:3};connected=true;parentReady=true;prepareCanvas();}};})();');
vm.runInContext(instrumented,c.context);c.context.window.test.setup();
check('hover, button and outside-box movements are not signature ink',()=>{const t=c.context.window.test;t.onPen({x:100,y:100,pressure:0});t.onPen({x:200,y:10,pressure:20});t.onPen({x:200,y:10,pressure:0});t.onPen({x:100,y:440,pressure:20});assert.equal(t.hasInk,false);});
check('pressure strokes inside the pad signing box create signature ink',()=>{const t=c.context.window.test;t.onPen({x:100,y:440,pressure:0});t.onPen({x:100,y:120,pressure:20});t.onPen({x:180,y:150,pressure:20});t.onPen({x:180,y:150,pressure:0});assert.equal(t.hasInk,true);assert.match(t.signaturePng(),/^data:image\/png;base64,/);});
console.log(`${count} checks passed. No real device, Drive file, or spreadsheet was written.`);

function child() {
  const e=env(), pads=[];
  class Pad {
    static supported(){return true;}
    static monochrome(data,w,h){assert.equal(w,800);assert.equal(h,480);return new Uint8Array(48000);}
    constructor(){this.capability={screenWidth:800,screenHeight:480,tabletMaxX:10800,tabletMaxY:6480,tabletMaxPressure:1023};this.closed=0;pads.push(this);}
    async connect(){return true;}
    async prepare(area){assert.equal(area.x,24);}
    async writeImage(data,progress=()=>{}){assert.equal(data.length,48000);progress(100);}
    async setInking(){}
    async disconnect(){this.closed++;}
  }
  const session='d'.repeat(32), origin='https://test-script.googleusercontent.com';
  e.context.location.hash='#'+new URLSearchParams({session,parentOrigin:origin});
  e.context.TiponStu540=Pad;e.elements.preview.ctx.getImageData=()=>({data:new Uint8Array(800*480*4)});
  vm.runInContext(childSource,e.context);
  e.deliver=(extra,from=origin)=>e.listeners.message({origin:from,source:e.popup,data:{requestId:session,...extra}});
  e.deliver({type:'TIPON_STU_INIT',applicantName:'Test Applicant'});
  e.pads=pads;e.sign=()=>{pads[0].onPen({x:3000,y:2000,pressure:200});pads[0].onPen({x:5000,y:2300,pressure:250});pads[0].onPen({x:5000,y:2300,pressure:0});};
  return e;
}
(async()=>{
  const e=child();await e.elements.connect.events.click();assert.match(e.elements.connection.textContent,/connected by USB/);
  e.sign();await e.elements.clear.events.click();assert.equal(e.elements.save.disabled,true);
  await e.elements.save.events.click();assert.equal(e.messages.filter(m=>m.message.type==='TIPON_STU_SIGNATURE').length,0);
  e.sign();await e.elements.save.events.click();await e.elements.save.events.click();
  const saves=e.messages.filter(m=>m.message.type==='TIPON_STU_SIGNATURE');assert.equal(saves.length,1);assert.match(saves[0].message.dataUrl,/^data:image\/png;base64,/);
  e.deliver({type:'TIPON_STU_RESULT',success:true},'https://wrong.example');assert.equal(e.pads[0].closed,0);
  e.deliver({type:'TIPON_STU_RESULT',success:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(e.pads[0].closed,1);assert.equal(e.messages.filter(m=>m.message.type==='TIPON_STU_ACK').length,1);
  e.timers.find(t=>t.ms===800).fn();assert.equal(e.popup.closed,true);
  console.log('PASS complete simulated USB capture → clear → capture → single save → confirmed cleanup and close');
  const f=child();await f.elements.connect.events.click();f.sign();await f.elements.save.events.click();f.deliver({type:'TIPON_STU_RESULT',success:false,message:'Sync failed'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.pads[0].closed,1);assert.equal(f.popup.closed,false);assert.equal(f.elements.save.disabled,true);assert.equal(f.messages.some(m=>m.message.type==='TIPON_STU_ACK'),false);
  console.log('PASS failed save releases USB but keeps the error visible and does not confirm success');
  console.log('17 flow checks passed. Hardware and production data remain untouched.');
})().catch(error=>{console.error(error);process.exitCode=1;});
