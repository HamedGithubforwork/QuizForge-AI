'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const tick = () => new Promise(resolve => setImmediate(resolve))

for (const windowsStore of [false, true]) test(`native menu drives browser/callback/refresh/revoke; Store=${windowsStore}`, async () => {
  const app = new EventEmitter(), menus = new Map(), reports = [], opened = [], calls = []
  let window, quits=0
  Object.assign(app,{isPackaged:true,getVersion:()=> '0.1.0',enableSandbox(){},requestSingleInstanceLock:()=>true,
    whenReady:()=>Promise.resolve(),isDefaultProtocolClient:()=>true,setAppUserModelId(){},quit:()=>quits++})
  class Window extends EventEmitter {
    constructor(options){super();window=this;this.webContents=new EventEmitter();this.options=options}
    loadURL(){return Promise.resolve()}
    isDestroyed(){return false}
    isMinimized(){return false}
    show(){}
    focus(){}
  }
  const menu={getMenuItemById:id=>menus.get(id)}
  const electron={ipcMain:{handle(){}},Notification:{isSupported:()=>true},app,BrowserWindow:Window,clipboard:{},
    shell:{openExternal:async url=>opened.push(url)},
    Menu:{buildFromTemplate:template=>{for(const root of template)for(const item of root.submenu||[])if(item.id)menus.set(item.id,item);return menu},
      setApplicationMenu(){},getApplicationMenu:()=>menu},
    dialog:{showMessageBox:async (_window,value)=>{reports.push(value);return {response:0}}},
    session:{fromPartition:()=>({setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){}})},
  }
  const tokenResult={accessToken:'synthetic',refreshToken:'synthetic-refresh',subject:'synthetic',userId:'synthetic',email:'private',expiresAt:Date.now()+300000}
  const client={exchange:async()=>{calls.push('exchange');return tokenResult},refresh:async()=>{calls.push('refresh');return tokenResult},revoke:async()=>calls.push('revoke')}
  const overrides={electron,'./native-runtime.json':{schema:1,poolId:'ca-central-1_Synthetic',clientId:'syntheticclient'},
    './updates.cjs':{...require('../src/updates.cjs'), loadApprovedConfiguration:()=>{
      assert.equal(windowsStore,false,'Store package must never read an external updater feed');return false
    }},
    './native-auth-client.cjs':{createNativeAuthClient:async()=>client},
    './guards.cjs':{guardContents(){}},'./diagnostics.cjs':{createDiagnostics:()=>({attach(){}}),showDiagnostics:async()=>{}}}
  const context={require:name=>Object.hasOwn(overrides,name)?overrides[name]:name.startsWith('node:')?require(name):require('../src/'+name.slice(2)),
    __dirname:require('node:path').dirname(require.resolve('../src/main.cjs')),
    process:{versions:{electron:'44.5.0',chrome:'1.0.0'},platform:'win32',windowsStore,arch:'x64',argv:['app.exe']},setImmediate,setTimeout,clearTimeout,setInterval,clearInterval}
  vm.runInNewContext(readFileSync(require.resolve('../src/main.cjs'),'utf8'),context)
  await tick()
  assert.match(window.options.webPreferences.preload,/preload.cjs$/)
  menus.get('desktop-updates').click()
  await tick()
  assert.equal(reports.pop().message,windowsStore ? 'Microsoft Store manages updates for this app.' : 'Automatic updates are not enabled in this preview')
  assert.equal(menus.get('desktop-updates').label,windowsStore ? 'Updates through Microsoft Store…' : 'Check for updates…')
  assert.equal(menus.get('native-test-start').enabled,true)
  menus.get('native-test-start').click()
  await tick()
  assert.equal(menus.get('native-test-start').enabled,false)
  assert.equal(menus.get('native-test-cancel').enabled,true)
  assert.equal(opened.length,1)
  const authorization=new URL(opened[0])
  const {CALLBACK_URL}=require('../src/native-auth-attempt.cjs')
  const callback=CALLBACK_URL+'?code=synthetic&state='+authorization.searchParams.get('state')
  app.emit('second-instance',{},['app.exe',callback])
  await tick()
  assert.deepEqual(calls,['exchange','refresh','revoke'])
  assert.equal(reports[0].message,'Desktop sign-in test passed')
  assert.equal(JSON.stringify(reports).includes('private'),false)
  assert.equal(menus.get('native-test-start').enabled,true)
  app.emit('second-instance',{},['app.exe',callback])
  await tick()
  assert.equal(calls.length,3)
  let prevented=false
  app.emit('before-quit',{preventDefault:()=>{prevented=true}})
  await tick()
  assert.equal(prevented,true)
  assert.equal(quits,1)
})
