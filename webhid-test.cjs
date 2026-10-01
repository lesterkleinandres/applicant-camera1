const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/signature/stu540-webhid.js', 'utf8');
new vm.Script(source);
let count = 0;
async function check(name, fn) {await fn(); count++; console.log('PASS ' + name);}
function deferred() {let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject};}
function fixture() {
  const requests=[], sent=[], listeners={}, reports={};
  let closeCount=0, openCount=0, inFlight=0, maxInFlight=0;
  const bytes=new Uint8Array(12), view=new DataView(bytes.buffer);
  bytes[0]=9; [10800,6480,1023,800,480].forEach((n,i)=>view.setUint16(1+i*2,n,false));
  const device={vendorId:0x056a,productId:0x00a8,opened:false,
    async open(){openCount++;this.opened=true;}, async close(){closeCount++;this.opened=false;},
    async receiveFeatureReport(id){assert.equal(id,9);return view;},
    async sendFeatureReport(id,data){inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);sent.push({id,data:Uint8Array.from(data)});await new Promise(resolve=>setImmediate(resolve));inFlight--;},
    addEventListener(n,fn){reports[n]=fn;},removeEventListener(n){delete reports[n];}};
  const hid={requestDevice(options){requests.push(options);return Promise.resolve([device]);},
    addEventListener(n,fn){listeners[n]=fn;},removeEventListener(n){delete listeners[n];}};
  const context={window:{isSecureContext:true},navigator:{hid},Uint8Array,DataView,Promise,Math,Error,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(source,context);
  const Adapter=context.window.TiponStu540;
  return {Adapter,pad:new Adapter(),context,hid,device,requests,sent,listeners,reports,view,
    get closeCount(){return closeCount;},get openCount(){return openCount;},get maxInFlight(){return maxInFlight;}};
}
(async()=>{
  await check('unsupported browser and insecure pages do not request USB access',async()=>{
    for(const type of ['browser','https']){const e=fixture();if(type==='browser')e.context.navigator.hid=null;else e.context.window.isSecureContext=false;
      await assert.rejects(e.pad.connect(),/Chrome or Edge/);assert.equal(e.requests.length,0);}
  });
  await check('device picker is called immediately from Connect with only the STU-540 filter',async()=>{
    const e=fixture();const connecting=e.pad.connect();assert.equal(e.requests.length,1);
    assert.equal(JSON.stringify(e.requests[0]),JSON.stringify({filters:[{vendorId:0x056a,productId:0x00a8}]}));
    assert.equal(await connecting,true);assert.equal(e.pad.capability.tabletMaxX,10800);assert.equal(e.pad.capability.screenHeight,480);await e.pad.disconnect();
  });
  await check('cancelled selection and permission denial never open the device',async()=>{
    const e=fixture();e.hid.requestDevice=async()=>[];assert.equal(await e.pad.connect(),false);assert.equal(e.openCount,0);
    e.hid.requestDevice=async()=>{throw Object.assign(new Error('Denied'),{name:'NotAllowedError'});};await assert.rejects(e.pad.connect(),/Denied/);assert.equal(e.openCount,0);
  });
  await check('a non-STU-540 device is rejected before opening',async()=>{
    const e=fixture();e.device.productId=1;await assert.rejects(e.pad.connect(),/Select one/);assert.equal(e.openCount,0);
  });
  await check('malformed capability reports release the USB handle',async()=>{
    for(const mutate of [e=>e.view.setUint8(0,8),e=>e.view.setUint16(7,640,false),e=>e.view.setUint16(5,0,false)]) {
      const e=fixture();mutate(e);await assert.rejects(e.pad.connect(),/invalid capability|Unexpected/);assert.equal(e.closeCount,1);assert.equal(e.device.opened,false);
    }
  });
  await check('open failure does not leave listeners or a claimed device',async()=>{
    const e=fixture();e.device.open=async()=>{throw new Error('Busy');};await assert.rejects(e.pad.connect(),/Busy/);
    assert.equal(e.pad.device,null);assert.equal(Object.keys(e.reports).length,0);assert.equal(Object.keys(e.listeners).length,0);
  });
  await check('late USB open is closed after capture cancellation',async()=>{
    const e=fixture(),gate=deferred(),entered=deferred();e.device.open=async()=>{entered.resolve();await gate.promise;e.device.opened=true;};
    const outcome=e.pad.connect().catch(error=>error);await entered.promise;await e.pad.disconnect();gate.resolve();
    assert.match((await outcome).message,/cancelled/);assert.equal(e.device.opened,false);assert.ok(e.closeCount>=1);
  });
  await check('pen decoding uses big-endian coordinates and strips pressure flags without mutating data',async()=>{
    const e=fixture();await e.pad.connect();const b=new Uint8Array([0xc1,0x02,0x15,0x18,0x0c,0xa8,0,1,0,2]);const original=Array.from(b);
    const pen=e.Adapter.decodePen(0x34,new DataView(b.buffer),e.pad.capability);assert.equal(pen.x,5400);assert.equal(pen.y,3240);assert.equal(pen.pressure,258);
    assert.deepEqual(Array.from(b),original);assert.equal(e.Adapter.decodePen(1,new DataView(b.buffer,0,6),e.pad.capability).pressure,258);await e.pad.disconnect();
  });
  await check('short, unknown and out-of-range pen reports are ignored',async()=>{
    const e=fixture();await e.pad.connect();const bytes=new Uint8Array(10),d=new DataView(bytes.buffer);
    assert.equal(e.Adapter.decodePen(0x34,new DataView(new ArrayBuffer(6)),e.pad.capability),null);
    assert.equal(e.Adapter.decodePen(0x10,d,e.pad.capability),null);
    d.setUint16(0,4095);assert.equal(e.Adapter.decodePen(1,d,e.pad.capability),null);d.setUint16(0,0);d.setUint16(2,12000);assert.equal(e.Adapter.decodePen(1,d,e.pad.capability),null);await e.pad.disconnect();
  });
  await check('monochrome display uses most-significant bit first and composites transparency onto white',async()=>{
    const {Adapter}=fixture();const pixels=new Uint8Array(8*4).fill(255);pixels.set([0,0,0,255],0);
    assert.equal(Adapter.monochrome(pixels,8,1)[0],0x7f);pixels[3]=0;assert.equal(Adapter.monochrome(pixels,8,1)[0],255);
    assert.throws(()=>Adapter.monochrome(pixels,9,1),/Invalid/);
  });
  await check('pad preparation pauses ink and sets timed reports, black pen and bounded signing area',async()=>{
    const e=fixture();await e.pad.connect();await e.pad.prepare({x:24,y:55,w:752,h:344});
    assert.deepEqual(e.sent.map(s=>s.id),[0x21,0x32,0x2d,0x2a,0x20]);assert.deepEqual(Array.from(e.sent[1].data),[2]);
    const area=new DataView(e.sent[3].data.buffer);assert.equal(area.getUint16(0,true),24);assert.equal(area.getUint16(4,true),776);await e.pad.disconnect();
  });
  await check('display transfer waits for all 190 chunks, preserves bytes and uses exact final length',async()=>{
    const e=fixture();await e.pad.connect();const data=Uint8Array.from({length:48000},(_,i)=>i%251);const progress=[];
    await e.pad.writeImage(data,p=>progress.push(p));assert.equal(e.maxInFlight,1);assert.equal(e.sent[0].id,0x25);assert.equal(e.sent[0].data[0],0);
    assert.equal(e.sent.at(-1).id,0x27);const chunks=e.sent.filter(s=>s.id===0x26);assert.equal(chunks.length,190);assert.equal(chunks.at(-1).data[0],183);
    assert.ok(chunks.every(s=>s.data.length===255));const restored=chunks.flatMap(s=>Array.from(s.data.slice(2,2+s.data[0])));assert.deepEqual(restored,Array.from(data));assert.equal(progress.at(-1),100);await e.pad.disconnect();
  });
  await check('failed image transfers stop subsequent blocks and cleanup releases the pad',async()=>{
    const e=fixture();await e.pad.connect();const send=e.device.sendFeatureReport;let chunks=0;
    e.device.sendFeatureReport=async(id,data)=>{if(id===0x26&&++chunks===2)throw new Error('USB failure');return send(id,data);};
    await assert.rejects(e.pad.writeImage(new Uint8Array(48000)),/USB failure/);assert.equal(chunks,2);assert.equal(e.sent.some(s=>s.id===0x27),false);
    await e.pad.disconnect();assert.equal(e.device.opened,false);assert.equal(e.closeCount,1);
  });
  await check('disconnect during an in-flight image block waits before cleanup and prevents later blocks',async()=>{
    const e=fixture();await e.pad.connect();const send=e.device.sendFeatureReport,gate=deferred(),entered=deferred();let blocks=0;
    e.device.sendFeatureReport=async(id,data)=>{if(id===0x26){blocks++;entered.resolve();await gate.promise;}return send(id,data);};
    const writing=e.pad.writeImage(new Uint8Array(48000)).catch(error=>error);await entered.promise;
    const closing=e.pad.disconnect();assert.equal(e.device.opened,true);gate.resolve();
    assert.match((await writing).message,/connection ended/);await closing;assert.equal(blocks,1);assert.equal(e.device.opened,false);
  });
  await check('unplugging the selected device notifies capture and removes input handlers',async()=>{
    const e=fixture();await e.pad.connect();let notices=0;e.pad.onDisconnect=()=>notices++;
    e.listeners.disconnect({device:{}});assert.equal(notices,0);
    e.device.opened=false;e.listeners.disconnect({device:e.device});await Promise.resolve();
    assert.equal(notices,1);assert.equal(e.pad.device,null);assert.equal(Object.keys(e.reports).length,0);
  });
  await check('USB timeouts reject instead of reporting a successful connection',async()=>{
    const {Adapter}=fixture();await assert.rejects(Adapter.bounded(new Promise(()=>{}),'USB test',5),/timed out/);
  });
  console.log(`${count} WebHID checks passed with simulated USB reports. Physical STU-540 test still required.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
