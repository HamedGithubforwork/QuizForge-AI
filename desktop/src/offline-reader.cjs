'use strict'
const { randomUUID } = require('node:crypto')
const { windowOptions } = require('./policy.cjs')
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function renderOffline(snapshot) {
  const decks = snapshot.decks.map(deck => `<details class="deck"><summary>${escape(deck.name)} <small>${deck.cards.length} cards</small></summary>
    <p>${escape(deck.description)}</p>${deck.cards.map((card, i) => `<article><span class="number">CARD ${i + 1}${card.suspended ? ' · SUSPENDED' : ''}</span>
    <h2>${escape(card.question)}</h2>${card.choices ? `<ol>${card.choices.map(c => `<li>${escape(c)}</li>`).join('')}</ol>` : ''}
    <details class="answer"><summary>Reveal answer</summary><p>${escape(card.answer.correct_answer)}</p><p>${escape(card.explanation)}</p></details></article>`).join('') || '<p>No cards in this deck.</p>'}</details>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
  <title>Offline study — Quiz From Notes</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f7fc;color:#192c44;font:17px/1.6 system-ui,sans-serif}main{max-width:940px;margin:auto;padding:40px 24px}
  .eyebrow,.number{font-size:12px;letter-spacing:.1em;font-weight:700;color:#46617f}h1{font-size:36px;line-height:1.2;margin:8px 0 14px}h2{font-size:20px;white-space:pre-wrap}
  .notice{background:#e8effb;border-left:4px solid #376dc5;padding:16px 20px;border-radius:6px;margin:24px 0}.deck{background:white;border:1px solid #d8e1ed;border-radius:12px;margin:18px 0;padding:20px}
  summary{cursor:pointer;font-weight:650}summary:focus-visible{outline:3px solid #376dc5;outline-offset:5px}small{color:#55708d;font-weight:400;margin-left:12px}
  article{border-top:1px solid #e3e9f2;padding:24px 0}p,li{white-space:pre-wrap;overflow-wrap:anywhere}.answer{background:#f0f5fc;border-radius:8px;padding:12px 18px}.answer p:last-child:empty{display:none}
  footer{color:#55708d;font-size:14px;margin-top:32px}</style></head><body><main><div class="eyebrow">QUIZ FROM NOTES · OFFLINE</div>
  <h1>Your saved study library</h1><p>Open a deck, think through each question, then reveal the answer.</p>
  <div class="notice"><strong>Practice only</strong> — progress is not saved or synchronized yet. This copy may be older than your online decks. AI generation and account changes require the online app.</div>
  <p><small>Copy saved: ${escape(snapshot.savedAt)}</small></p>${decks || '<p>No saved decks. Connect and save your study library first.</p>'}
  <footer>This library stays on this Windows profile. Close this window when finished. Remove the local copy from the app menu to disable offline access.</footer></main></body></html>`
}

function createOfflineReader({ BrowserWindow, session }) {
  let current
  return {
    close() { if (current && !current.isDestroyed()) current.destroy(); current = null },
    async open(snapshot) {
      this.close()
      const partition = 'qfn-offline-' + randomUUID()
      const isolated = session.fromPartition(partition)
      isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.on('will-download', event => event.preventDefault())
      isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] }, (_details, callback) => callback({ cancel: true }))
      const options = windowOptions()
      options.webPreferences.partition = partition
      options.webPreferences.javascript = false
      options.title = 'Offline study — Quiz From Notes'
      const window = new BrowserWindow(options)
      current = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) window.webContents.on(name, event => event.preventDefault())
      window.on('closed', () => { if (current === window) current = null })
      try {
        await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(renderOffline(snapshot)))
        if (!window.isDestroyed() && current === window) window.show()
      } catch { if (!window.isDestroyed()) window.destroy(); throw new Error('Could not open offline study.') }
    },
  }
}
module.exports = { renderOffline, createOfflineReader }
