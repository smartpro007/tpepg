const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const fs = require('fs');
const zlib = require('zlib');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateCompleteCombinedEPG() {
  console.log('Starting Complete Combined TataPlay & JioTV EPG Generation...');
  
  let allChannelsDict = {}; 
  let reportDataDict = {};  

  const today = dayjs().tz('Asia/Kolkata');
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'), // Yesterday (-1)
    today.format('DD-MM-YYYY'),                   // Today (0)
    today.add(1, 'day').format('DD-MM-YYYY')       // Tomorrow (+1)
  ];

  console.log(`Target Dates: ${datesToFetch.join(', ')}`);

  // ==========================================
  // १. TATA PLAY EPG FETCHING (Fixed Offset: 0, 20, 40, 60...)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing TataPlay EPG (3-Day Window)`);
  console.log(`==================================================`);

  for (const dateStr of datesToFetch) {
    console.log(`\n--- TataPlay Date: ${dateStr} ---`);
    let offset = 0;
    const limit = 20;
    let total = 836;
    let requestCount = 0;

    while (offset < total) {
      let responseData = null;
      let retries = 3;

      while (retries > 0) {
        try {
          const resp = await axios.get(
            `https://tm.tapi.videoready.tv/portal-search/pub/api/v1/channels/schedule?date=${dateStr}&languageFilters=&genreFilters=&limit=${limit}&offset=${offset}`,
            { headers: setHeaders(), timeout: 15000 }
          );
          responseData = resp.data?.data;
          break;
        } catch (err) {
          retries--;
          console.error(`--> TataPlay Error at offset ${offset} (Date: ${dateStr}). Retries left: ${retries}`);
          await sleep(10000);
        }
      }

      if (!responseData || !responseData.channelList || responseData.channelList.length === 0) {
        offset += limit; // इथे offset बरोबर 20 ने पुढे जाईल
        continue;
      }

      total = responseData.total || total;
      const channelList = responseData.channelList;

      channelList.forEach(channel => {
        if (channel.title && channel.title !== '.') {
          const site_id = `tp_${String(channel.id)}`;
          const name = channel.title;
          const logo = channel.transparentImageUrl || channel.thumbnailImage || '';
          const items = channel.epg || [];

          if (!allChannelsDict[site_id]) {
            allChannelsDict[site_id] = { id: site_id, name: name, logo: logo, epgItems: [] };
            reportDataDict[site_id] = { id: site_id, name: name, epg_generated: false };
          }

          if (items.length > 0) {
            reportDataDict[site_id].epg_generated = true;
            items.forEach(item => {
              allChannelsDict[site_id].epgItems.push({
                type: 'tataplay',
                data: item
              });
            });
          }
        }
      });

      offset += limit; // अचूक 20 ने वाढवणे
      requestCount++;

      if (requestCount % 5 === 0) {
        await sleep(5000); 
      } else {
        await sleep(1000);
      }
    }
  }

  // ==========================================
  // २. JIOTV EPG FETCHING (20-Channel Batching, Offset -1, 0, 1)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing JioTV EPG (Batches of 20 Channels)`);
  console.log(`==================================================`);

  if (fs.existsSync('./jiotv.json')) {
    const jioFileContent = fs.readFileSync('./jiotv.json', 'utf-8');
    const jioParsed = JSON.parse(jioFileContent);
    const jioChannels = jioParsed.channels || [];

    console.log(`Found ${jioChannels.length} JioTV channels to process.`);
    const jioOffsets = [-1, 0, 1]; 
    const batchSize = 20;

    for (let i = 0; i < jioChannels.length; i += batchSize) {
      const batch = jioChannels.slice(i, i + batchSize);
      console.log(`Processing JioTV Batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(jioChannels.length / batchSize)}...`);

      await Promise.all(batch.map(async (jioCh) => {
        const jioId = String(jioCh.channel_id || jioCh.id);
        const jioName = jioCh.channel_name || jioCh.name;

        if (!allChannelsDict[jioId]) {
          allChannelsDict[jioId] = { id: jioId, name: jioName, logo: jioCh.logo || '', epgItems: [] };
          reportDataDict[jioId] = { id: jioId, name: jioName, epg_generated: false };
        }

        for (const off of jioOffsets) {
          try {
            const jioResp = await axios.get(`https://iptvmax.site/api/epg/epg.php?id=${jioId}&offset=${off}`, { timeout: 10000 });
            const jioEpgData = jioResp.data;
            const programs = Array.isArray(jioEpgData) ? jioEpgData : (jioEpgData.epg || []);

            if (programs.length > 0) {
              reportDataDict[jioId].epg_generated = true;
              programs.forEach(prog => {
                allChannelsDict[jioId].epgItems.push({
                  type: 'jiotv',
                  data: prog
                });
              });
            }
          } catch (err) {
            // एरर इग्नोर करून पुढे जाणे
          }
        }
      }));

      await sleep(300);
    }
  } else {
    console.log('--> jiotv.json file not found! Skipping JioTV EPG.');
  }

  console.log('\nAll Data Fetched! Filtering Retention & Assembling XML...');

  // ==========================================
  // ३. XML स्ट्रक्चर व टाईम रिटेन्शन (Past 8 Days to Future 1 Day)
  // ==========================================
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combined-TataPlay-JioTV-Generator">\n';

  const now = dayjs();
  const maxPastTime = now.subtract(8, 'day'); 
  const maxFutureTime = now.add(2, 'day');    

  // A) चॅनेल्स टॅग
  Object.values(allChannelsDict).forEach(ch => {
    xml += `  <channel id="${ch.id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // B) प्रोग्राम्स टॅग
  Object.values(allChannelsDict).forEach(ch => {
    ch.epgItems.forEach(item => {
      let startTime, endTime, title, desc, icon;

      if (item.type === 'tataplay') {
        const epgItem = item.data;
        startTime = dayjs(Number(epgItem.startTime));
        endTime = dayjs(Number(epgItem.endTime));
        title = epgItem.title || '';
        desc = epgItem.desc || '';
        icon = epgItem.boxCoverImage || '';
      } else if (item.type === 'jiotv') {
        const prog = item.data;
        startTime = dayjs(Number(prog.startEpoch));
        endTime = dayjs(Number(prog.endEpoch));
        title = prog.showname || '';
        desc = prog.description || '';
        icon = prog.assets?.['16:9']?.originalProgram || '';
      }

      if (startTime && startTime.isValid() && endTime && endTime.isValid()) {
        if (endTime.isAfter(maxPastTime) && startTime.isBefore(maxFutureTime)) {
          const start = startTime.format('YYYYMMDDHHmmss ZZ');
          const stop = endTime.format('YYYYMMDDHHmmss ZZ');

          xml += `  <programme start="${start}" stop="${stop}" channel="${ch.id}">\n`;
          xml += `    <title lang="en">${escapeXML(title)}</title>\n`;
          if (desc) {
            xml += `    <desc lang="en">${escapeXML(desc)}</desc>\n`;
          }
          if (icon) {
            xml += `    <icon src="${escapeXML(icon)}" />\n`;
          }
          xml += `  </programme>\n`;
        }
      }
    });
  });

  xml += '</tv>';

  // ==========================================
  // ४. फोल्डर आणि फाईल्स सेव्ह करणे
  // ==========================================
  if (!fs.existsSync('./epg')) {
    fs.mkdirSync('./epg');
  }

  fs.writeFileSync('./epg/tataplay.xml', xml, 'utf-8');
  const gzipContent = zlib.gzipSync(xml);
  fs.writeFileSync('./epg/tataplay.xml.gz', gzipContent);
  
  const reportList = Object.values(reportDataDict);
  fs.writeFileSync('./epg/channels_report.json', JSON.stringify(reportList, null, 2), 'utf-8');

  console.log(`\n==================================================`);
  console.log(`SUCCESS! Combined EPG generated for ${reportList.length} channels.`);
  console.log(`Files saved: ./epg/tataplay.xml, ./epg/tataplay.xml.gz, ./epg/channels_report.json`);
  console.log(`==================================================`);
}

function escapeXML(str) {
  if (!str) return '';
  return String(str).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function setHeaders() {
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://watch.tataplay.com',
    'Referer': 'https://watch.tataplay.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'content-type': 'application/json',
    'locale': 'ENG',
    'me': 'web'
  };
}

generateCompleteCombinedEPG();
