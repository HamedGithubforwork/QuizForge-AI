'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createNativeReminders,reminderSlot}=require('../src/native-reminders.cjs')
const prefs={enabled:true,timezone:'America/Toronto',reminder_time:'19:00:00',minimum_due_cards:2}
test('saved time zone, 15-minute window, midnight and repeated DST hour use one local date',()=>{
  assert.equal(reminderSlot(prefs,new Date('2026-09-30T22:59:00Z')),null)
  assert.equal(reminderSlot(prefs,new Date('2026-09-30T23:00:00Z')),'2026-09-30')
  assert.equal(reminderSlot(prefs,new Date('2026-09-30T23:14:59Z')),'2026-09-30')
  assert.equal(reminderSlot(prefs,new Date('2026-09-30T23:15:00Z')),null)
  assert.equal(reminderSlot({...prefs,reminder_time:'00:00'},new Date('2026-10-01T04:00:00Z')),'2026-10-01')
  const dst={...prefs,reminder_time:'01:30'}
  assert.equal(reminderSlot(dst,new Date('2026-11-01T05:30:00Z')),'2026-11-01')
  assert.equal(reminderSlot(dst,new Date('2026-11-01T06:30:00Z')),'2026-11-01')
  assert.equal(reminderSlot({...prefs,timezone:'Invalid'},new Date()),null)
  assert.equal(reminderSlot({...prefs,enabled:false},new Date('2026-09-30T23:00:00Z')),null)
})
function fixture(){
  let g=1,due=2,now=new Date('2026-09-30T23:00:00Z'),fail=false
  const shown=[];let closed=0,calls=0
  const account={generation:()=>g,current:()=>({userId:'a',enrolled:true}),request:async({path})=>{
    calls++;if(fail)throw Error('offline');return {status:200,body:JSON.stringify(path.endsWith('preferences')?prefs:[{due_count:due}])}
  }}
  const reminders=createNativeReminders({account,supported:()=>true,now:()=>now,show:options=>{shown.push(options);return {close:()=>closed++}}})
  return {account,reminders,shown,get closed(){return closed},get calls(){return calls},switch:()=>g++,due:v=>due=v,time:v=>now=new Date(v),fail:v=>fail=v}
}
test('requires device opt-in, fresh due threshold, once per account/day, no account details in toast',async()=>{
  const f=fixture();await f.reminders.tick();assert.equal(f.calls,0)
  f.reminders.enable();f.due(1);await f.reminders.tick();assert.equal(f.shown.length,0)
  f.due(2);await f.reminders.tick();await f.reminders.tick();assert.equal(f.shown.length,1)
  assert.deepEqual(f.shown[0],{title:'Quiz From Notes',body:'Your study cards are ready to review.'})
  f.reminders.disable();assert.equal(f.closed,1)
  f.reminders.enable();await f.reminders.tick();assert.equal(f.shown.length,1)
  f.time('2026-10-01T23:00:00Z');await f.reminders.tick();assert.equal(f.shown.length,2)
})
test('offline retry and account replacement never deliver cached or stale reminder data',async()=>{
  const f=fixture();f.reminders.enable();f.fail(true);await f.reminders.tick();assert.equal(f.shown.length,0)
  f.fail(false);await f.reminders.tick();assert.equal(f.shown.length,1)
  f.switch();assert.equal(f.reminders.status().enabled,false);await f.reminders.tick();assert.equal(f.shown.length,1)
  f.reminders.clear();assert.equal(f.closed,1)
  f.reminders.enable();f.time('2026-10-01T23:00:00Z')
  let resolve;f.account.request=()=>new Promise(r=>{resolve=r})
  const pending=f.reminders.tick();f.reminders.dispose();resolve({status:200,body:JSON.stringify(prefs)})
  await pending;assert.equal(f.shown.length,1)
})
