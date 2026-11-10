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
  console.log('Starting Fast EPG Generation (JioTV 20-Channel Batching)...');
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combined-EPG-Generator">\n';

  let allChannelsDict = {}; 
  let reportDataDict = {};  

  // ==========================================
  // JIOTV EPG FETCHING (Parallel Batches of 20 Channels)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing JioTV Channels EPG in Batches (Past 1, Present, Future 1)`);
  console.log(`==================================================`);

  if (fs.existsSync('./jiotv.json')) {
    const jioFileContent = fs.readFileSync('./jiotv.json', 'utf-8');
    const jioParsed = JSON.parse(jioFileContent);
    const jioChannels = jioParsed.channels || [];

    console.log(`Found ${jioChannels.length} JioTV channels to process from jiotv.json.`);
    const jioOffsets = [-1, 0, 1]; // -1: काल, 0: आज, 1: उद्या
    const batchSize = 20; // तू म्हणालास तशी २० चॅनेल्सची बॅच

    for (let i = 0; i < jioChannels.length; i += batchSize) {
      const batch = jioChannels.slice(i, i + batchSize);
      console.log(`\nProcessing Batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(jioChannels.length / batchSize)} (Channels ${i + 1} to ${Math.min(i + batchSize, jioChannels.length)})...`);

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

      await sleep(300); // सर्व्हरवर लोड जाऊ नये म्हणून छोटा पॉझ
    }
  } else {
    console.log('--> jiotv.json file not found! Skipping JioTV EPG.');
  }

  console.log('\nAll JioTV Data Fetched in Batches! Assembling XML...');

  // ==========================================
  // XML स्ट्रक्चर व टाईम रिटेन्शन (Past 8 Days to Future 1 Day)
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

      if (item.type === 'jiotv') {
        const prog = item.data;
        startTime = dayjs(Number(prog.startEpoch));
        endTime = dayjs(Number(prog.endEpoch));
        title = prog.showname || '';
        desc = prog.description || '';
        icon = prog.assets?.['16:9']?.originalProgram || '';

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
      }
    });
  });

  xml += '</tv>';

  // ==========================================
  // फोल्डर आणि फाईल्स सेव्ह करणे
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
  console.log(`SUCCESS! EPG generated successfully for ${reportList.length} channels using 20-channel batching.`);
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
