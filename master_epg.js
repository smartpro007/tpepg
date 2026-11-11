const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const fs = require('fs');
const zlib = require('zlib');
const xml2js = require('xml2js');

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateMasterWithSamsungAndMac() {
  console.log('Starting EPG Generation for Samsung TV Plus & MAC Portal...');

  if (!fs.existsSync('./channels.json')) {
    console.log('channels.json not found!');
    return;
  }

  const channelsList = JSON.parse(fs.readFileSync('./channels.json', 'utf-8'));
  let samsungIds = [];
  let macChannels = [];
  let extraXmlSnippet = '';

  channelsList.forEach(ch => {
    // चॅनेल टॅग तयार करणे
    extraXmlSnippet += `  <channel id="${ch.channel_id}">\n`;
    extraXmlSnippet += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) extraXmlSnippet += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    extraXmlSnippet += `  </channel>\n`;

    if (ch.source === 'samsungtvplus') {
      samsungIds.push(ch.channel_id);
    } else if (ch.source === '4k.tvstb.me') {
      macChannels.push(ch);
    }
  });

  // ==========================================
  // १. SAMSUNG TV PLUS (Extracting from .xml.gz URL)
  // ==========================================
  console.log('Fetching & Extracting Samsung TV Plus EPG...');
  try {
    const samsungResp = await axios.get('https://i.mjh.nz/SamsungTVPlus/in.xml.gz', {
      responseType: 'arraybuffer',
      timeout: 25000
    });

    const unzippedXml = zlib.gunzipSync(samsungResp.data).toString('utf-8');
    const parser = new xml2js.Parser();
    const parsedXml = await parser.parseStringPromise(unzippedXml);

    if (parsedXml?.tv?.programme) {
      parsedXml.tv.programme.forEach(prog => {
        const chId = prog.$.channel;
        if (samsungIds.includes(chId)) {
          extraXmlSnippet += `  <programme start="${prog.$.start}" stop="${prog.$.stop}" channel="${chId}">\n`;
          if (prog.title) extraXmlSnippet += `    <title lang="en">${escapeXML(prog.title[0])}</title>\n`;
          if (prog.desc) extraXmlSnippet += `    <desc lang="en">${escapeXML(prog.desc[0])}</desc>\n`;
          extraXmlSnippet += `  </programme>\n`;
        }
      });
      console.log('Samsung TV Plus EPG extracted successfully.');
    }
  } catch (err) {
    console.log('Samsung EPG Error:', err.message);
  }

  // ==========================================
  // २. MAC PORTAL (4k.tvstb.me - Stalker API Logic)
  // ==========================================
  console.log('Connecting to MAC Portal (Stalker API)...');
  const portalBase = "http://4k.tvstb.me/stalker_portal/server/load.php";
  const mac = "00:1A:79:00:81:91";
  const macHeaders = [
    "User-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stb app ver: 2 rev: 250 Safari/533.3",
    "X-User-Agent: Model: MAG250; Link: WiFi",
    "Referer: http://4k.tvstb.me/stalker_portal/c/",
    `Cookie: mac=${mac}; stb_lang=en; timezone=Asia/Kolkata`
  ];

  try {
    // Handshake
    const handshakeUrl = `${portalBase}?type=stb&action=handshake&prehash=${encodeURIComponent(mac)}&token=&JsHttpRequest=1-xml`;
    const hsResp = await axios.get(handshakeUrl, { headers: macHeaders, timeout: 15000 });
    const token = hsResp.data?.js?.token || hsResp.data?.token;

    if (token) {
      const authHeaders = [...macHeaders, `Authorization: Bearer ${token}`];

      // Get All Channels
      const channelsUrl = `${portalBase}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`;
      const chResp = await axios.get(channelsUrl, { headers: authHeaders, timeout: 15000 });
      
      const channelData = chResp.data;
      let allStalkerChannels = [];
      if (channelData?.js?.data && Array.isArray(channelData.js.data)) {
        allStalkerChannels = channelData.js.data;
      } else if (Array.isArray(channelData?.js)) {
        allStalkerChannels = channelData.js;
      }

      for (const targetCh of macChannels) {
        // नावाने किंवा आयडीने मॅच करणे
        const matched = allStalkerChannels.find(sc => 
          (sc.name && sc.name.toLowerCase() === targetCh.name.toLowerCase()) || 
          (String(sc.id) === String(targetCh.channel_id))
        );

        if (matched) {
          const apiId = matched.id;
          const epgUrl = `${portalBase}?type=itv&action=get_short_epg&tv_genre_id=0&not_ended=1&ch_id=${apiId}&JsHttpRequest=1-xml`;
          
          try {
            const epgResp = await axios.get(epgUrl, { headers: authHeaders, timeout: 10000 });
            const epgJson = epgResp.data;
            let programs = [];
            
            if (epgJson?.js?.data && Array.isArray(epgJson.js.data)) {
              programs = epgJson.js.data;
            } else if (Array.isArray(epgJson?.js)) {
              programs = epgJson.js;
            }

            programs.forEach(prog => {
              const startTs = Number(prog.start_timestamp);
              const stopTs = Number(prog.stop_timestamp);

              if (startTs > 0 && stopTs > startTs) {
                const start = dayjs.unix(startTs).utc().format('YYYYMMDDHHmmss ZZ');
                const stop = dayjs.unix(stopTs).utc().format('YYYYMMDDHHmmss ZZ');
                const title = prog.name || 'Unknown';
                const desc = prog.descr || '';

                extraXmlSnippet += `  <programme start="${start}" stop="${stop}" channel="${targetCh.channel_id}">\n`;
                extraXmlSnippet += `    <title lang="en">${escapeXML(title)}</title>\n`;
                if (desc) extraXmlSnippet += `    <desc lang="en">${escapeXML(desc)}</desc>\n`;
                extraXmlSnippet += `  </programme>\n`;
              }
            });
          } catch (err) {
            // एका चॅनेलच्या एररमुळे सगळी प्रोसेस थांबणार नाही
          }
        }
        await sleep(150);
      }
      console.log('MAC Portal EPG extracted successfully.');
    }
  } catch (err) {
    console.log('MAC Portal Error:', err.message);
  }

  // ==========================================
  // ३. MERGE INTO tataplay.xml.gz
  // ==========================================
  const targetFile = './epg/tataplay.xml';
  if (fs.existsSync(targetFile)) {
    let existingXml = fs.readFileSync(targetFile, 'utf-8');
    existingXml = existingXml.replace('</tv>', extraXmlSnippet + '</tv>');

    fs.writeFileSync(targetFile, existingXml, 'utf-8');
    fs.writeFileSync('./epg/tataplay.xml.gz', zlib.gzipSync(existingXml));
    console.log('Successfully merged Samsung & MAC EPG into tataplay.xml.gz!');
  } else {
    console.log('tataplay.xml not found for merging!');
  }
}

function escapeXML(str) {
  if (!str) return '';
  return String(str).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;'; case '>': return '&gt;';
      case '&': return '&amp;'; case '\'': return '&apos;'; case '"': return '&quot;';
    }
  });
}

generateMasterWithSamsungAndMac();
