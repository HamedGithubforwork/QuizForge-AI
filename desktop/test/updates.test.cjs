'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { approvedConfiguration, loadApprovedConfiguration, createUpdates } = require('../src/updates.cjs')
const config = {provider:'github',owner:'HamedGithubforwork',repo:'QuizForge-AI',private:false,releaseType:'release',updaterCacheDirName:'quiz-from-notes-desktop-updater',publisherName:['Synthetic Publisher']}
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(overrides={}) {
  const events=[],updater=new EventEmitter()
  Object.assign(updater,{checkForUpdates:async()=>({isUpdateAvailable:true}),downloadUpdate:async()=>events.push('download'),quitAndInstall:(silent,restart)=>events.push(['install',silent,restart])},overrides)
  const subject=createUpdates({updater,prompt:async kind=>{events.push(kind);return kind==='restart'},beforeInstall:async()=>events.push('cleanup')})
  return {updater,subject,events}
}

test('requires the pinned public release feed and a nonempty publisher; unsigned preview fails closed',()=>{
  assert.equal(approvedConfiguration(config),true)
  for(const edit of [{publisherName:[]},{publisherName:''},{publisherName:undefined},{owner:'other'},{repo:'other'},
    {private:true},{updaterCacheDirName:'../other'},{token:'secret'},{host:'other.test'},{provider:'generic'},{releaseType:'draft'}])
    assert.equal(approvedConfiguration({...config,...edit}),false)
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qfn-updates-'))
  try {
    assert.equal(loadApprovedConfiguration(dir),false)
    fs.writeFileSync(path.join(dir,'app-update.yml'),JSON.stringify(config))
    assert.equal(loadApprovedConfiguration(dir),true)
    fs.writeFileSync(path.join(dir,'app-update.yml'),'a'.repeat(16385))
    assert.equal(loadApprovedConfiguration(dir),false)
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('background check downloads but never installs without explicit restart choice',async()=>{
  const {updater,subject,events}=fixture()
  assert.equal(updater.autoInstallOnAppQuit,false)
  assert.equal(updater.autoDownload,false)
  assert.equal(updater.allowDowngrade,false)
  assert.equal(updater.allowPrerelease,false)
  assert.equal(updater.disableWebInstaller,true)
  await subject.check()
  assert.equal(subject.status().phase,'ready')
  assert.deepEqual(events,['download'])
  await subject.check(true)
  assert.deepEqual(events,['download','restart','cleanup',['install',true,true]])
})

test('declining restart leaves the verified download ready and normal quit does not install',async()=>{
  const updater=new EventEmitter(),events=[]
  Object.assign(updater,{checkForUpdates:async()=>({isUpdateAvailable:true}),downloadUpdate:async()=>{},quitAndInstall:()=>events.push('install')})
  const subject=createUpdates({updater,prompt:async()=>false,beforeInstall:async()=>events.push('cleanup')})
  await subject.check(true)
  assert.equal(subject.status().phase,'ready')
  subject.dispose()
  await subject.restart()
  assert.deepEqual(events,[])
})

test('single-flight checks and closing during check prevent a later download',async()=>{
  const wait=deferred();let checks=0
  const {subject,events}=fixture({checkForUpdates:()=>{checks++;return wait.promise}})
  const first=subject.check()
  await subject.check()
  subject.dispose()
  wait.resolve({isUpdateAvailable:true})
  await first
  assert.equal(checks,1)
  assert.deepEqual(events,[])
})

test('signature/download failures never become installable or expose raw errors',async()=>{
  const {subject,events}=fixture({downloadUpdate:async()=>{throw Error('private URL and publisher detail')}})
  await subject.check(true)
  await subject.restart()
  assert.equal(subject.status().phase,'error')
  assert.deepEqual(events,['error'])
})

test('no feed does not pretend to be up to date; no update returns the right result',async()=>{
  const messages=[]
  const off=createUpdates({updater:null,prompt:async k=>messages.push(k)})
  await off.check();await off.check(true)
  assert.deepEqual(messages,['unavailable'])
  const {subject,events}=fixture({checkForUpdates:async()=>({isUpdateAvailable:false})})
  await subject.check(true)
  assert.deepEqual(events,['current'])
})

test('signed-build metadata gate checks exact version, size and checksum before release drafting',()=>{
  const { spawnSync } = require('node:child_process')
  const { createHash } = require('node:crypto')
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qfn-update-build-'))
  try {
    const resources=path.join(root,'win-unpacked/resources');fs.mkdirSync(resources,{recursive:true})
    fs.writeFileSync(path.join(resources,'app-update.yml'),JSON.stringify(config))
    const bytes=Buffer.from('synthetic installer; signature verified by the separate Windows gate')
    fs.writeFileSync(path.join(root,'preview.exe'),bytes)
    const info={version:require('../package.json').version,files:[{url:'preview.exe',size:bytes.length,sha512:createHash('sha512').update(bytes).digest('base64')}]}
    fs.writeFileSync(path.join(root,'latest.yml'),JSON.stringify(info))
    const run=()=>spawnSync(process.execPath,[require.resolve('../scripts/verify-update-build.cjs'),root],{encoding:'utf8'})
    assert.equal(run().status,0)
    fs.appendFileSync(path.join(root,'preview.exe'),'tampered')
    assert.equal(run().status,1)
    info.files[0].url='../escape.exe';fs.writeFileSync(path.join(root,'latest.yml'),JSON.stringify(info))
    assert.equal(run().status,1)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})
