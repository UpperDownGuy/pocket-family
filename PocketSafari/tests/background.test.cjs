const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
function environment(origins = ["https://shop.example"]) {
  let listener;
  const sent = [];
  const storage = { enabledOrigins: origins };
  const browser = {
    runtime: { id:"pocket", getURL:()=>"safari-web-extension://pocket/", onMessage:{ addListener:fn=>listener=fn }, sendNativeMessage: async (_, value)=>{sent.push(value);return {ok:true};} },
    storage:{ local:{ get:async()=>storage, set:async value=>Object.assign(storage,value) } },
    tabs:{ query:async()=>[] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../Resources/background.js"),"utf8"), { browser, URL, Date, Number, Set });
  return { call:(message,sender)=>listener(message,sender),sent,storage };
}
const sender = { id:"pocket", frameId:0, url:"https://shop.example/receipt", tab:{id:1,url:"https://shop.example/receipt"} };
const receipt = { merchant:"shop.example", note:"arbitrary page data", amountCents:1200, orderReference:"A1234", url:"https://shop.example" };
test("enabled top frame delivers only constrained receipt fields", async()=>{
  const env=environment();
  const result=await env.call({type:"receipt",receipt},sender);
  assert.equal(result.ok,true);
  assert.equal(env.sent[0].type,"purchase");
  assert.equal(env.sent[0].receipt.note,"Online purchase");
  assert.equal(env.storage.lastDelivery.ok,true);
});
test("page scripts cannot perform native sign-in or log out",async()=>{
  const env=environment();
  for(const type of ["login","logout","status"]) assert.equal((await env.call({type},sender)).ok,false);
  assert.equal(env.sent.length,0);
});
test("disabled sites, foreign sender, subframes, and mismatched origins cannot log",async()=>{
  for(const entry of [
    {origins:[],sender},
    {sender:{...sender,id:"other"}},
    {sender:{...sender,frameId:1}},
    {sender:{...sender,tab:{id:1,url:"https://other.example"}}}
  ]) {
    const env=environment(entry.origins);
    assert.equal((await env.call({type:"receipt",receipt},entry.sender)).ok,false);
    assert.equal(env.sent.length,0);
  }
});
test("reject forged merchant, origin, amount or reference",async()=>{
  const env=environment();
  for(const change of [{merchant:"other.example"},{url:"https://shop.example/?secret"},{amountCents:1.5},{orderReference:"paid"}]) assert.equal((await env.call({type:"receipt",receipt:{...receipt,...change}},sender)).ok,false);
  assert.equal(env.sent.length,0);
});
test("only extension popup may sign in through native bridge",async()=>{
  const env=environment();
  assert.equal((await env.call({type:"login"},{id:"pocket",url:"safari-web-extension://pocket/popup.html"})).ok,true);
  assert.equal(env.sent.length,1);
});
