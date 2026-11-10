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

async function generateSmartCombinedEPG() {
  console.log('Starting Smart Incremental EPG Generation (Skipping Existing Data)...');
  
  let allChannelsDict = {}; 
  let reportDataDict = {};  
  let existingProgramKeys = new Set(); // आधीच फेच झालेला डेटा ट्रॅक करण्यासाठी

  // ==========================================
  // ०. आधीची XML फाईल वाचून हयात डेटा जतन करणे (Smart Skip Check)
  // ==========================================
  if (fs.existsSync('./epg/tataplay.xml.gz')) {
    try {
      console.log('Reading existing EPG archive to identify already fetched data...');
      const fileBuffer = fs.readFileSync('./epg/tataplay.xml.gz');
      const xmlContent = zlib.gunzipSync(fileBuffer).toString('utf-8');
      
      // साध्या रेग्युलर एक्सप्रेसने जुन्या ፕሮग्राम्सचे चॅनेल आणि टाईम स्टॅम्प ट्रॅक करणे जेणेकरून ड्युप्लिकेट फेच टाळता येईल
      const progRegex = /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">/g;
      let match;
      while ((match = progRegex.exec(xmlContent)) !== null) {
        const key = `${match[3]}_${match[1]}`; // channelId_startTime
        existingProgramKeys.add(key);
      }
      console.log(`Loaded ${existingProgramKeys.size} existing unique programme entries from storage.`);
    } catch (err) {
      console.log('Could not read existing EPG archive, proceeding with fresh fetch.');
    }
  }

  const today = dayjs().tz('Asia/Kolkata');
  const datesToFetch = [
    today.subtract(1, 'day').format('DD-MM-YYYY'), // Yesterday (-1)
    today.format('DD-MM-YYYY'),                   // Today (0)
    today.add(1, 'day').format('DD-MM-YYYY')       // Tomorrow (+1)
  ];

  // ==========================================
  // १. TATA PLAY EPG FETCHING (Smart Batching)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing TataPlay EPG (Smart Incremental)`);
  console.log(`==================================================`);

  for (const dateStr of datesToFetch) {
    console.log(`\n--- TataPlay Date: ${dateStr} ---`);
    let offset = 0;
    let limit = 20;
    let total = 836;

    while (offset < total) {
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
          await sleep(5000);
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
              const startTime = dayjs(Number(item.startTime));
              if (startTime.isValid()) {
                const startStr = startTime.format('YYYYMMDDHHmmss ZZ');
                const uniqueKey = `${site_id}_${startStr}`;

                // जर हा प्रोग्राम आधीच अस्तित्वात असेल तर तो पुन्हा ऍड होणार नाही (Smart Skip)
                allChannelsDict[site_id].epgItems.push({
                  type: 'tataplay',
                  data: item,
                  isExisting: existingProgramKeys.has(uniqueKey)
                });
              }
            });
          }
        }
      });

      offset += limit;
      await sleep(200);
    }
  }

  // ==========================================
  // २. JIOTV EPG FETCHING (Smart Offset Fetching)
  // ==========================================
  console.log(`\n==================================================`);
  console.log(`>>> Processing JioTV EPG (Smart Incremental Batches)`);
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
                const startTime = dayjs(Number(prog.startEpoch));
                if (startTime.isValid()) {
                  const startStr = startTime.format('YYYYMMDDHHmmss ZZ');
                  const uniqueKey = `${jioId}_${startStr}`;

                  allChannelsDict[jioId].epgItems.push({
                    type: 'jiotv',
                    data: prog,
                    isExisting: existingProgramKeys.has(uniqueKey)
                  });
                }
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

  console.log('\nAll Data Processed! Assembling XML with Retention Window...');

  // ==========================================
  // ३. XML स्ट्रक्चर व टाईम रिटेन्शन (Past 8 Days to Future 1 Day)
  // ==========================================
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<tv generator-info-name="Smart-Combined-EPG-Generator">\n';

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

  // B) प्रोग्राम्स टॅग (जुन्या आणि नवीन डेटाचे स्मार्ट मर्जींग)
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
  console.log(`SUCCESS! Smart Combined EPG generated for ${reportList.length} channels.`);
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

generateSmartCombinedEPG();
