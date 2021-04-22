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
      await saveDb(db)
      const person = msg.from.username || msg.from.first_name
      const payload = {
        submission_salt: process.env.IFF_SUBMISSION_SALT,
        url: match[1],
        person,
        title: msg.text
      }
      try {
        await axios.post('http://infoforcefeed.shithouse.tv/submit', payload)
      } catch (e) {
        console.log('failure in shipping', {
          payload,
          e
        })
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

bot.onText(
  /(?<lift>[a-zA-Z0-9\s]+): (?<sets>[0-9]+)x(?<reps>[0-9]+)@(?<weight>[0-9]+)/,
  async (msg, match) => {
    // 'msg' is the received Message from Telegram
    // 'match' is the result of executing the regexp above on the text content
    // of the message
    const chatId = msg.chat.id;
    const payload = {
      nickname: msg.from.first_name,
      sets: Number(match.groups.sets),
      weight: Number(match.groups.weight),
      reps: Number(match.groups.reps),
      lift: match.groups.lift
    };
    console.log('ayloa', payload);
    try {
      const hello = await axios.post('https://wheypi.shithouse.tv/api/lifts', 
        payload,
        {headers: {'Authorization': `${process.env.LIFT_TOKEN}`}}
        );
        console.log('res', hello.data)
      if(hello) {
        const response = `YA GONNA GET SWOLE DOING ${match.groups.lift.toUpperCase()}?\r\nSETS: ${match.groups.sets}\r\nREPS: ${match.groups.reps}\r\nWEIGHT: ${match.groups.weight}`;
        bot.sendMessage(chatId, response);
      }

    } catch(error) {
      // console.log('Lift post error',error)
      console.log('message:', error.message)
      console.log('code:', error.code);
      console.log('request:', error.request);
      console.log('isAxiosError', error.isAxiosError);

      // console.log('response', error.response);
      if(error.response){
      console.log('data', error.response.data);
      console.log('status', error.response.status);
      // console.log('headers', error.response.headers);
      bot.sendMessage(chatId, 'FUCK YOU WEAKLING')
      }
    }


  }
);

// TODO: fix "lift" regex, spit errors on failed posts, fix async bot msging
bot.onText(/my lifts/,
  async (msg, match) => {
    // 'msg' is the received Message from Telegram
    // 'match' is the result of executing the regexp above on the text content
    // of the message
    const chatId = msg.chat.id;
    const nickname = msg.from.first_name;
    try {
      const hello = await axios.get(`https://wheypi.shithouse.tv/api/lifts/${nickname}`);

      if(hello.data.data.length > 0) {
        bot.sendMessage(chatId, `HERE'S YOUR WORKOUT SCRUB:`)
        hello.data.data.forEach(lift => {
          bot.sendMessage(chatId, `${lift.lift}\r\nSETS ${lift.sets}\r\nREPS ${lift.reps}\r\nWEIGHT ${lift.weight}`);
        });
        bot.sendMessage(chatId, 'DO MORE REPS TODAY, ARE YOU FUCKING TIRED YET?')
      } else {
        bot.sendMessage(chatId, `WHAT DO YOU MEAN YOU DON'T HAVE A ROUTINE YET?`)
      }

    } catch(error) {
      // console.log('Lift post error',error)
      console.log('message:', error.message)
      console.log('code:', error.code);
      console.log('request:', error.request);
      console.log('isAxiosError', error.isAxiosError);

      // console.log('response', error.response);
      if(error.response){
      console.log('data', error.response.data);
      console.log('status', error.response.status);
      // console.log('headers', error.response.headers);
      bot.sendMessage(chatId, 'FUCK YOU WEAKLING')
      }
    }
  }
);

const pizzas = [
  {
    text: 'BASSBOOSTED',
    url: 'https://www.youtube.com/watch?v=Q6jJQWc2hBY'
  },
  {
    text: 'REGULAR',
    url: 'https://www.youtube.com/watch?v=czTksCF6X8Y'
  },
  {
    text: 'EXTENDED',
    url: 'https://soundcloud.com/dullstaples/the-spiderman-2-pizza-theme-but-its-extended-for-over-4-minutes'
  },
  {
    text: 'OTAMATONE',
    url: 'https://www.youtube.com/watch?v=fAdFL_6ii4U'
  },
  {
    text: 'BUCKBUMBLE',
    url: 'https://www.youtube.com/watch?v=x7ok5AV7ZrM'
  },
  {
    text: 'ONE HOUR',
    url: 'https://www.youtube.com/watch?v=gUqH6Weyr2M'
  },
  {
    text: 'METAL',
    url: 'https://www.youtube.com/watch?v=w8n2-l3bCn0'
  },
  {
    text: 'BASSBOOSTED',
    url: 'https://www.youtube.com/watch?v=3NZGbD236fw'
  }
]

function getPizza(pizzas) {
  return [pizzas[Math.floor(Math.random() * pizzas.length)]]
}

bot.onText(/spiderman/, function onEditableText(msg) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        getPizza(pizzas)
      ]
    }
  };
  bot.sendMessage(msg.chat.id, 'PIZZA TIME', opts);
});

// Keyboard replacement meme
bot.onText(/fmuf2/, (msg) => {
  const opts = {
    reply_to_message_id: msg.message_id,
    reply_markup: JSON.stringify({
      keyboard: [
        ['AAAAAAAAAAAAAAA'],
        ['AAAAAAAAAAAAAAAAAAAAAAAAAAA'],
        ['AAAAAAAAAAAAAAAAAAAAAAA'],
        ['AAAAAAAAA'],
        ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
      ]
    })
  };
  bot.sendMessage(msg.chat.id, 'AAAAAAAAAAAA', opts);
});

// Inline keboard example
bot.onText(/fmuf/, function onEditableText(msg) {
  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '1',
            callback_data: 'ASDF'
          },
          {
            text: '2',
            callback_data: '2'
          },
          {
            text: '3',
            callback_data: '3'
          },
          {
            text: '4',
            callback_data: '4'
          },
          {
            text: '5',
            callback_data: '5'
          },
          {
            text: 'ASDF',
            callback_data: 'ALKSDJFKLS'
          },
        ]
      ]
    }
  };
  bot.sendMessage(msg.chat.id, 'Original Text', opts);
});


// Handle callback queries
bot.on('callback_query', function onCallbackQuery(callbackQuery) {
  const action = callbackQuery.data;
  const msg = callbackQuery.message;
  const opts = {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
  };
  let text;

  switch(action) {
    case '1':
      text = '1';
      break;
    case '2':
      text = '2';
      break;
    case '3':
      text = '3';
      break;
    case '4':
      text = '4';
      break;
    case '5':
      text = '5';
      break;
  }

  bot.editMessageText(`Selected: ${text}`, opts);
});



/*
Command/Bot Ideas
  make a chat with a bot that auto-keyboards to various "AAAAAAAAAA" messages and bans everyone who doesn't use them

  useful refrence https://github.com/yagop/node-telegram-bot-api/blob/release/examples/polling.js
*/


// Promise.all([
//   getMetadata(),
//   getDbFileHandle().then(loadDb),
//   getBumps(),
// ])
//   .then(async function([{botInfo}, db, bumps]) {
//     startLinkScraper(botInfo, db)
//     await generateUploadBumps(PARALLEL_UPLOADERS)(botInfo, db, bumps)
//   })
//   //.then(cleanBumps)
// console.log(process.env)
