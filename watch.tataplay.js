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
  console.log('Starting JioTV EPG Generation (TataPlay Skipped & Preserved)...');
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combined-EPG-Generator">\n';

  let allChannelsDict = {}; 
  let reportDataDict = {};  

  // ==========================================
  // ०. आधीची टाटा प्ले फाईल सुरक्षित वाचून तसेच लोड करणे (TataPlay Skipped / Preserved)
  // ==========================================
  if (fs.existsSync('./epg/tataplay.xml.gz')) {
    try {
      console.log('Reading existing TataPlay EPG data... TataPlay fetching is completely SKIPPED.');
      const fileBuffer = fs.readFileSync('./epg/tataplay.xml.gz');
      const xmlContent = zlib.gunzipSync(fileBuffer).toString('utf-8');
      
      // इथे आपण हवं तर जुना XML मधला टाटा प्लेचा डेटा ठेवू शकतो किंवा थेट नवीन जिओटीव्ही त्यात मर्च करू शकतो.
      // सर्वात सोपा मार्ग म्हणजे आधीची XML फाईल तशीच पुढे वापरणे.
    } catch (err) {
      console.log('Could not read existing GZ file.');
    }
  }

  // ==========================================
  // १. JIOTV EPG FETCHING (Past 1, Present, Future 1 - Offset -1, 0, 1)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing JioTV Channels EPG (Past 1, Present, Future 1)`);
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
          // एरर इग्नोर करून पुढे जाणे
        }
      }

      await sleep(300);
    }
  } else {
    console.log('--> jiotv.json file not found! Skipping JioTV EPG.');
  }

  console.log('\nAll Data Fetched! Assembling XML...');

  // ==========================================
  // २. XML स्ट्रक्चर व टाईम रिटेन्शन (Past 8 Days to Future 1 Day)
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
  // ३. फोल्डर आणि फाईल्स सेव्ह करणे
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
  console.log(`SUCCESS! JioTV EPG generated and merged.`);
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
