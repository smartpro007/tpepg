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

async function fetchExtraEPG() {
  console.log('Starting Samsung & MAC Portal EPG Fetcher...');

  if (!fs.existsSync('./channels.json')) {
    console.log('channels.json not found!');
    return;
  }

  const extraList = JSON.parse(fs.readFileSync('./channels.json', 'utf-8'));
  let samsungIds = [];
  let macChannels = [];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Samsung-Mac-Fetcher">\n';

  extraList.forEach(ch => {
    xml += `  <channel id="${ch.channel_id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    xml += `  </channel>\n`;

    if (ch.source === 'samsungtvplus') samsungIds.push(ch.channel_id);
    else if (ch.source === '4k.tvstb.me') macChannels.push(ch);
  });

  // ==========================================
  // १. SAMSUNG TV PLUS EPG FETCHING
  // ==========================================
  console.log('Fetching Samsung TV Plus EPG...');
  try {
    const samsungResp = await axios.get('https://i.mjh.nz/SamsungTVPlus/in.xml.gz', { responseType: 'arraybuffer', timeout: 20000 });
    const unzipped = zlib.gunzipSync(samsungResp.data).toString('utf-8');
    const parsedXml = await (new xml2js.Parser()).parseStringPromise(unzipped);

    if (parsedXml?.tv?.programme) {
      parsedXml.tv.programme.forEach(prog => {
        if (samsungIds.includes(prog.$.channel)) {
          xml += `  <programme start="${prog.$.start}" stop="${prog.$.stop}" channel="${prog.$.channel}">\n`;
          if (prog.title) xml += `    <title lang="en">${escapeXML(prog.title[0])}</title>\n`;
          if (prog.desc) xml += `    <desc lang="en">${escapeXML(prog.desc[0])}</desc>\n`;
          xml += `  </programme>\n`;
        }
      });
    }
  } catch (e) {
    console.log('Samsung EPG Error:', e.message);
  }

  // ==========================================
  // २. MAC PORTAL (4k.tvstb.me) EPG FETCHING
  // ==========================================
  console.log('Fetching MAC Portal EPG...');
  const portalBase = "http://4k.tvstb.me/stalker_portal/server/load.php";
  const mac = "00:1A:79:00:81:91";
  const macHeaders = [
    "User-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stb app ver: 2 rev: 250 Safari/533.3",
    "Referer: http://4k.tvstb.me/stalker_portal/c/",
    `Cookie: mac=${mac}; stb_lang=en; timezone=Asia/Kolkata`
  ];

  try {
    const hsResp = await axios.get(`${portalBase}?type=stb&action=handshake&prehash=${encodeURIComponent(mac)}&JsHttpRequest=1-xml`, { headers: macHeaders });
    const token = hsResp.data?.js?.token || hsResp.data?.token;
    
    if (token) {
      const authHeaders = [...macHeaders, `Authorization: Bearer ${token}`];
      const chResp = await axios.get(`${portalBase}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`, { headers: authHeaders });
      const allStalkerChannels = chResp.data?.js?.data || [];

      for (const targetCh of macChannels) {
        const matched = allStalkerChannels.find(sc => sc.name.toLowerCase() === targetCh.name.toLowerCase() || sc.id === targetCh.channel_id);
        if (matched) {
          const epgResp = await axios.get(`${portalBase}?type=itv&action=get_short_epg&tv_genre_id=0&not_ended=1&ch_id=${matched.id}&JsHttpRequest=1-xml`, { headers: authHeaders });
          const programs = epgResp.data?.js?.data || epgResp.data?.js || [];
          
          if (Array.isArray(programs)) {
            programs.forEach(prog => {
              const startTs = Number(prog.start_timestamp);
              const stopTs = Number(prog.stop_timestamp);
              if (startTs && stopTs) {
                const start = dayjs.unix(startTs).utc().format('YYYYMMDDHHmmss ZZ');
                const stop = dayjs.unix(stopTs).utc().format('YYYYMMDDHHmmss ZZ');
                xml += `  <programme start="${start}" stop="${stop}" channel="${targetCh.channel_id}">\n`;
                xml += `    <title lang="en">${escapeXML(prog.name || 'Unknown')}</title>\n`;
                if (prog.descr) xml += `    <desc lang="en">${escapeXML(prog.descr)}</desc>\n`;
                xml += `  </programme>\n`;
              }
            });
          }
        }
        await sleep(200);
      }
    }
  } catch (e) {
    console.log('MAC Portal EPG Error:', e.message);
  }

  xml += '</tv>';

  if (!fs.existsSync('./epg')) fs.mkdirSync('./epg');
  fs.writeFileSync('./epg/samsung_mac.xml', xml, 'utf-8');
  console.log('Success! Saved to ./epg/samsung_mac.xml');
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

fetchExtraEPG();
