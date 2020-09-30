'use strict'

const axios = require('axios')
const Jimp = require('jimp')
const fs = require('fs').promises
const TelegramBot = require('node-telegram-bot-api')
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true})

let fsh
async function getDbFileHandle() {
  try {
    fsh = await fs.open('./bump-db.json', 'r+')
  } catch (e) {
    console.log('error while opening file handle', e)
    fsh = await fs.open('./bump-db.json', 'w+')
  }
  return fsh
}

const dbDefault = {
  seen: {},
  sent: {}
}
async function loadDb() {
  let data = ''
  try {
    data = (await fsh.readFile()).toString()
  } catch (e) {
    console.log('failed reading db', e)
    return dbDefault
  }
  if (data) {
    return JSON.parse(data)
  } else {
    console.log('zcv')
    return dbDefault
  }
}

async function saveDb(db) {
  try {
    console.log('writing db')
    await fsh.write(JSON.stringify(db), 0)
  } catch (e) {
    console.log('failed to write db', e)
  }
}

// number of stickers per set
const SET_SIZE = 100

// uploading is dominated by network requests, so we can push this up to
// saturate the cpu with image processing
const PARALLEL_UPLOADERS = 2


const imageRegex = /jpg-large$|png-large$|\.png$|\.jpg$|\.jpeg$/i

function sleep(n) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, n)
  })
}

function getEmoji() {
  return '🍆'
}

function getStickerSetName({botInfo, setIdx}) {
  return `shithouse_scoop_${setIdx}_by_${botInfo.username}`
}

async function uploader(botInfo, bumps, db) {
  const {seen, sent} = db
  while(bumps.length) {
    const bump = bumps.pop()
    const i = bumps.length
    if (seen[bump.name]) {
      continue
    }

    // compute sticker set name
    const setIdx = (i / SET_SIZE) | 0
    const setName = getStickerSetName({botInfo, setIdx})

    // compute image buffer to send
    let im
    try {
      im = await Jimp.read(`http://${bump.name}.shithouse.tv/${bump.image}`)
    } catch (e) {
      console.log('error fetching bump', e)
      seen[bump.name] = true
      await saveDb(db)
      continue
    }
    im.scaleToFit(512, 512)
    const toSend = await im.getBufferAsync('image/png')
    console.log('processing', i, setIdx, bump)

    try {
      await bot.createNewStickerSet(
        process.env.TELEGRAM_USER_ID,
        setName,
        `poop scoop ${setIdx}`,
        toSend,
        getEmoji()
      )
    } catch (e) {
      if (e.response.body.description !== 'Bad Request: sticker set name is already occupied') {
        console.log('error making set:', e)
      } else {
        console.log('ok')
      }
    }

    seen[bump.name] = true
    try {
      await bot.addStickerToSet(
        process.env.TELEGRAM_USER_ID,
        setName,
        toSend,
        getEmoji()
      )
      await saveDb(db)
    } catch (e) {
      console.log(e)
      await saveDb(db)
      continue
    }
    if (!sent[setIdx]) {
      const stickerSet = await bot.getStickerSet(setName)
      await bot.sendSticker(
        process.env.TELEGRAM_USER_ID,
        stickerSet.stickers[0].file_id
      )
      sent[setIdx] = true
      await saveDb(db)
    }
    await sleep(100)
  }
}

function generateUploadBumps(numWorkers) {
  return async function uploadBumps(botInfo, db, bumps) {
    for (let i = 0; i < numWorkers; ++i) {
      uploader(botInfo, bumps, db)
    }
  }
}

// link scraper
const httpPattern = /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi

async function startLinkScraper(botInfo, db) {
  if (db.lastMessageIdSeen == null) {
    db.lastMessageIdSeen = 0
    await saveDb(db)
  }

  bot.onText(httpPattern, async (msg, match) => {
    if (msg.message_id > db.lastMessageIdSeen) {
      db.lastMessageIdSeen = msg.message_id
      console.log('sending', msg)
      await saveDb(db)
      const person = msg.from.username || msg.from.first_name
      const payload = {
        submission_salt: process.env.IFF_SUBMISSION_SALT,
        url: match[1],
        person,
        title: msg.text
      }
      console.log('shipping', payload)
      try {
        await axios.post('http://infoforcefeed.shithouse.tv/submit', payload)
      } catch (e) {
        console.log('failure in shipping', e)
      }
    }
  })
}

async function getBumps() {
  const bumpRequest = axios.get('http://api.shithouse.tv')
  return (await bumpRequest).data.filter(b => b.image && imageRegex.exec(b.image)).reverse()

}

async function getSet(setName) {
  try {
    return await bot.getStickerSet(setName)
  } catch (e) {
    return null
  }
}

async function cleanBumps([{botInfo}]) {
  let setIdx = 0
  let currSet
  while (currSet = await getSet(getStickerSetName({botInfo, setIdx}))) {
    for (let s of currSet.stickers) {
      await bot.deleteStickerFromSet(s.file_id)
    }
    ++setIdx
  }
  await fs.unlink('./bump-db.json')
}

async function getMetadata() {
  return {
    botInfo: await bot.getMe()
  }
}

Promise.all([
  getMetadata(),
  getDbFileHandle().then(loadDb),
  getBumps(),
])
  .then(async function([{botInfo}, db, bumps]) {
    startLinkScraper(botInfo, db)
    await generateUploadBumps(PARALLEL_UPLOADERS)(botInfo, db, bumps)
  })
  //.then(cleanBumps)
console.log(process.env)
