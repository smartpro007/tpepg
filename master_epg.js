const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const fs = require('fs');
const zlib = require('zlib');
const xml2js = require('xml2js');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runMasterGenerator() {
  console.log('Starting Master Single-URL EPG Generation (TataPlay + JioTV + Samsung + MAC)...');
  
  let allChannelsDict = {}; 
  let reportDataDict = {};  
  let tataCount = 0, jioCount = 0, extraCount = 0;

  const today = dayjs().tz('Asia/Kolkata');
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'), 
    today.format('DD-MM-YYYY'),                   
    today.add(1, 'day').format('DD-MM-YYYY')       
  ];

  // ==========================================
  // १. TATA PLAY EPG FETCHING
  // ==========================================
  console.log('\n=== STEP 1: Fetching TataPlay EPG ===');
  for (const dateStr of datesToFetch) {
    let currentOffset = 0;
    const batchLimit = 20;
    let totalChannels = 836;

    while (currentOffset < totalChannels) {
      let responseData = null;
      let attempts = 5;

      while (attempts > 0) {
        try {
          const url = `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=${dateStr}&languageFilters=&genreFilters=&limit=${batchLimit}&offset=${currentOffset}`;
          const resp = await axios.get(url, { headers: getTataHeaders(), timeout: 20000 });
          responseData = resp.data?.data;
          break;
        } catch (err) {
          attempts--;
          if (err.response?.status === 429) {
            await sleep(20000);
          } else {
            await sleep(5000);
          }
        }
      }

      if (!responseData || !Array.isArray(responseData.channelList) || responseData.channelList.length === 0) {
        currentOffset += batchLimit;
        continue;
      }

      totalChannels = responseData.total || totalChannels;
      responseData.channelList.forEach(ch => {
        if (ch.title && ch.title !== '.') {
          const site_id = `tp_${String(ch.id)}`;
          if (!allChannelsDict[site_id]) {
            allChannelsDict[site_id] = { id: site_id, name: ch.title, logo: ch.transparentImageUrl || ch.thumbnailImage || '', epgItems: [] };
            reportDataDict[site_id] = { id: site_id, name: ch.title, provider: 'TataPlay' };
            tataCount++;
          }
          if (ch.epg && ch.epg.length > 0) {
            ch.epg.forEach(item => {
              allChannelsDict[site_id].epgItems.push({ type: 'tataplay', data: item });
            });
          }
        }
      });

      currentOffset += batchLimit;
      await sleep(2000);
    }
  }

  // ==========================================
  // २. JIOTV EPG FETCHING
  // ==========================================
  console.log('\n=== STEP 2: Fetching JioTV EPG ===');
  if (fs.existsSync('./jiotv.json')) {
    const jioParsed = JSON.parse(fs.readFileSync('./jiotv.json', 'utf-8'));
    const jioChannels = jioParsed.channels || [];
    const offsets = [-1, 0, 1];
    const chunk = 20;

    for (let i = 0; i < jioChannels.length; i += chunk) {
      const batch = jioChannels.slice(i, i + chunk);
      await Promise.all(batch.map(async (jioCh) => {
        const jioId = String(jioCh.channel_id || jioCh.id);
        const jioName = jioCh.channel_name || jioCh.name;

        if (!allChannelsDict[jioId]) {
          allChannelsDict[jioId] = { id: jioId, name: jioName, logo: jioCh.logo || '', epgItems: [] };
          reportDataDict[jioId] = { id: jioId, name: jioName, provider: 'JioTV' };
          jioCount++;
        }

        for (const off of offsets) {
          try {
            const resp = await axios.get(`https://iptvmax.site/api/epg/epg.php?id=${jioId}&offset=${off}`, { timeout: 10000 });
            const programs = Array.isArray(resp.data) ? resp.data : (resp.data.epg || []);
            programs.forEach(prog => {
              allChannelsDict[jioId].epgItems.push({ type: 'jiotv', data: prog });
            });
          } catch (e) {}
        }
      }));
      await sleep(300);
    }
  }

  // ==========================================
  // ३. SAMSUNG & MAC PORTAL (channels.json)
  // ==========================================
  console.log('\n=== STEP 3: Fetching Samsung & MAC Portal EPG ===');
  if (fs.existsSync('./channels.json')) {
    const extraList = JSON.parse(fs.readFileSync('./channels.json', 'utf-8'));
    let samsungIds = [];
    let macChannels = [];

    extraList.forEach(ch => {
      if (!allChannelsDict[ch.channel_id]) {
        allChannelsDict[ch.channel_id] = { id: ch.channel_id, name: ch.name, logo: ch.logo || '', epgItems: [] };
        reportDataDict[ch.channel_id] = { id: ch.channel_id, name: ch.name, provider: ch.source };
        extraCount++;
      }
      if (ch.source === 'samsungtvplus') samsungIds.push(ch.channel_id);
      else if (ch.source === '4k.tvstb.me') macChannels.push(ch);
    });

    // Samsung TV Plus
    try {
      const samsungResp = await axios.get('https://i.mjh.nz/SamsungTVPlus/in.xml.gz', { responseType: 'arraybuffer', timeout: 20000 });
      const unzipped = zlib.gunzipSync(samsungResp.data).toString('utf-8');
      const parsedXml = await (new xml2js.Parser()).parseStringPromise(unzipped);

      if (parsedXml?.tv?.programme) {
        parsedXml.tv.programme.forEach(prog => {
          if (samsungIds.includes(prog.$.channel)) {
            allChannelsDict[prog.$.channel].epgItems.push({ type: 'samsung', data: prog });
          }
        });
      }
    } catch (e) {}

    // MAC Portal (4k.tvstb.me)
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
                allChannelsDict[targetCh.channel_id].epgItems.push({ type: 'mac', data: prog });
              });
            }
          }
          await sleep(200);
        }
      }
    } catch (e) {}
  }

  // ==========================================
  // ४. MASTER XML BUILDING & SAVING
  // ==========================================
  console.log('\n=== STEP 4: Assembling Master XML &tataplay.xml.gz ===');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Master-Combined-EPG">\n';

  const now = dayjs();
  const maxPastTime = now.subtract(8, 'day'); 
  const maxFutureTime = now.add(2, 'day');    

  Object.values(allChannelsDict).forEach(ch => {
    xml += `  <channel id="${ch.id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    xml += `  </channel>\n`;
  });

  Object.values(allChannelsDict).forEach(ch => {
    ch.epgItems.forEach(item => {
      let startTime, endTime, title = '', desc = '', icon = '';

      if (item.type === 'tataplay') {
        startTime = dayjs(Number(item.data.startTime));
        endTime = dayjs(Number(item.data.endTime));
        title = item.data.title || '';
        desc = item.data.desc || '';
        icon = item.data.boxCoverImage || '';
      } else if (item.type === 'jiotv') {
        startTime = dayjs(Number(item.data.startEpoch));
        endTime = dayjs(Number(item.data.endEpoch));
        title = item.data.showname || '';
        desc = item.data.description || '';
        icon = item.data.assets?.['16:9']?.originalProgram || '';
      } else if (item.type === 'samsung') {
        startTime = dayjs(item.data.$.start, 'YYYYMMDDHHmmss ZZ');
        endTime = dayjs(item.data.$.stop, 'YYYYMMDDHHmmss ZZ');
        title = item.data.title?.[0] || '';
        desc = item.data.desc?.[0] || '';
      } else if (item.type === 'mac') {
        startTime = dayjs.unix(Number(item.data.start_timestamp));
        endTime = dayjs.unix(Number(item.data.stop_timestamp));
        title = item.data.name || '';
        desc = item.data.descr || '';
      }

      if (startTime && startTime.isValid() && endTime && endTime.isValid()) {
        if (endTime.isAfter(maxPastTime) && startTime.isBefore(maxFutureTime)) {
          xml += `  <programme start="${startTime.format('YYYYMMDDHHmmss ZZ')}" stop="${endTime.format('YYYYMMDDHHmmss ZZ')}" channel="${ch.id}">\n`;
          xml += `    <title lang="en">${escapeXML(title)}</title>\n`;
          if (desc) xml += `    <desc lang="en">${escapeXML(desc)}</desc>\n`;
          if (icon) xml += `    <icon src="${escapeXML(icon)}" />\n`;
          xml += `  </programme>\n`;
        }
      }
    });
  });

  xml += '</tv>';

  if (!fs.existsSync('./epg')) fs.mkdirSync('./epg');

  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  fs.writeFileSync('./epg/tataplay.xml.gz', zlib.gzipSync(xml));
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(Object.values(reportDataDict), null, 2), 'utf-8');

  console.log(`\nSUCCESS! Master EPG Generated.`);
  console.log(`- TataPlay: ${tataCount} | JioTV: ${jioCount} | Extra/Samsung/MAC: ${extraCount}`);
  console.log(`Saved to: ./epg/tataplay.xml.gz`);
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

function getTataHeaders() {
  return {
    'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://watch.tataplay.com', 'Referer': 'https://watch.tataplay.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'content-type': 'application/json', 'locale': 'ENG', 'me': 'web'
  };
}

runMasterGenerator();
