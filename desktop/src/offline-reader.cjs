'use strict'
const { randomUUID } = require('node:crypto')
const { windowOptions } = require('./policy.cjs')
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function renderOffline(snapshot, actions = new Map()) {
  const decks = snapshot.decks.map(deck => `<details class="deck"><summary>${escape(deck.name)} <small>${deck.cards.length} cards</small></summary>
    <p>${escape(deck.description)}</p>${deck.cards.map((card, i) => `<article><span class="number">CARD ${i + 1}${card.suspended ? ' · SUSPENDED' : ''}</span>
    <h2>${escape(card.question)}</h2>${card.choices ? `<ol>${card.choices.map(c => `<li>${escape(c)}</li>`).join('')}</ol>` : ''}
    <details class="answer"><summary>Reveal answer</summary><p>${escape(card.answer.correct_answer)}</p><p>${escape(card.explanation)}</p>${snapshot.reviews?.some(r => r.card_id === card.id)
      ? `<p>${snapshot.reviews.find(r => r.card_id === card.id).synced ? 'Synced. Save a fresh library online before reviewing again.' : 'Rating saved on this computer — pending sync.'}</p>`
      : actions.get(card.id) || '<p>Practice only — this card is not available for a saved review.</p>'}</details></article>`).join('') || '<p>No cards in this deck.</p>'}</details>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
  <title>Offline study — Quiz From Notes</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f7fc;color:#192c44;font:17px/1.6 system-ui,sans-serif}main{max-width:940px;margin:auto;padding:40px 24px}
  .eyebrow,.number{font-size:12px;letter-spacing:.1em;font-weight:700;color:#46617f}h1{font-size:36px;line-height:1.2;margin:8px 0 14px}h2{font-size:20px;white-space:pre-wrap}
  .notice{background:#e8effb;border-left:4px solid #376dc5;padding:16px 20px;border-radius:6px;margin:24px 0}.deck{background:white;border:1px solid #d8e1ed;border-radius:12px;margin:18px 0;padding:20px}
  .ratings{display:flex;gap:12px;flex-wrap:wrap}.ratings a{display:inline-block;padding:10px 15px;border:1px solid #376dc5;border-radius:8px;color:#244f93;text-decoration:none}summary{cursor:pointer;font-weight:650}summary:focus-visible{outline:3px solid #376dc5;outline-offset:5px}small{color:#55708d;font-weight:400;margin-left:12px}
  article{border-top:1px solid #e3e9f2;padding:24px 0}p,li{white-space:pre-wrap;overflow-wrap:anywhere}.answer{background:#f0f5fc;border-radius:8px;padding:12px 18px}.answer p:last-child:empty{display:none}
  footer{color:#55708d;font-size:14px;margin-top:32px}</style></head><body><main><div class="eyebrow">QUIZ FROM NOTES · OFFLINE</div>
  <h1>Your saved study library</h1><p>Open a deck, think through each question, then reveal the answer.</p>
  <div class="notice"><strong>Offline study</strong> — ratings are saved encrypted on this computer. Use Sync offline reviews after signing in online. Each saved card allows one rating until you sync and save a fresh library; changed online cards may need reconciliation. AI generation requires the online app.</div>
  <p><small>Copy saved: ${escape(snapshot.savedAt)}</small></p>${decks || '<p>No saved decks. Connect and save your study library first.</p>'}
  <footer>This library stays on this Windows profile. Close this window when finished. Remove the local copy from the app menu to disable offline access.</footer></main></body></html>`
}

function createOfflineReader({ BrowserWindow, session }) {
  let current
  return {
    close() { if (current && !current.isDestroyed()) current.destroy(); current = null },
    async open(snapshot, { record, reportError = async () => {} } = {}) {
      this.close()
      const partition = 'qfn-offline-' + randomUUID()
      const isolated = session.fromPartition(partition)
      isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.on('will-download', event => event.preventDefault())
      isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] }, (_details, callback) => callback({ cancel: true }))
      const actions = new Map(), commands = new Map()
      if (record) for (const deck of snapshot.decks) for (const card of deck.cards) {
        if (card.suspended || Date.parse(card.due_at) > Date.now() || snapshot.reviews?.some(r => r.card_id === card.id)) continue
        actions.set(card.id, '<nav class="ratings" aria-label="Save review rating">' + ['Again', 'Hard', 'Good', 'Easy'].map((label, i) => {
          const url = 'https://offline.quizfromnotes.invalid/' + randomUUID()
          commands.set(url, { cardId: card.id, rating: i + 1 })
          return `<a href="${url}">${label}</a>`
        }).join('') + '</nav>')
      }
      const options = windowOptions()
      options.webPreferences.partition = partition
      options.webPreferences.javascript = false
      options.title = 'Offline study — Quiz From Notes'
      const window = new BrowserWindow(options)
      current = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) window.webContents.on(name, event => event.preventDefault())
      let recording = false
      window.webContents.on('will-frame-navigate', event => {
        event.preventDefault()
        const command = event.isMainFrame === true ? commands.get(event.url) : undefined
        if (!command || recording || window.isDestroyed() || current !== window) return
        recording = true
        const guard = () => { if (window.isDestroyed() || current !== window) throw Error('Offline reader closed.') }
        void (async () => {
          try {
            const updated = await record(command.cardId, command.rating, guard)
            guard()
            await this.open(updated, { record, reportError })
          } catch { if (!window.isDestroyed() && current === window) await reportError(window) }
          finally { recording = false }
        })().catch(() => {})
      })
      window.on('closed', () => { if (current === window) current = null })
      try {
        await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(renderOffline(snapshot, actions)))
        if (!window.isDestroyed() && current === window) window.show()
      } catch { if (!window.isDestroyed()) window.destroy(); throw new Error('Could not open offline study.') }
    },
  }
}
module.exports = { renderOffline, createOfflineReader }
