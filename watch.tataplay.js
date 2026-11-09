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

async function generateEPG() {
  console.log('Starting Combined TataPlay & JioTV EPG Generation...');
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combined-EPG-Generator">\n';

  // ३ दिवसांची रेंज तयार करणे: मागील १ दिवस, आजचा दिवस, पुढील १ दिवस
  const today = dayjs().tz('Asia/Kolkata');
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'), // Yesterday
    today.format('DD-MM-YYYY'),                   // Today
    today.add(1, 'day').format('DD-MM-YYYY')       // Tomorrow
  ];

  console.log(`Target Dates: ${datesToFetch.join(', ')}`);

  let allChannelsDict = {}; // सर्व चॅनेल्सची युनिक यादी साठवण्यासाठी
  let reportDataDict = {};  // चॅनेल रिपोर्ट साठवण्यासाठी

  // ==========================================
  // १. TATA PLAY EPG FETCHING (With Clear Logs)
  // ==========================================
  for (const dateStr of datesToFetch) {
    console.log(`\n==================================================`);
    console.log(`>>> Processing TataPlay Date: ${dateStr}`);
    console.log(`==================================================`);

    let offset = 0;
    let limit = 20;
    let total = 836;
    let requestCount = 0;

    while (offset < total) {
      console.log(`[TataPlay - ${dateStr}] Fetching channels offset ${offset} of ${total}...`);
      
      let responseData = null;
      let retries = 3;

      while (retries > 0) {
        try {
          const resp = await axios.get(
            `https://iptvmax.site/api/epg/tata.php?date=${dateStr}&limit=${limit}&offset=${offset}`,
            { timeout: 15000 }
          );
          responseData = resp.data?.data;
          break;
        } catch (err) {
          retries--;
          console.error(`--> TataPlay Error at offset ${offset}. Status: ${err.response?.status || err.message}`);
          console.log(`--> Waiting 15 seconds before retrying... (Retries left: ${retries})`);
          await sleep(15000);
        }
      }

      if (!responseData || !responseData.channelList || responseData.channelList.length === 0) {
        offset += limit;
        continue;
      }

      total = responseData.total || total;
      const channelList = responseData.channelList;

      channelList.forEach(channel => {
        if (channel.title && channel.title !== '.') {
          const site_id = String(channel.id);
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

      offset += limit;
      requestCount++;

      if (requestCount % 5 === 0) {
        await sleep(5000);
      } else {
        await sleep(1000);
      }
    }
  }

  // ==========================================
  // २. JIOTV EPG FETCHING (Past, Present, Future with Clear Logs)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing JioTV Channels EPG (Past, Present, Future)`);
  console.log(`==================================================`);

  if (fs.existsSync('./jiotv.json')) {
    const jioFileContent = fs.readFileSync('./jiotv.json', 'utf-8');
    const jioParsed = JSON.parse(jioFileContent);
    const jioChannels = jioParsed.channels || [];

    console.log(`Found ${jioChannels.length} JioTV channels to process.`);
    const jioOffsets = [-1, 0, 1]; // -1: काल, 0: आज, 1: उद्या

    for (const jioCh of jioChannels) {
      const jioId = String(jioCh.channel_id);
      const jioName = jioCh.channel_name;

      if (!allChannelsDict[jioId]) {
        allChannelsDict[jioId] = { id: jioId, name: jioName, logo: '', epgItems: [] };
        reportDataDict[jioId] = { id: jioId, name: jioName, epg_generated: false };
      }

      // तिन्ही दिवसांसाठी (काल, आज, उद्या) डेटा फेच करणे
      for (const off of jioOffsets) {
        try {
          console.log(`Fetching JioTV EPG for: ${jioName} (ID: ${jioId}) [Offset: ${off}]`);
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
          console.error(`--> Error fetching JioTV EPG for ID ${jioId} at offset ${off}: ${err.message}`);
        }
      }

      await sleep(300); // सर्व्हरवर लोड येऊ नये म्हणून छोटा पॉझ
    }
  } else {
    console.log('--> jiotv.json file not found! Skipping JioTV EPG.');
  }

  console.log('\nAll Data Fetched! Filtering Retention & Assembling XML...');

  // ==========================================
  // ३. XML स्ट्रक्चर व टाईम रिटेन्शन फिल्टरिंग (Past 8 Days to Future 1 Day)
  // ==========================================
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
  console.log(`SUCCESS! Combined EPG generated for ${reportList.length} total channels.`);
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

generateEPG();
