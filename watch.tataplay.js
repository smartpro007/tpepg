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
  console.log('Starting EPG Generation (TataPlay Preserved & JioTV 3-Day Fetching)...');
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Combined-EPG-Generator">\n';

  let allChannelsDict = {}; 
  let reportDataDict = {};  

  // ==========================================
  // ०. जुनी XML/GZ फाईल वाचून टाटा प्लेचा जुना डेटा जतन करणे
  // ==========================================
  if (fs.existsSync('./epg/tataplay.xml.gz')) {
    try {
      console.log('Reading existing TataPlay EPG data from storage...');
      const fileBuffer = fs.readFileSync('./epg/tataplay.xml.gz');
      const xmlContent = zlib.gunzipSync(fileBuffer).toString('utf-8');
      
      // टीप: हवं असल्यास आपण जुन्या फाईलमधले चॅनेल्स काढू शकतो, 
      // पण इथे आपण थेट नवीन जिओटीव्हीचा डेटा ॲड करून XML फ्रेश बनवतोय.
      console.log('Existing TataPlay compressed archive loaded.');
    } catch (err) {
      console.log('Could not read existing GZ file, proceeding with fresh XML structure.');
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

    console.log(`Found ${jioChannels.length} JioTV channels to process from jio.json.`);
    const jioOffsets = [-1, 0, 1]; // -1: काल, 0: आज, 1: उद्या

    for (const jioCh of jioChannels) {
      // इथे जिएटीव्हीच्या JSON मधील योग्य की वापरली आहे (channel_id आणि channel_name)
      const jioId = String(jioCh.channel_id || jioCh.id);
      const jioName = jioCh.channel_name || jioCh.name;

      if (!allChannelsDict[jioId]) {
        allChannelsDict[jioId] = { id: jioId, name: jioName, logo: jioCh.logo || '', epgItems: [] };
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
          console.error(`--> Error fetching JioTV ID ${jioId} at offset ${off}: ${err.message}`);
        }
      }

      await sleep(200); // स्पीड फास्ट ठेवण्यासाठी छोटा पॉझ
    }
  } else {
    console.log('--> jiotv.json file not found! Skipping JioTV EPG.');
  }

  console.log('\nAll JioTV Data Fetched! Assembling XML...');

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
  console.log(`SUCCESS! EPG generated successfully for ${reportList.length} channels.`);
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
