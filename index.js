'use strict'

const axios = require('axios')
const Jimp = require('jimp')
const fs = require('fs').promises
const TelegramBot = require('node-telegram-bot-api')
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN)

const dbFileHandleProm = fs.open('./bump-db.json', 'r+')

const dbDefault = {
  seen: {},
  sent: {}
}
async function loadDb() {
  const fsh = await dbFileHandleProm
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
  const fsh = await dbFileHandleProm
  try {
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
  return async function uploadBumps([{botInfo}, db, bumps]) {
    for (let i = 0; i < numWorkers; ++i) {
      uploader(botInfo, bumps, db)
    }
  }
}

async function getBumps() {
  const bumpRequest = axios.get('http://api.shithouse.tv')
  return (await bumpRequest).data.filter(b => b.image && imageRegex.exec(b.image))

}

async function getSet(setName) {
  try {
    return await bot.getStickerSet(setName)
  } catch (e) {
    return null
  }
}

async function cleanBumps({botInfo}) {
  let setIdx = 0
  let currSet
  while (currSet = await getSet(getStickerSetName({botInfo, setIdx}))) {
    for (let s of currSet.stickers) {
      await bot.deleteStickerFromSet(s.file_id)
    }
    ++setIdx
  }
}

async function getMetadata() {
  return {
    botInfo: await bot.getMe()
  }
}

Promise.all([
  getMetadata(),
  loadDb(),
  getBumps(),
])
  .then(generateUploadBumps(PARALLEL_UPLOADERS))
  //.then(cleanBumps)
