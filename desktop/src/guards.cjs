'use strict'
const { allowedNavigation } = require('./policy.cjs')

function guardContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', event => event.preventDefault())
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    contents.on(name, event => {
      if (!allowedNavigation(event.url)) event.preventDefault()
    })
  }
}

module.exports = { guardContents }
