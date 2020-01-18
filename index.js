'use strict'

const axios = require('axios')
const Jimp = require('jimp')
const FormData = require('form-data')
const TelegramBot = require('node-telegram-bot-api')
const TELEGRAM_API_PREFIX = 'https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN

const imageRegex = /jpg-large$|png-large$|\.png$|\.jpg$|\.jpeg$/i
let botInfo

function sleep(n) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, n)
  })
}

async function getBumps() {
  const bumpRequest = axios.get('http://api.shithouse.tv')
  botInfo = (await axios.get(`${TELEGRAM_API_PREFIX}/getMe`)).data.result
  const bumps = (await bumpRequest).data.filter(b => b.image && imageRegex.exec(b.image))

  for (let i = 0; i < bumps.length; ++i) {
    const bump = bumps[i]
    const packIdx = (i / 200) | 0
    try {
    const packReq = await axios.post(TELEGRAM_API_PREFIX + '/createNewStickerSet', {
      user_id: botInfo.id,
      name: `shithouse_scoop_${packIdx}_by_${botInfo.username}`,
      title: `poop scoop ${packIdx}`,
      emojis: 'eggplant',
      png_sticker: Buffer.from('')
    })
    console.log(packReq)
    } catch (e) {
      console.log(e)
    }
    const im = await Jimp.read(`http://${bump.name}.shithouse.tv/${bump.image}`)
    const bitmap = im.bitmap
    console.log('before', bitmap, bitmap.data.length/1024)
    if (bitmap.height > bitmap.width) {
      if (bitmap.height != 512) {
        im.resize(Jimp.AUTO, 512)
      }
    } else {
      if (bitmap.width != 512) {
        im.resize(512, Jimp.AUTO)
      }
    }
    console.log('after', im.bitmap, bitmap.data.length/1024)
    if (bitmap.data.length/1024 > 512) {
      //console.log(bitmap.data.length / 1024)
    }
    await sleep(100)
  }
}

getBumps()
