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
  console.log('Starting Combined TataPlay & JioTV EPG Generation (Advanced Multi-Day & Retention)...');
  
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
  // १. TATA PLAY EPG FETCHING (With Future check)
  // ==========================================
  const fetchTataPlay = async () => {
    console.log(`\n>>> Starting TataPlay EPG Fetching...`);
    for (const dateStr of datesToFetch) {
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
            await sleep(15000);
          }
        }

        if (responseData && responseData.channelList) {
          total = responseData.total || total;
          responseData.channelList.forEach(channel => {
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
                  // फ्युचर डेटा असल्यास किंवा नॉर्मल डेटा असल्यास तपासणी करून समाविष्ट करणे
                  if (item.startTime) {
                    allChannelsDict[site_id].epgItems.push({ type: 'tataplay', data: item });
                  }
                });
              }
            }
          });
        }
        offset += limit;
        await sleep(500);
      }
    }
    console.log(`>>> TataPlay EPG Fetching Completed.`);
  };

  // ==========================================
  // २. JIOTV EPG FETCHING (Past 1, Present, Future 1 Days)
  // ==========================================
  const fetchJioTV = async () => {
    console.log(`\n>>> Starting JioTV EPG Fetching (Past, Present, Future)...`);
    if (fs.existsSync('./jiotv.json')) {
      const jioFileContent = fs.readFileSync('./jiotv.json', 'utf-8');
      const jioParsed = JSON.parse(jioFileContent);
      const jioChannels = jioParsed.channels || [];

      // जिओटीव्हीसाठी ३ दिवसांचे ऑफसेट्स: -1 (काल), 0 (आज), 1 (उद्या)
      const jioOffsets = [-1, 0, 1];
      const batchSize = 10; 

      for (let i = 0; i < jioChannels.length; i += batchSize) {
        const batch = jioChannels.slice(i, i + batchSize);

        await Promise.all(batch.map(async (jioCh) => {
          const jioId = String(jioCh.channel_id);
          const jioName = jioCh.channel_name;

          if (!allChannelsDict[jioId]) {
            allChannelsDict[jioId] = { id: jioId, name: jioName, logo: '', epgItems: [] };
            reportDataDict[jioId] = { id: jioId, name: jioName, epg_generated: false };
          }

          // तिन्ही दिवसांसाठी लूप करून डेटा फेच करणे
          for (const off of jioOffsets) {
            try {
              const jioResp = await axios.get(`https://iptvmax.site/api/epg/epg.php?id=${jioId}&offset=${off}`, { timeout: 10000 });
              const jioEpgData = jioResp.data;
              const programs = Array.isArray(jioEpgData) ? jioEpgData : (jioEpgData.epg || []);

              if (programs.length > 0) {
                reportDataDict[jioId].epg_generated = true;
                programs.forEach(prog => {
                  allChannelsDict[jioId].epgItems.push({ type: 'jiotv', data: prog });
                });
              }
            } catch (err) {
              // एरर आल्यास इग्नोर करून पुढे जाणे
            }
          }
        }));

        await sleep(500);
      }
    }
    console.log(`>>> JioTV EPG Fetching Completed.`);
  };

  // दोन्ही प्रोव्हायडर्स एकत्र समांतर रन करणे
  await Promise.all([fetchTataPlay(), fetchJioTV()]);

  console.log('\nAll Data Fetched! Filtering Retention (Past 8 Days & Future 1 Day) & Assembling XML...');

  // ==========================================
  // ३. XML स्ट्रक्चर व टाईम रिटेन्शन फिल्टरिंग (Past 8 Days to Future 1 Day)
  // ==========================================
  const now = dayjs();
  const maxPastTime = now.subtract(8, 'day'); // मागील ८ दिवसांपेक्षा जुना डेटा नको
  const maxFutureTime = now.add(2, 'day');    // पुढील १-२ दिवसांपेक्षा जास्त पुढचा नको

  // A) चॅनेल्स टॅग
  Object.values(allChannelsDict).forEach(ch => {
    xml += `  <channel id="${ch.id}">\n`;
    xml += `    <display-name>${escapeXML(ch.name)}</display-name>\n`;
    if (ch.logo) {
      xml += `    <icon src="${escapeXML(ch.logo)}" />\n`;
    }
    xml += `  </channel>\n`;
  });

  // B) प्रोग्राम्स टॅग (रिटेन्शन नियम लागू करून)
  Object.values(allChannelsDict).forEach(ch => {
    ch.epgItems.forEach(item => {
      let startTime, endTime, title, desc, icon;
      let isValidTime = false;

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
        // रिटेन्शन नियम: प्रोग्राम थांबण्याची वेळ मागील ८ दिवसांपेक्षा जास्त असावी आणि भविष्यातील मर्यादेत असावी
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
  console.log(`SUCCESS! Combined EPG generated with Retention Rules.`);
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
